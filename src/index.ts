import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { NIM_BASE_URL, PROVIDER_ID } from "./constants.js";
import { handleError, resolveModel } from "./error-handler.js";
import { logDebug } from "./logger.js";
import { startProxy } from "./proxy.js";
import { SessionManager } from "./session.js";
import {
  addKey,
  getActiveKeys,
  getDefaultStore,
  getNextKey,
  loadStore,
  recordModelRateLimit,
  recordRateLimit,
  saveStore,
} from "./store.js";
import type { KeyStoreConfig, SessionState } from "./types.js";

function isValidStrategy(
  val: unknown,
): val is "round-robin" | "least-failures" {
  return val === "round-robin" || val === "least-failures";
}

export const NvidiaNimKeyRotator: Plugin = async (
  input: PluginInput,
  options?: Record<string, unknown>,
) => {
  const client = input.client;
  const config: KeyStoreConfig = {
    storePath:
      typeof options?.storePath === "string" ? options.storePath : undefined,
    rotationStrategy: isValidStrategy(options?.rotationStrategy)
      ? options.rotationStrategy
      : "round-robin",
  };

  const store = loadStore(config) ?? getDefaultStore();
  if (!Array.isArray(store.fallbackChain)) store.fallbackChain = [];

  const sessionManager = new SessionManager();
  const sessions = new Map<string, SessionState>();

  // Seed env key if no active keys exist
  const envKey = process.env.NVIDIA_API_KEY;
  if (getActiveKeys(store).length === 0 && envKey) {
    if (!store.keys.some((k) => k.name === "env-default")) {
      addKey(store, "env-default", envKey);
      try {
        saveStore(store, config);
      } catch {
        /* best-effort */
      }
    }
  }

  // Start proxy
  const proxyPort =
    typeof options?.proxyPort === "number" ? options.proxyPort : 0;
  const disableProxy = options?.disableProxy === true;
  let proxy: ReturnType<typeof startProxy> = null;

  if (!disableProxy) {
    proxy = startProxy({
      port: proxyPort,
      store,
      config,
      sessions,
      onRateLimit: (sessionID, modelId, keyId) => {
        const session = sessionManager.getIfExists(sessionID);
        if (session) session.rateLimitCount++;
        recordRateLimit(store, keyId);
        recordModelRateLimit(store, keyId, modelId);
        try {
          saveStore(store, config);
        } catch {
          /* best-effort */
        }
      },
    });
    if (!proxy) {
      logDebug("proxy disabled due to port conflict");
    }
  }

  // Helper: show toast (fire-and-forget)
  const showToast = (
    variant: "info" | "warning" | "error",
    message: string,
  ) => {
    try {
      client.tui?.showToast?.({
        body: { title: "Model Fallback", message, variant },
      });
    } catch {
      /* swallow */
    }
  };

  // Helper: check if session is a subagent
  async function isSubagentSession(sessionID: string): Promise<boolean> {
    try {
      const res = await client.session.get({ path: { id: sessionID } });
      return !!res.data?.parentID;
    } catch {
      return false;
    }
  }

  // Helper: abort session
  async function abortSession(sessionID: string): Promise<void> {
    await client.session.abort({ path: { id: sessionID } });
  }

  // Helper: wait for idle (event-driven via polling fallback)
  async function waitForIdle(sessionID: string): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      try {
        const res = await client.session.status({});
        const data =
          res && typeof res === "object" && "data" in res ? res.data : res;
        if (data && typeof data === "object") {
          const statusMap = data as Record<string, unknown>;
          const status = statusMap[sessionID] as
            | Record<string, unknown>
            | undefined;
          if (!status || status.type === "idle") return true;
        }
      } catch {
        /* keep polling */
      }
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    return false;
  }

  // Helper: re-prompt session with a new model
  async function promptSession(
    sessionID: string,
    modelId: string,
    _session: SessionState,
  ): Promise<void> {
    const messagesResult = await client.session.messages({
      path: { id: sessionID },
    });
    const entries =
      messagesResult && "data" in messagesResult
        ? messagesResult.data
        : messagesResult;
    if (!Array.isArray(entries)) throw new Error("no messages");

    const userMessages = (entries as Array<Record<string, unknown>>).filter(
      (e) => (e?.info as Record<string, unknown>)?.role === "user",
    );
    if (userMessages.length === 0) throw new Error("no user messages");

    const lastUser = userMessages[userMessages.length - 1] as Record<
      string,
      unknown
    >;
    const info = lastUser.info as Record<string, unknown>;
    const parts = lastUser.parts as Array<Record<string, unknown>>;

    const promptParts: Array<{ type: "text"; id: string; text: string }> = [];
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part?.type === "text") {
          promptParts.push({
            type: "text",
            id: part.id as string,
            text: part.text as string,
          });
        }
      }
    }
    if (promptParts.length === 0) throw new Error("no text parts");

    await client.session.prompt({
      path: { id: sessionID },
      body: {
        messageID: info?.id as string,
        agent: info?.agent as string,
        model: { providerID: PROVIDER_ID, modelID: modelId },
        parts: promptParts,
      },
    });
  }

  const hooks: Hooks = {
    config: async (cfg) => {
      if (proxy) {
        const c = cfg as Record<
          string,
          Record<string, Record<string, Record<string, unknown>>>
        >;
        if (!c.provider) c.provider = {};
        if (!c.provider.nvidia) c.provider.nvidia = {};
        if (!c.provider.nvidia.options) c.provider.nvidia.options = {};
        c.provider.nvidia.options.baseURL = `http://localhost:${proxy.port}`;
      }
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "Enter NVIDIA NIM API Key",
          async authorize(inputs) {
            const key = inputs?.apiKey;
            if (!key) return { type: "failed" };
            try {
              const res = await fetch(`${NIM_BASE_URL}/v1/models`, {
                headers: { Authorization: `Bearer ${key}` },
              });
              if (!res.ok) return { type: "failed" };
            } catch {
              return { type: "failed" };
            }
            return { type: "success", key, provider: PROVIDER_ID };
          },
        },
      ],
    },

    "chat.headers": async (input, output) => {
      if (input.model?.providerID !== PROVIDER_ID) return;
      if (input.sessionID) {
        output.headers["X-Nim-Rotator-Session-ID"] = input.sessionID;
      }
    },

    "chat.message": async (input, output) => {
      const chain = store.fallbackChain;
      if (chain.length === 0) return;

      const sessionID = input.sessionID;
      const session = await sessionManager.getOrCreate(sessionID, () =>
        isSubagentSession(sessionID),
      );

      // Set phase to active on first message
      if (session.phase === "idle") {
        sessionManager.setPhase(sessionID, "active");
      }

      // Proactive promotion: resolve to highest-priority available model
      const desiredIndex = resolveModel(store, session, chain);
      const target = chain[desiredIndex];
      if (!target) return;

      output.message.model = { providerID: PROVIDER_ID, modelID: target.id };
      session.currentModelId = target.id;
      session.chainIndex = desiredIndex;
      session.lastUserMessageID = output.message.id;

      // Update shared sessions map for proxy model rewriting
      sessions.set(sessionID, session);
    },

    "shell.env": async (_input, output) => {
      const next = getNextKey(store, config);
      if (next) {
        output.env = output.env ?? {};
        output.env.NVIDIA_API_KEY = next.key.key;
      }
    },

    event: async ({ event }) => {
      if (event.type === "session.error") {
        const props = (event as Record<string, unknown>).properties as
          | Record<string, unknown>
          | undefined;
        const sessionID = props?.sessionID as string | undefined;
        if (!sessionID) return;
        await handleError(
          { sessionID, error: props?.error, source: "session.error" },
          {
            store,
            sessionManager,
            showToast,
            abortSession,
            waitForIdle,
            promptSession,
          },
        );
        return;
      }

      if ((event.type as string) === "session.next.step.failed") {
        const props = (event as Record<string, unknown>).properties as
          | Record<string, unknown>
          | undefined;
        const sessionID = props?.sessionID as string | undefined;
        if (!sessionID) return;
        await handleError(
          {
            sessionID,
            error: props?.error,
            source: "session.next.step.failed",
          },
          {
            store,
            sessionManager,
            showToast,
            abortSession,
            waitForIdle,
            promptSession,
          },
        );
        return;
      }

      if (event.type === "session.status") {
        const props = (event as Record<string, unknown>).properties as
          | Record<string, unknown>
          | undefined;
        const sessionID = props?.sessionID as string | undefined;
        const status = props?.status as Record<string, unknown> | undefined;

        if (status?.type === "retry" && sessionID) {
          await handleError(
            {
              sessionID,
              error: props?.error ?? status,
              source: "session.status.retry",
            },
            {
              store,
              sessionManager,
              showToast,
              abortSession,
              waitForIdle,
              promptSession,
            },
          );
          return;
        }

        if (status?.type === "idle" && sessionID) {
          const session = sessionManager.getIfExists(sessionID);
          if (!session) return; // Ignore unknown sessions — no allocation
          if (session.phase === "retrying") return;
          session.rateLimitCount = 0;
          session.serverErrorCount = 0;
          session.fallbacksTriggered = 0;
          sessionManager.setPhase(sessionID, "idle");
          sessions.delete(sessionID);
          return;
        }
      }

      if (event.type === "session.deleted") {
        const props = (event as Record<string, unknown>).properties as
          | Record<string, unknown>
          | undefined;
        const info = props?.info as Record<string, unknown> | undefined;
        const sessionID = info?.id as string | undefined;
        if (sessionID) {
          sessionManager.delete(sessionID);
          sessions.delete(sessionID);
        }
      }
    },
  };

  return hooks;
};

export default NvidiaNimKeyRotator;

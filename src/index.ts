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
        logDebug(
          `[onRateLimit] called sessionID=${sessionID} modelId=${modelId} keyId=${keyId}`,
        );
        const session = sessionManager.getIfExists(sessionID);
        if (session) {
          // Skip counter increment if model already changed (stale 429 from prior model)
          if (session.currentModelId === modelId) {
            const prev = session.rateLimitCount;
            session.rateLimitCount++;
            logDebug(
              `[onRateLimit] rateLimitCount ${prev} -> ${session.rateLimitCount} phase=${session.phase}`,
            );
          } else {
            logDebug(
              `[onRateLimit] stale 429 for ${modelId}, session now uses ${session.currentModelId} — skipping count`,
            );
          }
        } else {
          logDebug(`[onRateLimit] session NOT found for ${sessionID}`);
        }
        try {
          recordRateLimit(store, keyId);
          logDebug(`[onRateLimit] recordRateLimit done for keyId=${keyId}`);
        } catch (e) {
          logDebug(
            `[onRateLimit] recordRateLimit failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        try {
          recordModelRateLimit(store, keyId, modelId);
          logDebug(`[onRateLimit] recordModelRateLimit done`);
        } catch (e) {
          logDebug(
            `[onRateLimit] recordModelRateLimit failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        try {
          saveStore(store, config);
          logDebug(`[onRateLimit] saveStore done`);
        } catch (e) {
          logDebug(
            `[onRateLimit] saveStore failed: ${e instanceof Error ? e.message : String(e)}`,
          );
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

      logDebug(
        `[chat.message] sessionID=${sessionID} model=${target.id} chainIndex=${desiredIndex} phase=${session.phase} rateLimitCount=${session.rateLimitCount}`,
      );

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
        logDebug(
          `[event] session.error sessionID=${sessionID} error=${JSON.stringify(props?.error, null, 0)?.slice(0, 300)}`,
        );
        if (!sessionID) return;
        await handleError(
          { sessionID, error: props?.error, source: "session.error" },
          { store, sessionManager, showToast },
        );
        return;
      }

      if ((event.type as string) === "session.next.step.failed") {
        const props = (event as Record<string, unknown>).properties as
          | Record<string, unknown>
          | undefined;
        const sessionID = props?.sessionID as string | undefined;
        logDebug(
          `[event] session.next.step.failed sessionID=${sessionID} error=${JSON.stringify(props?.error, null, 0)?.slice(0, 300)}`,
        );
        if (!sessionID) return;
        await handleError(
          {
            sessionID,
            error: props?.error,
            source: "session.next.step.failed",
          },
          { store, sessionManager, showToast },
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
          const message =
            typeof status.message === "string" ? status.message : "";
          const is429Retry = /429|too many requests|rate.?limit/i.test(message);
          const isTimeoutRetry = /time.?out|timed.?out|abort/i.test(message);
          logDebug(
            `[event] session.status.retry sessionID=${sessionID} attempt=${status.attempt} message=${message} is429=${is429Retry} isTimeout=${isTimeoutRetry} hasError=${!!props?.error}`,
          );
          // Synthesize a typed error so classifyError picks the right class
          let error: unknown;
          if (is429Retry) {
            error = { name: "APIError", data: { statusCode: 429, message } };
          } else if (isTimeoutRetry) {
            error = { name: "APIError", data: { statusCode: 408, message } };
          } else {
            error = { name: "APIError", data: { statusCode: 503, message } };
          }
          await handleError(
            {
              sessionID,
              error,
              source: "session.status.retry",
            },
            { store, sessionManager, showToast },
          );
          return;
        }

        if (status?.type === "idle" && sessionID) {
          const session = sessionManager.getIfExists(sessionID);
          logDebug(
            `[event] session.status.idle sessionID=${sessionID} hasSession=${!!session} phase=${session?.phase} rateLimitCount=${session?.rateLimitCount}`,
          );
          if (!session) return;
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

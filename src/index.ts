import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import {
  loadStore,
  saveStore,
  addKey,
  getActiveKeys,
  getDefaultStore,
} from "./storage.js";
import type { KeyStore, KeyStoreConfig, FallbackModel } from "./types.js";
import {
  extractStatus,
  describeError,
  is429Error,
  isStatusMessageRateLimited,
  shouldRetryForError,
  type SessionState,
} from "./errors.js";
import { startProxy } from "./proxy.js";

const PROVIDER_ID = "nvidia";
const NIM_BASE_URL = "https://integrate.api.nvidia.com";
const VALID_STRATEGIES = ["round-robin", "least-failures"] as const;

import { logDebug } from "./logger.js";

function dumpSessionState(state: SessionState, label: string) {
  return `[${label}] attemptIndex=${state.attemptIndex}, inRetry=${state.inRetry}, aborting=${state.aborting}, pendingRetryIndex=${state.pendingRetryIndex ?? "null"}, activeChainModelId=${state.activeChainModelId ?? "null"}, rateLimitCount=${state.rateLimitCount}, currentModelId=${state.currentModelId ?? "null"}, lastFailedModelId=${state.lastFailedModelId ?? "null"}, lastErrorHandledAt=${state.lastErrorHandledAt}`;
}

function isValidStrategy(
  val: unknown,
): val is KeyStoreConfig["rotationStrategy"] {
  return val === "round-robin" || val === "least-failures";
}

function modelKey(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}/${model.modelID}`;
}

async function isSubagentSession(
  client: PluginInput["client"],
  sessionID: string,
): Promise<boolean> {
  try {
    const res = await (
      client.session as unknown as {
        get: (p: { path: { id: string } }) => Promise<unknown>;
      }
    ).get({ path: { id: sessionID } });
    const data =
      res && typeof res === "object" && "data" in res
        ? (res as { data: unknown }).data
        : res;
    if (!data || typeof data !== "object") return false;
    return (data as Record<string, unknown>)?.parentID !== undefined;
  } catch (err) {
    logDebug(
      `[nim-rotator] isSubagentSession failed for ${sessionID}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

const SUBAGENT_CACHE_MAX_SIZE = 1000;
const SUBAGENT_CACHE_TTL_MS = 60_000;
const ERROR_DEDUP_WINDOW_MS = 500;
const SESSIONS_MAX_SIZE = 500;
const SESSIONS_MAX_AGE_MS = 10 * 60 * 1000;

// Retry backoff constants — copied from Opencode's retry mechanism
const RETRY_INITIAL_DELAY = 2000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_MAX_DELAY_NO_HEADERS = 30_000;
const RETRY_MAX_DELAY = 2_147_483_647;

// Model cooldown after rate limit: 1 hour
const MODEL_COOLDOWN_MS = 60 * 60 * 1000;

function capDelay(ms: number): number {
  return Math.min(ms, RETRY_MAX_DELAY);
}

function calculateRetryDelay(attempt: number, error?: unknown): number {
  // attempt is 1-based
  let retryAfterMs: number | undefined;

  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    const data = rec.data as Record<string, unknown> | undefined;

    // Check for retry-after headers in the error
    const headers = data?.responseHeaders as Record<string, string> | undefined;
    if (headers) {
      const retryAfterMsHeader = headers["retry-after-ms"];
      if (retryAfterMsHeader) {
        const parsed = Number.parseFloat(retryAfterMsHeader);
        if (!Number.isNaN(parsed)) {
          retryAfterMs = parsed;
        }
      }

      if (retryAfterMs === undefined) {
        const retryAfter = headers["retry-after"];
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter);
          if (!Number.isNaN(parsedSeconds)) {
            retryAfterMs = Math.ceil(parsedSeconds * 1000);
          } else {
            const parsedDate = Date.parse(retryAfter) - Date.now();
            if (!Number.isNaN(parsedDate) && parsedDate > 0) {
              retryAfterMs = Math.ceil(parsedDate);
            }
          }
        }
      }
    }
  }

  if (retryAfterMs !== undefined) {
    return capDelay(retryAfterMs);
  }

  return capDelay(
    Math.min(
      RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1),
      RETRY_MAX_DELAY_NO_HEADERS,
    ),
  );
}

const subAgentCache = new Map<string, number>();

async function isSubagentSessionCached(
  client: PluginInput["client"],
  sessionID: string,
): Promise<boolean> {
  const cached = subAgentCache.get(sessionID);
  if (cached !== undefined) {
    if (cached > Date.now()) {
      return true;
    }
    subAgentCache.delete(sessionID);
  }
  const result = await isSubagentSession(client, sessionID);
  if (result) {
    if (subAgentCache.size >= SUBAGENT_CACHE_MAX_SIZE) {
      const firstKey = subAgentCache.keys().next().value;
      if (firstKey !== undefined) {
        subAgentCache.delete(firstKey);
      }
    }
    subAgentCache.set(sessionID, Date.now() + SUBAGENT_CACHE_TTL_MS);
  }
  return result;
}

function findChainIndex(
  chain: FallbackModel[],
  model: { providerID: string; modelID: string } | undefined,
): number {
  if (!model || model.providerID !== PROVIDER_ID) return -1;
  return chain.findIndex((entry) => entry.id === model.modelID);
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
      ? options!.rotationStrategy
      : "round-robin",
  };

  const store = loadStore(config) ?? getDefaultStore();
  if (!Array.isArray(store.fallbackChain)) store.fallbackChain = [];

  const sessions = new Map<string, SessionState>();
  const modelCooldowns = new Map<string, number>();
  const proxySessions = new Map<
    string,
    {
      activeChainModelId: string | undefined;
      currentModelId: string | undefined;
    }
  >();
  const proxyPort =
    typeof options?.proxyPort === "number" ? options.proxyPort : 8765;

  const proxy = startProxy({
    port: proxyPort,
    store,
    config,
    sessions: proxySessions,
    onRateLimit: (sessionID: string, modelId: string) => {
      const state = sessions.get(sessionID);
      if (state) {
        state.rateLimitCount++;
      }
      safeSaveStore();
    },
  });
  const actualProxyPort = proxy.port;

  const reloadFromDisk = () => {
    let fresh: KeyStore | null = null;
    try {
      fresh = loadStore(config);
    } catch (err) {
      logDebug(
        `[nim-rotator] Failed to reload store from disk: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (fresh === null) return;
    try {
      store.keys = fresh.keys;
      store.currentIndex = fresh.currentIndex;
      store.rotationStrategy = fresh.rotationStrategy;
      store.updatedAt = fresh.updatedAt;
      store.lastUsedKeyId = fresh.lastUsedKeyId;
      store.fallbackChain = Array.isArray(fresh.fallbackChain)
        ? fresh.fallbackChain
        : [];
      store.maxRateLimitFailures =
        typeof fresh.maxRateLimitFailures === "number" &&
        Number.isFinite(fresh.maxRateLimitFailures) &&
        fresh.maxRateLimitFailures >= 1
          ? fresh.maxRateLimitFailures
          : getDefaultStore().maxRateLimitFailures;
    } catch (err) {
      logDebug(
        `[nim-rotator] Failed to apply reloaded store: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const safeSaveStore = () => {
    try {
      const fresh = loadStore(config);
      if (fresh) {
        // Merge proxy-managed fields into the fresh store
        fresh.currentIndex = store.currentIndex;
        fresh.lastUsedKeyId = store.lastUsedKeyId;
        saveStore(fresh, config);
      } else {
        saveStore(store, config);
      }
    } catch (err) {
      console.error("[nim-rotator] Failed to save store:", err);
    }
  };

  const activeKeys = getActiveKeys(store);

  if (activeKeys.length === 0) {
    const envKey = process.env.NVIDIA_API_KEY;
    if (envKey) {
      const existing = store.keys.find((k) => k.name === "env-default");
      if (!existing) {
        addKey(store, "env-default", envKey);
        safeSaveStore();
      }
    }
  }

  const showToast = async (
    variant: "success" | "info" | "warning" | "error",
    message: string,
  ) => {
    try {
      await client.tui?.showToast?.({
        body: { title: "Model Fallback", message, variant },
      });
    } catch (err) {
      logDebug(
        `[nim-rotator] showToast failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const getState = (sessionID: string): SessionState => {
    const existing = sessions.get(sessionID);
    if (existing) {
      logDebug(
        `[nim-rotator] getState: reusing existing session for ${sessionID}`,
      );
      return existing;
    }
    if (sessions.size >= SESSIONS_MAX_SIZE) {
      const now = Date.now();
      let oldestId: string | undefined;
      let oldestTime = Infinity;
      for (const [id, s] of sessions) {
        if (s.createdAt < oldestTime) {
          oldestTime = s.createdAt;
          oldestId = id;
        }
      }
      if (oldestId) sessions.delete(oldestId);
      for (const [id, s] of sessions) {
        if (now - s.createdAt > SESSIONS_MAX_AGE_MS) {
          sessions.delete(id);
        }
      }
    }
    const next: SessionState = {
      attemptIndex: 0,
      inRetry: false,
      aborting: false,
      pendingRetryIndex: undefined,
      lastUserMessageID: undefined,
      activeChainKey: undefined,
      activeChainModelId: undefined,
      rateLimitCount: 0,
      currentModelId: undefined,
      lastFailedModelId: undefined,
      lastErrorHandledAt: 0,
      createdAt: Date.now(),
      retryAttempt: 0,
    };
    sessions.set(sessionID, next);
    logDebug(`[nim-rotator] getState: CREATED new session for ${sessionID}`);
    return next;
  };

  const cleanupSession = (sessionID: string) => {
    sessions.delete(sessionID);
    subAgentCache.delete(sessionID);
  };

  const waitForSessionIdle = async (
    sessionID: string,
    timeoutMs: number = 2000,
  ): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await client.session.status({});
        const data =
          res && typeof res === "object" && "data" in res
            ? (res as { data: unknown }).data
            : res;
        if (data && typeof data === "object") {
          const statusMap = data as Record<string, unknown>;
          const status = statusMap[sessionID] as
            | Record<string, unknown>
            | undefined;
          if (status?.type === "idle") {
            return true;
          }
          if (!status) {
            return true;
          }
        }
      } catch {
        // status endpoint might not be available, keep polling
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    logDebug(`[nim-rotator] waitForSessionIdle timed out for ${sessionID}`);
    return false;
  };

  const triggerRetry = async (
    sessionID: string,
    state: SessionState,
    reason?: string,
    error?: unknown,
  ): Promise<boolean> => {
    const chain = store.fallbackChain;
    if (chain.length < 2) return false;

    // Prevent concurrent retries for the same session
    if (state.retryPromise) {
      return state.retryPromise;
    }

    const doRetry = async (): Promise<boolean> => {
      state.retryAttempt++;
      const attempt = state.retryAttempt;

      // Calculate delay with exponential backoff
      const delay = calculateRetryDelay(attempt, error);

      // Show notification before delay so user doesn't think it's frozen
      if (delay > 0) {
        await showToast(
          "info",
          `Retrying with fallback model in ${Math.ceil(delay / 1000)}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      let nextIndex = (state.attemptIndex + 1) % chain.length;
      if (
        state.lastFailedModelId &&
        chain[nextIndex]?.id === state.lastFailedModelId &&
        chain.length > 2
      ) {
        nextIndex = (nextIndex + 1) % chain.length;
      }
      state.inRetry = true;
      state.pendingRetryIndex = nextIndex;

      try {
        const source = chain[state.attemptIndex];
        const target = chain[nextIndex];
        if (!source || !target) {
          logDebug(
            `[nim-rotator] triggerRetry: source or target is undefined. sourceIndex=${state.attemptIndex}, nextIndex=${nextIndex}, chainLength=${chain.length}`,
          );
          return false;
        }

        await showToast(
          "warning",
          `${source.name} → ${target.name}${reason ? `: ${reason}` : ""}`,
        );

        const messagesResult = await client.session.messages({
          path: { id: sessionID },
        });
        const entries =
          messagesResult && "data" in messagesResult
            ? messagesResult.data
            : messagesResult;
        if (!Array.isArray(entries)) {
          logDebug(
            `[nim-rotator] triggerRetry: entries is not an array. type=${typeof entries}`,
          );
          return false;
        }

        const userMessages = (entries as Array<Record<string, unknown>>).filter(
          (entry) => (entry?.info as Record<string, unknown>)?.role === "user",
        );
        if (userMessages.length === 0) {
          logDebug(`[nim-rotator] triggerRetry: no user messages found`);
          return false;
        }

        const lastUser = userMessages[userMessages.length - 1] as Record<
          string,
          unknown
        >;
        const lastUserInfo = lastUser.info as Record<string, unknown>;
        const lastUserParts = lastUser.parts as Array<Record<string, unknown>>;

        if (
          state.lastUserMessageID &&
          (lastUserInfo?.id as string) !== state.lastUserMessageID
        ) {
          logDebug(
            `[nim-rotator] triggerRetry: message ID mismatch. expected=${state.lastUserMessageID}, actual=${lastUserInfo?.id}`,
          );
          return false;
        }

        const promptParts: Array<{
          type: "text";
          id: string;
          text: string;
          synthetic?: boolean;
          ignored?: boolean;
        }> = [];
        if (Array.isArray(lastUserParts)) {
          for (const part of lastUserParts) {
            if (part?.type === "text") {
              promptParts.push({
                type: "text",
                id: part.id as string,
                text: part.text as string,
                synthetic: part.synthetic as boolean | undefined,
                ignored: part.ignored as boolean | undefined,
              });
            }
          }
        }

        state.aborting = true;
        try {
          await client.session.abort({ path: { id: sessionID } });
        } catch (abortErr) {
          logDebug(
            `[nim-rotator] abort failed for ${sessionID}: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`,
          );
        }

        const idle = await waitForSessionIdle(sessionID);
        if (!idle) {
          logDebug(
            `[nim-rotator] triggerRetry: session ${sessionID} did not go idle after abort`,
          );
          state.pendingRetryIndex = undefined;
          return false;
        }

        logDebug(
          `[nim-rotator] triggerRetry: sending prompt with model ${target.id} for session ${sessionID}`,
        );
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            messageID: lastUserInfo?.id as string,
            agent: lastUserInfo?.agent as string,
            model: {
              providerID: PROVIDER_ID,
              modelID: target.id,
            },
            parts: promptParts,
          },
        });

        logDebug(
          `[nim-rotator] triggerRetry: successfully triggered fallback for session ${sessionID}`,
        );
        return true;
      } catch (err) {
        logDebug(
          `[nim-rotator] triggerRetry failed for ${sessionID}: ${err instanceof Error ? err.message : String(err)}`,
        );
        state.pendingRetryIndex = undefined;
        return false;
      } finally {
        state.inRetry = false;
      }
    };

    state.retryPromise = doRetry();
    try {
      return await state.retryPromise;
    } finally {
      state.retryPromise = undefined;
    }
  };

  const handleSessionError = async (event: Record<string, unknown>) => {
    const props = event.properties as Record<string, unknown> | undefined;
    const error = props?.error;
    const sessionID = props?.sessionID as string | undefined;

    logDebug(
      `[nim-rotator] handleSessionError called: sessionID=${sessionID ?? "none"}, is429=${is429Error(error)}, errorName=${(error as any)?.name ?? "unknown"}`,
    );

    if (is429Error(error)) {
      reloadFromDisk();
      const stateForBlacklist = sessionID ? sessions.get(sessionID) : undefined;
      const modelForBlacklist =
        stateForBlacklist?.currentModelId ??
        stateForBlacklist?.activeChainModelId;
      if (stateForBlacklist) {
        stateForBlacklist.lastFailedModelId = modelForBlacklist;
      }
      safeSaveStore();
    }

    if (!sessionID) {
      logDebug(`[nim-rotator] handleSessionError: no sessionID, returning`);
      return;
    }

    const state = getState(sessionID);
    if (state.aborting) {
      state.aborting = false;
      return;
    }
    if (state.inRetry) return;

    const now = Date.now();
    if (now - state.lastErrorHandledAt < ERROR_DEDUP_WINDOW_MS) return;
    state.lastErrorHandledAt = now;

    if (!shouldRetryForError(error, state)) {
      if (!is429Error(error)) {
        state.rateLimitCount = 0;
      }
      return;
    }

    if (is429Error(error)) {
      state.rateLimitCount++;
    } else {
      state.rateLimitCount++;
    }
    logDebug(
      `[nim-rotator] handleSessionError: rateLimitCount=${state.rateLimitCount}, threshold=${store.maxRateLimitFailures}`,
    );
    if (state.rateLimitCount < store.maxRateLimitFailures) return;

    // Set cooldown for the current model before falling back
    const cooldownModelId = state.currentModelId ?? state.activeChainModelId;
    if (cooldownModelId) {
      modelCooldowns.set(cooldownModelId, Date.now() + MODEL_COOLDOWN_MS);
    }

    // For subagents: don't abort — update model index for next turn
    if (await isSubagentSessionCached(client, sessionID)) {
      const chain = store.fallbackChain;
      if (chain.length >= 2) {
        const nextIndex = (state.attemptIndex + 1) % chain.length;
        state.attemptIndex = nextIndex;
        state.activeChainModelId = chain[nextIndex]?.id;
      }
      proxySessions.set(sessionID, {
        activeChainModelId: state.activeChainModelId,
        currentModelId: state.currentModelId,
      });
      await showToast(
        "info",
        `Subagent rate limited — next turn will use ${state.activeChainModelId ?? "fallback model"}`,
      );
      return;
    }

    const reason = describeError(error, state, store.maxRateLimitFailures);
    const triggered = await triggerRetry(sessionID, state, reason, error);
    if (!triggered) {
      logDebug(`[nim-rotator] triggerRetry returned false for ${sessionID}`);
    }
  };

  const handleSessionStatusRetry = async (
    sessionID: string,
    status: Record<string, unknown>,
  ) => {
    const message = status.message as string | undefined;
    const is429 = isStatusMessageRateLimited(message);
    if (!is429) return;

    const state = sessions.get(sessionID);
    if (!state) return;
    if (state.inRetry) return;

    reloadFromDisk();
    const modelForBlacklist = state.currentModelId ?? state.activeChainModelId;
    state.lastFailedModelId = modelForBlacklist;
    safeSaveStore();

    state.rateLimitCount++;
    if (state.rateLimitCount < store.maxRateLimitFailures) return;

    // Set cooldown for the current model before falling back
    const cooldownModelId = state.currentModelId ?? state.activeChainModelId;
    if (cooldownModelId) {
      modelCooldowns.set(cooldownModelId, Date.now() + MODEL_COOLDOWN_MS);
    }

    // For subagents: don't abort — update model index for next turn
    if (await isSubagentSessionCached(client, sessionID)) {
      const chain = store.fallbackChain;
      if (chain.length >= 2) {
        const nextIndex = (state.attemptIndex + 1) % chain.length;
        state.attemptIndex = nextIndex;
        state.activeChainModelId = chain[nextIndex]?.id;
      }
      proxySessions.set(sessionID, {
        activeChainModelId: state.activeChainModelId,
        currentModelId: state.currentModelId,
      });
      await showToast(
        "info",
        `Subagent rate limited — next turn will use ${state.activeChainModelId ?? "fallback model"}`,
      );
      return;
    }

    const reason = `Rate limited (429) — ${state.rateLimitCount}/${store.maxRateLimitFailures} consecutive`;
    const triggered2 = await triggerRetry(sessionID, state, reason);
    if (!triggered2) {
      logDebug(
        `[nim-rotator] triggerRetry returned false for ${sessionID} (status retry)`,
      );
    }
  };

  const handleSessionStepFailed = async (event: Record<string, unknown>) => {
    const props = event.properties as Record<string, unknown> | undefined;
    const sessionID = props?.sessionID as string | undefined;
    if (!sessionID) return;

    const error = props?.error as Record<string, unknown> | undefined;
    const errorData =
      error && typeof error === "object" && "data" in error
        ? (error.data as Record<string, unknown>)
        : undefined;
    const errorMessage =
      typeof errorData?.message === "string"
        ? errorData.message
        : typeof error?.message === "string"
          ? error.message
          : undefined;

    if (!isStatusMessageRateLimited(errorMessage) && !is429Error(error)) {
      return;
    }

    const state = getState(sessionID);
    if (state.inRetry) return;

    const now = Date.now();
    if (now - state.lastErrorHandledAt < ERROR_DEDUP_WINDOW_MS) return;
    state.lastErrorHandledAt = now;

    reloadFromDisk();
    const modelForBlacklist = state.currentModelId ?? state.activeChainModelId;
    state.lastFailedModelId = modelForBlacklist;
    safeSaveStore();

    state.rateLimitCount++;
    if (state.rateLimitCount < store.maxRateLimitFailures) return;

    // Set cooldown for the current model before falling back
    const cooldownModelId = state.currentModelId ?? state.activeChainModelId;
    if (cooldownModelId) {
      modelCooldowns.set(cooldownModelId, Date.now() + MODEL_COOLDOWN_MS);
    }

    // For subagents: don't abort — update model index for next turn
    if (await isSubagentSessionCached(client, sessionID)) {
      const chain = store.fallbackChain;
      if (chain.length >= 2) {
        const nextIndex = (state.attemptIndex + 1) % chain.length;
        state.attemptIndex = nextIndex;
        state.activeChainModelId = chain[nextIndex]?.id;
      }
      proxySessions.set(sessionID, {
        activeChainModelId: state.activeChainModelId,
        currentModelId: state.currentModelId,
      });
      await showToast(
        "info",
        `Subagent rate limited — next turn will use ${state.activeChainModelId ?? "fallback model"}`,
      );
      return;
    }

    const reason = `Rate limited (429) — ${state.rateLimitCount}/${store.maxRateLimitFailures} consecutive`;
    const triggered3 = await triggerRetry(sessionID, state, reason, error);
    if (!triggered3) {
      logDebug(
        `[nim-rotator] triggerRetry returned false for ${sessionID} (step failed)`,
      );
    }
  };

  const hooks: Hooks = {
    config: async (cfg: any) => {
      if (!cfg.provider) cfg.provider = {};
      if (!cfg.provider.nvidia) cfg.provider.nvidia = {};
      if (!cfg.provider.nvidia.options) cfg.provider.nvidia.options = {};
      cfg.provider.nvidia.options.baseURL = `http://localhost:${actualProxyPort}`;
    },
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "Enter NVIDIA NIM API Key",
          async authorize(inputs) {
            const key = inputs?.["apiKey"];
            if (!key) return { type: "failed" };

            try {
              const res = await fetch(`${NIM_BASE_URL}/v1/models`, {
                headers: { Authorization: `Bearer ${key}` },
              });
              if (!res.ok) return { type: "failed" };
            } catch (err) {
              logDebug(
                `[nim-rotator] authorize fetch failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              return { type: "failed" };
            }

            return {
              type: "success",
              key,
              provider: PROVIDER_ID,
            };
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
      const state = getState(sessionID);
      const requestedModel = output.message.model ?? input.model;
      let activeChainKey = state.activeChainKey;
      let activeChainKeyStr = activeChainKey;

      if (!activeChainKeyStr || state.pendingRetryIndex === undefined) {
        if (!requestedModel) {
          cleanupSession(sessionID);
          return;
        }
        activeChainKeyStr = modelKey(requestedModel);
      }

      const chainIndex = findChainIndex(chain, requestedModel);
      if (chainIndex < 0 && state.pendingRetryIndex === undefined) {
        return;
      }

      let desiredIndex: number;
      if (state.pendingRetryIndex !== undefined) {
        desiredIndex = state.pendingRetryIndex;
      } else {
        // Check if first model's cooldown has expired and reset to it
        if (chain.length > 0) {
          const firstModel = chain[0];
          const cooldownExpiry = modelCooldowns.get(firstModel.id);
          if (cooldownExpiry !== undefined && Date.now() >= cooldownExpiry) {
            state.attemptIndex = 0;
            state.activeChainModelId = firstModel.id;
            modelCooldowns.delete(firstModel.id);
            desiredIndex = 0;
          } else {
            desiredIndex = chainIndex >= 0 ? chainIndex : 0;
          }
        } else {
          desiredIndex = chainIndex >= 0 ? chainIndex : 0;
        }
      }

      // Proactively skip models that are blacklisted for the current key
      const findNonBlacklistedModel = (startIndex: number): number => {
        for (let i = 0; i < chain.length; i++) {
          const idx = (startIndex + i) % chain.length;
          const model = chain[idx];
          if (!model) continue;
          const activeKeysForModel = getActiveKeys(store, model.id);
          if (activeKeysForModel.length > 0) {
            return idx;
          }
        }
        return startIndex; // fallback: use original
      };

      desiredIndex = findNonBlacklistedModel(desiredIndex);

      const target = chain[desiredIndex];
      if (!target) {
        cleanupSession(sessionID);
        return;
      }

      output.message.model = {
        providerID: PROVIDER_ID,
        modelID: target.id,
      };

      state.activeChainKey = activeChainKeyStr;
      state.activeChainModelId = target.id;
      state.attemptIndex = desiredIndex;
      state.lastUserMessageID = output.message.id;

      proxySessions.set(sessionID, {
        activeChainModelId: target.id,
        currentModelId: state.currentModelId,
      });
    },
    "shell.env": async (_input, _output) => {
      // API key rotation is now handled entirely by the proxy
    },
    event: async ({ event }) => {
      if (event.type === "session.error") {
        await handleSessionError(event as Record<string, unknown>);
        return;
      }

      if ((event.type as string) === "session.next.step.failed") {
        await handleSessionStepFailed(event as Record<string, unknown>);
        return;
      }

      if (event.type === "session.status") {
        const props = (event as Record<string, unknown>).properties as
          | Record<string, unknown>
          | undefined;
        const sessionID = props?.sessionID as string | undefined;
        const status = props?.status as Record<string, unknown> | undefined;
        const statusType = status?.type;

        if (statusType === "retry" && sessionID && status) {
          await handleSessionStatusRetry(sessionID, status);
          return;
        }

        if (statusType === "idle" && sessionID) {
          const state = getState(sessionID);
          if (state.inRetry) return;
          state.rateLimitCount = 0;
          state.pendingRetryIndex = undefined;
          state.lastFailedModelId = undefined;
          state.retryAttempt = 0;
          cleanupSession(sessionID);
          return;
        }
      }

      if (event.type === "session.deleted") {
        const sessionID = (
          (event.properties as Record<string, unknown>)?.info as Record<
            string,
            unknown
          >
        )?.id as string;
        if (sessionID) cleanupSession(sessionID);
      }
    },
  };

  return hooks;
};

export default NvidiaNimKeyRotator;

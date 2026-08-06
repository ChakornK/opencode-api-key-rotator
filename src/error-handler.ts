import {
  DEDUP_WINDOW_MS,
  NETWORK_ERROR_THRESHOLD,
  SERVER_ERROR_THRESHOLD,
} from "./constants.js";
import { logDebug } from "./logger.js";
import type { SessionManager } from "./session.js";
import {
  getCooldownExpiry,
  isModelAvailable,
  recordModelCooldown,
  resetPromotionFailures,
} from "./store.js";
import type {
  ErrorClass,
  ErrorEvent,
  FallbackModel,
  KeyStore,
  SessionState,
} from "./types.js";

/** Extracts HTTP status code from an error object. Returns undefined if not found. */
function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const rec = error as Record<string, unknown>;
  const data = rec.data as Record<string, unknown> | undefined;
  if (typeof data?.statusCode === "number") return data.statusCode;
  if (typeof data?.status === "number") return data.status;
  if (typeof rec.status === "number") return rec.status;
  if (typeof rec.statusCode === "number") return rec.statusCode;
  return undefined;
}

/** Extracts transport error code (ECONNREFUSED, ETIMEDOUT, etc.) from error. */
function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const rec = error as Record<string, unknown>;
  if (typeof rec.code === "string") return rec.code;
  const data = rec.data as Record<string, unknown> | undefined;
  if (typeof data?.code === "string") return data.code;
  return undefined;
}

/** Classifies an error into one of 7 categories. */
export function classifyError(error: unknown): ErrorClass {
  const status = extractStatusCode(error);
  const code = extractErrorCode(error);

  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 500 || status === 502 || status === 503 || status === 504)
    return "server_error";
  if (status === 408) return "timeout";

  if (status === 422) return "model_invalid";
  if (status === 400) {
    const msg = getErrorMessage(error);
    if (msg && /model.*(not found|invalid|unavailable)/i.test(msg))
      return "model_invalid";
  }

  if (code === "ETIMEDOUT" || code === "TIMEOUT") return "timeout";
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ENETUNREACH")
    return "network";
  if (code && /tls|ssl|cert/i.test(code)) return "network";

  // Check for timeout in message
  const msg = getErrorMessage(error);
  if (msg && /time\s*out|timed?\s*out/i.test(msg)) return "timeout";

  return "non_retryable";
}

function getErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const rec = error as Record<string, unknown>;
  const data = rec.data as Record<string, unknown> | undefined;
  if (typeof data?.message === "string") return data.message;
  if (typeof rec.message === "string") return rec.message;
  return undefined;
}

/** Computes dedup fingerprint for an error event. */
function computeFingerprint(event: ErrorEvent, session: SessionState): string {
  const status = extractStatusCode(event.error);
  const code = extractErrorCode(event.error);
  const identifier =
    status !== undefined ? String(status) : (code ?? "unknown");
  return `${event.source}:${identifier}:${session.currentModelId ?? "none"}`;
}

/**
 * Selects the earliest available model in the chain, skipping the current.
 * If all are on cooldown, picks the one expiring soonest.
 */
export function advanceToEarliestAvailable(
  store: KeyStore,
  session: SessionState,
  chain: FallbackModel[],
): number {
  // Prefer earliest (lowest index) available model
  for (let i = 0; i < chain.length; i++) {
    if (i === session.chainIndex) continue;
    if (isModelAvailable(store, chain[i].id)) return i;
  }
  // All on cooldown: pick soonest-expiring
  let bestIdx = (session.chainIndex + 1) % chain.length;
  let soonest = Infinity;
  for (let i = 0; i < chain.length; i++) {
    if (i === session.chainIndex) continue;
    const expiry = getCooldownExpiry(chain[i].id);
    if (expiry < soonest) {
      soonest = expiry;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Resolves the model for a chat.message. Promotes to the highest-priority
 * available model if one outranks the current session model.
 * Returns the chain index to use.
 */
export function resolveModel(
  store: KeyStore,
  session: SessionState,
  chain: FallbackModel[],
): number {
  if (session.phase === "retrying" || session.phase === "failing") {
    return session.chainIndex;
  }
  if (chain.length === 0) return session.chainIndex;

  // Scan from index 0 for earliest available
  for (let i = 0; i < chain.length; i++) {
    if (isModelAvailable(store, chain[i].id)) {
      if (i < session.chainIndex) {
        // Promote: higher-priority model is now available
        session.chainIndex = i;
        session.rateLimitCount = 0;
        session.serverErrorCount = 0;
        session.fallbacksTriggered = 0;
      }
      return i;
    }
  }
  // No model available — best effort with current
  return session.chainIndex;
}

export interface ErrorHandlerDeps {
  store: KeyStore;
  sessionManager: SessionManager;
  showToast: (variant: "info" | "warning" | "error", message: string) => void;
  abortSession: (sessionID: string) => Promise<void>;
  waitForIdle: (sessionID: string) => Promise<boolean>;
  promptSession: (
    sessionID: string,
    modelId: string,
    session: SessionState,
  ) => Promise<void>;
}

/** Handles a single error event. Classifies, deduplicates, and triggers fallback if needed. */
export async function handleError(
  event: ErrorEvent,
  deps: ErrorHandlerDeps,
): Promise<void> {
  const {
    store,
    sessionManager,
    showToast,
    abortSession,
    waitForIdle,
    promptSession,
  } = deps;
  const session = sessionManager.getIfExists(event.sessionID);
  if (!session?.currentModelId) return;

  // Phase guard
  if (session.phase === "retrying") return;

  // Fingerprint dedup
  const now = Date.now();
  const fingerprint = computeFingerprint(event, session);
  if (
    fingerprint === session.lastErrorFingerprint &&
    now - session.lastErrorAt < DEDUP_WINDOW_MS
  ) {
    return;
  }
  session.lastErrorFingerprint = fingerprint;
  session.lastErrorAt = now;

  // Classify
  const errorClass = classifyError(event.error);

  if (errorClass === "non_retryable") {
    // SessionStatus lacks statusCode, so 429 retries classify as non_retryable;
    // skip the reset to let the proxy-side counter accumulate
    if (event.source !== "session.status.retry") {
      session.rateLimitCount = 0;
    }
    return;
  }
  if (errorClass === "auth") return; // Proxy handles key disabling

  // Determine if fallback should trigger
  let shouldFallback = false;
  if (errorClass === "rate_limit") {
    session.rateLimitCount++;
    shouldFallback = session.rateLimitCount >= store.maxRateLimitFailures;
  } else if (errorClass === "server_error" || errorClass === "timeout") {
    session.serverErrorCount++;
    shouldFallback = session.serverErrorCount >= SERVER_ERROR_THRESHOLD;
  } else if (errorClass === "model_invalid") {
    shouldFallback = true;
  } else if (errorClass === "network") {
    session.serverErrorCount++;
    shouldFallback = session.serverErrorCount >= NETWORK_ERROR_THRESHOLD;
  }

  if (!shouldFallback) return;

  // Circuit breaker
  const chain = store.fallbackChain;
  if (chain.length < 2) return;
  if (session.fallbacksTriggered >= chain.length) {
    showToast("error", "All models exhausted. Try again later.");
    sessionManager.setPhase(event.sessionID, "idle");
    return;
  }

  // Advance to earliest available
  const nextIndex = advanceToEarliestAvailable(store, session, chain);
  session.fallbacksTriggered++;

  // Record cooldown on rate-limited model
  if (errorClass === "rate_limit") {
    recordModelCooldown(session.currentModelId);
  }

  const targetModel = chain[nextIndex];
  if (!targetModel) return;

  // Subagent path: advance without abort
  if (session.isSubagent) {
    session.chainIndex = nextIndex;
    session.currentModelId = targetModel.id;
    session.rateLimitCount = 0;
    session.serverErrorCount = 0;
    showToast("info", `Next turn: ${targetModel.name}`);
    return;
  }

  // Main session: toast → abort → wait idle → re-prompt
  if (!sessionManager.setPhase(event.sessionID, "retrying")) return;
  showToast("info", `Switching to ${targetModel.name}`);

  try {
    await abortSession(event.sessionID);
    const idle = await waitForIdle(event.sessionID);
    if (!idle) throw new Error("waitForIdle timed out");
    await promptSession(event.sessionID, targetModel.id, session);

    // Success
    session.chainIndex = nextIndex;
    session.currentModelId = targetModel.id;
    session.rateLimitCount = 0;
    session.serverErrorCount = 0;
    resetPromotionFailures(targetModel.id);
    sessionManager.setPhase(event.sessionID, "active");
  } catch (err) {
    logDebug(
      `triggerFallback failed for ${event.sessionID}: ${err instanceof Error ? err.message : String(err)}`,
    );
    sessionManager.setPhase(event.sessionID, "active");
    session.rateLimitCount = 0;
  }
}

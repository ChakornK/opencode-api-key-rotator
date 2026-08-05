/** Model cooldown base duration (30 minutes). Escalates 1.5× on repeated promotion failures. */
export const MODEL_COOLDOWN_BASE_MS = 1_800_000;

/** Maximum model cooldown (4 hours). */
export const MODEL_COOLDOWN_MAX_MS = 14_400_000;

/** Cooldown escalation factor applied on each consecutive promotion failure. */
export const COOLDOWN_ESCALATION_FACTOR = 1.5;

/** Error fingerprint deduplication window. */
export const DEDUP_WINDOW_MS = 100;

/** Per-key-per-model blacklist base duration (30 seconds). */
export const MODEL_BLACKLIST_BASE_DURATION_MS = 30_000;

/** Per-key-per-model blacklist maximum duration (1 hour). */
export const MODEL_BLACKLIST_MAX_DURATION_MS = 3_600_000;

/** Blacklist duration escalation factor on consecutive rate limits. */
export const BLACKLIST_ESCALATION_FACTOR = 1.5;

/** Streaming stall detection threshold — no data for this long triggers abort. */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/** Proxy connect timeout. */
export const CONNECT_TIMEOUT_MS = 30_000;

/** Maximum sessions tracked before LRU eviction. */
export const SESSION_MAP_MAX_SIZE = 500;

/** Grace count: consecutive server_error/timeout before triggering fallback. */
export const SERVER_ERROR_THRESHOLD = 2;

/** Grace count: consecutive network errors before triggering fallback. */
export const NETWORK_ERROR_THRESHOLD = 3;

/** Default maxRateLimitFailures if not configured. */
export const DEFAULT_MAX_RATE_LIMIT_FAILURES = 3;

/** File watcher debounce interval for external store changes. */
export const FILE_WATCHER_DEBOUNCE_MS = 300;

/** Benchmark spinner animation interval. */
export const SPINNER_INTERVAL_MS = 200;

/** Wait-for-idle timeout during fallback retry. */
export const WAIT_FOR_IDLE_TIMEOUT_MS = 5_000;

/** Maximum port retry attempts on EADDRINUSE. */
export const PORT_RETRY_ATTEMPTS = 5;

/** NVIDIA NIM API base URL. */
export const NIM_BASE_URL = "https://integrate.api.nvidia.com";

/** Provider ID for NVIDIA in OpenCode. */
export const PROVIDER_ID = "nvidia";

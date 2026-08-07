export type RotationStrategy = "round-robin" | "least-failures";

export type SessionPhase = "idle" | "active" | "failing" | "retrying";

export type ErrorClass =
  | "rate_limit"
  | "server_error"
  | "timeout"
  | "auth"
  | "model_invalid"
  | "network"
  | "non_retryable";

export type BenchmarkStatus =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export interface ModelBlacklistEntry {
  blacklistedUntil: number;
  nextDurationMs: number;
}

export interface ApiKeyEntry {
  id: string;
  name: string;
  key: string;
  createdAt: number;
  lastUsedAt?: number;
  rateLimitCount: number;
  enabled: boolean;
  modelBlacklist?: Record<string, ModelBlacklistEntry>;
}

export interface FallbackModel {
  id: string;
  name: string;
  benchmarkTtfb?: number;
  benchmarkTps?: number;
  benchmarkStatus?: BenchmarkStatus;
  benchmarkError?: string;
}

export interface KeyStore {
  keys: ApiKeyEntry[];
  rotationStrategy: RotationStrategy;
  updatedAt: number;
  lastUsedKeyId?: string;
  fallbackChain: FallbackModel[];
  maxRateLimitFailures: number;
  theme?: string;
}

export interface ExportedKey {
  name: string;
  key: string;
}

export interface ExportPayload {
  version: 1;
  exportedAt: number;
  keys: ExportedKey[];
}

export interface ImportResult {
  added: number;
  skipped: number;
  errors: string[];
  pendingKeys: ExportedKey[];
}

export interface KeyStoreConfig {
  storePath?: string;
  rotationStrategy?: RotationStrategy;
}

export interface SessionState {
  readonly isSubagent: boolean;
  phase: SessionPhase;
  chainIndex: number;
  rateLimitCount: number;
  serverErrorCount: number;
  currentModelId: string | undefined;
  lastUserMessageID: string | undefined;
  lastFailedModelId: string | undefined;
  retryAttempt: number;
  fallbacksTriggered: number;
  lastErrorFingerprint: string | undefined;
  lastErrorAt: number;
  createdAt: number;
  markedForDeletion: boolean;
}

export interface ErrorEvent {
  sessionID: string;
  error: unknown;
  source: "session.error" | "session.status.retry" | "session.next.step.failed";
}

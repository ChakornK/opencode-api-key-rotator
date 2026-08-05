import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type {
  ApiKeyEntry,
  ExportPayload,
  FallbackModel,
  ImportResult,
  KeyStore,
  KeyStoreConfig,
  ModelBlacklistEntry,
} from "./types.js";
import {
  DEFAULT_MAX_RATE_LIMIT_FAILURES,
  MODEL_BLACKLIST_BASE_DURATION_MS,
  MODEL_BLACKLIST_MAX_DURATION_MS,
  BLACKLIST_ESCALATION_FACTOR,
  MODEL_COOLDOWN_BASE_MS,
  MODEL_COOLDOWN_MAX_MS,
  COOLDOWN_ESCALATION_FACTOR,
} from "./constants.js";
import { logDebug } from "./logger.js";

const DEFAULT_STORE_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "nim-rotator-keys.json",
);

// Runtime-only model cooldown tracking (never persisted)
const modelCooldowns = new Map<string, number>();
const promotionFailureCounts = new Map<
  string,
  { count: number; lastFailedAt: number }
>();

/** Resolves the store file path from config, env, or default. */
export function resolveStorePath(config?: KeyStoreConfig): string {
  return (
    config?.storePath ??
    process.env.NIM_ROTATOR_STORE_PATH ??
    DEFAULT_STORE_PATH
  );
}

/** Returns a fresh default KeyStore. */
export function getDefaultStore(): KeyStore {
  return {
    keys: [],
    rotationStrategy: "round-robin",
    updatedAt: Date.now(),
    lastUsedKeyId: undefined,
    fallbackChain: [],
    maxRateLimitFailures: DEFAULT_MAX_RATE_LIMIT_FAILURES,
  };
}

/** Loads the store from disk. Migrates v1 format (currentIndex → lastUsedKeyId). Returns null on failure. */
export function loadStore(config?: KeyStoreConfig): KeyStore | null {
  const storePath = resolveStorePath(config);
  try {
    if (!existsSync(storePath)) return null;
    const raw = readFileSync(storePath, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return null;
    if (!Array.isArray(data.keys)) return null;

    // v1 migration
    if ("currentIndex" in data && typeof data.currentIndex === "number") {
      data.lastUsedKeyId = data.keys[data.currentIndex]?.id;
      delete data.currentIndex;
    }

    const store: KeyStore = {
      ...getDefaultStore(),
      ...data,
      keys: (data.keys as unknown[])
        .filter(
          (k): k is Record<string, unknown> =>
            k !== null && typeof k === "object",
        )
        .map((k) => ({
          id: typeof k.id === "string" ? k.id : crypto.randomUUID(),
          name: typeof k.name === "string" ? k.name : "unnamed",
          key: typeof k.key === "string" ? k.key : "",
          createdAt: typeof k.createdAt === "number" ? k.createdAt : Date.now(),
          lastUsedAt:
            typeof k.lastUsedAt === "number" ? k.lastUsedAt : undefined,
          rateLimitCount:
            typeof k.rateLimitCount === "number" ? k.rateLimitCount : 0,
          enabled: k.enabled !== false,
          modelBlacklist:
            k.modelBlacklist && typeof k.modelBlacklist === "object"
              ? (k.modelBlacklist as Record<string, ModelBlacklistEntry>)
              : undefined,
        }))
        .filter((k) => k.key) as ApiKeyEntry[],
      fallbackChain: Array.isArray(data.fallbackChain)
        ? (data.fallbackChain as unknown[]).filter(
            (m): m is FallbackModel =>
              m !== null && typeof m === "object" && !!(m as FallbackModel).id,
          )
        : [],
      maxRateLimitFailures:
        typeof data.maxRateLimitFailures === "number" &&
        data.maxRateLimitFailures >= 1
          ? data.maxRateLimitFailures
          : DEFAULT_MAX_RATE_LIMIT_FAILURES,
    };

    return store;
  } catch (err) {
    logDebug(
      `loadStore failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Saves the store with merge-on-save strategy. Acquires advisory lock (best-effort). */
export function saveStore(store: KeyStore, config?: KeyStoreConfig): void {
  const storePath = resolveStorePath(config);
  const lockPath = `${storePath}.lock`;
  let lockAcquired = false;

  // Best-effort advisory lock
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
    lockAcquired = true;
  } catch {
    // Proceed without lock if acquisition fails.
  }

  try {
    const disk = loadStore(config);
    let toWrite: KeyStore;

    if (disk) {
      // Merge: disk wins structure, runtime wins volatile
      toWrite = {
        ...disk,
        lastUsedKeyId: store.lastUsedKeyId,
        updatedAt: Date.now(),
      };
      // Merge per-key runtime state
      for (const memKey of store.keys) {
        const diskKey = toWrite.keys.find((k) => k.id === memKey.id);
        if (diskKey) {
          diskKey.rateLimitCount = memKey.rateLimitCount;
          diskKey.lastUsedAt = memKey.lastUsedAt;
          diskKey.modelBlacklist = memKey.modelBlacklist;
        }
      }
      // Validate lastUsedKeyId
      if (
        toWrite.lastUsedKeyId &&
        !toWrite.keys.some((k) => k.id === toWrite.lastUsedKeyId)
      ) {
        toWrite.lastUsedKeyId = undefined;
      }
    } else {
      toWrite = { ...store, updatedAt: Date.now() };
    }

    // Sanitize transient benchmark state
    for (const model of toWrite.fallbackChain) {
      if (model.benchmarkStatus === "running") {
        model.benchmarkStatus = "idle";
      }
    }

    // Atomic write
    const dir = dirname(storePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${storePath}.tmp.${crypto.randomUUID()}`;
    try {
      writeFileSync(tmpPath, `${JSON.stringify(toWrite, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(tmpPath, storePath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort */
      }
      throw err;
    }
  } finally {
    if (lockAcquired) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Adds a new API key entry to the store. */
export function addKey(store: KeyStore, name: string, key: string): void {
  store.keys.push({
    id: crypto.randomUUID(),
    name,
    key,
    createdAt: Date.now(),
    rateLimitCount: 0,
    enabled: true,
  });
}

/** Removes a key by ID. Clears lastUsedKeyId if it pointed to the removed key. */
export function removeKey(store: KeyStore, id: string): void {
  const idx = store.keys.findIndex((k) => k.id === id);
  if (idx === -1) return;
  store.keys.splice(idx, 1);
  if (store.lastUsedKeyId === id) store.lastUsedKeyId = undefined;
}

/** Renames a key. */
export function renameKey(store: KeyStore, id: string, newName: string): void {
  const entry = store.keys.find((k) => k.id === id);
  if (entry) entry.name = newName;
}

/** Toggles a key's enabled state. */
export function toggleKey(
  store: KeyStore,
  id: string,
  enabled?: boolean,
): void {
  const entry = store.keys.find((k) => k.id === id);
  if (entry) entry.enabled = enabled ?? !entry.enabled;
}

/** Resets rateLimitCount and clears modelBlacklist for one or all keys. */
export function resetFailures(store: KeyStore, keyId?: string): void {
  const reset = (e: ApiKeyEntry) => {
    e.rateLimitCount = 0;
    delete e.modelBlacklist;
  };
  if (keyId) {
    const entry = store.keys.find((k) => k.id === keyId);
    if (entry) reset(entry);
  } else {
    for (const k of store.keys) reset(k);
  }
}

/** Returns enabled keys not blacklisted for the given model. */
export function getActiveKeys(
  store: KeyStore,
  modelId?: string,
): ApiKeyEntry[] {
  const now = Date.now();
  return store.keys.filter((k) => {
    if (!k.enabled) return false;
    if (modelId && k.modelBlacklist) {
      const slot = k.modelBlacklist[modelId];
      if (slot && slot.blacklistedUntil > now) return false;
    }
    return true;
  });
}

/** Selects the next key via configured strategy. Updates lastUsedKeyId and lastUsedAt in memory. */
export function getNextKey(
  store: KeyStore,
  config?: KeyStoreConfig,
  modelId?: string,
): { key: ApiKeyEntry } | null {
  const active = getActiveKeys(store, modelId);
  if (active.length === 0) return null;

  const strategy =
    config?.rotationStrategy ?? store.rotationStrategy ?? "round-robin";

  if (strategy === "least-failures") {
    const sorted = [...active].sort(
      (a, b) => a.rateLimitCount - b.rateLimitCount,
    );
    const best = sorted[0];
    store.lastUsedKeyId = best.id;
    best.lastUsedAt = Date.now();
    return { key: best };
  }

  // Round-robin via lastUsedKeyId cursor
  const lastIdx = active.findIndex((k) => k.id === store.lastUsedKeyId);
  const nextIdx = (lastIdx + 1) % active.length;
  const selected = active[nextIdx];
  store.lastUsedKeyId = selected.id;
  selected.lastUsedAt = Date.now();
  return { key: selected };
}

/** Increments rateLimitCount for a key. */
export function recordRateLimit(store: KeyStore, keyId: string): void {
  const entry = store.keys.find((k) => k.id === keyId);
  if (entry) entry.rateLimitCount++;
}

/** Blacklists a key for a model with escalating duration (1.5×, capped at 1 hour). */
export function recordModelRateLimit(
  store: KeyStore,
  keyId: string,
  modelId: string,
  now: number = Date.now(),
): void {
  const entry = store.keys.find((k) => k.id === keyId);
  if (!entry) return;
  if (!entry.modelBlacklist) entry.modelBlacklist = {};
  const slot = entry.modelBlacklist[modelId];
  const prevDuration = slot?.nextDurationMs ?? MODEL_BLACKLIST_BASE_DURATION_MS;
  const duration = Math.min(prevDuration, MODEL_BLACKLIST_MAX_DURATION_MS);
  entry.modelBlacklist[modelId] = {
    blacklistedUntil: now + duration,
    nextDurationMs: Math.min(
      duration * BLACKLIST_ESCALATION_FACTOR,
      MODEL_BLACKLIST_MAX_DURATION_MS,
    ),
  };
}

/** Halves blacklist nextDurationMs on successful use. Floors at base duration. */
export function recordSuccess(
  store: KeyStore,
  keyId: string,
  modelId: string,
): void {
  const entry = store.keys.find((k) => k.id === keyId);
  if (!entry?.modelBlacklist?.[modelId]) return;
  const slot = entry.modelBlacklist[modelId];
  slot.nextDurationMs = Math.max(
    MODEL_BLACKLIST_BASE_DURATION_MS,
    Math.floor(slot.nextDurationMs / 2),
  );
  // Remove entry entirely if expired and at base
  if (
    slot.blacklistedUntil <= Date.now() &&
    slot.nextDurationMs <= MODEL_BLACKLIST_BASE_DURATION_MS
  ) {
    delete entry.modelBlacklist[modelId];
    if (Object.keys(entry.modelBlacklist).length === 0)
      delete entry.modelBlacklist;
  }
}

/** Removes a blacklist entry for a key-model pair. */
export function clearModelBlacklist(
  store: KeyStore,
  keyId: string,
  modelId: string,
): void {
  const entry = store.keys.find((k) => k.id === keyId);
  if (!entry?.modelBlacklist) return;
  delete entry.modelBlacklist[modelId];
  if (Object.keys(entry.modelBlacklist).length === 0)
    delete entry.modelBlacklist;
}

/** Records a model cooldown with escalation on repeated promotion failures. */
export function recordModelCooldown(modelId: string): void {
  const pf = promotionFailureCounts.get(modelId) ?? {
    count: 0,
    lastFailedAt: 0,
  };
  const now = Date.now();
  // Escalate if failed again within 2× the last cooldown window
  if (now - pf.lastFailedAt < MODEL_COOLDOWN_BASE_MS * 2) {
    pf.count++;
  } else {
    pf.count = 1;
  }
  pf.lastFailedAt = now;
  promotionFailureCounts.set(modelId, pf);

  const cooldown = Math.min(
    MODEL_COOLDOWN_BASE_MS * COOLDOWN_ESCALATION_FACTOR ** (pf.count - 1),
    MODEL_COOLDOWN_MAX_MS,
  );
  modelCooldowns.set(modelId, now + cooldown);
}

/** Returns the cooldown expiry timestamp for a model, or 0 if not on cooldown. */
export function getCooldownExpiry(modelId: string): number {
  const expiry = modelCooldowns.get(modelId);
  if (!expiry || expiry <= Date.now()) {
    modelCooldowns.delete(modelId);
    return 0;
  }
  return expiry;
}

/** Returns true if the model is not on cooldown and has at least one active key. */
export function isModelAvailable(store: KeyStore, modelId: string): boolean {
  if (getCooldownExpiry(modelId) > 0) return false;
  return getActiveKeys(store, modelId).length > 0;
}

/** Resets promotion failure counter for a model (call after successful completion on promoted model). */
export function resetPromotionFailures(modelId: string): void {
  promotionFailureCounts.delete(modelId);
}

/** Creates an export payload from the store's keys. */
export function exportKeys(store: KeyStore): ExportPayload {
  return {
    version: 1,
    exportedAt: Date.now(),
    keys: store.keys.map((k) => ({ name: k.name, key: k.key })),
  };
}

/** Validates and imports keys from a raw JSON string. */
export function importKeys(store: KeyStore, raw: string): ImportResult {
  const result: ImportResult = {
    added: 0,
    skipped: 0,
    errors: [],
    pendingKeys: [],
  };
  if (raw.length > 1024 * 1024) {
    result.errors.push("Import file too large (max 1MB)");
    return result;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    result.errors.push("Invalid JSON format");
    return result;
  }
  if (typeof data !== "object" || data === null) {
    result.errors.push("Expected a JSON object");
    return result;
  }
  const rec = data as Record<string, unknown>;
  if (rec.version !== 1) {
    result.errors.push("Unsupported export version");
    return result;
  }
  if (!Array.isArray(rec.keys)) {
    result.errors.push("Missing 'keys' array");
    return result;
  }

  for (const entry of rec.keys) {
    if (result.pendingKeys.length >= 100) {
      result.errors.push("Too many keys (max 100)");
      break;
    }
    if (!entry || typeof entry !== "object") {
      result.errors.push("Invalid key entry");
      continue;
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const key = typeof e.key === "string" ? e.key.trim() : "";
    if (!name || !key) {
      result.errors.push("Empty name or key");
      continue;
    }
    if (!key.startsWith("nvapi-")) {
      result.errors.push(`Key "${name}" missing nvapi- prefix`);
      continue;
    }
    result.pendingKeys.push({ name, key });
  }

  // Apply
  for (const { name, key } of result.pendingKeys) {
    if (store.keys.some((k) => k.name === name || k.key === key)) {
      result.skipped++;
    } else {
      addKey(store, name, key);
      result.added++;
    }
  }
  return result;
}

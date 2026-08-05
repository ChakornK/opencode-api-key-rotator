// Compatibility shim: re-exports store functions under old names for TUI code.
// The TUI screens/UI code imports from this file. Will be removed once TUI is fully migrated.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import type {
  ApiKeyEntry,
  ExportedKey,
  ExportPayload,
  KeyStore,
  KeyStoreConfig,
  ImportResult,
} from "./types.js";
import { DEFAULT_MAX_RATE_LIMIT_FAILURES } from "./constants.js";

const DEFAULT_STORE_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "nim-rotator-keys.json",
);

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

export function resolveStorePath(config?: KeyStoreConfig): string {
  return (
    config?.storePath ??
    process.env.NIM_ROTATOR_STORE_PATH ??
    DEFAULT_STORE_PATH
  );
}

export function loadStore(config?: KeyStoreConfig): KeyStore | null {
  const storePath = resolveStorePath(config);
  try {
    if (existsSync(storePath)) {
      const raw = readFileSync(storePath, "utf-8");
      const data = JSON.parse(raw);
      if (typeof data !== "object" || data === null) return null;
      const store = data as KeyStore;
      if (!store.keys || !Array.isArray(store.keys)) return null;

      // v1 migration: derive lastUsedKeyId from currentIndex
      if ("currentIndex" in data && typeof data.currentIndex === "number") {
        store.lastUsedKeyId = store.keys[data.currentIndex]?.id;
        delete (data as Record<string, unknown>).currentIndex;
      }

      return {
        ...getDefaultStore(),
        ...store,
        keys: Array.isArray(store.keys)
          ? (store.keys.filter(
              (k) => k !== null && typeof k === "object",
            ) as ApiKeyEntry[])
          : [],
        fallbackChain: Array.isArray(store.fallbackChain)
          ? store.fallbackChain.filter(
              (m) => m && typeof m === "object" && m.id,
            )
          : [],
        maxRateLimitFailures:
          typeof store.maxRateLimitFailures === "number" &&
          store.maxRateLimitFailures >= 1
            ? store.maxRateLimitFailures
            : DEFAULT_MAX_RATE_LIMIT_FAILURES,
      };
    }
  } catch {
    // Returns null on any parse/read failure.
  }
  return null;
}

export function saveStore(store: KeyStore, config?: KeyStoreConfig): void {
  const storePath = resolveStorePath(config);
  const dir = dirname(storePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  store.updatedAt = Date.now();

  // Sanitize transient benchmark state before writing
  for (const model of store.fallbackChain) {
    if (model.benchmarkStatus === "running") {
      model.benchmarkStatus = "idle";
    }
  }

  const tmpPath = storePath + ".tmp." + crypto.randomUUID();
  try {
    writeFileSync(tmpPath, JSON.stringify(store, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(tmpPath, storePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup of temp file.
    }
    throw err;
  }
}

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

export function removeKey(store: KeyStore, id: string): void {
  const index = store.keys.findIndex((k) => k.id === id);
  if (index === -1) return;
  store.keys.splice(index, 1);
  if (store.lastUsedKeyId === id) {
    store.lastUsedKeyId = undefined;
  }
}

export function renameKey(store: KeyStore, id: string, newName: string): void {
  const entry = store.keys.find((k) => k.id === id);
  if (entry) entry.name = newName;
}

export function toggleKey(
  store: KeyStore,
  id: string,
  enabled?: boolean,
): void {
  const entry = store.keys.find((k) => k.id === id);
  if (entry) entry.enabled = enabled ?? !entry.enabled;
}

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

export function getNextKey(
  store: KeyStore,
  config?: KeyStoreConfig,
  modelId?: string,
): { key: ApiKeyEntry; index: number } | null {
  const active = getActiveKeys(store, modelId);
  if (active.length === 0) return null;

  const strategy =
    config?.rotationStrategy ?? store.rotationStrategy ?? "round-robin";

  if (strategy === "least-failures") {
    const sorted = [...active].sort((a, b) => {
      if (a.rateLimitCount !== b.rateLimitCount)
        return a.rateLimitCount - b.rateLimitCount;
      return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0);
    });
    const best = sorted[0];
    const realIdx = store.keys.indexOf(best);
    store.lastUsedKeyId = best.id;
    best.lastUsedAt = Date.now();
    return { key: best, index: realIdx };
  }

  // Round-robin via lastUsedKeyId cursor
  const lastIdx = active.findIndex((k) => k.id === store.lastUsedKeyId);
  const nextIdx = (lastIdx + 1) % active.length;
  const selected = active[nextIdx];
  const realIdx = store.keys.indexOf(selected);
  store.lastUsedKeyId = selected.id;
  selected.lastUsedAt = Date.now();
  return { key: selected, index: realIdx };
}

export function resetFailures(store: KeyStore, keyId?: string): void {
  if (keyId) {
    const entry = store.keys.find((k) => k.id === keyId);
    if (entry) {
      entry.rateLimitCount = 0;
      delete entry.modelBlacklist;
    }
  } else {
    for (const k of store.keys) {
      k.rateLimitCount = 0;
      delete k.modelBlacklist;
    }
  }
}

export function recordRateLimit(store: KeyStore, keyId: string): void {
  const entry = store.keys.find((k) => k.id === keyId);
  if (entry) entry.rateLimitCount++;
}

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
  const base = 30_000;
  const max = 3_600_000;
  const factor = 1.5;
  const previousNext = slot?.nextDurationMs ?? base;
  const duration = Math.min(previousNext, max);
  entry.modelBlacklist[modelId] = {
    blacklistedUntil: now + duration,
    nextDurationMs: Math.min(duration * factor, max),
  };
}

export function exportKeys(store: KeyStore): ExportPayload {
  return {
    version: 1,
    exportedAt: Date.now(),
    keys: store.keys.map((k) => ({ name: k.name, key: k.key })),
  };
}

export function validateExportPath(filePath: string): string | null {
  const resolved = resolve(filePath);
  const blocked = ["/etc/", "/proc/", "/sys/", "/dev/"];
  for (const prefix of blocked) {
    if (resolved.startsWith(prefix))
      return "Cannot write to system directories";
  }
  return null;
}

export function writeExportFile(
  payload: ExportPayload,
  filePath: string,
): void {
  const pathError = validateExportPath(filePath);
  if (pathError) throw new Error(pathError);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = filePath + ".tmp." + crypto.randomUUID();
  try {
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup.
    }
    throw err;
  }
}

export function readAndValidateImportFile(
  filePath: string,
): { raw: string } | { error: string } {
  const resolved = resolve(filePath);
  const blocked = ["/etc/", "/proc/", "/sys/", "/dev/"];
  for (const prefix of blocked) {
    if (resolved.startsWith(prefix))
      return { error: "Cannot read from system directories" };
  }
  try {
    return { raw: readFileSync(resolved, "utf-8") };
  } catch {
    return { error: "Cannot read file" };
  }
}

export function validateImportPayload(raw: string): ImportResult {
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
    result.errors.push("Missing or invalid 'keys' array");
    return result;
  }
  for (const entry of rec.keys) {
    if (result.pendingKeys.length >= 100) {
      result.errors.push("Too many keys in import file (max 100)");
      break;
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>).name !== "string" ||
      typeof (entry as Record<string, unknown>).key !== "string"
    ) {
      result.errors.push("Invalid key entry");
      continue;
    }
    const name = ((entry as Record<string, unknown>).name as string).trim();
    const key = ((entry as Record<string, unknown>).key as string).trim();
    if (!name || !key) {
      result.errors.push("Key entry has empty name or key");
      continue;
    }
    if (!key.startsWith("nvapi-")) {
      result.errors.push(`Key "${name}" does not start with 'nvapi-'`);
      continue;
    }
    result.pendingKeys.push({ name, key });
  }
  return result;
}

export function applyImport(
  store: KeyStore,
  pendingKeys: ExportedKey[],
): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  for (const { name, key } of pendingKeys) {
    if (store.keys.find((k) => k.name === name || k.key === key)) {
      skipped++;
      continue;
    }
    addKey(store, name, key);
    added++;
  }
  return { added, skipped };
}

export type { ImportResult };

// Compatibility shim: re-exports store functions for TUI code that imports from "../storage.js".
// The TUI screens/UI use these exports. Once TUI is fully migrated, this file can be deleted.

export {
  resolveStorePath,
  getDefaultStore,
  loadStore,
  saveStore,
  addKey,
  removeKey,
  renameKey,
  toggleKey,
  resetFailures,
  getActiveKeys,
  getNextKey,
  recordRateLimit,
  recordModelRateLimit,
  exportKeys,
  importKeys,
} from "./store.js";

export type { ImportResult } from "./types.js";

// TUI-only file I/O helpers (not in store.ts because they deal with arbitrary user paths)

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExportPayload, ExportedKey } from "./types.js";

const SYSTEM_PATH_PREFIXES = ["/etc/", "/proc/", "/sys/", "/dev/"];

/** Validates an export file path against blocked system prefixes. */
export function validateExportPath(filePath: string): string | null {
  const resolved = resolve(filePath);
  for (const prefix of SYSTEM_PATH_PREFIXES) {
    if (resolved.startsWith(prefix))
      return "Cannot write to system directories";
  }
  return null;
}

/** Writes an export payload to a user-specified file path. */
export function writeExportFile(
  payload: ExportPayload,
  filePath: string,
): void {
  const pathError = validateExportPath(filePath);
  if (pathError) throw new Error(pathError);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp.${crypto.randomUUID()}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/** Reads and validates an import file from a user-specified path. */
export function readAndValidateImportFile(
  filePath: string,
): { raw: string } | { error: string } {
  const resolved = resolve(filePath);
  for (const prefix of SYSTEM_PATH_PREFIXES) {
    if (resolved.startsWith(prefix))
      return { error: "Cannot read from system directories" };
  }
  try {
    return { raw: readFileSync(resolved, "utf-8") };
  } catch {
    return { error: "Cannot read file" };
  }
}

/** Validates import payload structure and returns pending keys. */
export function validateImportPayload(raw: string): {
  added: number;
  skipped: number;
  errors: string[];
  pendingKeys: ExportedKey[];
} {
  const result: {
    added: number;
    skipped: number;
    errors: string[];
    pendingKeys: ExportedKey[];
  } = {
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
  return result;
}

/** Applies validated import keys to the store. */
export function applyImport(
  store: import("./types.js").KeyStore,
  pendingKeys: ExportedKey[],
): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  for (const { name, key } of pendingKeys) {
    if (store.keys.some((k) => k.name === name || k.key === key)) {
      skipped++;
    } else {
      store.keys.push({
        id: crypto.randomUUID(),
        name,
        key,
        createdAt: Date.now(),
        rateLimitCount: 0,
        enabled: true,
      });
      added++;
    }
  }
  return { added, skipped };
}

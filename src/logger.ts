import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEBUG_LOG_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "nim-rotator-debug.log",
);

let dirEnsured = false;

/** Appends a timestamped debug line to the log file. Never throws. */
export function logDebug(message: string): void {
  try {
    if (!dirEnsured) {
      const dir = dirname(DEBUG_LOG_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      dirEnsured = true;
    }
    const timestamp = new Date().toISOString();
    appendFileSync(DEBUG_LOG_PATH, `[${timestamp}] ${message}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Silently ignores write failures to avoid disrupting the plugin.
  }
}

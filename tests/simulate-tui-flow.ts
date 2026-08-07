/**
 * Simulates the user's exact flow:
 * 1. Load store (like TUI startup)
 * 2. Remove a model from fallback chain
 * 3. Save (like pressing "x" in TUI)
 * 4. Reload from disk (like Ctrl+C then reopening)
 * 5. Check if removal persisted
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { loadStore, resolveStorePath, saveStore } from "../src/store.js";
import type { FallbackModel, KeyStore } from "../src/types.js";

const TEST_STORE = "/tmp/opencode/tui-sim/store.json";
const TEST_DIR = "/tmp/opencode/tui-sim";

// Clean slate
if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
mkdirSync(TEST_DIR, { recursive: true });

// Seed a store with 3 models (like the user has)
const initialStore: KeyStore = {
  keys: [
    {
      id: "k1",
      name: "my-key",
      key: "nvapi-test",
      createdAt: 1,
      rateLimitCount: 0,
      enabled: true,
    },
  ],
  rotationStrategy: "round-robin",
  updatedAt: Date.now(),
  lastUsedKeyId: "k1",
  fallbackChain: [
    { id: "deepseek-ai/deepseek-r1", name: "DeepSeek R1" },
    { id: "deepseek-ai/deepseek-pro", name: "DeepSeek Pro" },
    { id: "meta/llama-3.1-8b-instruct", name: "Llama 3.1 8B" },
  ],
  maxRateLimitFailures: 3,
};
writeFileSync(TEST_STORE, JSON.stringify(initialStore, null, 2));
console.log("=== Initial store written (3 models) ===");

// --- Step 1: TUI loads store (like state.ts initialization) ---
const tuiStore = loadStore({ storePath: TEST_STORE });
if (!tuiStore) throw new Error("Failed to load store");
console.log(`TUI loaded: ${tuiStore.fallbackChain.length} models`);
console.log(`  Models: ${tuiStore.fallbackChain.map((m) => m.id).join(", ")}`);

// --- Step 2: User presses "x" to remove DeepSeek Pro ---
const removeIdx = tuiStore.fallbackChain.findIndex(
  (m) => m.id === "deepseek-ai/deepseek-pro",
);
console.log(
  `\n=== Removing model at index ${removeIdx}: ${tuiStore.fallbackChain[removeIdx].name} ===`,
);
tuiStore.fallbackChain.splice(removeIdx, 1);
console.log(
  `In-memory chain after splice: ${tuiStore.fallbackChain.length} models`,
);
console.log(`  Models: ${tuiStore.fallbackChain.map((m) => m.id).join(", ")}`);

// --- Step 3: safeSaveStore() (TUI calls with ownsFallbackChain=true) ---
console.log("\n=== Calling saveStore(tuiStore, config, true) ===");
saveStore(tuiStore, { storePath: TEST_STORE }, true);

// Inspect what's on disk
const diskAfterSave = readFileSync(TEST_STORE, "utf-8");
const parsed = JSON.parse(diskAfterSave);
console.log(`Disk after save: ${parsed.fallbackChain.length} models`);
console.log(
  `  Models: ${parsed.fallbackChain.map((m: any) => m.id).join(", ")}`,
);

// --- Step 4: Simulate Ctrl+C then reopen (reload from disk) ---
console.log("\n=== Simulating app restart: loadStore() ===");
const reloaded = loadStore({ storePath: TEST_STORE });
if (!reloaded) throw new Error("Failed to reload store");
console.log(`Reloaded: ${reloaded.fallbackChain.length} models`);
console.log(`  Models: ${reloaded.fallbackChain.map((m) => m.id).join(", ")}`);

// --- Step 5: Verify ---
const proStillThere = reloaded.fallbackChain.some(
  (m) => m.id === "deepseek-ai/deepseek-pro",
);
if (proStillThere) {
  console.log(
    "\n❌ BUG: DeepSeek Pro is STILL in the chain after removal + save + reload!",
  );
  process.exit(1);
} else {
  console.log(
    "\n✅ DeepSeek Pro correctly removed and stays removed after reload.",
  );
}

// --- Step 6: Simulate file watcher triggering refreshStore after the save ---
console.log(
  "\n=== Simulating file watcher: refreshStore() replaces state.store ===",
);
// refreshStore does: state.store = loadStore()
const refreshed = loadStore({ storePath: TEST_STORE });
if (!refreshed) throw new Error("Failed to reload for refresh");
// This is what the TUI's state.store becomes after file watcher fires
console.log(`After refreshStore: ${refreshed.fallbackChain.length} models`);
console.log(`  Models: ${refreshed.fallbackChain.map((m) => m.id).join(", ")}`);

// Now simulate another save from this refreshed state (e.g., Ctrl+C handler)
console.log("\n=== Simulating Ctrl+C: cancelBenchmark() → safeSaveStore() ===");
saveStore(refreshed, { storePath: TEST_STORE }, true);

const afterCtrlC = loadStore({ storePath: TEST_STORE });
if (!afterCtrlC) throw new Error("Failed to load after Ctrl+C save");
console.log(`After Ctrl+C save: ${afterCtrlC.fallbackChain.length} models`);
console.log(
  `  Models: ${afterCtrlC.fallbackChain.map((m) => m.id).join(", ")}`,
);

const proAfterCtrlC = afterCtrlC.fallbackChain.some(
  (m) => m.id === "deepseek-ai/deepseek-pro",
);
if (proAfterCtrlC) {
  console.log(
    "\n❌ BUG: DeepSeek Pro came back after refreshStore + Ctrl+C save!",
  );
  process.exit(1);
} else {
  console.log("\n✅ Ctrl+C save after refreshStore still correct.");
}

// --- Step 7: Simulate plugin saving with stale store (the race condition) ---
console.log(
  "\n=== Simulating plugin save with stale store (ownsFallbackChain=false) ===",
);
const pluginStaleStore: KeyStore = {
  ...initialStore, // plugin's copy still has all 3 models!
};
saveStore(pluginStaleStore, { storePath: TEST_STORE }); // default: ownsFallbackChain=false

const afterPluginSave = loadStore({ storePath: TEST_STORE });
if (!afterPluginSave) throw new Error("Failed to load after plugin save");
console.log(
  `After plugin save: ${afterPluginSave.fallbackChain.length} models`,
);
console.log(
  `  Models: ${afterPluginSave.fallbackChain.map((m) => m.id).join(", ")}`,
);

const proBackAfterPlugin = afterPluginSave.fallbackChain.some(
  (m) => m.id === "deepseek-ai/deepseek-pro",
);
if (proBackAfterPlugin) {
  console.log("\n❌ BUG: Plugin save re-added DeepSeek Pro!");
  process.exit(1);
} else {
  console.log(
    "\n✅ Plugin save did NOT re-add DeepSeek Pro. Disk's chain preserved.",
  );
}

// Cleanup
rmSync(TEST_DIR, { recursive: true });
console.log("\nAll checks passed.");

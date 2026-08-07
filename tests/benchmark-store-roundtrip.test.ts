import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadStore, saveStore } from "../src/store.js";
import type { FallbackModel, KeyStore } from "../src/types.js";

const TEST_DIR = "/tmp/opencode/benchmark-save-test";
const TEST_STORE_PATH = `${TEST_DIR}/store.json`;

function makeStore(fallbackChain: FallbackModel[]): KeyStore {
  return {
    keys: [
      {
        id: "k1",
        name: "test",
        key: "nvapi-xxx",
        createdAt: 1,
        rateLimitCount: 0,
        enabled: true,
      },
    ],
    rotationStrategy: "round-robin",
    updatedAt: Date.now(),
    lastUsedKeyId: "k1",
    fallbackChain,
    maxRateLimitFailures: 3,
  };
}

describe("Store save/load round-trip for benchmark results", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("cancelled benchmark metrics survive save and reload", () => {
    const model: FallbackModel = {
      id: "model-1",
      name: "Test Model",
      benchmarkStatus: "cancelled",
      benchmarkTtfb: 850,
      benchmarkTps: 42.5,
    };
    const store = makeStore([model]);

    // First save (no prior disk version)
    saveStore(store, { storePath: TEST_STORE_PATH });

    // Verify it's on disk
    const raw = readFileSync(TEST_STORE_PATH, "utf-8");
    const onDisk = JSON.parse(raw);
    expect(onDisk.fallbackChain[0].benchmarkStatus).toBe("cancelled");
    expect(onDisk.fallbackChain[0].benchmarkTtfb).toBe(850);
    expect(onDisk.fallbackChain[0].benchmarkTps).toBe(42.5);

    // Load back
    const loaded = loadStore({ storePath: TEST_STORE_PATH });
    expect(loaded).not.toBeNull();
    expect(loaded!.fallbackChain[0].benchmarkStatus).toBe("cancelled");
    expect(loaded!.fallbackChain[0].benchmarkTtfb).toBe(850);
    expect(loaded!.fallbackChain[0].benchmarkTps).toBe(42.5);
  });

  test("second save with disk existing preserves in-memory benchmark results", () => {
    // Simulate: disk has model without benchmark results
    const initialStore = makeStore([{ id: "model-1", name: "Test Model" }]);
    saveStore(initialStore, { storePath: TEST_STORE_PATH });

    // Now memory has benchmark results
    const updatedStore = makeStore([
      {
        id: "model-1",
        name: "Test Model",
        benchmarkStatus: "cancelled",
        benchmarkTtfb: 1200,
        benchmarkTps: 35.0,
      },
    ]);

    // Second save — merge-on-save path (disk exists), TUI owns fallback chain
    saveStore(updatedStore, { storePath: TEST_STORE_PATH }, true);

    // Reload and verify
    const loaded = loadStore({ storePath: TEST_STORE_PATH });
    expect(loaded!.fallbackChain[0].benchmarkStatus).toBe("cancelled");
    expect(loaded!.fallbackChain[0].benchmarkTtfb).toBe(1200);
    expect(loaded!.fallbackChain[0].benchmarkTps).toBe(35.0);
  });

  test("adding a model to fallback chain persists through save", () => {
    // Disk has one model
    const initialStore = makeStore([{ id: "model-1", name: "Model A" }]);
    saveStore(initialStore, { storePath: TEST_STORE_PATH });

    // Memory has two models (user added one)
    const updatedStore = makeStore([
      { id: "model-1", name: "Model A" },
      { id: "model-2", name: "Model B" },
    ]);
    saveStore(updatedStore, { storePath: TEST_STORE_PATH }, true);

    const loaded = loadStore({ storePath: TEST_STORE_PATH });
    expect(loaded!.fallbackChain).toHaveLength(2);
    expect(loaded!.fallbackChain[1].id).toBe("model-2");
  });

  test("removing a model from fallback chain persists through save", () => {
    // Disk has two models
    const initialStore = makeStore([
      { id: "model-1", name: "Model A" },
      { id: "model-2", name: "Model B" },
    ]);
    saveStore(initialStore, { storePath: TEST_STORE_PATH });

    // Memory removed model-2
    const updatedStore = makeStore([{ id: "model-1", name: "Model A" }]);
    saveStore(updatedStore, { storePath: TEST_STORE_PATH }, true);

    const loaded = loadStore({ storePath: TEST_STORE_PATH });
    expect(loaded!.fallbackChain).toHaveLength(1);
    expect(loaded!.fallbackChain[0].id).toBe("model-1");
  });

  test("sanitize step does not mutate the passed-in store object", () => {
    // Disk exists
    const initial = makeStore([
      {
        id: "m1",
        name: "X",
        benchmarkStatus: "done",
        benchmarkTtfb: 100,
        benchmarkTps: 50,
      },
    ]);
    saveStore(initial, { storePath: TEST_STORE_PATH });

    // Memory has a model with "running" status
    const running: FallbackModel = {
      id: "m1",
      name: "X",
      benchmarkStatus: "running",
    };
    const memStore = makeStore([running]);
    saveStore(memStore, { storePath: TEST_STORE_PATH }, true);

    // The sanitize step should NOT mutate the original in-memory model
    expect(running.benchmarkStatus).toBe("running");
  });
});

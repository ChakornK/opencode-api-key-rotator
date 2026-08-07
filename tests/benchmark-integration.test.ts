import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loadStore, saveStore } from "../src/store.js";
import { BenchmarkRunner } from "../src/tui/benchmark.js";
import type { FallbackModel, KeyStore } from "../src/types.js";

// Stub state module
mock.module("../src/tui/state.js", () => ({
  state: { benchmarkRunners: new Map(), currentScreen: "fallback-chain" },
  callRenderApp: () => {},
}));

const TEST_DIR = "/tmp/opencode/benchmark-integration-test";
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

describe("Full cancel → save → reload integration", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("cancel mid-stream: metrics survive save → load → save cycle", async () => {
    // Set up initial store on disk (model with no benchmark data)
    const model: FallbackModel = { id: "m1", name: "Model" };
    const store = makeStore([model]);
    saveStore(store, { storePath: TEST_STORE_PATH });

    // Start benchmark (mock streaming)
    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: {"choices":[{"delta":{"content":"hello world content"}}]}\n\n`,
            ),
          );
          controller.enqueue(
            new TextEncoder().encode(
              `data: {"choices":[{"delta":{"content":"more content here"}}]}\n\n`,
            ),
          );
          // Leave open
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const runner = new BenchmarkRunner();
    const runPromise = runner.run(model, "fake-key");
    await new Promise((r) => setTimeout(r, 50));

    // Cancel
    runner.cancel();
    runner.applyResultToModel(model);

    // Verify in-memory state
    expect(model.benchmarkStatus).toBe("cancelled");
    expect(model.benchmarkTtfb).toBeDefined();

    // Save (simulates safeSaveStore after cancel)
    store.fallbackChain = [model];
    saveStore(store, { storePath: TEST_STORE_PATH }, true);

    // Verify disk
    const raw = JSON.parse(readFileSync(TEST_STORE_PATH, "utf-8"));
    expect(raw.fallbackChain[0].benchmarkStatus).toBe("cancelled");
    expect(raw.fallbackChain[0].benchmarkTtfb).toBeGreaterThanOrEqual(0);

    // Simulate refreshStore: reload from disk
    const reloaded = loadStore({ storePath: TEST_STORE_PATH });
    expect(reloaded!.fallbackChain[0].benchmarkStatus).toBe("cancelled");
    expect(reloaded!.fallbackChain[0].benchmarkTtfb).toBeGreaterThanOrEqual(0);

    // Simulate another save AFTER reload (e.g., user reorders chain)
    saveStore(reloaded!, { storePath: TEST_STORE_PATH }, true);

    // Verify metrics survive second save
    const reloaded2 = loadStore({ storePath: TEST_STORE_PATH });
    expect(reloaded2!.fallbackChain[0].benchmarkStatus).toBe("cancelled");
    expect(reloaded2!.fallbackChain[0].benchmarkTtfb).toBeGreaterThanOrEqual(0);
  });

  test("sanitize step does NOT mutate in-memory model (shallow copy)", () => {
    // Initial disk state
    saveStore(makeStore([{ id: "m1", name: "X" }]), {
      storePath: TEST_STORE_PATH,
    });

    // In-memory model with "running" status
    const model: FallbackModel = {
      id: "m1",
      name: "X",
      benchmarkStatus: "running",
    };
    const store = makeStore([model]);
    saveStore(store, { storePath: TEST_STORE_PATH }, true);

    // Sanitize writes "idle" to disk but does NOT mutate the live object
    expect(model.benchmarkStatus).toBe("running");
  });

  test("cancelled model is not affected by sanitize mutation", () => {
    saveStore(makeStore([{ id: "m1", name: "X" }]), {
      storePath: TEST_STORE_PATH,
    });

    const model: FallbackModel = {
      id: "m1",
      name: "X",
      benchmarkStatus: "cancelled",
      benchmarkTtfb: 500,
      benchmarkTps: 30,
    };
    const store = makeStore([model]);
    saveStore(store, { storePath: TEST_STORE_PATH }, true);

    // "cancelled" should NOT be touched by sanitize
    expect(model.benchmarkStatus).toBe("cancelled");
    expect(model.benchmarkTtfb).toBe(500);
    expect(model.benchmarkTps).toBe(30);
  });

  test("adding model persists through save with existing disk", () => {
    // Disk has model A
    saveStore(makeStore([{ id: "a", name: "A" }]), {
      storePath: TEST_STORE_PATH,
    });

    // Memory has model A + B
    const store = makeStore([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    saveStore(store, { storePath: TEST_STORE_PATH }, true);

    const loaded = loadStore({ storePath: TEST_STORE_PATH });
    expect(loaded!.fallbackChain).toHaveLength(2);
    expect(loaded!.fallbackChain[1].id).toBe("b");
  });

  test("plugin save does NOT overwrite TUI's fallback chain changes", () => {
    // TUI removes model B, saves with ownsFallbackChain=true
    const tuiStore = makeStore([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    saveStore(tuiStore, { storePath: TEST_STORE_PATH }, true);

    // TUI removes model B
    tuiStore.fallbackChain = [{ id: "a", name: "A" }];
    saveStore(tuiStore, { storePath: TEST_STORE_PATH }, true);

    // Verify disk has only model A
    let loaded = loadStore({ storePath: TEST_STORE_PATH });
    expect(loaded!.fallbackChain).toHaveLength(1);

    // Plugin saves its stale store (still has model B) WITHOUT ownsFallbackChain
    const pluginStore = makeStore([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    saveStore(pluginStore, { storePath: TEST_STORE_PATH }); // default: disk wins

    // Verify disk STILL has only model A (plugin didn't overwrite TUI's removal)
    loaded = loadStore({ storePath: TEST_STORE_PATH });
    expect(loaded!.fallbackChain).toHaveLength(1);
    expect(loaded!.fallbackChain[0].id).toBe("a");
  });
});

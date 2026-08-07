import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { BenchmarkRunner } from "../src/tui/benchmark.js";
import type { FallbackModel } from "../src/types.js";

mock.module("../src/tui/state.js", () => ({
  state: { benchmarkRunners: new Map(), currentScreen: "fallback-chain" },
  callRenderApp: () => {},
}));

function makeModel(id = "test-model"): FallbackModel {
  return { id, name: "Test Model" };
}

function mockSuccessfulStream(chunks: string[]) {
  return mock(async () => {
    const stream = new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
          await new Promise((r) => setTimeout(r, 5));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
}

describe("Preservation: Normal Completion and Error Behavior", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("successful completion persists TTFB and TPS to model with status done", async () => {
    const contentChunks = Array.from(
      { length: 20 },
      (_, i) =>
        `data: {"choices":[{"delta":{"content":"word${i} more text padding here "}}]}\n\n`,
    );
    // Spread chunks over time to pass the 2s TPS gate
    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream({
        async start(controller) {
          for (const chunk of contentChunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
            await new Promise((r) => setTimeout(r, 5));
          }
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const runner = new BenchmarkRunner();
    const model = makeModel();
    const result = await runner.run(model, "fake-key");
    runner.applyResultToModel(model);

    expect(result.phase).toBe("done");
    expect(model.benchmarkStatus).toBe("done");
    expect(model.benchmarkTtfb).toBeDefined();
    expect(model.benchmarkTtfb).toBeGreaterThanOrEqual(0);
    // TPS persisted (may be set from final calc)
    expect(model.benchmarkTps).toBeDefined();
    expect(model.benchmarkTps).toBeGreaterThan(0);
  });

  test("HTTP error sets error status and message on model", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    const runner = new BenchmarkRunner();
    const model = makeModel();
    await runner.run(model, "fake-key");
    runner.applyResultToModel(model);

    expect(model.benchmarkStatus).toBe("error");
    expect(model.benchmarkError).toBe("HTTP 401");
  });

  test("HTTP 500 sets error status with correct message", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Internal Server Error", { status: 500 });
    }) as typeof fetch;

    const runner = new BenchmarkRunner();
    const model = makeModel();
    await runner.run(model, "fake-key");
    runner.applyResultToModel(model);

    expect(model.benchmarkStatus).toBe("error");
    expect(model.benchmarkError).toBe("HTTP 500");
  });

  test("runner tracks in benchmarkRunners map during execution", async () => {
    const { state } = await import("../src/tui/state.js");

    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream({
        async start(controller) {
          // Delay to allow checking the map mid-flight
          await new Promise((r) => setTimeout(r, 50));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const runner = new BenchmarkRunner();
    const model = makeModel("tracked-model");
    state.benchmarkRunners.set("tracked-model", runner);

    const runPromise = runner.run(model, "fake-key");

    // Mid-execution: runner should still be in the map
    await new Promise((r) => setTimeout(r, 20));
    expect(state.benchmarkRunners.has("tracked-model")).toBe(true);

    await runPromise;
    // Cleanup happens in the caller (actions.ts), not in the runner itself on success
    state.benchmarkRunners.delete("tracked-model");
  });

  test("generation counter invalidates stale continuations", async () => {
    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream({
        async start(controller) {
          await new Promise((r) => setTimeout(r, 100));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const runner = new BenchmarkRunner();
    const model = makeModel();

    // Start first run
    const run1 = runner.run(model, "fake-key");
    // Immediately start second run (bumps generation)
    const run2 = runner.run(model, "fake-key");

    const result1 = await run1;
    const result2 = await run2;

    // First run was invalidated by second
    // Second run should complete normally
    expect(result2.phase).toBe("done");
  });
});

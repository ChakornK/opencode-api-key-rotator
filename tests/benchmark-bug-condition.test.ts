import { beforeEach, describe, expect, mock, test } from "bun:test";
import { BenchmarkRunner } from "../src/tui/benchmark.js";
import type { FallbackModel } from "../src/types.js";

// Stub state module so BenchmarkRunner doesn't crash on import
mock.module("../src/tui/state.js", () => ({
  state: { benchmarkRunners: new Map(), currentScreen: "fallback-chain" },
  callRenderApp: () => {},
}));

function makeModel(id = "test-model"): FallbackModel {
  return { id, name: "Test Model" };
}

describe("Bug Condition: Benchmark Metrics Accuracy and Availability", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  test("max_tokens is 256", async () => {
    let capturedBody: string | undefined;

    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string;
        // Return a minimal OK streaming response then end
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    ) as typeof fetch;

    const runner = new BenchmarkRunner();
    await runner.run(makeModel(), "fake-key");

    const body = JSON.parse(capturedBody!);
    expect(body.max_tokens).toBe(256);

    globalThis.fetch = originalFetch;
  });

  test("cancel preserves last-known TTFB and TPS", async () => {
    // Simulate a stream that provides TTFB and some content before cancel
    let readerResolve:
      | ((value: { done: boolean; value?: Uint8Array }) => void)
      | null = null;

    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream({
        start(controller) {
          // Send a content chunk
          const chunk = `data: {"choices":[{"delta":{"content":"hello world this is content"}}]}\n\n`;
          controller.enqueue(new TextEncoder().encode(chunk));
          // Send a second chunk so TPS can compute
          const chunk2 = `data: {"choices":[{"delta":{"content":"more content here for tokens"}}]}\n\n`;
          controller.enqueue(new TextEncoder().encode(chunk2));
          // Leave stream open (don't close) to simulate ongoing
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const runner = new BenchmarkRunner();
    const model = makeModel();

    // Start benchmark but don't await (we'll cancel mid-stream)
    const runPromise = runner.run(model, "fake-key");

    // Wait enough for TTFB to be recorded and some streaming
    await new Promise((r) => setTimeout(r, 100));

    runner.cancel();
    runner.applyResultToModel(model);

    // Bug: cancel currently wipes metrics
    expect(model.benchmarkTtfb).toBeDefined();

    globalThis.fetch = originalFetch;
  });

  test("TPS is calculated when content chunks arrive but stream errors before 2s gate", async () => {
    // Send content chunks then error before 2s TPS_UPDATE_INTERVAL elapses.
    // The final TPS calc (after while loop) is skipped because the error propagates.
    globalThis.fetch = mock(async () => {
      const stream = new ReadableStream({
        async start(controller) {
          const chunks = [
            `data: {"choices":[{"delta":{"content":"first chunk of generated text here"}}]}\n\n`,
            `data: {"choices":[{"delta":{"content":"second chunk more tokens generated"}}]}\n\n`,
            `data: {"choices":[{"delta":{"content":"third chunk even more content now"}}]}\n\n`,
          ];
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
            await new Promise((r) => setTimeout(r, 10));
          }
          // Simulate server timeout mid-stream
          controller.error(new Error("network timeout"));
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const runner = new BenchmarkRunner();
    const model = makeModel();
    await runner.run(model, "fake-key");
    runner.applyResultToModel(model);

    // Bug: TPS never calculated because stream errored before 2s gate and final calc is skipped
    expect(model.benchmarkTps).toBeDefined();
    expect(model.benchmarkTps).toBeGreaterThan(0);

    globalThis.fetch = originalFetch;
  });
});

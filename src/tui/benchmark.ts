import { SPINNER_INTERVAL_MS } from "../constants.js";
import type { FallbackModel } from "../types.js";
import { callRenderApp, state } from "./state.js";

const NIM_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const TPS_UPDATE_INTERVAL_MS = 2_000;
const CHARS_PER_TOKEN = 4;

export interface BenchmarkMetrics {
  ttfb: number | undefined;
  tps: number | undefined;
  tokenCount: number;
}

export type BenchmarkPhase =
  | "idle"
  | "connecting"
  | "streaming"
  | "done"
  | "error"
  | "cancelled";

export interface BenchmarkState {
  phase: BenchmarkPhase;
  metrics: BenchmarkMetrics;
  error: string | undefined;
}

/** Runs a streaming benchmark against a single model. Supports cancellation via generation counter. */
export class BenchmarkRunner {
  private generation = 0;
  private controller: AbortController | null = null;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private _phase: BenchmarkPhase = "idle";
  private _metrics: BenchmarkMetrics = {
    ttfb: undefined,
    tps: undefined,
    tokenCount: 0,
  };
  private _error: string | undefined;
  private _modelId: string | undefined;
  private _cancelled = false;
  private lastGoodTps: number | undefined;

  private setTps(value: number | undefined): void {
    if (value != null && Number.isFinite(value) && value >= 0) {
      this._metrics.tps = value;
      this.lastGoodTps = value;
    } else if (this.lastGoodTps != null) {
      this._metrics.tps = this.lastGoodTps;
    }
  }

  get phase(): BenchmarkPhase {
    return this._phase;
  }
  get metrics(): BenchmarkMetrics {
    return { ...this._metrics };
  }
  get error(): string | undefined {
    return this._error;
  }
  get modelId(): string | undefined {
    return this._modelId;
  }
  get isRunning(): boolean {
    return this._phase === "connecting" || this._phase === "streaming";
  }

  getState(): BenchmarkState {
    return {
      phase: this._phase,
      metrics: { ...this._metrics },
      error: this._error,
    };
  }

  /** Cancels in-flight work. Bumps generation to invalidate stale continuations. Evicts from map. */
  cancel(): void {
    this.generation++;
    this._cancelled = true;
    if (this.controller) this.controller.abort();
    this.teardown();
    this._phase = "cancelled";
    this._error = undefined;
    // Evict from runners map immediately
    if (this._modelId) state.benchmarkRunners.delete(this._modelId);
    callRenderApp();
  }

  /** Executes the benchmark. Returns final state. Checks generation after every await. */
  async run(model: FallbackModel, apiKey: string): Promise<BenchmarkState> {
    this.teardown();
    this.generation++;
    const gen = this.generation;
    this._cancelled = false;

    this.controller = new AbortController();
    this._phase = "connecting";
    this._metrics = { ttfb: undefined, tps: undefined, tokenCount: 0 };
    this._error = undefined;
    this._modelId = model.id;
    this.lastGoodTps = undefined;

    this.startSpinner();

    try {
      await this.execute(model, apiKey, gen);
      if (this.generation !== gen) return this.getState();
      this._phase = "done";
    } catch (err) {
      if (this.generation !== gen) return this.getState();
      if (this._cancelled) {
        this._phase = "cancelled";
        this._error = undefined;
      } else {
        this._phase = "error";
        this._error = err instanceof Error ? err.message : "Benchmark failed";
      }
    } finally {
      if (this.generation === gen) this.teardown();
    }

    return this.getState();
  }

  /** Writes benchmark results to the provided model reference. Caller must re-resolve model by ID. */
  applyResultToModel(model: FallbackModel): void {
    if (this._phase === "done") {
      model.benchmarkStatus = "done";
      model.benchmarkTtfb =
        this._metrics.ttfb != null && Number.isFinite(this._metrics.ttfb)
          ? this._metrics.ttfb
          : undefined;
      model.benchmarkTps =
        this._metrics.tps != null &&
        Number.isFinite(this._metrics.tps) &&
        this._metrics.tps > 0
          ? this._metrics.tps
          : undefined;
      if (model.benchmarkTps == null) {
        model.benchmarkStatus = "error";
        model.benchmarkError = "TPS calculation failed";
      }
    } else if (this._phase === "error") {
      model.benchmarkStatus = "error";
      model.benchmarkError = this._error;
    } else if (this._phase === "cancelled") {
      model.benchmarkStatus = "idle";
      delete model.benchmarkTtfb;
      delete model.benchmarkTps;
      delete model.benchmarkError;
    }
  }

  resetModel(model: FallbackModel): void {
    model.benchmarkStatus = "idle";
    delete model.benchmarkTtfb;
    delete model.benchmarkTps;
    delete model.benchmarkError;
  }

  private async execute(
    model: FallbackModel,
    apiKey: string,
    gen: number,
  ): Promise<void> {
    const signal = this.controller!.signal;
    const startTime = Date.now();

    const res = await fetch(NIM_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.id,
        messages: [
          {
            role: "user",
            content:
              "Write a function that takes an array of integers and returns the two numbers that sum to a given target. Explain your approach.",
          },
        ],
        max_tokens: 512,
        stream: true,
      }),
      signal,
    });

    if (this.generation !== gen) return;

    // Only record TTFB if response is successful
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const firstByteTime = Date.now();
    this._metrics.ttfb = firstByteTime - startTime;
    this._phase = "streaming";
    callRenderApp();

    const reader = res.body?.getReader();
    if (!reader) throw new Error("Response body is empty");

    await this.readStream(reader, gen, firstByteTime);
  }

  private async readStream(
    reader: {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
      releaseLock(): void;
    },
    gen: number,
    ttfbTime: number,
  ): Promise<void> {
    let streamStart = 0;
    let lastTpsUpdate = 0;
    let charCount = 0;
    let contentChunks = 0;
    let buffer = "";
    const decoder = new TextDecoder();

    try {
      while (true) {
        if (this.generation !== gen) return;
        const chunk = await reader.read();
        if (this.generation !== gen) return;
        const { done, value } = chunk;
        if (done) break;

        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const content = parsed?.choices?.[0]?.delta?.content;
              if (content) {
                charCount += content.length;
                contentChunks++;
                if (streamStart === 0) streamStart = ttfbTime;
              }
            } catch {}
          }
        }

        if (charCount === 0 || contentChunks < 2) continue;

        const estimatedTokens = Math.max(
          1,
          Math.round(charCount / CHARS_PER_TOKEN),
        );
        this._metrics.tokenCount = estimatedTokens;
        const now = Date.now();
        const elapsed = Math.max(1, now - streamStart);
        const calculatedTps = (estimatedTokens / elapsed) * 1000;

        if (
          lastTpsUpdate === 0 ||
          now - lastTpsUpdate >= TPS_UPDATE_INTERVAL_MS
        ) {
          this.setTps(calculatedTps);
          lastTpsUpdate = now;
          callRenderApp();
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }

    if (charCount > 0 && streamStart > 0) {
      const finalTokens = Math.max(1, Math.round(charCount / CHARS_PER_TOKEN));
      this._metrics.tokenCount = finalTokens;
      const streamDuration = Math.max(1, Date.now() - streamStart);
      this.setTps((finalTokens / streamDuration) * 1000);
    }
  }

  // Spinner drives periodic re-renders. Stopped only by teardown(), never self-terminates.
  private startSpinner(): void {
    this.stopSpinner();
    this.spinnerInterval = setInterval(() => {
      if (state.currentScreen === "fallback-chain") callRenderApp();
    }, SPINNER_INTERVAL_MS);
    // Prevent spinner from blocking process exit
    if (
      this.spinnerInterval &&
      typeof this.spinnerInterval === "object" &&
      "unref" in this.spinnerInterval
    ) {
      (this.spinnerInterval as { unref(): void }).unref();
    }
  }

  private stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
  }

  private teardown(): void {
    this.stopSpinner();
    this.controller = null;
  }
}

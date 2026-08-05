import { logDebug } from "../logger.js";
import {
  applyImport,
  exportKeys,
  resetFailures,
  toggleKey,
  writeExportFile,
} from "../storage.js";
import { getActiveTheme, setPreviewTheme } from "../themes.js";
import { BenchmarkRunner } from "./benchmark.js";
import {
  callRenderApp,
  navigate,
  safeSaveStore,
  setStatus,
  state,
  stopFileWatcher,
} from "./state.js";

export function handleKeyAction(action: string): void {
  if (!state.selectedKeyId) return;
  const entry = state.store.keys.find((k) => k.id === state.selectedKeyId);
  const theme = getActiveTheme();

  switch (action) {
    case "toggle":
      if (entry) {
        toggleKey(state.store, state.selectedKeyId);
        safeSaveStore();
        setStatus(
          `Toggled "${entry.name}" to ${entry.enabled ? "ON" : "OFF"}`,
          theme.success,
        );
      }
      navigate("key-actions");
      break;
    case "rename":
      state.renameTargetId = state.selectedKeyId;
      navigate("rename");
      break;
    case "delete":
      state.deleteTargetId = state.selectedKeyId;
      navigate("confirm-delete");
      break;
    case "back":
      navigate("key-selector");
      break;
  }
}

export function handleMenuSelect(value: string): void {
  const theme = getActiveTheme();
  switch (value) {
    case "add":
      navigate("add-name");
      break;
    case "manage":
      navigate("key-selector");
      break;
    case "reset-failures":
      resetFailures(state.store);
      safeSaveStore();
      setStatus("All failure counts reset", theme.success);
      navigate("list");
      break;
    case "toggle-strategy": {
      const current = state.store.rotationStrategy;
      state.store.rotationStrategy =
        current === "round-robin" ? "least-failures" : "round-robin";
      safeSaveStore();
      setStatus(`Strategy: ${state.store.rotationStrategy}`, theme.primary);
      navigate("list");
      break;
    }
    case "theme":
      setPreviewTheme(null);
      navigate("theme-selector");
      break;
    case "export":
      navigate("export-path");
      break;
    case "import":
      navigate("import-path");
      break;
    case "quit":
      cancelBenchmark();
      safeSaveStore();
      stopFileWatcher();
      if (state.renderer) state.renderer.destroy();
      process.exit(0);
  }
}

export function handleExport(filePath: string): void {
  const theme = getActiveTheme();
  const path = filePath.trim();
  if (!path) {
    setStatus("File path is required", theme.error);
    callRenderApp();
    return;
  }
  try {
    const payload = exportKeys(state.store);
    writeExportFile(payload, path);
    setStatus(
      `Exported ${payload.keys.length} key(s) to ${path}`,
      theme.success,
    );
    navigate("list");
  } catch (err) {
    console.error("[nim-rotator] Export failed:", err);
    setStatus("Export failed: check file path and permissions", theme.error);
    callRenderApp();
  }
}

export function handleImportConfirm(value: string): void {
  const theme = getActiveTheme();
  if (value !== "yes" || !state.pendingImportResult) {
    state.pendingImportPath = "";
    state.pendingImportResult = null;
    navigate("list");
    return;
  }
  const { added, skipped } = applyImport(
    state.store,
    state.pendingImportResult.pendingKeys,
  );
  safeSaveStore();
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  setStatus(`Import complete: ${parts.join(", ")}`, theme.success);
  state.pendingImportPath = "";
  state.pendingImportResult = null;
  navigate("list");
}

// Fallback Chain Actions

export function handleFallbackMenuSelect(value: string): void {
  switch (value) {
    case "edit-chain":
      state.fallbackChainIndex = 0;
      state.fallbackChainScrollOffset = 0;
      navigate("fallback-chain");
      break;
    case "settings":
      navigate("fallback-settings");
      break;
  }
}

export function handleFallbackChainKey(keyName: string): void {
  const chain = state.store.fallbackChain;
  const totalItems = chain.length + 1;

  switch (keyName) {
    case "up":
      state.fallbackChainIndex = Math.max(0, state.fallbackChainIndex - 1);
      callRenderApp();
      break;
    case "down":
      state.fallbackChainIndex = Math.min(
        totalItems - 1,
        state.fallbackChainIndex + 1,
      );
      callRenderApp();
      break;
    case "x": {
      if (state.fallbackChainIndex < chain.length) {
        const removed = chain[state.fallbackChainIndex];
        cancelBenchmark(removed.id);
        chain.splice(state.fallbackChainIndex, 1);
        safeSaveStore();
        if (state.fallbackChainIndex >= chain.length) {
          state.fallbackChainIndex = Math.max(0, chain.length - 1);
        }
        callRenderApp();
      }
      break;
    }
    case "j": {
      const jIndex = state.fallbackChainIndex;
      if (jIndex < chain.length - 1) {
        const temp = chain[jIndex];
        chain[jIndex] = chain[jIndex + 1];
        chain[jIndex + 1] = temp;
        state.fallbackChainIndex = jIndex + 1;
        safeSaveStore();
        callRenderApp();
      }
      break;
    }
    case "k": {
      const kIndex = state.fallbackChainIndex;
      if (kIndex > 0 && kIndex < chain.length) {
        const temp = chain[kIndex];
        chain[kIndex] = chain[kIndex - 1];
        chain[kIndex - 1] = temp;
        state.fallbackChainIndex = kIndex - 1;
        safeSaveStore();
        callRenderApp();
      }
      break;
    }
    case "a": {
      state.modelSelectorIndex = 0;
      state.modelSelectorScrollOffset = 0;
      navigate("model-selector");
      break;
    }
    case "b": {
      startBenchmark().catch(() => {
        // Error already handled inside startBenchmark
      });
      break;
    }
    case "c": {
      const selectedModel = chain[state.fallbackChainIndex];
      if (selectedModel) cancelBenchmark(selectedModel.id);
      break;
    }
    case "return":
    case "enter": {
      if (state.fallbackChainIndex >= chain.length) {
        state.modelSelectorIndex = 0;
        state.modelSelectorScrollOffset = 0;
        navigate("model-selector");
      }
      break;
    }
  }
}

export async function fetchNimModels(): Promise<void> {
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      setStatus("Failed to fetch models from NVIDIA NIM", "#FF5555");
      state.modelsLoaded = false;
      return;
    }
    const data = (await res.json()) as {
      data?: Array<{ id: string; name?: string }>;
    };
    if (!data.data || !Array.isArray(data.data)) {
      setStatus("Invalid response from NVIDIA NIM", "#FF5555");
      state.modelsLoaded = false;
      return;
    }
    state.availableModels = data.data.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
    }));
    state.modelsLoaded = true;
  } catch (err) {
    console.error("[nim-rotator] Failed to fetch models:", err);
    setStatus("Failed to fetch models from NVIDIA NIM", "#FF5555");
    state.modelsLoaded = false;
  }
}

export function addFallbackModel(id: string, name: string): void {
  const chain = state.store.fallbackChain;

  if (chain.some((m) => m.id === id)) {
    setStatus(
      `Model "${name}" is already in the fallback chain`,
      getActiveTheme().warning,
    );
    callRenderApp();
    return;
  }

  const insertIndex =
    state.fallbackChainIndex >= chain.length
      ? chain.length
      : state.fallbackChainIndex + 1;

  chain.splice(insertIndex, 0, {
    id,
    name,
    benchmarkTtfb: undefined,
    benchmarkTps: undefined,
    benchmarkStatus: "idle",
  });

  safeSaveStore();
  state.fallbackChainIndex = insertIndex;
}

// Benchmarking

/** Starts a benchmark for the currently selected model. Guards against double-start. */
export async function startBenchmark(): Promise<void> {
  const chain = state.store.fallbackChain;
  const idx = state.fallbackChainIndex;

  if (idx >= chain.length) {
    setStatus("No model selected to benchmark", getActiveTheme().warning);
    return;
  }

  const modelId = chain[idx].id;

  // Double-start guard
  if (state.benchmarkRunners.has(modelId)) return;

  const apiKey =
    state.store.keys.find((k) => k.enabled && k.key)?.key ||
    process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    setStatus("No API key available for benchmarking", getActiveTheme().error);
    return;
  }

  // Set running state
  const model = chain[idx];
  model.benchmarkStatus = "running";
  delete model.benchmarkTps;
  delete model.benchmarkTtfb;
  delete model.benchmarkError;

  const runner = new BenchmarkRunner();
  state.benchmarkRunners.set(modelId, runner);
  callRenderApp();

  try {
    await runner.run(model, apiKey);
  } catch (err) {
    // Runner failed unexpectedly
    logDebug(
      `benchmark runner threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Re-resolve model from CURRENT store (may have been refreshed during await)
  const currentModel = state.store.fallbackChain.find((m) => m.id === modelId);
  if (currentModel && state.benchmarkRunners.get(modelId) === runner) {
    state.benchmarkRunners.delete(modelId);
    runner.applyResultToModel(currentModel);
    safeSaveStore();
  } else if (state.benchmarkRunners.get(modelId) === runner) {
    // Model removed during benchmark — clean up runner
    state.benchmarkRunners.delete(modelId);
  }
  callRenderApp();
}

/** Cancels one or all benchmark runners. Resets model statuses. */
export function cancelBenchmark(modelId?: string): void {
  if (modelId) {
    const runner = state.benchmarkRunners.get(modelId);
    if (runner) {
      runner.cancel();
      // cancel() already evicts from map
      const model = state.store.fallbackChain.find((m) => m.id === modelId);
      if (model) {
        model.benchmarkStatus = "idle";
        delete model.benchmarkTps;
        delete model.benchmarkTtfb;
        delete model.benchmarkError;
      }
      safeSaveStore();
      callRenderApp();
    }
  } else {
    // Cancel all
    for (const [id, runner] of state.benchmarkRunners) {
      runner.cancel();
      const model = state.store.fallbackChain.find((m) => m.id === id);
      if (model) {
        model.benchmarkStatus = "idle";
        delete model.benchmarkTps;
        delete model.benchmarkTtfb;
        delete model.benchmarkError;
      }
    }
    state.benchmarkRunners.clear();
    safeSaveStore();
    callRenderApp();
  }
}

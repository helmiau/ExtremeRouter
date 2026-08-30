// Background synchronizer for the Dynamic Model Capability Catalog.
//
// Lifecycle (§6): startup delay → sync → success schedules the next refresh,
// failure schedules a bounded backoff retry. Never overlapping, never throwing:
// a failed sync keeps the last-known-good snapshot and the hand-written
// capability tables remain fully authoritative on their own (§21/§22/§36).
//
// The main thread NEVER parses the 4.4MB upstream payload — the worker does
// that off-loop and writes a small validated delta snapshot; this module only
// spawns the worker and loads the small file into memory afterwards.

import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { MODEL_CATALOG_CONFIG } from "open-sse/config/runtimeConfig.js";
import {
  CATALOG_FILE,
  loadCatalogSnapshotFromDisk,
  getCatalogSnapshot,
  installCatalogSource,
} from "open-sse/providers/catalogSource.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

const WORKER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.js");

const state = {
  running: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastResult: null,
  etag: null,
  timer: null,
};

export function getCatalogState() {
  const snapshot = getCatalogSnapshot();
  const meta = snapshot?.meta || null;
  const stale = meta?.syncedAt
    ? Date.now() - meta.syncedAt > MODEL_CATALOG_CONFIG.maxStalenessMs
    : !meta; // never synced → the catalog layer itself is "unavailable"
  return {
    enabled: MODEL_CATALOG_CONFIG.enabled,
    running: state.running,
    state: state.running
      ? "syncing"
      : meta?.syncedAt
        ? (stale ? "stale" : "ready")
        : "unavailable",
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt || meta?.syncedAt || null,
    lastError: state.lastError,
    etag: state.etag || meta?.etag || null,
    modelCount: meta?.modelCount || 0,
    providerCount: meta?.providerCount || 0,
    file: CATALOG_FILE,
    url: MODEL_CATALOG_CONFIG.url,
    refreshIntervalMs: MODEL_CATALOG_CONFIG.refreshIntervalMs,
    stale,
  };
}

// Snapshot every registry model with its currently resolved capabilities so the
// worker can compute a meaningful delta without importing app modules (the
// worker cannot resolve bundler aliases).
function collectRegistryEntries() {
  // Imported lazily so merely loading this module (e.g. from a route in dev)
  // does not pull the whole registry into every entry point.
  return (async () => {
    const { default: REGISTRY } = await import("open-sse/providers/registry/index.js");
    const entries = [];
    for (const provider of REGISTRY) {
      if (!Array.isArray(provider.models)) continue;
      for (const model of provider.models) {
        if (typeof model === "string" || !model?.id) continue;
        entries.push({
          provider: provider.id,
          model: model.id,
          // Registry entries declare contextWindow (same field registryLimits reads).
          contextLength: model.contextWindow ?? null,
          current: getCapabilitiesForModel(provider.id, model.id),
        });
      }
    }
    return entries;
  })();
}

function runWorker(workerOpts) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_FILE, {
        workerData: workerOpts,
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    const timeout = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(reject, new Error("sync worker timed out"));
    }, MODEL_CATALOG_CONFIG.workerTimeoutMs);

    worker.on("message", (msg) => {
      if (msg?.ok) finish(resolve, msg.result);
      else finish(reject, new Error(msg?.error || "sync failed"));
    });
    worker.on("error", (err) => finish(reject, err));
    worker.on("exit", (code) => {
      if (!settled && code !== 0) finish(reject, new Error(`worker exited with ${code}`));
    });
  });
}

/**
 * Run one sync attempt. Returns the worker summary, or null when the sync
 * could not complete (already running / transport / validation failure).
 * Never throws (§36: failure isolation from the request path).
 */
export async function syncModelCatalog() {
  if (!MODEL_CATALOG_CONFIG.enabled) return null;
  if (state.running) return null; // never overlap sync jobs (§6)
  state.running = true;
  state.lastAttemptAt = Date.now();
  try {
    const entries = await collectRegistryEntries();
    const result = await runWorker({
      url: MODEL_CATALOG_CONFIG.url,
      etag: state.etag,
      outFile: CATALOG_FILE,
      timeoutMs: MODEL_CATALOG_CONFIG.requestTimeoutMs,
      maxPayloadBytes: MODEL_CATALOG_CONFIG.maxPayloadBytes,
      entries,
      minModalityShare: MODEL_CATALOG_CONFIG.minModalityShare,
      limitTolerance: MODEL_CATALOG_CONFIG.limitTolerance,
    });

    if (result.status === "updated") {
      state.etag = result.etag;
      // Load the small validated delta into memory (atomic swap; the big
      // payload never crosses the main thread).
      loadCatalogSnapshotFromDisk();
      console.log(`[model-catalog] snapshot updated | ${result.snapshot.models ? Object.keys(result.snapshot.models).length : 0} models, ${result.snapshot.providers ? Object.keys(result.snapshot.providers).length : 0} providers, ${(result.bytes / 1024).toFixed(1)}KB payload`);
    } else {
      console.log("[model-catalog] catalog unchanged (ETag 304)");
    }
    state.lastSuccessAt = Date.now();
    state.lastError = null;
    state.lastResult = { status: result.status, etag: result.etag ?? null };
    return result;
  } catch (error) {
    state.lastError = error?.message || String(error);
    console.log(`[model-catalog] sync failed; keeping last-known-good | ${state.lastError}`);
    return null;
  } finally {
    state.running = false;
  }
}

/**
 * Schedule the recurring background sync. Never blocks startup; a failure
 * retries on the backoff interval instead of the full refresh interval.
 */
export function startModelCatalogSync() {
  if (state.timer) return;
  if (!MODEL_CATALOG_CONFIG.enabled) {
    console.log("[model-catalog] disabled (MODEL_CATALOG=off) — local capability tables only");
    return;
  }

  // Serve whatever snapshot survived from a previous run immediately.
  loadCatalogSnapshotFromDisk();
  installCatalogSource().catch((err) => {
    console.error(`[model-catalog] failed to install catalog source: ${err?.message || err}`);
  });

  const schedule = (delay) => {
    state.timer = setTimeout(async () => {
      const result = await syncModelCatalog();
      schedule(result ? MODEL_CATALOG_CONFIG.refreshIntervalMs : MODEL_CATALOG_CONFIG.retryBackoffMs);
    }, delay);
    state.timer.unref?.();
  };
  schedule(MODEL_CATALOG_CONFIG.startupDelayMs);
  console.log(`[model-catalog] background sync scheduled (first run in ${Math.round(MODEL_CATALOG_CONFIG.startupDelayMs / 1000)}s, interval ${Math.round(MODEL_CATALOG_CONFIG.refreshIntervalMs / 3600000)}h)`);
}

/**
 * Test hook: reset scheduler state between tests. Not part of the public API.
 */
export function __resetSyncStateForTests() {
  if (state.timer) clearTimeout(state.timer);
  state.running = false;
  state.lastAttemptAt = null;
  state.lastSuccessAt = null;
  state.lastError = null;
  state.lastResult = null;
  state.etag = null;
  state.timer = null;
}

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
  extendCatalogValidation,
  persistCatalogSnapshot,
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
  // Freshness = the most recent successful VALIDATION of the active snapshot
  // (200 install or 304 confirmation), falling back to syncedAt for legacy
  // snapshots written before validatedAt existed. An old payload age alone
  // never means stale while conditional validations keep succeeding.
  const freshness = meta?.validatedAt ?? meta?.syncedAt ?? null;
  const stale = freshness
    ? Date.now() - freshness > MODEL_CATALOG_CONFIG.maxStalenessMs
    : !meta; // never synced → the catalog layer itself is "unavailable"
  return {
    enabled: MODEL_CATALOG_CONFIG.enabled,
    running: state.running,
    state: state.running
      ? "syncing"
      : freshness
        ? (stale ? "stale" : "ready")
        : "unavailable",
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt || freshness || null,
    lastError: state.lastError,
    etag: state.etag || meta?.etag || null,
    // syncedAt = last payload INSTALL; validatedAt = last upstream validation.
    syncedAt: meta?.syncedAt || null,
    validatedAt: meta?.validatedAt || null,
    modelCount: meta?.modelCount || 0,
    providerCount: meta?.providerCount || 0,
    file: CATALOG_FILE,
    url: MODEL_CATALOG_CONFIG.url,
    refreshIntervalMs: MODEL_CATALOG_CONFIG.refreshIntervalMs,
    stale,
  };
}

// Snapshot every registry model with the capabilities the HAND-WRITTEN tables
// resolve on their own, so the delta computation can tell which upstream values
// are actually a change.
//
// The previous synced catalog MUST be detached first. Leaving it installed
// makes each delta relative to the LAST one: an upstream value that still
// agrees with what we previously wrote looks like "no change" and is dropped —
// the provider-limit delta erases itself over repeated syncs.
function collectRegistryEntries() {
  // Imported lazily so merely loading this module (e.g. from a route in dev)
  // does not pull the whole registry into every entry point.
  return (async () => {
    const [{ default: REGISTRY }, { setCatalogSource }] = await Promise.all([
      import("open-sse/providers/registry/index.js"),
      import("open-sse/providers/capabilities.js"),
    ]);
    setCatalogSource(null);
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
    // Effective validator: scheduler state, falling back to the active
    // snapshot's etag — after a restart state.etag is null while the persisted
    // snapshot still carries one, and the first sync must stay conditional.
    const currentEtag = state.etag ?? getCatalogSnapshot()?.meta?.etag ?? null;
    const result = await runWorker({
      url: MODEL_CATALOG_CONFIG.url,
      etag: currentEtag,
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
      // payload never crosses the main thread). The snapshot carries both
      // syncedAt and validatedAt = install time.
      loadCatalogSnapshotFromDisk();
      console.log(`[model-catalog] sync success: catalog updated | ${result.snapshot.models ? Object.keys(result.snapshot.models).length : 0} models, ${result.snapshot.providers ? Object.keys(result.snapshot.providers).length : 0} providers, ${(result.bytes / 1024).toFixed(1)}KB payload`);
    } else {
      // 304 Not Modified: upstream confirms our validator (ETag) is current.
      // The catalog contents, snapshot file data, and ETag stay untouched —
      // only freshness advances (validatedAt = now), persisted as a small
      // metadata-only snapshot rewrite so restarts keep the correct freshness.
      if (extendCatalogValidation()) {
        persistCatalogSnapshot();
      }
      console.log("[model-catalog] sync success: catalog unchanged (304) — freshness extended");
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
    // collectRegistryEntries detaches the catalog reader so the delta baseline
    // is the hand-written tables alone; put it back whatever happened.
    installCatalogSource().catch((err) => {
      console.error(`[model-catalog] failed to restore catalog source: ${err?.message || err}`);
    });
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

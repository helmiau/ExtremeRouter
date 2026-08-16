/**
 * Smart Routing Telemetry — in-memory event bus + run registry.
 *
 * Mirrors the swarmTelemetry.js pattern: a singleton EventEmitter on `global`
 * (survives Next.js dev hot-reload) plus a capped in-memory run registry.
 * History persistence is deferred (same as swarm).
 *
 * A run captures the per-request ROUTING DECISION that distinguishes smart
 * routing from a plain fallback chain:
 *   - routing.reason      — tool_calling | research_cookie_primary | general | ...
 *   - routing.order       — the ordered pool handed to the fallback chain
 *   - routing.excludedCookies — cookie members dropped for tool-calling requests
 *   - routing.cookiePool / normalPool — split pools for research routing
 *   - routing.intent      — how research intent was decided (heuristic signal +
 *                           confidence, or which classifier model ran)
 *   - servedModel         — the member that actually answered (post-fallback)
 *
 * Live events carry a `type` for the client: "smart:start" | "smart:route" |
 * "smart:served" | "smart:complete" | "smart:error".
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

// Singleton on global to survive Next.js dev hot-reload.
if (!global._smartRoutingEmitter) {
  global._smartRoutingEmitter = new EventEmitter();
  global._smartRoutingEmitter.setMaxListeners(200);
  global._smartRoutingRuns = new Map(); // runId → SmartRoutingRun
  global._smartRoutingEmitTimers = {}; // key → timeout (debounce)
  global._smartRoutingPersistPending = new Map(); // runId → run (dedup buffer)
  global._smartRoutingPersistTimer = null;
}
const smartRoutingEmitter = global._smartRoutingEmitter;
const smartRoutingRuns = global._smartRoutingRuns;
const emitTimers = global._smartRoutingEmitTimers;
const persistPending = global._smartRoutingPersistPending;

export { smartRoutingEmitter };

const MAX_RUNS_KEPT = 50;

// ── Persistence (fire-and-forget, never blocks routing) ───────────────────
// Writes are buffered and flushed in a batch (mirrors requestDetailsRepo): a
// per-run upsert on a debounced timer, so a burst of requests does not hammer
// the sync SQLite adapter on the hot path. Failures are swallowed — telemetry
// must never break routing.
const PERSIST_BATCH_SIZE = 50;
const PERSIST_FLUSH_MS = 2000;

/**
 * Enqueue the latest state of a run for persistence. Deduped by runId — only
 * the most recent object reference is kept, so intermediate states collapse
 * into one upsert when the flush fires.
 */
function enqueuePersist(run) {
  if (!run || !run.runId) return;
  try {
    persistPending.set(run.runId, run);
    if (persistPending.size >= PERSIST_BATCH_SIZE) {
      if (global._smartRoutingPersistTimer) {
        clearTimeout(global._smartRoutingPersistTimer);
        global._smartRoutingPersistTimer = null;
      }
      flushPersistence().catch(() => {});
    } else if (!global._smartRoutingPersistTimer) {
      global._smartRoutingPersistTimer = setTimeout(() => {
        global._smartRoutingPersistTimer = null;
        flushPersistence().catch(() => {});
      }, PERSIST_FLUSH_MS);
    }
  } catch {
    // Never let persistence bookkeeping affect routing.
  }
}

/**
 * Drain the pending buffer into the DB (batch upsert + retention prune).
 * Dynamic import keeps the DB module out of the routing import graph and lets
 * persistence fail lazily (e.g. in unit tests / no-DB contexts).
 */
export async function flushPersistence() {
  if (persistPending.size === 0) return;
  const pending = [...persistPending.values()];
  persistPending.clear();
  try {
    const { persistRuns } = await import("@/lib/db/repos/smartRoutingRunsRepo.js");
    await persistRuns(pending);
  } catch (error) {
    // Roll back: keep the batch so a transient DB failure doesn't lose data.
    for (const run of pending) persistPending.set(run.runId, run);
    console.warn("[smartRoutingTelemetry] persist failed (will retry on next flush):", error?.message || error);
  }
}

/**
 * Hydrate the in-memory registry from the DB after a restart. Only loads when
 * memory is empty (a live session already has everything newer in the bus;
 * merging could resurrect stale rows over live runs). Safe to call multiple
 * times — subsequent calls no-op once runs exist in memory.
 */
export async function hydrateSmartRunsFromDb({ limit = 50 } = {}) {
  if (smartRoutingRuns.size > 0) return false;
  try {
    const { loadRecentRuns } = await import("@/lib/db/repos/smartRoutingRunsRepo.js");
    const runs = await loadRecentRuns({ limit });
    for (const run of runs) {
      if (run?.runId && !smartRoutingRuns.has(run.runId)) smartRoutingRuns.set(run.runId, run);
    }
    return runs.length > 0;
  } catch (error) {
    console.warn("[smartRoutingTelemetry] hydrate from DB failed:", error?.message || error);
    return false;
  }
}

/**
 * Debounced emit — coalesces rapid bursts of the same event key into one
 * emission (mirrors scheduleSwarmEvent). The routing decision itself is a
 * one-shot event, so callers pass delayMs 0 for it.
 */
export function scheduleSmartRoutingEvent(event, payload, delayMs = 120) {
  const key = `${event}:${payload?.runId || ""}`;
  if (emitTimers[key]) clearTimeout(emitTimers[key]);
  emitTimers[key] = setTimeout(() => {
    delete emitTimers[key];
    smartRoutingEmitter.emit(event, payload);
  }, delayMs);
}

/**
 * Create + register a new smart-routing run. Returns the run object.
 * The routing decision is filled in later by updateRoutingDecision once the
 * intent resolver + pool builder return.
 */
export function createSmartRoutingRun({ comboName, promptPreview }) {
  const runId = randomUUID();
  const now = Date.now();
  const run = {
    runId,
    comboName,
    promptPreview: (promptPreview || "").slice(0, 200),
    routing: null,
    servedModel: null,
    status: "running",
    error: null,
    startedAt: now,
    completedAt: null,
    totalDurationMs: null,
  };

  smartRoutingRuns.set(runId, run);
  // Evict oldest COMPLETED runs over the cap — never an in-flight run (its
  // later markServedModel/markRun* calls would silently no-op).
  if (smartRoutingRuns.size > MAX_RUNS_KEPT) {
    const finished = [...smartRoutingRuns.entries()]
      .filter(([, r]) => r.status === "done" || r.status === "error")
      .sort((a, b) => a[1].startedAt - b[1].startedAt);
    while (smartRoutingRuns.size > MAX_RUNS_KEPT && finished.length > 0) {
      smartRoutingRuns.delete(finished.shift()[0]);
    }
  }

  scheduleSmartRoutingEvent(
    "smart:start",
    { type: "smart:start", runId, comboName, promptPreview: run.promptPreview, status: "running" },
    0,
  );
  enqueuePersist(run);
  return run;
}

/**
 * Record the per-request routing decision (reason + selected pool + excluded
 * cookies / pool split + intent detail). Emits smart:route.
 */
export function updateRoutingDecision(runId, routing) {
  const run = smartRoutingRuns.get(runId);
  if (!run) return;
  // Trim arrays to keep the snapshot / SSE payload small.
  const slim = {
    reason: routing?.reason || "general",
    order: Array.isArray(routing?.order) ? routing.order : [],
    excludedCookies: Array.isArray(routing?.excludedCookies) ? routing.excludedCookies : [],
    cookiePool: Array.isArray(routing?.cookiePool) ? routing.cookiePool : [],
    normalPool: Array.isArray(routing?.normalPool) ? routing.normalPool : [],
    intent: routing?.intent || null,
  };
  run.routing = slim;
  scheduleSmartRoutingEvent(
    "smart:route",
    { type: "smart:route", runId, routing: slim, status: "running" },
    0,
  );
  enqueuePersist(run);
}

/**
 * Record which pool member actually answered (known once the fallback chain
 * returns ok, before the response stream necessarily finishes).
 */
export function markServedModel(runId, model) {
  const run = smartRoutingRuns.get(runId);
  if (!run) return;
  run.servedModel = model;
  scheduleSmartRoutingEvent(
    "smart:served",
    { type: "smart:served", runId, servedModel: model, status: "running" },
    0,
  );
  enqueuePersist(run);
}

/**
 * Mark the whole run as errored (terminal).
 */
export function markRunError(runId, error) {
  const run = smartRoutingRuns.get(runId);
  if (!run) return;
  if (run.status === "done" || run.status === "error") return;
  run.status = "error";
  run.error = String(error?.message || error || "unknown");
  run.completedAt = Date.now();
  run.totalDurationMs = run.completedAt - run.startedAt;
  scheduleSmartRoutingEvent(
    "smart:error",
    { type: "smart:error", runId, error: run.error, servedModel: run.servedModel, status: "error", totalDurationMs: run.totalDurationMs },
    0,
  );
  enqueuePersist(run);
}

/**
 * Mark the whole run as completed (terminal, idempotent).
 */
export function markRunComplete(runId, extra = {}) {
  const run = smartRoutingRuns.get(runId);
  if (!run) return;
  if (run.status === "done" || run.status === "error") return;
  run.status = "done";
  run.completedAt = Date.now();
  run.totalDurationMs = run.completedAt - run.startedAt;
  Object.assign(run, extra);
  scheduleSmartRoutingEvent(
    "smart:complete",
    { type: "smart:complete", runId, servedModel: run.servedModel, status: "done", totalDurationMs: run.totalDurationMs, ...extra },
    0,
  );
  enqueuePersist(run);
}

/**
 * Get a snapshot of recent smart-routing runs (newest first).
 * Deep-clones so callers can never mutate the live run objects.
 */
export function getRecentSmartRuns(limit = 20) {
  return [...smartRoutingRuns.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map((r) => structuredClone(r));
}

// Flush pending persistence on graceful shutdown so the last buffered runs
// aren't lost on a clean restart (mirrors requestDetailsRepo).
const _shutdownFlush = async () => {
  try { await flushPersistence(); } catch { /* ignore */ }
};
process.off("beforeExit", _shutdownFlush);
process.off("SIGINT", _shutdownFlush);
process.off("SIGTERM", _shutdownFlush);
process.off("exit", _shutdownFlush);
process.on("beforeExit", _shutdownFlush);
process.on("SIGINT", _shutdownFlush);
process.on("SIGTERM", _shutdownFlush);
process.on("exit", _shutdownFlush);

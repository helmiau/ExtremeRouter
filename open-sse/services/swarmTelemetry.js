/**
 * Swarm Telemetry — in-memory event bus + run registry for Hierarchical Swarm.
 *
 * Mirrors the statsEmitter pattern from usageRepo.js: a singleton EventEmitter
 * with a debounced emit helper so a worker fan-out of N workers doesn't flood
 * the SSE stream. Active runs are kept in an in-memory Map (cleared on restart);
 * history persistence is deferred to Phase 2.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

// Singleton on global to survive Next.js dev hot-reload.
if (!global._swarmEmitter) {
  global._swarmEmitter = new EventEmitter();
  global._swarmEmitter.setMaxListeners(200);
  global._swarmRuns = new Map(); // runId → SwarmRun
  global._swarmEmitTimers = {}; // key → timeout (debounce)
}
const swarmEmitter = global._swarmEmitter;
const swarmRuns = global._swarmRuns;
const emitTimers = global._swarmEmitTimers;

export { swarmEmitter };

const MAX_RUNS_KEPT = 50;

/**
 * Debounced emit. Coalesces rapid bursts of the same event key into a single
 * emission, mirroring scheduleStatsEvent() from usageRepo.js.
 */
export function scheduleSwarmEvent(event, payload, delayMs = 120) {
  // Include worker index in the dedup key so per-worker events (swarm:stage
  // with different worker indices) are NOT collapsed into one. Previously all
  // workers in a run shared the key "swarm:stage:<runId>" and only the last
  // worker's event was emitted — the dashboard lost all other worker statuses.
  const workerKey = payload?.worker !== undefined ? `:w${payload.worker}` : "";
  const key = `${event}:${payload?.runId || ""}${workerKey}`;
  if (emitTimers[key]) clearTimeout(emitTimers[key]);
  emitTimers[key] = setTimeout(() => {
    delete emitTimers[key];
    swarmEmitter.emit(event, payload);
  }, delayMs);
}

/**
 * Create + register a new swarm run. Returns the run object.
 */
export function createSwarmRun({ comboName, promptPreview, managerModel, staffModel, auditModel, workerCount }) {
  const runId = randomUUID();
  const now = Date.now();
  const run = {
    runId,
    comboName,
    promptPreview: (promptPreview || "").slice(0, 200),
    managerModel,
    staffModel,
    auditModel,
    workerCount: workerCount || 0,
    status: "running",
    startedAt: now,
    completedAt: null,
    totalDurationMs: null,
    stages: {
      gatekeeper: { status: "pending", startedAt: null, completedAt: null, durationMs: null, model: managerModel, verdict: null },
      manager: { status: "pending", startedAt: null, completedAt: null, durationMs: null, model: managerModel, strategy: null },
      workers: { status: "pending", startedAt: null, completedAt: null, durationMs: null, workers: [] },
      audit: { status: "pending", startedAt: null, completedAt: null, durationMs: null, model: staffModel || auditModel },
      synthesis: { status: "pending", startedAt: null, completedAt: null, durationMs: null, model: managerModel },
    },
  };

  // Initialize per-worker slots
  for (let i = 0; i < (workerCount || 0); i++) {
    run.stages.workers.workers.push({ index: i, status: "pending", model: null, durationMs: null });
  }

  swarmRuns.set(runId, run);
  // Evict oldest COMPLETED runs if over cap — never evict an in-flight run,
  // or its later markStage*/markRun* calls would silently no-op.
  if (swarmRuns.size > MAX_RUNS_KEPT) {
    const finished = [...swarmRuns.entries()]
      .filter(([, r]) => r.status === "done" || r.status === "error")
      .sort((a, b) => a[1].startedAt - b[1].startedAt);
    while (swarmRuns.size > MAX_RUNS_KEPT && finished.length > 0) {
      swarmRuns.delete(finished.shift()[0]);
    }
  }

  scheduleSwarmEvent("swarm:start", { type: "swarm:start", runId, comboName, promptPreview: run.promptPreview, workerCount: run.workerCount, status: "running" }, 0);
  return run;
}

/**
 * Mark a stage as started/running.
 */
export function markStageStart(runId, stage, extra = {}) {
  const run = swarmRuns.get(runId);
  if (!run) return;
  const s = run.stages[stage];
  if (!s) return;
  s.status = "running";
  s.startedAt = Date.now();
  Object.assign(s, extra);
  // Keep the run-level worker count in sync with the actually-dispatched fan-out
  // (the pre-allocated workerCount is the configured minimum, not the real subtask
  // count the Manager emitted — autoScale can dispatch a different number).
  if (stage === "workers" && typeof extra.workerCount === "number") {
    run.workerCount = extra.workerCount;
  }
  scheduleSwarmEvent("swarm:stage", { type: "swarm:stage", runId, stage, status: "running", ...extra });
}

/**
 * Mark a stage as completed.
 */
export function markStageDone(runId, stage, extra = {}) {
  const run = swarmRuns.get(runId);
  if (!run) return;
  const s = run.stages[stage];
  if (!s) return;
  // Idempotency guard: don't re-complete a stage that's already done.
  if (s.status === "done") return;
  s.status = "done";
  s.completedAt = Date.now();
  s.durationMs = s.startedAt ? s.completedAt - s.startedAt : null;
  // The `workers` key is the per-worker SLOT array owned by markWorkerStatus —
  // never let a stage summary clobber it. Summary payloads (e.g. the
  // `{ index, ok }` results array from dispatchWorkers) are parked in
  // `s.summary` instead, preserving per-worker model/status/durationMs.
  const { workers, ...summary } = extra;
  Object.assign(s, summary);
  if (workers) s.summary = { workerResults: workers };
  scheduleSwarmEvent("swarm:stage", { type: "swarm:stage", runId, stage, status: "done", durationMs: s.durationMs, ...summary });
}

/**
 * Mark an individual worker slot within the workers stage.
 */
export function markWorkerStatus(runId, workerIndex, status, extra = {}) {
  const run = swarmRuns.get(runId);
  if (!run) return;
  // Grow the workers array dynamically if the index exceeds the pre-allocated
  // slots (which were based on the configured workerCount, not the actual
  // subtask count from the Manager strategy).
  while (run.stages.workers.workers.length <= workerIndex) {
    run.stages.workers.workers.push({
      index: run.stages.workers.workers.length,
      status: "pending",
      model: null,
      durationMs: null,
    });
  }
  const w = run.stages.workers.workers[workerIndex];
  if (!w) return;
  if (status === "running" && !w.startedAt) w.startedAt = Date.now();
  if ((status === "done" || status === "error") && !w.completedAt) {
    w.completedAt = Date.now();
    w.durationMs = w.startedAt ? w.completedAt - w.startedAt : null;
  }
  w.status = status;
  Object.assign(w, extra);
  scheduleSwarmEvent("swarm:stage", { type: "swarm:stage", runId, stage: "workers", worker: workerIndex, status, durationMs: w.durationMs, ...extra });
}

/**
 * Mark the whole run as errored.
 */
export function markRunError(runId, error) {
  const run = swarmRuns.get(runId);
  if (!run) return;
  // Idempotency guard: don't overwrite a terminal state.
  if (run.status === "done" || run.status === "error") return;
  run.status = "error";
  run.error = String(error?.message || error || "unknown");
  run.completedAt = Date.now();
  run.totalDurationMs = run.completedAt - run.startedAt;
  scheduleSwarmEvent("swarm:error", { type: "swarm:error", runId, error: run.error, status: "error", totalDurationMs: run.totalDurationMs }, 0);
}

/**
 * Mark the whole run as completed successfully.
 */
export function markRunComplete(runId, extra = {}) {
  const run = swarmRuns.get(runId);
  if (!run) return;
  // Idempotency guard: if the run is already in a terminal state (done/error),
  // don't re-mark it. This prevents double swarm:complete events when the
  // synthesis stream wrapper fires both on natural completion and on cancel.
  if (run.status === "done" || run.status === "error") return;
  run.status = "done";
  run.completedAt = Date.now();
  run.totalDurationMs = run.completedAt - run.startedAt;
  Object.assign(run, extra);
  scheduleSwarmEvent("swarm:complete", { type: "swarm:complete", runId, status: "done", totalDurationMs: run.totalDurationMs, ...extra }, 0);
}

/**
 * Get a snapshot of recent swarm runs (newest first).
 * Used by GET /api/swarm/active for dashboard initial load.
 */
export function getRecentSwarms(limit = 20) {
  // Deep-clone so callers (REST snapshot, SSE initial snapshot, serializers)
  // can never mutate the live run objects or observe a half-updated run.
  return [...swarmRuns.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map((r) => structuredClone(r));
}

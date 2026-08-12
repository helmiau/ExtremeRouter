/**
 * Pure state reducer for SwarmTelemetryMonitor.
 *
 * Extracted from the component so the live-event protocol is unit-testable
 * without React. Consumes the SSE payloads emitted by
 * open-sse/services/swarmTelemetry.js (each live event carries a `type`:
 * "swarm:start" | "swarm:stage" | "swarm:complete" | "swarm:error"; the
 * initial hydrate is `{ type: "snapshot", runs }`).
 */

export const MAX_VISIBLE_RUNS = 50;

function emptyStages() {
  return {
    gatekeeper: { status: "pending" },
    manager: { status: "pending" },
    workers: { status: "pending", workers: [] },
    audit: { status: "pending" },
    synthesis: { status: "pending" },
  };
}

export function swarmRunsReducer(prev, data) {
  // Snapshot: replace all (also on SSE auto-reconnect re-hydration).
  if (data.type === "snapshot" && Array.isArray(data.runs)) {
    return data.runs;
  }
  if (!data.runId) return prev;

  // swarm:start — a brand-new run that isn't in the list yet: insert it at the
  // top. (Previously the reducer only ever updated existing runs, so a run that
  // started after the snapshot never appeared until a page refresh.)
  if (data.type === "swarm:start") {
    const run = {
      runId: data.runId,
      comboName: data.comboName,
      promptPreview: data.promptPreview,
      workerCount: data.workerCount,
      status: "running",
      startedAt: Date.now(),
      totalDurationMs: null,
      stages: emptyStages(),
    };
    return [run, ...prev].slice(0, MAX_VISIBLE_RUNS);
  }

  // Existing run — apply stage / run-level updates immutably.
  return prev.map((run) => {
    if (run.runId !== data.runId) return run;
    const next = { ...run, stages: { ...run.stages } };

    if (data.type === "swarm:stage") {
      if (data.stage === "workers" && data.worker !== undefined) {
        // Per-worker update — grow slots dynamically: the backend grows its
        // slot array the same way, since the pre-allocated count is only the
        // configured minimum, not the actual dispatched fan-out.
        const workers = [...(next.stages.workers?.workers || [])];
        while (workers.length <= data.worker) {
          workers.push({ index: workers.length, status: "pending", model: null });
        }
        workers[data.worker] = {
          ...workers[data.worker],
          status: data.status,
          model: data.model ?? workers[data.worker].model,
          durationMs: data.durationMs ?? workers[data.worker].durationMs,
        };
        next.stages.workers = { ...next.stages.workers, workers };
      } else if (data.stage) {
        next.stages[data.stage] = {
          ...next.stages[data.stage],
          status: data.status,
          durationMs: data.durationMs ?? next.stages[data.stage]?.durationMs,
          model: data.model ?? next.stages[data.stage]?.model,
          verdict: data.verdict ?? next.stages[data.stage]?.verdict,
          strategy: data.strategy ?? next.stages[data.stage]?.strategy,
          skipped: data.skipped ?? next.stages[data.stage]?.skipped,
        };
      }
    } else if (data.type === "swarm:complete") {
      next.status = "done";
      next.totalDurationMs = data.totalDurationMs;
      if (typeof data.workerCount === "number") next.workerCount = data.workerCount;
    } else if (data.type === "swarm:error") {
      next.status = "error";
      next.error = data.error;
      next.totalDurationMs = data.totalDurationMs;
    }
    return next;
  });
}

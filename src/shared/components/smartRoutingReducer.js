/**
 * Pure state reducer for SmartRoutingTelemetryMonitor.
 *
 * Extracted from the component so the live-event protocol is unit-testable
 * without React. Consumes the SSE payloads emitted by
 * open-sse/services/smartRoutingTelemetry.js (each live event carries a `type`:
 * "smart:start" | "smart:route" | "smart:served" | "smart:complete" |
 * "smart:error"; the initial hydrate is `{ type: "snapshot", runs }`).
 *
 * A run is: { runId, comboName, promptPreview, routing, servedModel, status,
 * error, startedAt, totalDurationMs } where `routing` is the per-request
 * decision { reason, order, excludedCookies, cookiePool, normalPool, intent }.
 */

export const MAX_VISIBLE_RUNS = 50;

export function smartRoutingRunsReducer(prev, data) {
  // Snapshot: replace all (also on SSE auto-reconnect re-hydration).
  if (data.type === "snapshot" && Array.isArray(data.runs)) {
    return data.runs;
  }
  if (!data.runId) return prev;

  // smart:start — a brand-new run that isn't in the list yet: insert at top.
  if (data.type === "smart:start") {
    const run = {
      runId: data.runId,
      comboName: data.comboName,
      promptPreview: data.promptPreview,
      routing: null,
      servedModel: null,
      status: "running",
      error: null,
      startedAt: Date.now(),
      totalDurationMs: null,
    };
    return [run, ...prev].slice(0, MAX_VISIBLE_RUNS);
  }

  // Existing run — apply updates immutably.
  return prev.map((run) => {
    if (run.runId !== data.runId) return run;
    const next = { ...run };

    if (data.type === "smart:route") {
      next.routing = data.routing;
    } else if (data.type === "smart:served") {
      next.servedModel = data.servedModel;
    } else if (data.type === "smart:complete") {
      next.status = "done";
      next.totalDurationMs = data.totalDurationMs;
    } else if (data.type === "smart:error") {
      next.status = "error";
      next.error = data.error;
      next.totalDurationMs = data.totalDurationMs;
    }
    return next;
  });
}

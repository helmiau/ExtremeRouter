import { beforeEach, describe, it, expect } from "vitest";
import {
  createSwarmRun,
  markStageStart,
  markStageDone,
  markWorkerStatus,
  markRunComplete,
  markRunError,
  getRecentSwarms,
  swarmEmitter,
} from "open-sse/services/swarmTelemetry.js";
import { swarmRunsReducer, MAX_VISIBLE_RUNS } from "@/shared/components/swarmReducer";

// ── Test helpers ───────────────────────────────────────────────────────────

beforeEach(() => {
  // Isolate the in-memory run registry + pending emit timers between tests.
  // (Debounced stage events fire 120ms later and would otherwise leak into
  // the next test's capture window.)
  global._swarmRuns.clear();
  for (const key of Object.keys(global._swarmEmitTimers)) {
    clearTimeout(global._swarmEmitTimers[key]);
    delete global._swarmEmitTimers[key];
  }
});

const tick = () => new Promise((r) => setTimeout(r, 60));

/** Capture emitted events for the given names, removing listeners after. */
function capture(eventNames = ["swarm:start", "swarm:stage", "swarm:complete", "swarm:error"]) {
  const events = [];
  const on = (p) => events.push(p);
  for (const ev of eventNames) swarmEmitter.on(ev, on);
  return () => {
    for (const ev of eventNames) swarmEmitter.off(ev, on);
    return events;
  };
}

// ── Wire protocol: every live event carries a `type` (audit Bug A + B) ─────

describe("wire protocol", () => {
  it("emits `type` on every live event kind the client keys off", async () => {
    const stop = capture();
    const run = createSwarmRun({ comboName: "c1", promptPreview: "p", managerModel: "m", workerCount: 2 });
    await tick();
    markStageStart(run.runId, "gatekeeper");
    markWorkerStatus(run.runId, 0, "running", { model: "m1" });
    await tick();
    markRunComplete(run.runId, { workerCount: 2 });
    await tick();
    const events = stop();

    const types = new Set(events.map((e) => e.type));
    expect(types.has("swarm:start")).toBe(true);
    expect(types.has("swarm:stage")).toBe(true);
    expect(types.has("swarm:complete")).toBe(true);
  });

  it("emits `type: swarm:error` on run errors", async () => {
    const stop = capture(["swarm:error"]);
    const run = createSwarmRun({ comboName: "c1", promptPreview: "p", managerModel: "m", workerCount: 1 });
    await tick();
    markRunError(run.runId, new Error("boom"));
    await tick();
    const [errEvent] = stop();
    expect(errEvent.type).toBe("swarm:error");
    expect(errEvent.status).toBe("error");
    expect(errEvent.error).toBe("boom");
  });
});

// ── Client reducer (shared module) ─────────────────────────────────────────

describe("swarmRunsReducer", () => {
  it("inserts a run that starts after the snapshot (audit Bug A fix)", () => {
    let state = swarmRunsReducer([], { type: "snapshot", runs: [] });
    expect(state).toEqual([]);

    state = swarmRunsReducer(state, {
      type: "swarm:start",
      runId: "r1",
      comboName: "combo-x",
      promptPreview: "build a thing",
      workerCount: 3,
    });

    expect(state).toHaveLength(1);
    expect(state[0].runId).toBe("r1");
    expect(state[0].status).toBe("running");
    expect(state[0].stages.gatekeeper.status).toBe("pending");
  });

  it("transitions a run to done on swarm:complete (audit Bug B fix)", () => {
    let state = swarmRunsReducer([], {
      type: "swarm:start",
      runId: "r1",
      comboName: "combo-x",
      promptPreview: "p",
      workerCount: 2,
    });

    state = swarmRunsReducer(state, {
      type: "swarm:stage",
      runId: "r1",
      stage: "workers",
      status: "done",
      durationMs: 1200,
    });
    expect(state[0].stages.workers.status).toBe("done");

    state = swarmRunsReducer(state, {
      type: "swarm:complete",
      runId: "r1",
      status: "done",
      totalDurationMs: 5000,
      workerCount: 2,
    });
    expect(state[0].status).toBe("done");
    expect(state[0].totalDurationMs).toBe(5000);
  });

  it("transitions a run to error on swarm:error", () => {
    let state = swarmRunsReducer([], {
      type: "swarm:start",
      runId: "r1",
      comboName: "combo-x",
      promptPreview: "p",
      workerCount: 1,
    });
    state = swarmRunsReducer(state, { type: "swarm:error", runId: "r1", error: "kaboom", totalDurationMs: 99 });
    expect(state[0].status).toBe("error");
    expect(state[0].error).toBe("kaboom");
  });

  it("grows worker slots dynamically for indexes beyond the snapshot count", () => {
    let state = swarmRunsReducer([], {
      type: "swarm:start",
      runId: "r1",
      comboName: "c",
      promptPreview: "p",
      workerCount: 1, // configured minimum — actual fan-out is 3
    });

    for (let i = 0; i < 3; i++) {
      state = swarmRunsReducer(state, {
        type: "swarm:stage",
        runId: "r1",
        stage: "workers",
        worker: i,
        status: "done",
        model: `m${i}`,
        durationMs: 100 + i,
      });
    }
    expect(state[0].stages.workers.workers).toHaveLength(3);
    expect(state[0].stages.workers.workers[2].model).toBe("m2");
    expect(state[0].stages.workers.workers[2].status).toBe("done");
  });

  it("caps the visible run list", () => {
    let state = [];
    for (let i = 0; i < MAX_VISIBLE_RUNS + 5; i++) {
      state = swarmRunsReducer(state, {
        type: "swarm:start",
        runId: `r${i}`,
        comboName: "c",
        promptPreview: "p",
        workerCount: 1,
      });
    }
    expect(state).toHaveLength(MAX_VISIBLE_RUNS);
    expect(state[0].runId).toBe(`r${MAX_VISIBLE_RUNS + 4}`);
  });

  it("keeps per-worker detail when a stage-level workers event arrives (no clobber)", () => {
    let state = swarmRunsReducer([], {
      type: "swarm:start",
      runId: "r1",
      comboName: "c",
      promptPreview: "p",
      workerCount: 2,
    });
    state = swarmRunsReducer(state, {
      type: "swarm:stage",
      runId: "r1",
      stage: "workers",
      worker: 0,
      status: "done",
      model: "m1",
      durationMs: 42,
    });
    // A stage-level workers event must not wipe the slot array.
    state = swarmRunsReducer(state, {
      type: "swarm:stage",
      runId: "r1",
      stage: "workers",
      status: "done",
      durationMs: 900,
    });
    expect(state[0].stages.workers.status).toBe("done");
    expect(state[0].stages.workers.workers[0].model).toBe("m1");
    expect(state[0].stages.workers.workers[0].status).toBe("done");
  });
});

// ── Backend run registry ───────────────────────────────────────────────────

describe("run registry integrity", () => {
  it("markStageDone('workers') no longer clobbers per-worker slots (audit Bug C fix)", async () => {
    const run = createSwarmRun({ comboName: "c1", promptPreview: "p", managerModel: "m", workerCount: 2 });
    markWorkerStatus(run.runId, 0, "running", { model: "m1" });
    markWorkerStatus(run.runId, 0, "done", { model: "m1", outputLen: 42 });
    markWorkerStatus(run.runId, 1, "done", { model: "m2", outputLen: 12 });

    // dispatchWorkers passes the { index, ok } summary under the `workers` key.
    markStageDone(run.runId, "workers", { workers: [{ index: 0, ok: true }, { index: 1, ok: true }] });

    const w = run.stages.workers.workers;
    expect(w[0].model).toBe("m1");
    expect(w[0].status).toBe("done");
    expect(w[0].outputLen).toBe(42);
    expect(w[1].model).toBe("m2");
    // Summary parked separately, not on the slots:
    expect(run.stages.workers.summary.workerResults).toEqual([
      { index: 0, ok: true },
      { index: 1, ok: true },
    ]);
  });

  it("tracks worker durationMs from running → done", async () => {
    const run = createSwarmRun({ comboName: "c1", promptPreview: "p", managerModel: "m", workerCount: 1 });
    markWorkerStatus(run.runId, 0, "running", { model: "m1" });
    markWorkerStatus(run.runId, 0, "done", { model: "m1" });
    const w = run.stages.workers.workers[0];
    expect(w.durationMs).toBeGreaterThanOrEqual(0);
    expect(w.completedAt).toBeGreaterThanOrEqual(w.startedAt);
  });

  it("grows the backend slot array beyond the configured workerCount", async () => {
    const run = createSwarmRun({ comboName: "c1", promptPreview: "p", managerModel: "m", workerCount: 2 });
    markWorkerStatus(run.runId, 4, "done", { model: "m5" });
    expect(run.stages.workers.workers).toHaveLength(5);
    expect(run.stages.workers.workers[4].model).toBe("m5");
  });

  it("markStageStart('workers') syncs run.workerCount to the actual fan-out", async () => {
    const run = createSwarmRun({ comboName: "c1", promptPreview: "p", managerModel: "m", workerCount: 2 });
    markStageStart(run.runId, "workers", { workerCount: 7 });
    expect(run.workerCount).toBe(7);
  });

  it("getRecentSwarms returns deep clones — mutation cannot leak into live runs", async () => {
    const run = createSwarmRun({ comboName: "c1", promptPreview: "p", managerModel: "m", workerCount: 1 });
    const snap = getRecentSwarms(50)[0];
    expect(snap).not.toBe(run);
    snap.status = "done";
    snap.stages.gatekeeper.status = "done";
    expect(run.status).toBe("running");
    expect(run.stages.gatekeeper.status).toBe("pending");
  });

  it("eviction never removes an in-flight (running) run", async () => {
    // Fill the registry past the cap with completed runs, plus one running run.
    const running = createSwarmRun({ comboName: "keep", promptPreview: "p", managerModel: "m", workerCount: 1 });
    markRunComplete(running.runId); // oops — complete it so it's not "running"
    expect(running.status).toBe("done");

    // Now create a genuinely running run and a flood of completed ones.
    const active = createSwarmRun({ comboName: "active", promptPreview: "p", managerModel: "m", workerCount: 1 });
    for (let i = 0; i < 60; i++) {
      const r = createSwarmRun({ comboName: `flood-${i}`, promptPreview: "p", managerModel: "m", workerCount: 1 });
      markRunComplete(r.runId);
    }
    // The active (never-completed) run must still be present.
    const ids = new Set(getRecentSwarms(200).map((r) => r.runId));
    expect(ids.has(active.runId)).toBe(true);
    expect(global._swarmRuns.size).toBeLessThanOrEqual(51);
  });

  it("markRunComplete is idempotent — a single swarm:complete event", async () => {
    const stop = capture(["swarm:complete"]);
    const run = createSwarmRun({ comboName: "c1", promptPreview: "p", managerModel: "m", workerCount: 1 });
    await tick();
    markRunComplete(run.runId, { workerCount: 1 });
    markRunComplete(run.runId, { workerCount: 1 }); // second call must no-op
    await tick();
    const events = stop();
    expect(events).toHaveLength(1);
    expect(run.status).toBe("done");
  });

  it("markRunError is a terminal state — later completion is ignored", async () => {
    const run = createSwarmRun({ comboName: "c1", promptPreview: "p", managerModel: "m", workerCount: 1 });
    markRunError(run.runId, new Error("boom"));
    markRunComplete(run.runId, { workerCount: 1 });
    expect(run.status).toBe("error");
    expect(run.error).toBe("boom");
  });
});

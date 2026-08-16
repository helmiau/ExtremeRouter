import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  createSmartRoutingRun,
  updateRoutingDecision,
  markServedModel,
  markRunComplete,
  markRunError,
  getRecentSmartRuns,
  smartRoutingEmitter,
  flushPersistence,
  hydrateSmartRunsFromDb,
} from "open-sse/services/smartRoutingTelemetry.js";
import { smartRoutingRunsReducer, MAX_VISIBLE_RUNS } from "@/shared/components/smartRoutingReducer";
import { buildIntentResolver, detectResearchHeuristic } from "open-sse/services/smartRouting.js";

// The telemetry module dynamic-imports the DB repo for persistence — mock it
// so flush/hydrate tests are deterministic and never touch a real database.
vi.mock("@/lib/db/repos/smartRoutingRunsRepo.js", () => ({
  persistRuns: vi.fn(async () => {}),
  loadRecentRuns: vi.fn(async () => []),
}));

const { persistRuns: persistRunsMock, loadRecentRuns: loadRecentRunsMock } = await import("@/lib/db/repos/smartRoutingRunsRepo.js");

// ── Test helpers ───────────────────────────────────────────────────────────

beforeEach(() => {
  // Isolate the in-memory run registry + pending emit timers between tests.
  global._smartRoutingRuns.clear();
  for (const key of Object.keys(global._smartRoutingEmitTimers)) {
    clearTimeout(global._smartRoutingEmitTimers[key]);
    delete global._smartRoutingEmitTimers[key];
  }
  // Isolate the persistence buffer + flush timer.
  global._smartRoutingPersistPending.clear();
  if (global._smartRoutingPersistTimer) {
    clearTimeout(global._smartRoutingPersistTimer);
    global._smartRoutingPersistTimer = null;
  }
  vi.clearAllMocks();
});

const tick = () => new Promise((r) => setTimeout(r, 60));

/** Capture emitted events for the given names, removing listeners after. */
function capture(eventNames = ["smart:start", "smart:route", "smart:served", "smart:complete", "smart:error"]) {
  const events = [];
  const on = (p) => events.push(p);
  for (const ev of eventNames) smartRoutingEmitter.on(ev, on);
  return () => {
    for (const ev of eventNames) smartRoutingEmitter.off(ev, on);
    return events;
  };
}

const TOOL_ROUTING = {
  reason: "tool_calling",
  order: ["kr/claude-opus-4-7", "glm/glm-5.1"],
  excludedCookies: ["felo-web/deepseek-v4-flash", "felo-web/perplexity-web"],
  intent: { intent: "general", source: "heuristic", signal: "none", confidence: 0.4, classifierModel: null },
};

// ── Wire protocol: every live event carries a `type` ───────────────────────

describe("wire protocol", () => {
  it("emits `type` on every live event kind the client keys off", async () => {
    const stop = capture();
    const run = createSmartRoutingRun({ comboName: "ai-researcher", promptPreview: "research this" });
    await tick();
    updateRoutingDecision(run.runId, TOOL_ROUTING);
    markServedModel(run.runId, "kr/claude-opus-4-7");
    await tick();
    markRunComplete(run.runId);
    await tick();
    const events = stop();

    const types = new Set(events.map((e) => e.type));
    expect(types.has("smart:start")).toBe(true);
    expect(types.has("smart:route")).toBe(true);
    expect(types.has("smart:served")).toBe(true);
    expect(types.has("smart:complete")).toBe(true);
  });

  it("emits `type: smart:error` on run errors", async () => {
    const stop = capture(["smart:error"]);
    const run = createSmartRoutingRun({ comboName: "c1", promptPreview: "p" });
    await tick();
    markRunError(run.runId, new Error("boom"));
    await tick();
    const [errEvent] = stop();
    expect(errEvent.type).toBe("smart:error");
    expect(errEvent.status).toBe("error");
    expect(errEvent.error).toBe("boom");
  });

  it("carries the routing decision (reason + pool + excluded cookies) on smart:route", async () => {
    const stop = capture(["smart:route"]);
    const run = createSmartRoutingRun({ comboName: "c1", promptPreview: "p" });
    await tick();
    updateRoutingDecision(run.runId, TOOL_ROUTING);
    await tick();
    const [routeEvent] = stop();
    expect(routeEvent.routing.reason).toBe("tool_calling");
    expect(routeEvent.routing.order).toEqual(["kr/claude-opus-4-7", "glm/glm-5.1"]);
    expect(routeEvent.routing.excludedCookies).toHaveLength(2);
  });
});

// ── Client reducer (shared module) ─────────────────────────────────────────

describe("smartRoutingRunsReducer", () => {
  it("inserts a run that starts after the snapshot", () => {
    let state = smartRoutingRunsReducer([], { type: "snapshot", runs: [] });
    expect(state).toEqual([]);

    state = smartRoutingRunsReducer(state, {
      type: "smart:start",
      runId: "r1",
      comboName: "ai-researcher",
      promptPreview: "build a thing",
    });
    expect(state).toHaveLength(1);
    expect(state[0].runId).toBe("r1");
    expect(state[0].status).toBe("running");
    expect(state[0].routing).toBeNull();
  });

  it("attaches the routing decision on smart:route", () => {
    let state = smartRoutingRunsReducer([], {
      type: "smart:start",
      runId: "r1",
      comboName: "c",
      promptPreview: "p",
    });
    state = smartRoutingRunsReducer(state, { type: "smart:route", runId: "r1", routing: TOOL_ROUTING });
    expect(state[0].routing.reason).toBe("tool_calling");
    expect(state[0].routing.excludedCookies).toHaveLength(2);
    expect(state[0].status).toBe("running");
  });

  it("records the served model on smart:served", () => {
    let state = smartRoutingRunsReducer([], {
      type: "smart:start",
      runId: "r1",
      comboName: "c",
      promptPreview: "p",
    });
    state = smartRoutingRunsReducer(state, { type: "smart:served", runId: "r1", servedModel: "kr/claude-opus-4-7" });
    expect(state[0].servedModel).toBe("kr/claude-opus-4-7");
  });

  it("transitions to done on smart:complete, preserving the decision", () => {
    let state = smartRoutingRunsReducer([], {
      type: "smart:start",
      runId: "r1",
      comboName: "c",
      promptPreview: "p",
    });
    state = smartRoutingRunsReducer(state, { type: "smart:route", runId: "r1", routing: TOOL_ROUTING });
    state = smartRoutingRunsReducer(state, { type: "smart:complete", runId: "r1", status: "done", totalDurationMs: 5000 });
    expect(state[0].status).toBe("done");
    expect(state[0].totalDurationMs).toBe(5000);
    expect(state[0].routing.reason).toBe("tool_calling"); // not clobbered
  });

  it("transitions to error on smart:error", () => {
    let state = smartRoutingRunsReducer([], {
      type: "smart:start",
      runId: "r1",
      comboName: "c",
      promptPreview: "p",
    });
    state = smartRoutingRunsReducer(state, { type: "smart:error", runId: "r1", error: "kaboom", totalDurationMs: 99 });
    expect(state[0].status).toBe("error");
    expect(state[0].error).toBe("kaboom");
  });

  it("caps the visible run list", () => {
    let state = [];
    for (let i = 0; i < MAX_VISIBLE_RUNS + 5; i++) {
      state = smartRoutingRunsReducer(state, {
        type: "smart:start",
        runId: `r${i}`,
        comboName: "c",
        promptPreview: "p",
      });
    }
    expect(state).toHaveLength(MAX_VISIBLE_RUNS);
    expect(state[0].runId).toBe(`r${MAX_VISIBLE_RUNS + 4}`);
  });
});

// ── Backend run registry ───────────────────────────────────────────────────

describe("run registry integrity", () => {
  it("getRecentSmartRuns returns deep clones — mutation cannot leak into live runs", async () => {
    const run = createSmartRoutingRun({ comboName: "c1", promptPreview: "p" });
    updateRoutingDecision(run.runId, TOOL_ROUTING);
    const snap = getRecentSmartRuns(50)[0];
    expect(snap).not.toBe(run);
    expect(snap.routing).not.toBe(run.routing);
    snap.status = "done";
    snap.routing.reason = "general";
    expect(run.status).toBe("running");
    expect(run.routing.reason).toBe("tool_calling");
  });

  it("eviction never removes an in-flight (running) run", async () => {
    const active = createSmartRoutingRun({ comboName: "active", promptPreview: "p" });
    for (let i = 0; i < 60; i++) {
      const r = createSmartRoutingRun({ comboName: `flood-${i}`, promptPreview: "p" });
      markRunComplete(r.runId);
    }
    const ids = new Set(getRecentSmartRuns(200).map((r) => r.runId));
    expect(ids.has(active.runId)).toBe(true);
    expect(global._smartRoutingRuns.size).toBeLessThanOrEqual(51);
  });

  it("markRunComplete is idempotent — a single smart:complete event", async () => {
    const stop = capture(["smart:complete"]);
    const run = createSmartRoutingRun({ comboName: "c1", promptPreview: "p" });
    await tick();
    markRunComplete(run.runId);
    markRunComplete(run.runId); // second call must no-op
    await tick();
    const events = stop();
    expect(events).toHaveLength(1);
    expect(run.status).toBe("done");
  });

  it("markRunError is terminal — later completion is ignored", async () => {
    const run = createSmartRoutingRun({ comboName: "c1", promptPreview: "p" });
    markRunError(run.runId, new Error("boom"));
    markRunComplete(run.runId);
    expect(run.status).toBe("error");
    expect(run.error).toBe("boom");
  });

  it("markRunComplete carries the servedModel recorded earlier", async () => {
    const stop = capture(["smart:complete"]);
    const run = createSmartRoutingRun({ comboName: "c1", promptPreview: "p" });
    markServedModel(run.runId, "kr/claude-opus-4-7");
    await tick();
    markRunComplete(run.runId);
    await tick();
    const [completeEvent] = stop();
    expect(completeEvent.servedModel).toBe("kr/claude-opus-4-7");
  });
});

// ── Intent resolver reporting (telemetry hook) ─────────────────────────────

describe("buildIntentResolver onIntent reporting", () => {
  it("reports heuristic keyword hit with confidence and no classifier", async () => {
    const reports = [];
    const resolve = buildIntentResolver({
      config: { intentDetection: { confidenceThreshold: 0.6 } },
      onIntent: (d) => reports.push(d),
    });
    const intent = await resolve("please research the latest trends");
    expect(intent).toBe("research");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      intent: "research",
      source: "heuristic",
      signal: "keyword",
      confidence: 0.75,
      classifierModel: null,
    });
  });

  it("reports classifier usage when the heuristic is ambiguous and enabled", async () => {
    const reports = [];
    const resolve = buildIntentResolver({
      config: {
        intentDetection: {
          confidenceThreshold: 0.6,
          llmClassifierFallback: { enabled: true, model: "kr/claude-haiku-4.5" },
        },
      },
      handleSingleModel: async () => ({
        ok: true,
        status: 200,
        clone: () => ({ json: async () => ({ choices: [{ message: { content: "research" } }] }) }),
      }),
      onIntent: (d) => reports.push(d),
    });
    const intent = await resolve("hello there");
    expect(intent).toBe("research");
    expect(reports[0]).toMatchObject({
      intent: "research",
      source: "classifier",
      signal: "none",
      classifierModel: "kr/claude-haiku-4.5",
    });
  });

  it("degrades to heuristic report when the classifier throws", async () => {
    const reports = [];
    const resolve = buildIntentResolver({
      config: {
        intentDetection: {
          confidenceThreshold: 0.6,
          llmClassifierFallback: { enabled: true, model: "kr/claude-haiku-4.5" },
        },
      },
      handleSingleModel: async () => { throw new Error("network down"); },
      onIntent: (d) => reports.push(d),
    });
    const intent = await resolve("hello there");
    expect(intent).toBe("general");
    expect(reports[0].source).toBe("heuristic");
    expect(reports[0].classifierModel).toBeNull();
  });

  it("does not throw when onIntent itself throws", async () => {
    const resolve = buildIntentResolver({
      config: { intentDetection: { confidenceThreshold: 0.6 } },
      onIntent: () => { throw new Error("reporter bug"); },
    });
    await expect(resolve("research this")).resolves.toBe("research");
  });

  it("detectResearchHeuristic still distinguishes url/keyword/none signals", () => {
    expect(detectResearchHeuristic("check https://example.com").signal).toBe("url");
    expect(detectResearchHeuristic("compare options").signal).toBe("keyword");
    expect(detectResearchHeuristic("hello world").signal).toBe("none");
  });
});

// ── Persistence: buffered writes + DB hydration ────────────────────────────

describe("persistence", () => {
  afterEach(() => {
    // Drop any flush timer + buffer left by enqueuePersist so a pending 2s
    // timer never delays the suite.
    global._smartRoutingPersistPending.clear();
    if (global._smartRoutingPersistTimer) {
      clearTimeout(global._smartRoutingPersistTimer);
      global._smartRoutingPersistTimer = null;
    }
  });

  it("enqueues the run for persistence on mutations (deduped by runId)", () => {
    const run = createSmartRoutingRun({ comboName: "c1", promptPreview: "p" });
    updateRoutingDecision(run.runId, TOOL_ROUTING);
    markServedModel(run.runId, "kr/claude-opus-4-7");
    // Multiple mutations collapse into ONE pending entry with the latest state.
    expect(global._smartRoutingPersistPending.size).toBe(1);
    const pending = [...global._smartRoutingPersistPending.values()][0];
    expect(pending.servedModel).toBe("kr/claude-opus-4-7");
    expect(pending.routing.reason).toBe("tool_calling");
  });

  it("flushPersistence drains the buffer to the repo with the latest state", async () => {
    const run = createSmartRoutingRun({ comboName: "c1", promptPreview: "p" });
    updateRoutingDecision(run.runId, TOOL_ROUTING);
    markRunComplete(run.runId);

    await flushPersistence();
    expect(persistRunsMock).toHaveBeenCalledTimes(1);
    const [batch] = persistRunsMock.mock.calls[0];
    expect(batch).toHaveLength(1);
    expect(batch[0].runId).toBe(run.runId);
    expect(batch[0].status).toBe("done");
    expect(batch[0].routing.reason).toBe("tool_calling");
    expect(global._smartRoutingPersistPending.size).toBe(0);
  });

  it("hydrateSmartRunsFromDb loads persisted history into memory on restart", async () => {
    const stored = {
      runId: "old-1",
      comboName: "ai-researcher",
      promptPreview: "research from yesterday",
      routing: { reason: "general", order: ["kr/claude-opus-4-7"], excludedCookies: [], cookiePool: [], normalPool: [], intent: null },
      servedModel: "kr/claude-opus-4-7",
      status: "done",
      error: null,
      startedAt: Date.now() - 86400000,
      completedAt: Date.now() - 86390000,
      totalDurationMs: 10000,
    };
    loadRecentRunsMock.mockReturnValueOnce([stored]);

    const loaded = await hydrateSmartRunsFromDb({ limit: 50 });
    expect(loaded).toBe(true);
    const runs = getRecentSmartRuns(50);
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("old-1");
    expect(runs[0].routing.reason).toBe("general");

    // Second hydrate call is a no-op once live runs exist (no stale resurrection).
    const again = await hydrateSmartRunsFromDb({ limit: 50 });
    expect(again).toBe(false);
    expect(loadRecentRunsMock).toHaveBeenCalledTimes(1);
  });

  it("hydrateSmartRunsFromDb never resurrects rows over live in-flight runs", async () => {
    createSmartRoutingRun({ comboName: "live", promptPreview: "p" });
    loadRecentRunsMock.mockReturnValueOnce([{ runId: "db-row", comboName: "old", status: "done", startedAt: 1, routing: null }]);
    const loaded = await hydrateSmartRunsFromDb({ limit: 50 });
    expect(loaded).toBe(false);
    expect(getRecentSmartRuns(50)).toHaveLength(1);
    expect(getRecentSmartRuns(50)[0].comboName).toBe("live");
  });

  it("persistence failure degrades silently — routing unaffected", async () => {
    persistRunsMock.mockRejectedValueOnce(new Error("db locked"));
    const run = createSmartRoutingRun({ comboName: "c1", promptPreview: "p" });
    markRunComplete(run.runId);
    await expect(flushPersistence()).resolves.toBeUndefined();
    // Rolled back for retry on the next flush.
    expect(global._smartRoutingPersistPending.size).toBe(1);
    // The live run registry + emit protocol still work.
    expect(run.status).toBe("done");
  });
});

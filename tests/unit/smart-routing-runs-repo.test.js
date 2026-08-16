// Guards smart-routing telemetry persistence: the repo must upsert runs with
// the routing decision JSON intact, prune past the retention cap, and parse
// stored rows back into the run shape the UI reducer expects.
import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn();
const getMock = vi.fn(() => ({ c: 0 }));
const allMock = vi.fn(() => []);
const transactionMock = vi.fn();

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({
    run: runMock,
    get: getMock,
    all: allMock,
    transaction: transactionMock,
  })),
}));

const { persistRuns, loadRecentRuns, queryHistory, getDistinctCombos, DEFAULT_MAX_RECORDS } = await import("../../src/lib/db/repos/smartRoutingRunsRepo.js");

const SAMPLE_RUN = {
  runId: "r1",
  comboName: "ai-researcher",
  promptPreview: "research the latest AI trends",
  lastUserMessage: "research the latest AI trends and cite sources from reputable publications",
  routing: {
    reason: "research_cookie_primary",
    order: ["felo-web/deepseek-v4-flash", "kr/claude-opus-4-7"],
    excludedCookies: [],
    cookiePool: ["felo-web/deepseek-v4-flash"],
    normalPool: ["kr/claude-opus-4-7"],
    intent: { intent: "research", source: "heuristic", signal: "keyword", confidence: 0.75, classifierModel: null },
  },
  servedModel: "felo-web/deepseek-v4-flash",
  status: "done",
  error: null,
  startedAt: 1000,
  completedAt: 5000,
  totalDurationMs: 4000,
};

describe("smartRoutingRunsRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockImplementation((fn) => fn());
  });

  it("upserts a run with the routing decision stored as JSON + dedicated reason column", async () => {
    await persistRuns([SAMPLE_RUN]);
    const insertCall = runMock.mock.calls.find((c) => c[0].startsWith("INSERT INTO smartRoutingRuns"));
    expect(insertCall).toBeTruthy();
    const [id, comboName, promptPreview, lastUserMessage, routingJson, reasonCol, servedModel, status, error, startedAt, completedAt, totalDurationMs] = insertCall[1];
    expect(id).toBe("r1");
    expect(comboName).toBe("ai-researcher");
    expect(promptPreview).toBe("research the latest AI trends");
    expect(lastUserMessage).toContain("cite sources");
    expect(status).toBe("done");
    expect(reasonCol).toBe("research_cookie_primary");
    expect(startedAt).toBe("1000");
    expect(totalDurationMs).toBe(4000);
    const routing = JSON.parse(routingJson);
    expect(routing.reason).toBe("research_cookie_primary");
    expect(routing.cookiePool).toEqual(["felo-web/deepseek-v4-flash"]);
    expect(routing.intent.signal).toBe("keyword");
    expect(servedModel).toBe("felo-web/deepseek-v4-flash");
    expect(error).toBeNull();
  });

  it("stores null routing for a run that never got a decision", async () => {
    await persistRuns([{ runId: "r2", comboName: "c", startedAt: 1, status: "running" }]);
    const insertCall = runMock.mock.calls.find((c) => c[0].startsWith("INSERT INTO smartRoutingRuns"));
    expect(insertCall[1][3]).toBeNull();
  });

  it("prunes rows beyond the retention cap (oldest removed)", async () => {
    getMock.mockReturnValueOnce({ c: DEFAULT_MAX_RECORDS + 25 });
    await persistRuns([SAMPLE_RUN]);
    const pruneCall = runMock.mock.calls.find((c) => c[0].startsWith("DELETE FROM smartRoutingRuns"));
    expect(pruneCall).toBeTruthy();
    expect(pruneCall[1][0]).toBe(25); // DELETE ... LIMIT 25
  });

  it("does not prune when under the cap", async () => {
    await persistRuns([SAMPLE_RUN]);
    const pruneCall = runMock.mock.calls.find((c) => c[0].startsWith("DELETE FROM smartRoutingRuns"));
    expect(pruneCall).toBeUndefined();
  });

  it("loads runs back with routing parsed and timestamps as numbers", async () => {
    allMock.mockReturnValueOnce([
      {
        id: "r1",
        comboName: "ai-researcher",
        promptPreview: "research the latest AI trends",
        lastUserMessage: "research the latest AI trends and cite sources from reputable publications",
        routing: JSON.stringify(SAMPLE_RUN.routing),
        servedModel: "felo-web/deepseek-v4-flash",
        status: "done",
        error: null,
        startedAt: "1000",
        completedAt: "5000",
        totalDurationMs: 4000,
      },
    ]);
    const runs = await loadRecentRuns({ limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("r1");
    expect(runs[0].routing.reason).toBe("research_cookie_primary");
    expect(runs[0].lastUserMessage).toContain("cite sources");
    expect(runs[0].startedAt).toBe(1000);
    expect(runs[0].completedAt).toBe(5000);
    expect(runs[0].totalDurationMs).toBe(4000);
  });

  it("fetches a single run by id (A/B Lab run picker)", async () => {
    getMock.mockReturnValueOnce({
      id: "r1",
      comboName: "ai-researcher",
      promptPreview: "p",
      lastUserMessage: "full prompt text",
      routing: JSON.stringify({ reason: "tool_calling", order: ["kr/claude-opus-4-7"], excludedCookies: ["felo-web/deepseek-v4-flash"], cookiePool: [], normalPool: [] }),
      servedModel: "kr/claude-opus-4-7",
      status: "done",
      startedAt: "1000",
    });
    const { getSmartRunById } = await import("../../src/lib/db/repos/smartRoutingRunsRepo.js");
    const run = await getSmartRunById("r1");
    expect(run.runId).toBe("r1");
    expect(run.lastUserMessage).toBe("full prompt text");
    expect(run.routing.reason).toBe("tool_calling");
    // Unknown id → null, never throws.
    getMock.mockReturnValueOnce(undefined);
    expect(await getSmartRunById("missing")).toBeNull();
    expect(await getSmartRunById(null)).toBeNull();
  });

  it("skips rows with malformed routing JSON instead of crashing the load", async () => {
    allMock.mockReturnValueOnce([
      { id: "bad", comboName: "c", routing: "{not json", status: "done", startedAt: "1" },
      { id: "good", comboName: "c", routing: JSON.stringify({ reason: "general", order: ["x"] }), status: "done", startedAt: "2" },
    ]);
    const runs = await loadRecentRuns({ limit: 10 });
    expect(runs[0].runId).toBe("bad");
    expect(runs[0].routing).toBeNull(); // parseJson falls back to null
    expect(runs[1].routing.reason).toBe("general");
  });
});

// ── Paged history query (dashboard filters + pagination) ───────────────────

describe("queryHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockImplementation((fn) => fn());
  });

  it("builds WHERE conditions for combo/status/reason filters", async () => {
    await queryHistory({ comboName: "ai-researcher", status: "done", reason: "tool_calling" });
    const allCall = allMock.mock.calls.find((c) => c[0].includes("FROM smartRoutingRuns"));
    expect(allCall[0]).toContain("comboName = ?");
    expect(allCall[0]).toContain("status = ?");
    expect(allCall[0]).toContain("reason = ?");
    expect(allCall[0]).toContain("ORDER BY startedAt DESC LIMIT ? OFFSET ?");
    expect(allCall[1]).toEqual(["ai-researcher", "done", "tool_calling", 20, 0]);
  });

  it("converts date range to ms timestamps with CAST comparison", async () => {
    const start = new Date("2026-08-01T00:00").getTime();
    const end = new Date("2026-08-15T23:59").getTime();
    await queryHistory({ startDate: "2026-08-01T00:00", endDate: "2026-08-15T23:59" });
    const getCall = getMock.mock.calls.find((c) => c[0].includes("COUNT(*) as c"));
    expect(getCall[0]).toContain("CAST(startedAt AS INTEGER) >= ?");
    expect(getCall[0]).toContain("CAST(startedAt AS INTEGER) <= ?");
    expect(getCall[1]).toEqual([start, end]);
  });

  it("computes pagination metadata and clamps out-of-range pages", async () => {
    getMock.mockReturnValueOnce({ c: 45 });
    allMock.mockReturnValueOnce(Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, startedAt: String(i) })));
    const result = await queryHistory({ page: 2, pageSize: 20 });
    expect(result.pagination.totalItems).toBe(45);
    expect(result.pagination.totalPages).toBe(3);
    expect(result.pagination.page).toBe(2);
    expect(result.pagination.hasNext).toBe(true);
    expect(result.pagination.hasPrev).toBe(true);
    expect(result.runs).toHaveLength(20);

    // Page beyond the last page clamps down to totalPages (3).
    getMock.mockReturnValueOnce({ c: 45 });
    const clamped = await queryHistory({ page: 99, pageSize: 20 });
    expect(clamped.pagination.page).toBe(3);
    expect(clamped.pagination.hasNext).toBe(false);
  });

  it("caps page size at 200", async () => {
    getMock.mockReturnValueOnce({ c: 1000 });
    allMock.mockReturnValueOnce([]);
    const result = await queryHistory({ page: 1, pageSize: 9999 });
    expect(result.pagination.pageSize).toBe(200);
  });

  it("getDistinctCombos returns combo names only", async () => {
    allMock.mockReturnValueOnce([{ comboName: "ai-researcher" }, { comboName: "bug-hunter" }]);
    const combos = await getDistinctCombos();
    expect(combos).toEqual(["ai-researcher", "bug-hunter"]);
  });
});

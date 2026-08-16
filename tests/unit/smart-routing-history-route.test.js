// Route-level guard for the Smart Routing history API: param mapping and the
// guarantee that DB errors become a parseable JSON 500 (not an empty body,
// which crashed the dashboard with "Unexpected end of JSON input").
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/repos/smartRoutingRunsRepo.js", () => ({
  queryHistory: vi.fn(async () => ({
    runs: [],
    pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1, hasNext: false, hasPrev: false },
  })),
  getDistinctCombos: vi.fn(async () => []),
}));

const { queryHistory, getDistinctCombos } = await import("@/lib/db/repos/smartRoutingRunsRepo.js");
const { GET } = await import("../../src/app/api/smart-routing/history/route.js");

const RESULT = {
  runs: [
    {
      runId: "r1",
      comboName: "ai-researcher",
      routing: { reason: "research_cookie_primary", order: ["felo-web/deepseek-v4-flash"] },
      servedModel: "felo-web/deepseek-v4-flash",
      status: "done",
      startedAt: 1000,
      totalDurationMs: 900,
    },
  ],
  pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1, hasNext: false, hasPrev: false },
};

const get = (url) => GET(new Request(url));

beforeEach(() => {
  vi.clearAllMocks();
  queryHistory.mockResolvedValue(RESULT);
  getDistinctCombos.mockResolvedValue(["ai-researcher"]);
});

describe("GET /api/smart-routing/history", () => {
  it("returns runs + pagination + combos on success", async () => {
    const res = await get("http://localhost/api/smart-routing/history");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.runs[0].runId).toBe("r1");
    expect(data.pagination.totalItems).toBe(1);
    expect(data.combos).toEqual(["ai-researcher"]);
  });

  it("maps query params to repo filters", async () => {
    await get(
      "http://localhost/api/smart-routing/history?page=3&pageSize=50&reason=tool_calling&comboName=ai-researcher&status=error&startDate=2026-01-01T00:00&endDate=2026-01-31T23:59",
    );
    expect(queryHistory).toHaveBeenCalledWith({
      page: "3",
      pageSize: "50",
      comboName: "ai-researcher",
      status: "error",
      reason: "tool_calling",
      startDate: "2026-01-01T00:00",
      endDate: "2026-01-31T23:59",
    });
  });

  it("omits undefined filters when params are absent", async () => {
    await get("http://localhost/api/smart-routing/history");
    expect(queryHistory).toHaveBeenCalledWith({
      page: undefined,
      pageSize: undefined,
      comboName: undefined,
      status: undefined,
      reason: undefined,
      startDate: undefined,
      endDate: undefined,
    });
  });

  it("returns a JSON 500 (not an empty body) when the repo throws", async () => {
    queryHistory.mockRejectedValueOnce(new Error("no such table: smartRoutingRuns"));

    const res = await get("http://localhost/api/smart-routing/history");
    expect(res.status).toBe(500);
    const data = await res.json(); // must not throw — this was the reported crash
    expect(data.error).toContain("smart-routing history");
  });

  it("returns a JSON 500 when the combos query fails", async () => {
    getDistinctCombos.mockRejectedValueOnce(new Error("db locked"));

    const res = await get("http://localhost/api/smart-routing/history");
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBeTruthy();
  });
});

// End-to-end: smart-routing telemetry runs must survive a server restart.
// Uses a REAL SQLite DB in a temp DATA_DIR (never the user's data), proving
// the full chain: handleSmartRoutingChat → telemetry buffer → repo upsert →
// hydrate-from-DB on the next boot.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing any db-backed module
// (paths.js computes DATA_FILE at import time).
const tmpDir = path.join(os.tmpdir(), `er-smart-routing-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
process.env.DATA_DIR = tmpDir;

let telemetry;
let combo;
let repo;

beforeAll(async () => {
  telemetry = await import("open-sse/services/smartRoutingTelemetry.js");
  combo = await import("open-sse/services/combo.js");
  repo = await import("../../src/lib/db/repos/smartRoutingRunsRepo.js");
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function resetLiveState() {
  global._smartRoutingRuns.clear();
  global._smartRoutingPersistPending.clear();
  if (global._smartRoutingPersistTimer) {
    clearTimeout(global._smartRoutingPersistTimer);
    global._smartRoutingPersistTimer = null;
  }
}

describe("smart-routing persistence e2e", () => {
  it("persists a run to SQLite and hydrates it back after a simulated restart", async () => {
    resetLiveState();

    // 1. Run a real smart-routing request (research intent → cookie pool first).
    const res = await combo.handleSmartRoutingChat({
      body: {
        model: "ai-researcher",
        messages: [{ role: "user", content: "cari sumber terbaru tentang AI terbaik 2026" }],
        stream: false,
      },
      models: ["kr/claude-opus-4-7", "felo-web/deepseek-v4-flash", "glm/glm-5.1"],
      handleSingleModel: async () => ({
        ok: true, status: 200, statusText: "OK", headers: new Headers(), body: null, clone: () => null,
      }),
      log: { info: () => {}, warn: () => {} },
      comboName: "ai-researcher",
      config: { cookiePoolEnabled: true, intentDetection: { confidenceThreshold: 0.6 } },
    });
    expect(res.ok).toBe(true);

    // 2. Force the buffered write to hit the real DB.
    await telemetry.flushPersistence();

    // 3. Simulate a restart: wipe the in-memory registry (fresh server boot).
    resetLiveState();
    expect(telemetry.getRecentSmartRuns(50)).toHaveLength(0);

    // 4. Hydrate from the DB (what the API routes do on first load).
    const loaded = await telemetry.hydrateSmartRunsFromDb({ limit: 50 });
    expect(loaded).toBe(true);

    const runs = telemetry.getRecentSmartRuns(50);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.comboName).toBe("ai-researcher");
    expect(run.routing.reason).toBe("research_cookie_primary");
    expect(run.routing.order[0]).toBe("felo-web/deepseek-v4-flash");
    expect(run.routing.cookiePool).toEqual(["felo-web/deepseek-v4-flash"]);
    expect(run.routing.intent.signal).toBe("keyword");
    expect(run.servedModel).toBe("felo-web/deepseek-v4-flash");
    expect(run.status).toBe("done");
    expect(run.totalDurationMs).toBeGreaterThanOrEqual(0);

    // 5. The paginated history query (dashboard filters) reads the same row.
    const history = await repo.queryHistory({ page: 1, pageSize: 10 });
    expect(history.pagination.totalItems).toBe(1);
    expect(history.pagination.totalPages).toBe(1);
    expect(history.runs[0].runId).toBe(run.runId);

    const filtered = await repo.queryHistory({ reason: "research_cookie_primary" });
    expect(filtered.pagination.totalItems).toBe(1);
    const noMatch = await repo.queryHistory({ reason: "tool_calling" });
    expect(noMatch.pagination.totalItems).toBe(0);

    const combos = await repo.getDistinctCombos();
    expect(combos).toEqual(["ai-researcher"]);
  });
});

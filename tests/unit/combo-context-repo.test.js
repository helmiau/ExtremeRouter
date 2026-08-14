// Guards combo observability persistence: requestDetailsRepo's flush whitelist
// must carry the combo context into the stored JSON record. Regression test for
// the template-runtime audit — combo name/strategy/role/trafficClass must be
// queryable from requestDetails to verify combo behavior against template intent.
import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({ run: runMock, all: vi.fn(), get: vi.fn(() => ({ c: 0 })), transaction: transactionMock })),
}));

vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(async () => ({})),
}));

// Force batch flush on first push so the whitelist path runs deterministically.
process.env.OBSERVABILITY_ENABLED = "true";
process.env.OBSERVABILITY_BATCH_SIZE = "1";
process.env.OBSERVABILITY_FLUSH_INTERVAL_MS = "1";

const { saveRequestDetail } = await import("../../src/lib/db/repos/requestDetailsRepo.js");

describe("requestDetailsRepo combo persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockImplementation((fn) => fn());
  });

  it("persists combo context into the stored JSON record", async () => {
    const combo = { name: "max-reasoning-swarm", strategy: "swarm", role: "audit", trafficClass: "user" };
    await saveRequestDetail({
      id: "test-1",
      provider: "kiro",
      model: "claude-sonnet-4.5",
      connectionId: "conn-1",
      timestamp: new Date().toISOString(),
      latency: { ttft: 5, total: 10 },
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      request: {},
      status: "success",
      combo,
    });
    // Allow the async flush to run
    await new Promise((r) => setTimeout(r, 20));

    expect(transactionMock).toHaveBeenCalled();
    const insertCall = runMock.mock.calls.find((c) => c[0].startsWith("INSERT INTO requestDetails"));
    expect(insertCall).toBeTruthy();
    const stored = JSON.parse(insertCall[1][6]); // data column
    expect(stored.combo).toEqual(combo);
  });

  it("stores null combo for plain single-model requests", async () => {
    await saveRequestDetail({
      id: "test-2",
      provider: "openai",
      model: "gpt-4o",
      timestamp: new Date().toISOString(),
      latency: { ttft: 5, total: 10 },
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
      request: {},
      status: "success",
    });
    await new Promise((r) => setTimeout(r, 20));

    const insertCall = runMock.mock.calls.find((c) => c[0].startsWith("INSERT INTO requestDetails"));
    expect(insertCall).toBeTruthy();
    const stored = JSON.parse(insertCall[1][6]);
    expect(stored.combo).toBeNull();
  });
});

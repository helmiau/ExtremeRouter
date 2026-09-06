import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  getProjectIdForConnection,
  _resetProjectIdState,
} from "../../open-sse/services/projectId.js";

const connId = "conn-onboard";

// The retry path sleeps BASE_RETRY_DELAY_MS+jitter between attempts (the
// anti-abuse spacing); pin the env knobs to the legacy budget and collapse any
// sub-6s timer (retry sleeps land at BASE(1ms)+jitter≤5s) while leaving the
// per-attempt 30s abort timer intact.
const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  _resetProjectIdState();
  // Production defaults (attempts=2, 12s+jitter spacing) exist to avoid Google's
  // anti-abuse heuristics; these tests need the legacy 5-attempt budget and
  // collapsed sleeps, so pin both env knobs explicitly.
  process.env.ONBOARD_MAX_ATTEMPTS = "5";
  process.env.ONBOARD_RETRY_DELAY_MS = "1";
  vi.stubGlobal("setTimeout", (fn, ms, ...args) => {
    if (ms > 0 && ms <= 6_000) return realSetTimeout(fn, 0, ...args);
    return realSetTimeout(fn, ms, ...args);
  });
});

afterEach(() => {
  _resetProjectIdState();
  delete process.env.ONBOARD_MAX_ATTEMPTS;
  delete process.env.ONBOARD_RETRY_DELAY_MS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Route fetch calls: loadCodeAssist → `loadAssistBody`, onboardUser → queue. */
function stubFetch(loadAssistBody, onboardBodies) {
  const queue = [...onboardBodies];
  const fetchSpy = vi.fn((url) => {
    const isOnboard = String(url).includes("onboardUser");
    const body = isOnboard ? queue.shift() : loadAssistBody;
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

describe("onboardUser project-id extraction (contract-drift hardening)", () => {
  it("still recognizes the historical response.cloudaicompanionProject shape", async () => {
    stubFetch({}, [{ done: true, response: { cloudaicompanionProject: { id: "proj-hist" } } }]);

    const pid = await getProjectIdForConnection(connId, "token", "gemini-cli");
    expect(pid).toBe("proj-hist");
  });

  it.each([
    ["flat projectId", { done: true, projectId: "proj-flat" }, "proj-flat"],
    ["flat project_id (snake_case)", { done: true, project_id: "proj-snake" }, "proj-snake"],
    ["nested response.project_id", { done: true, response: { project_id: "proj-nested-snake" } }, "proj-nested-snake"],
    ["nested response.project object", { done: true, response: { project: { id: "proj-project" } } }, "proj-project"],
    ["flat cloudaicompanionProject string", { done: true, cloudaicompanionProject: "proj-flat-str" }, "proj-flat-str"],
    ["resource name projects/<id>", { done: true, projectId: "projects/proj-resource" }, "proj-resource"],
    ["nested response.id last resort", { done: true, response: { id: "proj-response-id" } }, "proj-response-id"],
  ])("recognizes %s", async (_label, onboardBody, expected) => {
    stubFetch({}, [onboardBody]);

    const pid = await getProjectIdForConnection(connId, "token", "gemini-cli");
    expect(pid).toBe(expected);
  });

  it("prefers the explicit project field over a generic id", async () => {
    // response.project carries the real id; a generic response.id must not win.
    stubFetch({}, [
      { done: true, response: { project: { id: "proj-real" }, id: "proj-generic" } },
    ]);

    const pid = await getProjectIdForConnection(connId, "token", "gemini-cli");
    expect(pid).toBe("proj-real");
  });

  it("fails fast (no retry) when done:true carries no recognizable id — the result is terminal", async () => {
    // done:true is Google's final LRO result; polling again returns the same
    // body, so the code must return null after ONE attempt instead of burning
    // ~2s×4 more on a permanent "no project provisioned" response.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch({}, [{ done: true, response: { someOtherField: 1 } }]);

    const pid = await getProjectIdForConnection(connId, "token", "gemini-cli");

    expect(pid).toBeNull();
    // 1 loadCodeAssist + 1 onboardUser attempt (no retries)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    const bodyLogs = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes("without a recognizable project_id")
    );
    expect(bodyLogs).toHaveLength(1);
    expect(String(bodyLogs[0][0])).toContain('"someOtherField":1');

    const finalLogs = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes("failed after 5 attempts")
    );
    expect(finalLogs).toHaveLength(0);
  });

  it("recovers when a pending (done:false) attempt is later followed by the id", async () => {
    // done:false = operation still running → polling is legitimate, and a
    // later attempt may return the id.
    stubFetch({}, [
      { done: false },
      { done: false },
      { done: true, projectId: "proj-late" },
    ]);

    const pid = await getProjectIdForConnection(connId, "token", "gemini-cli");
    expect(pid).toBe("proj-late");
  });
});

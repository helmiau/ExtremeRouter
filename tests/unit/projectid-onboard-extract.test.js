import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  getProjectIdForConnection,
  _resetProjectIdState,
} from "../../open-sse/services/projectId.js";

const connId = "conn-onboard";

// The retry path sleeps 2s between attempts; collapse only those sleeps to ~0
// so the suite stays fast without touching the per-attempt 30s timeout or
// AbortController internals.
const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  _resetProjectIdState();
  vi.stubGlobal("setTimeout", (fn, ms, ...args) => {
    if (ms === 2000) return realSetTimeout(fn, 0, ...args);
    return realSetTimeout(fn, ms, ...args);
  });
});

afterEach(() => {
  _resetProjectIdState();
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

    const pid = await getProjectIdForConnection(connId, "token", "antigravity");
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

    const pid = await getProjectIdForConnection(connId, "token", "antigravity");
    expect(pid).toBe(expected);
  });

  it("prefers the explicit project field over a generic id", async () => {
    // response.project carries the real id; a generic response.id must not win.
    stubFetch({}, [
      { done: true, response: { project: { id: "proj-real" }, id: "proj-generic" } },
    ]);

    const pid = await getProjectIdForConnection(connId, "token", "antigravity");
    expect(pid).toBe("proj-real");
  });

  it("logs the raw body ONCE when done:true has no recognizable id, then fails after 5 attempts", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch({}, [
      { done: true, response: { someOtherField: 1 } },
      { done: true, response: { someOtherField: 1 } },
      { done: true, response: { someOtherField: 1 } },
      { done: true, response: { someOtherField: 1 } },
      { done: true, response: { someOtherField: 1 } },
    ]);

    const pid = await getProjectIdForConnection(connId, "token", "antigravity");

    expect(pid).toBeNull();
    // 1 loadCodeAssist + 5 onboardUser attempts
    expect(globalThis.fetch).toHaveBeenCalledTimes(6);

    const bodyLogs = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes("without a recognizable project_id")
    );
    expect(bodyLogs).toHaveLength(1);
    expect(String(bodyLogs[0][0])).toContain('"someOtherField":1');

    const finalLogs = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes("failed after 5 attempts")
    );
    expect(finalLogs).toHaveLength(1);
  });

  it("recovers when a later attempt finally returns the id", async () => {
    stubFetch({}, [
      { done: true, response: {} },
      { done: true, projectId: "proj-late" },
    ]);

    const pid = await getProjectIdForConnection(connId, "token", "antigravity");
    expect(pid).toBe("proj-late");
  });
});

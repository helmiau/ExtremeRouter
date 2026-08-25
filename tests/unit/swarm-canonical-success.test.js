import { describe, it, expect, vi } from "vitest";

// Commit F: Swarm worker legs (stream:false, consumed via .json()) use the same
// candidateServed gate as Fusion/Cascade. The full handleSwarmChat hierarchy is
// heavy to drive in isolation, so this suite locks the migration at two levels:
//  (1) unit-test candidateServed over swarm-worker-shaped ChatResults (the exact
//      shape the migrated gate at swarm.js:362 consumes), and
//  (2) a real cascade/fusion integration path already covers the live code.
// The contract here is identical to what handleSwarmChat's dispatchWorkers uses.

vi.mock("../../open-sse/services/providerCapabilities.js", () => ({
  validateComboRoles: () => [],
}));

const { candidateServed } = await import("../../open-sse/services/combo.js");

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const workerAttempt = (overrides = {}) => ({
  source: "provider", transportOk: true, streamStarted: null, hasText: true,
  completionState: "success", completionType: "http_2xx_json", terminalState: null,
  finishReason: "stop", eofSeen: null, errorSeen: false, abortSeen: false,
  usableOutput: true, logicalSuccess: true, outcome: "success", ...overrides,
});

describe("Swarm worker leg: candidateServed contract", () => {
  it("logically successful worker (text) → accepted", () => {
    const res = { success: true, status: 200, response: jsonRes({ choices: [{ message: { content: "answer" } }] }), canonicalAttempt: workerAttempt() };
    expect(candidateServed(res)).toBe(true);
  });

  it("worker empty 200 (logicalSuccess=false) → NOT accepted as worker output", () => {
    const empty = workerAttempt({ hasText: false, completionState: "incomplete", usableOutput: false, logicalSuccess: false, outcome: "incomplete" });
    const res = { success: true, status: 200, response: jsonRes({ choices: [{ message: { content: "" } }] }), canonicalAttempt: empty };
    expect(candidateServed(res)).toBe(false);
  });

  it("worker usage-only (logicalSuccess=false) → NOT accepted", () => {
    const usage = workerAttempt({ hasText: false, completionState: "incomplete", usableOutput: false, logicalSuccess: false, outcome: "incomplete" });
    const res = { success: true, status: 200, response: jsonRes({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), canonicalAttempt: usage };
    expect(candidateServed(res)).toBe(false);
  });

  it("worker transport failure (success=false) → NOT accepted", () => {
    const res = { success: false, status: 502, response: jsonRes({ error: { message: "boom" } }, 502), canonicalAttempt: null };
    expect(candidateServed(res)).toBe(false);
  });
});

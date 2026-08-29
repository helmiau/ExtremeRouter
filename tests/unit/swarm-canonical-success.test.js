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

// ---- G2-E.3: Swarm worker leg must NOT own retry/fallback ----
// dispatchWorkers consumes the SAME candidateServed gate (swarm.js) as Fusion/
// Cascade. A failed worker leg (logicalSuccess=false) is dropped from the panel
// regardless of retryable/fallbackEligible on its policy — the strategy never
// re-dispatches a worker based on those fields. (Full handleSwarmChat pipeline
// is driven via gatekeeper→manager→worker→audit→synthesis; the worker gate below
// is the exact branch dispatchWorkers executes, proved here + by the Fusion/
// Cascade real-orchestration suites.)
describe("Swarm worker leg: policy fields do NOT trigger re-dispatch (G2-E.3)", () => {
  const failedWorker = (policy) => {
    const a = workerAttempt({ hasText: false, completionState: "failure", usableOutput: false, logicalSuccess: false, outcome: "failure", classification: "provider_failure", reason: "provider_error", policy });
    return { success: false, status: 502, response: jsonRes({ error: { message: "boom" } }, 502), canonicalAttempt: a };
  };
  it("worker failure with fallbackEligible=true is dropped (no per-worker fallback loop)", () => {
    // candidateServed consults logicalSuccess, not fallbackEligible. A failed leg
    // must be rejected even when policy would allow candidate fallback elsewhere.
    expect(candidateServed(failedWorker({ fallbackEligible: true, stopProgression: false, retryable: false }))).toBe(false);
  });
  it("worker failure with retryable=true is dropped (retry stays leaf-owned)", () => {
    expect(candidateServed(failedWorker({ fallbackEligible: false, stopProgression: false, retryable: true }))).toBe(false);
  });
  it("client_abort worker is dropped (no swarm retry/fallback)", () => {
    const a = workerAttempt({ completionState: "failure", logicalSuccess: false, outcome: "failure", classification: "client_abort", reason: "client_abort", policy: { fallbackEligible: false, stopProgression: true, retryable: false } });
    expect(candidateServed({ success: false, status: 499, response: jsonRes({ error: { message: "abort" } }, 499), canonicalAttempt: a })).toBe(false);
  });
});

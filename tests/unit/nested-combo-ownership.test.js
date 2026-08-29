import { describe, it, expect, vi } from "vitest";

// G2-E.3 §9/§34: nested combo ownership. The parent combo calls its child
// exactly once per candidate; the CHILD (a nested handleComboChat) owns its own
// retry/fallback progression over its members, and must NOT cause the parent to
// re-run the same physical leaf. We wire a real parent handleComboChat whose
// handleSingleModel is a real child handleComboChat (depth 2), with a scripted
// leaf. The leaf call-count invariant proves the single-retry-owner contract.

vi.mock("../../open-sse/services/providerCapabilities.js", () => ({
  validateComboRoles: () => [],
}));

const { handleComboChat } = await import("../../open-sse/services/combo.js");

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okBody = () => ({ id: "x", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });

// Leaf returns a finalized ChatResult. `policyFor` lets us drive each leaf's policy.
function leaf(status, policy, text = "ok") {
  return {
    success: status < 400,
    status,
    error: status < 400 ? undefined : `fail-${status}`,
    response: jsonRes(status, status < 400 ? okBody() : { error: { message: `fail-${status}` } }),
    canonicalAttempt: {
      source: "provider", transportOk: true, completionState: status < 400 ? "success" : "failure",
      logicalSuccess: status < 400, classification: status < 400 ? "success" : "transport_failure",
      reason: status < 400 ? null : `http_${status}`, policy: policy || { fallbackEligible: false, stopProgression: true, retryable: false },
    },
  };
}

// Child combo: tries [childA]. On failure with fallbackEligible=true it advances
// to childB. Returns a ChatResult so the PARENT can consume it via candidateServed.
function childHandleSingleModel(leafCalls, childModels) {
  return async (b, m) => {
    const child = await handleComboChat({
      body: { model: "child" }, models: childModels, handleSingleModel: leafCalls, log, comboName: "child", comboStrategy: "fallback",
    });
    // Wrap the child's returned Response into a ChatResult the parent can gate on.
    return { success: child.status < 400, status: child.status, response: child, canonicalAttempt: { source: "provider", transportOk: true, completionState: child.status < 400 ? "success" : "failure", logicalSuccess: child.status < 400, classification: child.status < 400 ? "success" : "transport_failure", reason: null, policy: { fallbackEligible: child.status < 400, stopProgression: child.status >= 400, retryable: false } } };
  };
}

describe("Nested combo: one retry/fallback owner per physical attempt (G2-E.3)", () => {
  it("child failure with fallbackEligible=true advances child, parent does NOT re-run the leaf", async () => {
    // Parent candidate [parentA] → child [childA(fails, fallback), childB(ok)].
    const leafCalls = vi.fn(async (b, m) => {
      if (m === "childA") return leaf(500, { fallbackEligible: true, stopProgression: false, retryable: false });
      return leaf(200, { fallbackEligible: false, stopProgression: true, retryable: false });
    });
    const parent = await handleComboChat({
      body: { model: "parent" }, models: ["parentA"], handleSingleModel: childHandleSingleModel(leafCalls, ["childA", "childB"]), log, comboName: "parent", comboStrategy: "fallback",
    });
    // Leaf childA called ONCE inside the child (child owns the fallback), childB
    // once. The parent invoked its handleSingleModel (the child) exactly once.
    expect(leafCalls.mock.calls.map(([, m]) => m)).toEqual(["childA", "childB"]);
    expect(parent.status).toBe(200);
  });

  it("child success → no duplicate leaf execution; parent does not double-fallback", async () => {
    const leafCalls = vi.fn(async (b, m) => leaf(200, { fallbackEligible: false, stopProgression: true, retryable: false }));
    const parent = await handleComboChat({
      body: { model: "parent" }, models: ["parentA"], handleSingleModel: childHandleSingleModel(leafCalls, ["childA"]), log, comboName: "parent", comboStrategy: "fallback",
    });
    expect(leafCalls).toHaveBeenCalledTimes(1); // child leaf ran once; no parent re-dispatch
    expect(parent.status).toBe(200);
  });

  it("child abort (stopProgression=true) → parent does not re-run the child leaf", async () => {
    const leafCalls = vi.fn(async (b, m) => leaf(499, { fallbackEligible: false, stopProgression: true, retryable: false }, "ok"));
    const parent = await handleComboChat({
      body: { model: "parent" }, models: ["parentA"], handleSingleModel: childHandleSingleModel(leafCalls, ["childA"]), log, comboName: "parent", comboStrategy: "fallback",
    });
    expect(leafCalls).toHaveBeenCalledTimes(1); // no retry after client_abort
    expect(parent.status).toBe(499);
  });
});

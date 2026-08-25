import { describe, it, expect } from "vitest";

// Commit G1: outcome classification layer (#2 of the 3-layer model).
// Pure function — no I/O, no Response access, no side effects. Classification is
// derived ONLY from the FINAL canonicalAttempt evidence (never provisional state).

import { classifyCanonicalAttempt, ATTEMPT_CLASSIFICATIONS } from "../../open-sse/utils/canonicalClassification.js";
import { createCanonicalAttempt } from "../../open-sse/utils/canonicalAttempt.js";
import { createStreamState, observeParsedEvent } from "../../open-sse/utils/streamState.js";
import { createCanonicalAttemptFromNonStreaming } from "../../open-sse/utils/nonStreamingAttempt.js";
import { createCanonicalAttemptFromForcedSse } from "../../open-sse/utils/forcedSseAttempt.js";

const base = () => ({
  source: "provider", transportOk: true, streamStarted: null, hasText: false,
  hasReasoning: false, hasToolCall: false, hasStructuredOutput: false, hasUsage: false,
  completionState: "success", completionType: null, terminalState: null, terminalType: null,
  finishReason: "stop", eofSeen: null, errorSeen: false, abortSeen: false,
  usableOutput: true, logicalSuccess: true, outcome: "success",
});

// ── basic classes ────────────────────────────────────────────────────────────
describe("classifyCanonicalAttempt — basic classes", () => {
  it("success — text + successful terminal", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: true });
    expect(c.classification).toBe("success");
    expect(c.reason).toBeNull();
  });

  it("success — reasoning + successful terminal", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: false, hasReasoning: true });
    expect(c.classification).toBe("success");
  });

  it("success — tool call + successful terminal", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: false, hasToolCall: true });
    expect(c.classification).toBe("success");
  });

  it("success — structured output + completion", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: false, hasStructuredOutput: true });
    expect(c.classification).toBe("success");
  });
});

// ── transport_failure ──────────────────────────────────────────────────────────
describe("transport_failure", () => {
  for (const [status, reason] of [[401, "http_401"], [403, "http_403"], [404, "http_404"], [429, "http_429"], [500, "http_5xx"], [502, "http_5xx"], [503, "http_5xx"]]) {
    it(`HTTP ${status} → transport_failure`, () => {
      const c = classifyCanonicalAttempt({ ...base(), transportOk: false, responseStatus: status, completionState: "failure", errorSeen: true, logicalSuccess: false });
      expect(c.classification).toBe("transport_failure");
      expect(c.reason).toBe(reason);
    });
  }
});

// ── provider_failure ────────────────────────────────────────────────────────────
describe("provider_failure", () => {
  it("HTTP 200 + provider error envelope", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: false, completionState: "failure", errorSeen: true, logicalSuccess: false });
    expect(c.classification).toBe("provider_failure");
    expect(c.reason).toBe("provider_error");
  });

  it("malformed-only SSE (completionType=malformed_sse)", () => {
    const c = classifyCanonicalAttempt({ ...base(), transportOk: true, completionState: "failure", completionType: "malformed_sse", errorSeen: true, logicalSuccess: false });
    expect(c.classification).toBe("provider_failure");
    expect(c.reason).toBe("malformed_sse");
  });

  it("malformed JSON with HTTP 200", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: false, usableOutput: false, completionState: "failure", errorSeen: true, logicalSuccess: false });
    expect(c.classification).toBe("provider_failure");
  });

  it("NOT misclassified as transport_failure when transportOk=true", () => {
    const c = classifyCanonicalAttempt({ ...base(), transportOk: true, completionState: "failure", errorSeen: true, logicalSuccess: false });
    expect(c.classification).not.toBe("transport_failure");
    expect(c.classification).toBe("provider_failure");
  });
});

// ── empty_output ────────────────────────────────────────────────────────────────
describe("empty_output", () => {
  it("usage-only (HTTP 200, no output)", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: false, hasUsage: true, usableOutput: false, completionState: "incomplete", logicalSuccess: false, outcome: "incomplete" });
    expect(c.classification).toBe("empty_output");
    expect(c.reason).toBe("usage_only");
  });

  it("empty content", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: false, usableOutput: false, completionState: "incomplete", logicalSuccess: false });
    expect(c.classification).toBe("empty_output");
    expect(c.reason).toBe("empty_response");
  });

  it("DONE-only / valid empty 200", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: false, usableOutput: false, completionState: "incomplete", logicalSuccess: false });
    expect(c.classification).toBe("empty_output");
  });
});

// ── incomplete ───────────────────────────────────────────────────────────────────
describe("incomplete", () => {
  it("text + EOF without successful terminal", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: true, completionState: "incomplete", logicalSuccess: false, outcome: "incomplete" });
    expect(c.classification).toBe("incomplete");
    expect(c.reason).toBe("no_successful_terminal");
  });

  it("finish_reason=length", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: true, finishReason: "length", completionState: "incomplete", logicalSuccess: false });
    expect(c.classification).toBe("incomplete");
    expect(c.reason).toBe("finish_reason_length");
  });

  it("explicit Responses incomplete terminal", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: true, completionType: "response.incomplete", completionState: "incomplete", logicalSuccess: false });
    expect(c.classification).toBe("incomplete");
    expect(c.reason).toBe("provider_incomplete");
  });
});

// ── cancelled ─────────────────────────────────────────────────────────────────────
describe("cancelled", () => {
  it("client abort (abortSeen=true)", () => {
    const c = classifyCanonicalAttempt({ ...base(), abortSeen: true, completionState: "cancelled", logicalSuccess: false });
    expect(c.classification).toBe("cancelled");
    expect(c.reason).toBe("client_abort");
  });

  it("provider response.cancelled", () => {
    const c = classifyCanonicalAttempt({ ...base(), abortSeen: false, completionState: "cancelled", completionType: "response.cancelled", logicalSuccess: false });
    expect(c.classification).toBe("cancelled");
    expect(c.reason).toBe("provider_cancelled");
  });

  it("cancelled is NOT classified as failure even with errorSeen", () => {
    const c = classifyCanonicalAttempt({ ...base(), abortSeen: true, completionState: "cancelled", errorSeen: true, logicalSuccess: false });
    expect(c.classification).toBe("cancelled");
  });
});

// ── null attempt (§14) ────────────────────────────────────────────────────────────
describe("null canonicalAttempt", () => {
  it("classifyCanonicalAttempt(null) → null (no fabrication)", () => {
    expect(classifyCanonicalAttempt(null)).toBeNull();
  });
});

// ── precedence conflicts (§25) ─────────────────────────────────────────────────────
describe("precedence conflicts", () => {
  it("transport failure + errorSeen → transport_failure (transport wins)", () => {
    const c = classifyCanonicalAttempt({ ...base(), transportOk: false, completionState: "failure", errorSeen: true, logicalSuccess: false });
    expect(c.classification).toBe("transport_failure");
  });

  it("HTTP 200 + provider error → provider_failure", () => {
    const c = classifyCanonicalAttempt({ ...base(), transportOk: true, completionState: "failure", errorSeen: true, logicalSuccess: false });
    expect(c.classification).toBe("provider_failure");
  });

  it("output + provider failure → provider_failure (not success/incomplete)", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: true, completionState: "failure", errorSeen: true, logicalSuccess: false });
    expect(c.classification).toBe("provider_failure");
  });

  it("output + cancellation → cancelled (not success)", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: true, abortSeen: true, completionState: "cancelled", logicalSuccess: false });
    expect(c.classification).toBe("cancelled");
  });

  it("usage + no output → empty_output", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasUsage: true, usableOutput: false, completionState: "incomplete", logicalSuccess: false });
    expect(c.classification).toBe("empty_output");
  });

  it("output + incomplete → incomplete", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: true, completionState: "incomplete", logicalSuccess: false });
    expect(c.classification).toBe("incomplete");
  });

  it("output + successful terminal → success", () => {
    const c = classifyCanonicalAttempt({ ...base(), hasText: true, completionState: "success", logicalSuccess: true });
    expect(c.classification).toBe("success");
  });
});

// ── cross-path: real adapter outputs ──────────────────────────────────────────────
describe("cross-path classification via real adapters", () => {
  const openaiText = (content) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
  const usageOnly = () => ({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });

  it("non-streaming success → success", () => {
    const ca = createCanonicalAttemptFromNonStreaming({ status: 200, parsed: openaiText("hi"), usage: null, malformed: false });
    expect(ca.classification).toBe("success");
  });

  it("non-streaming usage-only → empty_output", () => {
    const ca = createCanonicalAttemptFromNonStreaming({ status: 200, parsed: usageOnly(), usage: null, malformed: false });
    expect(ca.classification).toBe("empty_output");
  });

  it("forced-SSE valid text → success", () => {
    const ca = createCanonicalAttemptFromForcedSse({ status: 200, finalJson: openaiText("hi"), usage: { prompt_tokens: 1, completion_tokens: 1 } });
    expect(ca.classification).toBe("success");
  });

  it("forced-SSE malformed-only → provider_failure", () => {
    const ca = createCanonicalAttemptFromForcedSse({ status: 200, finalJson: null, malformedLines: 3 });
    expect(ca.classification).toBe("provider_failure");
    expect(ca.reason).toBe("malformed_sse");
  });

  it("provider HTTP 500 (forced-SSE) → transport_failure", () => {
    const ca = createCanonicalAttemptFromForcedSse({ status: 500, finalJson: null });
    expect(ca.classification).toBe("transport_failure");
  });

  it("streaming final attempt attaches classification via createCanonicalAttempt", () => {
    const s = createStreamState();
    observeParsedEvent(s, { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] });
    s.streamStarted = true; // the SSE transform sets this on first provider chunk (stream.js:99)
    observeParsedEvent(s, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    s.eofSeen = true;
    const ca = createCanonicalAttempt(s, { status: 200, source: "provider" });
    expect(ca.streamStarted).toBe(true);
    expect(ca.classification).toBe("success");
  });
});

// ── taxonomy completeness ──────────────────────────────────────────────────────────
describe("taxonomy", () => {
  it("all ATTEMPT_CLASSIFICATIONS are the bounded set (no policy fields)", () => {
    expect(ATTEMPT_CLASSIFICATIONS).toEqual([
      "success", "transport_failure", "provider_failure",
      "empty_output", "incomplete", "cancelled",
    ]);
    // Explicitly NOT present: retryable / fallbackEligible / healthAction / accountAction.
    expect(ATTEMPT_CLASSIFICATIONS.some((c) => /retry|fallback|health|account/.test(c))).toBe(false);
  });
});

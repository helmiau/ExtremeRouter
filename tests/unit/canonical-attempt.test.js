import { describe, it, expect, vi } from "vitest";

// Commit A: universal canonical attempt contract + pure semantics.
// Tests the contract layer and the corrected response.cancelled mapping.
// No adapters, no ChatResult integration — production behavior unchanged.

import { createStreamState, observeParsedEvent } from "../../open-sse/utils/streamState.js";
import {
  deriveCompletionState,
  deriveUsableOutput,
  deriveLogicalSuccess,
  deriveOutcome,
  createCanonicalAttempt,
} from "../../open-sse/utils/canonicalAttempt.js";

const stateFrom = (...events) => {
  const s = createStreamState();
  for (const evt of events) observeParsedEvent(s, evt);
  return s;
};

const openaiContent = (content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const openaiFinish = (fr) => ({ choices: [{ index: 0, delta: {}, finish_reason: fr }] });
const usageOnly = () => ({ choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 5, completion_tokens: 3 } });

describe("deriveCompletionState (universal completion semantics)", () => {
  it("maps normalized terminal states into universal completion", () => {
    expect(deriveCompletionState(stateFrom(openaiContent("a"), openaiFinish("stop")))).toBe("success");
    expect(deriveCompletionState(stateFrom(openaiContent("a"), { type: "response.failed" }))).toBe("failure");
    expect(deriveCompletionState(stateFrom(openaiContent("a"), openaiFinish("length")))).toBe("incomplete");
    expect(deriveCompletionState(createStreamState())).toBe("unknown");
  });

  it("three-way cancellation: client abort vs provider response.cancelled vs plain EOF", () => {
    const aborted = stateFrom(openaiContent("a"));
    aborted.abortSeen = true;
    expect(deriveCompletionState(aborted)).toBe("cancelled");

    const providerCancelled = stateFrom(openaiContent("a"), { type: "response.cancelled" });
    expect(deriveCompletionState(providerCancelled)).toBe("cancelled");
    expect(providerCancelled.terminalState).toBe("cancelled");
    expect(providerCancelled.abortSeen).toBe(false); // distinct evidence axes

    const plainEof = stateFrom(openaiContent("a"));
    plainEof.eofSeen = true;
    expect(deriveCompletionState(plainEof)).toBe("incomplete");
  });

  it("usage-only + successful terminal → completionState=success but logicalSuccess=false", () => {
    const s = stateFrom(usageOnly(), openaiFinish("stop"));
    expect(deriveCompletionState(s)).toBe("success");
    expect(deriveUsableOutput(s)).toBe(false);
    expect(deriveLogicalSuccess(s)).toBe(false);
  });

  it("never derived from transportOk/usage/emitted", () => {
    const noEvidence = createStreamState();
    noEvidence.hasUsage = true;
    expect(deriveCompletionState(noEvidence)).toBe("unknown"); // usage does not imply completion
  });
});

describe("deriveUsableOutput with structured output", () => {
  it("hasStructuredOutput=true counts as usable output even with hasText=false", () => {
    const s = createStreamState();
    s.hasStructuredOutput = true;
    s.hasText = false;
    expect(deriveUsableOutput(s)).toBe(true);
  });

  it("usage object alone is NOT structured output and NOT usable output", () => {
    const s = createStreamState();
    s.hasUsage = true;
    s.hasStructuredOutput = false;
    expect(deriveUsableOutput(s)).toBe(false);
  });
});

describe("logicalSuccess (universal rules)", () => {
  it("text + successful terminal → success; transportOk alone never grants it", () => {
    const s = stateFrom(openaiContent("a"), openaiFinish("stop"));
    expect(deriveLogicalSuccess(s)).toBe(true);

    // A stream that STARTED (bytes arrived) but produced no output is not success.
    const empty = createStreamState();
    empty.streamStarted = true;
    expect(deriveLogicalSuccess(empty)).toBe(false);

    // Even with transport Ok metadata, empty state is not success.
    const ca = createCanonicalAttempt(empty, { status: 200, source: "provider" });
    expect(ca.transportOk).toBe(true);
    expect(ca.logicalSuccess).toBe(false);
  });

  it("failure / incomplete / cancelled never yield logicalSuccess", () => {
    expect(deriveLogicalSuccess(stateFrom(openaiContent("a"), { type: "response.failed" }))).toBe(false);
    expect(deriveLogicalSuccess(stateFrom(openaiContent("a")))).toBe(false); // no terminal
    expect(deriveLogicalSuccess(stateFrom(openaiContent("a"), { type: "response.cancelled" }))).toBe(false);
  });
});

describe("deriveOutcome", () => {
  it("stays within the four operational outcomes", () => {
    expect(deriveOutcome(stateFrom(openaiContent("a"), openaiFinish("stop")))).toBe("success");
    expect(deriveOutcome(stateFrom(openaiContent("a"), { type: "response.failed" }))).toBe("failure");
    expect(deriveOutcome(stateFrom(openaiContent("a")))).toBe("incomplete");
    const aborted = stateFrom(openaiContent("a"));
    aborted.abortSeen = true;
    expect(deriveOutcome(aborted)).toBe("cancelled");
  });
});

describe("createCanonicalAttempt (universal schema + factory)", () => {
  it("provider streaming source populates the full shape", () => {
    const s = stateFrom(openaiContent("answer"), openaiFinish("stop"));
    const ca = createCanonicalAttempt(s, { status: 200, source: "provider" });
    expect(ca.source).toBe("provider");
    expect(ca.transportOk).toBe(true);
    expect(ca.streamStarted).toBe(false); // streamStarted set by transform, not observeParsedEvent
    expect(ca.hasText).toBe(true);
    expect(ca.hasStructuredOutput).toBe(false);
    expect(ca.completionState).toBe("success");
    expect(ca.terminalState).toBe("success");
    expect(ca.usableOutput).toBe(true);
    expect(ca.logicalSuccess).toBe(true);
    expect(ca.outcome).toBe("success");
  });

  it("null evidence + provider source → unknown completion, null stream fields", () => {
    const ca = createCanonicalAttempt(null, { status: 200, source: "provider" });
    expect(ca.streamStarted).toBe(null);
    expect(ca.eofSeen).toBe(null);
    expect(ca.terminalState).toBe(null);
    expect(ca.completionState).toBe("unknown"); // no evidence, provider path
    expect(ca.transportOk).toBe(true);
    expect(ca.usableOutput).toBe(false);
  });

  it("source is restricted to provider/cache/bypass", () => {
    expect(createCanonicalAttempt(null, { source: "bypass" }).source).toBe("bypass");
    expect(createCanonicalAttempt(null, { source: "combo" }).source).toBe("provider"); // orchestration ≠ source
  });

  it("bounded field set — no fallback/retry/health/taxonomy fields", () => {
    const ca = createCanonicalAttempt(null, { status: 500 });
    const keys = Object.keys(ca).sort();
    expect(keys).not.toContain("fallbackEligible");
    expect(keys).not.toContain("retryable");
    expect(keys).not.toContain("providerHealth");
    expect(keys).not.toContain("routingScore");
    expect(keys).not.toContain("errorTaxonomy");
  });

  it("first-terminal-wins preserved: completed→[DONE] stays success; failed→[DONE] stays failure", () => {
    const completed = stateFrom(openaiContent("x"), { type: "response.completed" }, { done: true });
    expect(completed.terminalState).toBe("success");
    expect(deriveOutcome(completed)).toBe("success");

    const failed = stateFrom(openaiContent("x"), { type: "response.failed" }, { done: true });
    expect(failed.terminalState).toBe("failure");
    expect(deriveOutcome(failed)).toBe("failure");
  });
});

describe("HARDENING: transportOk explicit 3-state contract", () => {
  it("status 200 → transportOk true", () => {
    expect(createCanonicalAttempt(null, { status: 200, source: "provider" }).transportOk).toBe(true);
  });
  it("status 500 → transportOk false", () => {
    expect(createCanonicalAttempt(null, { status: 500, source: "provider" }).transportOk).toBe(false);
    expect(createCanonicalAttempt(null, { status: 503, source: "provider" }).transportOk).toBe(false);
  });
  it("status undefined → transportOk null (NOT false)", () => {
    expect(createCanonicalAttempt(null, { source: "provider" }).transportOk).toBe(null);
    expect(createCanonicalAttempt(null, { status: null, source: "provider" }).transportOk).toBe(null);
  });
  it("transportOk stays independent from body-derived logicalSuccess", () => {
    const s = stateFrom(openaiContent("a"), openaiFinish("stop"));
    expect(createCanonicalAttempt(s, { status: 500, source: "provider" }).transportOk).toBe(false);
    expect(createCanonicalAttempt(s, { status: 500, source: "provider" }).logicalSuccess).toBe(true); // semantics independent of transport
  });
});

describe("HARDENING: source=cache synthetic semantics", () => {
  it("valid cache hit (2xx, no stream state) → completionState success, logicalSuccess true, stream fields null", () => {
    const ca = createCanonicalAttempt(null, { status: 200, source: "cache" });
    expect(ca.source).toBe("cache");
    expect(ca.transportOk).toBe(true);
    expect(ca.completionState).toBe("success");
    expect(ca.completionType).toBe("cache");
    expect(ca.usableOutput).toBe(true);
    expect(ca.logicalSuccess).toBe(true);
    expect(ca.outcome).toBe("success");
    expect(ca.streamStarted).toBe(null);
    expect(ca.eofSeen).toBe(null);
    expect(ca.terminalState).toBe(null);
    // No fabricated output-category evidence.
    expect(ca.hasText).toBe(false);
    expect(ca.hasReasoning).toBe(false);
    expect(ca.hasToolCall).toBe(false);
    expect(ca.hasStructuredOutput).toBe(false);
  });
  it("cache failure (non-2xx) → completionState failure, logicalSuccess false", () => {
    const ca = createCanonicalAttempt(null, { status: 502, source: "cache" });
    expect(ca.completionState).toBe("failure");
    expect(ca.logicalSuccess).toBe(false);
    expect(ca.outcome).toBe("failure");
    expect(ca.usableOutput).toBe(false);
  });
});

describe("HARDENING: source=bypass synthetic semantics", () => {
  it("valid bypass → completionState success, logicalSuccess true, stream evidence not fabricated", () => {
    const ca = createCanonicalAttempt(null, { status: 200, source: "bypass" });
    expect(ca.source).toBe("bypass");
    expect(ca.completionState).toBe("success");
    expect(ca.completionType).toBe("bypass");
    expect(ca.logicalSuccess).toBe(true);
    expect(ca.outcome).toBe("success");
    expect(ca.streamStarted).toBe(null); // NOT fabricated to true
    expect(ca.eofSeen).toBe(null);
    expect(ca.terminalState).toBe(null);
    expect(ca.hasText).toBe(false);
  });
  it("bypass error (non-2xx) → not fake success", () => {
    const ca = createCanonicalAttempt(null, { status: 500, source: "bypass" });
    expect(ca.completionState).toBe("failure");
    expect(ca.logicalSuccess).toBe(false);
  });
});

describe("HARDENING: no overfit — source!=provider does NOT hard-code success", () => {
  it("provider path with no evidence stays failure/incomplete (not auto-success)", () => {
    const ca = createCanonicalAttempt(null, { status: 200, source: "provider" });
    expect(ca.completionState).toBe("unknown");
    expect(ca.logicalSuccess).toBe(false);
  });
});
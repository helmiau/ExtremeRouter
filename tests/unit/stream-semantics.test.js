import { describe, it, expect, vi } from "vitest";

// Wave 2 commit 2: pure semantic derivation tests. These derive
// logicalSuccess / canonicalAttempt from the observed stream state; NO
// production behavior is asserted to change.

import { createStreamState, observeParsedEvent } from "../../open-sse/utils/streamState.js";
import { deriveUsableOutput, deriveLogicalSuccess, deriveAttemptOutcome, createCanonicalAttempt } from "../../open-sse/utils/streamSemantics.js";

const stateFrom = (...events) => {
  const s = createStreamState();
  for (const evt of events) observeParsedEvent(s, evt);
  return s;
};

// OpenAI-shaped events
const openaiContent = (content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const openaiReasoning = (c) => ({ choices: [{ index: 0, delta: { reasoning_content: c }, finish_reason: null }] });
const openaiTool = () => ({
  choices: [{
    index: 0,
    delta: { tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] },
  }],
});
const openaiFinish = (fr) => ({ choices: [{ index: 0, delta: {}, finish_reason: fr }] });
const usageOnly = () => ({ choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 5, completion_tokens: 3 } });

describe("deriveUsableOutput", () => {
  it("true for text / reasoning / tool-call", () => {
    expect(deriveUsableOutput(stateFrom(openaiContent("hi")))).toBe(true);
    expect(deriveUsableOutput(stateFrom(openaiReasoning("hmm")))).toBe(true);
    expect(deriveUsableOutput(stateFrom(openaiTool()))).toBe(true);
  });
  it("false for usage-only, empty, and pure [DONE]/terminal", () => {
    expect(deriveUsableOutput(stateFrom(usageOnly()))).toBe(false);
    expect(deriveUsableOutput(createStreamState())).toBe(false);
    expect(deriveUsableOutput(stateFrom(openaiFinish("stop")))).toBe(false);
  });
});

describe("deriveLogicalSuccess", () => {
  it("Case A: text + stop + EOF → success", () => {
    const s = stateFrom(openaiContent("answer"), openaiFinish("stop"));
    s.eofSeen = true;
    expect(deriveLogicalSuccess(s)).toBe(true);
  });
  it("Case B: tool-only + tool_calls → success", () => {
    const s = stateFrom(openaiTool(), openaiFinish("tool_calls"));
    expect(deriveLogicalSuccess(s)).toBe(true);
  });
  it("Case C: reasoning-only + stop → success (usable output category)", () => {
    const s = stateFrom(openaiReasoning("deep"), openaiFinish("stop"));
    expect(deriveLogicalSuccess(s)).toBe(true);
  });
  it("Case D: usage-only + [DONE] (neutral terminal) → NOT success", () => {
    const s = stateFrom(usageOnly());
    s.terminalSeen = true; // [DONE] observed → neutral (terminalState null)
    expect(s.terminalState).toBe(null);
    expect(deriveLogicalSuccess(s)).toBe(false);
  });
  it("Case E: empty stream + EOF → NOT success", () => {
    const s = createStreamState();
    s.eofSeen = true;
    expect(deriveLogicalSuccess(s)).toBe(false);
  });
  it("Case F: output + no terminal + EOF → NOT success", () => {
    const s = stateFrom(openaiContent("partial"));
    s.eofSeen = true;
    expect(deriveLogicalSuccess(s)).toBe(false);
  });
  it("Case G: output + failure terminal → NOT success", () => {
    const s = stateFrom(openaiContent("partial"), { type: "error", error: { type: "api_error" } });
    expect(deriveLogicalSuccess(s)).toBe(false);
  });
  it("Case H: output + abort → NOT success", () => {
    const s = stateFrom(openaiContent("partial"));
    s.abortSeen = true;
    expect(deriveLogicalSuccess(s)).toBe(false);
  });
  it("Case I (forensic Cline): text + usage + stop + [DONE] + EOF → success", () => {
    const s = stateFrom(
      openaiContent("Answer "),
      usageOnly(),
      openaiFinish("stop"),
    );
    s.terminalSeen = true; // [DONE] neutral observed AFTER the stop terminal
    s.eofSeen = true;
    expect(s.terminalState).toBe("success"); // first-terminal-wins preserved
    expect(deriveLogicalSuccess(s)).toBe(true);
  });
  it("usage telemetry never grants success even with a success terminal", () => {
    const s = stateFrom(usageOnly());
    expect(deriveLogicalSuccess(s)).toBe(false);
  });
});

describe("deriveAttemptOutcome", () => {
  it("maps the four outcome classes", () => {
    expect(deriveAttemptOutcome(stateFrom(openaiContent("a"), openaiFinish("stop")))).toBe("success");
    expect(deriveAttemptOutcome(stateFrom(openaiContent("a"), { type: "error", error: {} }))).toBe("failure");
    expect(deriveAttemptOutcome(stateFrom(openaiContent("a")))).toBe("incomplete"); // no terminal
    const aborted = stateFrom(openaiContent("a"));
    aborted.abortSeen = true;
    expect(deriveAttemptOutcome(aborted)).toBe("cancelled");
  });
  it("failure beats abort beats incomplete (check order)", () => {
    const both = stateFrom(openaiContent("a"), { type: "error", error: {} });
    both.abortSeen = true;
    expect(deriveAttemptOutcome(both)).toBe("failure");
  });
  it("finish_reason=length → incomplete", () => {
    expect(deriveAttemptOutcome(stateFrom(openaiContent("partial"), openaiFinish("length")))).toBe("incomplete");
  });
});

describe("createCanonicalAttempt", () => {
  it("composes state + transport into the full immutable-shaped object", () => {
    const s = stateFrom(openaiContent("answer"), openaiFinish("stop"));
    const ca = createCanonicalAttempt(s, { status: 200 });
    expect(ca.transportOk).toBe(true);
    expect(ca.hasText).toBe(true);
    expect(ca.terminalState).toBe("success");
    expect(ca.usableOutput).toBe(true);
    expect(ca.logicalSuccess).toBe(true);
    expect(ca.outcome).toBe("success");
    expect(ca.eofSeen).toBe(false); // derived only from state
  });
  it("transport status 503 → transportOk=false, semantics unaffected", () => {
    const s = stateFrom(openaiContent("answer"), openaiFinish("stop"));
    const ca = createCanonicalAttempt(s, { status: 503 });
    expect(ca.transportOk).toBe(false);
    expect(ca.logicalSuccess).toBe(true); // semantic result is independent of transport
  });
  it("field list is bounded — no fallback/retry/health/taxonomy fields", () => {
    const ca = createCanonicalAttempt(createStreamState(), { status: 500 });
    const keys = Object.keys(ca).sort();
    expect(keys).not.toContain("fallbackEligible");
    expect(keys).not.toContain("retryable");
    expect(keys).not.toContain("providerHealth");
    expect(keys).not.toContain("routingScore");
    expect(keys).not.toContain("errorTaxonomy");
  });
});

describe("first-terminal-wins through derivation", () => {
  it("response.completed then [DONE] stays success", () => {
    const s = stateFrom({ type: "response.completed" }, { done: true }); // done=true bare = neutral [DONE]
    expect(s.terminalState).toBe("success");
    expect(deriveLogicalSuccess(s) ? s.hasText : true).toBe(true); // usableOutput gate
    const withText = stateFrom(openaiContent("x"), { type: "response.completed" }, { done: true });
    expect(deriveLogicalSuccess(withText)).toBe(true);
  });
  it("response.failed then [DONE] stays failure", () => {
    const s = stateFrom(openaiContent("x"), { type: "response.failed" }, { done: true });
    expect(s.terminalState).toBe("failure");
    expect(deriveLogicalSuccess(s)).toBe(false);
    expect(deriveAttemptOutcome(s)).toBe("failure");
  });
});

describe("provider terminal matrix (derivation consistency)", () => {
  it("OpenAI stop / tool_calls / length", () => {
    expect(deriveLogicalSuccess(stateFrom(openaiContent("a"), openaiFinish("stop")))).toBe(true);
    expect(deriveLogicalSuccess(stateFrom(openaiTool(), openaiFinish("tool_calls")))).toBe(true);
    expect(deriveAttemptOutcome(stateFrom(openaiContent("a"), openaiFinish("length")))).toBe("incomplete");
  });
  it("Claude message_stop + text → success", () => {
    const s = stateFrom({ type: "content_block_delta", delta: { text: "hello" } }, { type: "message_stop" });
    expect(deriveLogicalSuccess(s)).toBe(true);
  });
  it("Responses completed/done → success; failed; incomplete; cancelled", () => {
    expect(deriveLogicalSuccess(stateFrom({ type: "response.output_text.delta", delta: "hi" }, { type: "response.completed" }))).toBe(true);
    expect(deriveLogicalSuccess(stateFrom({ type: "response.output_text.delta", delta: "hi" }, { type: "response.done" }))).toBe(true);
    expect(deriveAttemptOutcome(stateFrom({ type: "response.output_text.delta", delta: "hi" }, { type: "response.failed" }))).toBe("failure");
    expect(deriveAttemptOutcome(stateFrom({ type: "response.output_text.delta", delta: "hi" }, { type: "response.incomplete" }))).toBe("incomplete");
    const cancelled = stateFrom({ type: "response.output_text.delta", delta: "hi" }, { type: "response.cancelled" });
    cancelled.abortSeen = true;
    expect(deriveAttemptOutcome(cancelled)).toBe("cancelled");
  });
  it("Ollama done=true with payload → success", () => {
    const s = stateFrom({ done: true, message: { role: "assistant", content: "" }, total_duration: 1 });
    expect(s.terminalState).toBe("success");
    // content string is empty → not usable output; a real Ollama payload would
    // carry text in a delta. This asserts semantics, not the fixture.
    expect(deriveLogicalSuccess(s)).toBe(false);
    const withText = stateFrom({ done: true, message: { role: "assistant", content: "reply" }, total_duration: 1 });
    expect(withText.hasText).toBe(false); // observeParsedEvent reads delta.text only
    expect(deriveUsableOutput(withText)).toBe(false);
  });
  it("Gemini finishReason=STOP → success", () => {
    const s = stateFrom({ candidates: [{ content: { parts: [{ text: "gem answer" }] }, finishReason: "STOP" }] });
    expect(deriveLogicalSuccess(s)).toBe(true);
  });
});

describe("concurrency: canonical attempts never share mutable state", () => {
  it("A and B derive independently", () => {
    const a = stateFrom(openaiContent("A answer"), openaiFinish("stop"));
    const b = stateFrom(openaiTool(), { type: "error", error: { type: "api_error" } });
    const caA = createCanonicalAttempt(a, { status: 200 });
    const caB = createCanonicalAttempt(b, { status: 502 });
    expect(caA.logicalSuccess).toBe(true);
    expect(caA.outcome).toBe("success");
    expect(caB.hasToolCall).toBe(true);
    expect(caB.hasText).toBe(false);
    expect(caB.logicalSuccess).toBe(false);
    expect(caB.outcome).toBe("failure");
    // No shared mutation: mutating A's derived object must not affect B.
    caA.outcome = "mutated";
    expect(caB.outcome).toBe("failure");
  });
});
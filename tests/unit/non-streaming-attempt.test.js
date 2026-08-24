import { describe, it, expect, vi } from "vitest";

// Commit B: normal non-streaming canonical-attempt adapter tests.
// Pure-function tests over createCanonicalAttemptFromNonStreaming +
// extractNonStreamingEvidence. No ChatResult/Combo/HTTP behavior changes.

import {
  createCanonicalAttemptFromNonStreaming,
  extractNonStreamingEvidence,
} from "../../open-sse/utils/nonStreamingAttempt.js";

const openaiText = (content) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
const openaiTool = () => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
const openaiReasoning = (r) => ({ choices: [{ message: { role: "assistant", content: "", reasoning_content: r }, finish_reason: "stop" }] });
const usageOnlyBody = () => ({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } });
const emptyChoices = () => ({ choices: [] });
const emptyContent = () => ({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] });
const usage = { prompt_tokens: 5, completion_tokens: 3 };

const attempt = (overrides = {}) => createCanonicalAttemptFromNonStreaming({ status: 200, parsed: openaiText("ok"), usage: null, malformed: false, ...overrides });

describe("success matrix", () => {
  it("200 + text → logicalSuccess=true, completionState=success", () => {
    const ca = attempt({ parsed: openaiText("Hello") });
    expect(ca.transportOk).toBe(true);
    expect(ca.hasText).toBe(true);
    expect(ca.usableOutput).toBe(true);
    expect(ca.completionState).toBe("success");
    expect(ca.completionType).toBe("http_2xx_json");
    expect(ca.logicalSuccess).toBe(true);
    expect(ca.outcome).toBe("success");
  });
  it("200 + tool call → logicalSuccess=true", () => {
    const ca = attempt({ parsed: openaiTool() });
    expect(ca.hasToolCall).toBe(true);
    expect(ca.hasText).toBe(false);
    expect(ca.usableOutput).toBe(true);
    expect(ca.logicalSuccess).toBe(true);
  });
  it("200 + reasoning → logicalSuccess=true", () => {
    const ca = attempt({ parsed: openaiReasoning("deep thought") });
    expect(ca.hasReasoning).toBe(true);
    expect(ca.hasText).toBe(false);
    expect(ca.logicalSuccess).toBe(true);
  });
  it("200 + structured output (explicit response_format contract + valid structured result) → logicalSuccess=true", () => {
    const ca = attempt({ parsed: openaiText('{"city":"Paris"}'), structuredContract: true });
    expect(ca.hasStructuredOutput).toBe(true);
    expect(ca.usableOutput).toBe(true);
    expect(ca.logicalSuccess).toBe(true);
  });
});

describe("empty/non-success matrix", () => {
  it("200 + usage only → hasUsage=true, usableOutput=false, logicalSuccess=false", () => {
    const ca = attempt({ parsed: usageOnlyBody(), usage });
    expect(ca.hasUsage).toBe(true);
    expect(ca.usableOutput).toBe(false);
    expect(ca.completionState).toBe("incomplete");
    expect(ca.logicalSuccess).toBe(false);
  });
  it("200 + empty choices → logicalSuccess=false, incomplete", () => {
    const ca = attempt({ parsed: emptyChoices() });
    expect(ca.usableOutput).toBe(false);
    expect(ca.completionState).toBe("incomplete");
    expect(ca.logicalSuccess).toBe(false);
  });
  it("200 + empty content → logicalSuccess=false", () => {
    const ca = attempt({ parsed: emptyContent() });
    expect(ca.hasText).toBe(false);
    expect(ca.usableOutput).toBe(false);
    expect(ca.logicalSuccess).toBe(false);
  });
  it("200 + no usable model fields → incomplete", () => {
    const ca = attempt({ parsed: { id: "x", model: "m", choices: [{ message: {} }] } });
    expect(ca.usableOutput).toBe(false);
    expect(ca.completionState).toBe("incomplete");
    expect(ca.logicalSuccess).toBe(false);
  });
});

describe("error matrix", () => {
  it.each([400, 401, 403, 404, 429, 500, 502, 503])("non-2xx status %s → transportOk=false, completionState=failure, logicalSuccess=false", (status) => {
    const ca = attempt({ status, parsed: openaiText("x") });
    expect(ca.transportOk).toBe(false);
    expect(ca.completionState).toBe("failure");
    expect(ca.completionType).toBe("http_error");
    expect(ca.errorSeen).toBe(true);
    expect(ca.logicalSuccess).toBe(false);
  });
  it("malformed JSON (200) → errorSeen=true, completionState=failure, json_parse_error", () => {
    const ca = attempt({ malformed: true, parsed: null });
    expect(ca.transportOk).toBe(true); // HTTP was 200
    expect(ca.errorSeen).toBe(true);
    expect(ca.completionState).toBe("failure");
    expect(ca.completionType).toBe("json_parse_error");
    expect(ca.logicalSuccess).toBe(false);
  });
  it("provider semantic error envelope → errorSeen=true, not fake success", () => {
    const ca = attempt({ parsed: { error: { message: "provider exploded" } } });
    expect(ca.errorSeen).toBe(true);
    expect(ca.logicalSuccess).toBe(false);
  });
});

describe("metadata + field semantics", () => {
  it("usage present vs absent", () => {
    expect(attempt({ parsed: openaiText("x"), usage }).hasUsage).toBe(true);
    expect(attempt({ parsed: openaiText("x"), usage: null }).hasUsage).toBe(false);
  });
  it("source=provider; stream fields stay null", () => {
    const ca = attempt();
    expect(ca.source).toBe("provider");
    expect(ca.streamStarted).toBe(null);
    expect(ca.eofSeen).toBe(null);
    expect(ca.terminalState).toBe(null);
    expect(ca.terminalType).toBe(null);
    expect(ca.finishReason).toBe(null);
    expect(ca.abortSeen).toBe(false);
  });
  it("transportOk 3-state", () => {
    expect(attempt({ status: 200 }).transportOk).toBe(true);
    expect(attempt({ status: 500 }).transportOk).toBe(false);
    expect(attempt({ status: undefined }).transportOk).toBe(null);
  });
});

describe("logical derivation rules", () => {
  it("usableOutput=true + success completion → logicalSuccess", () => {
    expect(attempt({ parsed: openaiText("y") }).logicalSuccess).toBe(true);
  });
  it("usableOutput=false + success-looking completion → logicalSuccess=false", () => {
    const ca = attempt({ parsed: usageOnlyBody(), usage });
    expect(ca.completionState).toBe("incomplete"); // not even a success completion
    expect(ca.logicalSuccess).toBe(false);
  });
  it("output + incomplete completion → logicalSuccess=false", () => {
    // A 2xx without usable output is incomplete; nothing else here is success.
    const ca = attempt({ parsed: emptyContent() });
    expect(ca.logicalSuccess).toBe(false);
  });
});

describe("no false structured output", () => {
  it("usage JSON / error JSON / metadata envelope / empty choices never set hasStructuredOutput", () => {
    expect(extractNonStreamingEvidence({ usage: { prompt_tokens: 1 } }, usage).hasStructuredOutput).toBe(false);
    expect(extractNonStreamingEvidence({ error: { message: "x" } }, null).hasStructuredOutput).toBe(false);
    expect(extractNonStreamingEvidence({ id: "x", created: 1, model: "m" }, null).hasStructuredOutput).toBe(false);
    expect(extractNonStreamingEvidence({ choices: [] }, null).hasStructuredOutput).toBe(false);
    expect(extractNonStreamingEvidence(null, null).hasStructuredOutput).toBe(false);
  });
  it("tool RESULTS (user/tool messages) never count as tool calls", () => {
    const ev = extractNonStreamingEvidence({ choices: [{ message: { role: "tool", content: "result" } }] }, null);
    expect(ev.hasToolCall).toBe(false);
    expect(ev.hasText).toBe(false); // tool-result content is not assistant output
  });
});

describe("STRUCTURED OUTPUT HARDENING", () => {
  it("explicit structured contract + valid structured result → hasStructuredOutput=true → logicalSuccess", () => {
    const ca = attempt({ parsed: openaiText('{"city":"Paris","temp":22}'), structuredContract: true });
    expect(ca.hasStructuredOutput).toBe(true);
    expect(ca.usableOutput).toBe(true);
    expect(ca.logicalSuccess).toBe(true);
  });

  it.each([
    ["{hello}", "unbalanced brace"],
    ["[Note] deployment complete", "bracket-prefixed note"],
    ["{\n  this is just text\n}", "JSON-looking plain text"],
    ["[1] ordinary text", "ordered-list prefix"],
  ])("JSON-looking plain text %p (%s) is NOT structured output, but IS text", (content, _label) => {
    const ca = attempt({ parsed: openaiText(content), structuredContract: false });
    expect(ca.hasText).toBe(true); // normal text semantics preserved
    expect(ca.hasStructuredOutput).toBe(false); // no startsWith({/[) guess
    expect(ca.usableOutput).toBe(true); // text alone is usable output
  });

  it("false-positive prevention: JSON-looking text must NEVER become structured output even with a contract but invalid content", () => {
    const ca = attempt({ parsed: openaiText("{hello}"), structuredContract: true });
    expect(ca.hasStructuredOutput).toBe(false);
    expect(ca.hasText).toBe(true);
  });

  it("usage / error envelope / empty choices / metadata / [DONE] still never structured output", () => {
    expect(extractNonStreamingEvidence({ usage: { prompt_tokens: 1 } }, usage).hasStructuredOutput).toBe(false);
    expect(extractNonStreamingEvidence({ error: { message: "x" } }, null).hasStructuredOutput).toBe(false);
    expect(extractNonStreamingEvidence({ choices: [] }, null).hasStructuredOutput).toBe(false);
    expect(extractNonStreamingEvidence({ id: "x", model: "m" }, null).hasStructuredOutput).toBe(false);
    expect(extractNonStreamingEvidence({ done: true }, null).hasStructuredOutput).toBe(false);
  });

  it("structured output can coexist with hasText=false when normalization places it elsewhere (contract still satisfied)", () => {
    const ev = extractNonStreamingEvidence(
      { choices: [{ message: { role: "assistant", content: '{"a":1}' } }] },
      null,
      { structuredContract: true },
    );
    expect(ev.hasStructuredOutput).toBe(true);
  });
});

describe("forensic cases from the spec", () => {
  it("Case A: valid JSON but choices=[] → transportOk=true, usableOutput=false, incomplete, logicalSuccess=false", () => {
    const ca = attempt({ parsed: { choices: [] } });
    expect(ca.transportOk).toBe(true);
    expect(ca.usableOutput).toBe(false);
    expect(ca.completionState).toBe("incomplete");
    expect(ca.logicalSuccess).toBe(false);
  });
  it("Case B: usage only → hasUsage=true, usableOutput=false, logicalSuccess=false", () => {
    const ca = attempt({ parsed: usageOnlyBody(), usage });
    expect(ca.hasUsage).toBe(true);
    expect(ca.usableOutput).toBe(false);
    expect(ca.logicalSuccess).toBe(false);
  });
  it("Case C: valid tool call → logicalSuccess=true", () => {
    expect(attempt({ parsed: openaiTool() }).logicalSuccess).toBe(true);
  });
  it("Case D: valid structured output → logicalSuccess=true", () => {
    expect(attempt({ parsed: openaiText('{"ok":1}') }).logicalSuccess).toBe(true);
  });
  it("Case E: malformed JSON with 200 → errorSeen=true, failure, logicalSuccess=false", () => {
    const ca = attempt({ malformed: true });
    expect(ca.transportOk).toBe(true);
    expect(ca.errorSeen).toBe(true);
    expect(ca.completionState).toBe("failure");
    expect(ca.logicalSuccess).toBe(false);
  });
});
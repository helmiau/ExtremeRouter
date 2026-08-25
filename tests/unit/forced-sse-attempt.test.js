import { describe, it, expect, vi } from "vitest";

// sseToJsonHandler pulls request-detail persistence via an @/ alias. This
// session's pre-existing Vite alias break would otherwise prevent parser tests
// from loading; the parser/adapter test does not persist anything.
vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: vi.fn() }));

import { createCanonicalAttemptFromForcedSse } from "../../open-sse/utils/forcedSseAttempt.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

const openaiText = (content, finish_reason = "stop") => ({ choices: [{ message: { role: "assistant", content }, finish_reason }] });
const openaiTool = () => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
const openaiReasoning = () => ({ choices: [{ message: { role: "assistant", content: "", reasoning_content: "think" }, finish_reason: "stop" }] });
const usage = { prompt_tokens: 5, completion_tokens: 3 };
const attempt = (overrides = {}) => createCanonicalAttemptFromForcedSse({ status: 200, finalJson: openaiText("ok"), ...overrides });

describe("forced SSE → JSON canonical adapter: valid output", () => {
  it("text + finish_reason → provider source, success", () => {
    const ca = attempt({ finalJson: openaiText("hello", "stop") });
    expect(ca.source).toBe("provider");
    expect(ca.transportOk).toBe(true);
    expect(ca.hasText).toBe(true);
    expect(ca.finishReason).toBe("stop");
    expect(ca.completionState).toBe("success");
    expect(ca.logicalSuccess).toBe(true);
  });
  it("text + [DONE] parser result (finish reason preserved) → success", () => {
    const parsed = parseSSEToOpenAIResponse(
      'data: {"id":"x","choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n' +
      'data: {"id":"x","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n',
      "m",
    );
    const ca = attempt({ finalJson: parsed });
    expect(ca.hasText).toBe(true);
    expect(ca.finishReason).toBe("stop");
    expect(ca.logicalSuccess).toBe(true); // [DONE itself is not evidence
  });
  it("tool call + finish → success", () => {
    const ca = attempt({ finalJson: openaiTool() });
    expect(ca.hasToolCall).toBe(true);
    expect(ca.usableOutput).toBe(true);
    expect(ca.logicalSuccess).toBe(true);
  });
  it("reasoning + finish → success", () => {
    const ca = attempt({ finalJson: openaiReasoning() });
    expect(ca.hasReasoning).toBe(true);
    expect(ca.logicalSuccess).toBe(true);
  });
  it("usage + text (forensic) → usage recorded but text is success evidence", () => {
    const ca = attempt({ finalJson: openaiText("answer"), usage });
    expect(ca.hasUsage).toBe(true);
    expect(ca.hasText).toBe(true);
    expect(ca.logicalSuccess).toBe(true);
  });
  it("explicit structured contract + valid JSON content → structured output", () => {
    const ca = attempt({ finalJson: openaiText('{"city":"Paris"}'), structuredContract: true });
    expect(ca.hasStructuredOutput).toBe(true);
    expect(ca.logicalSuccess).toBe(true);
  });
});

describe("forced SSE → JSON canonical adapter: empty/incomplete", () => {
  it("usage-only → usableOutput=false, logicalSuccess=false, incomplete", () => {
    const ca = attempt({ finalJson: { choices: [], usage }, usage });
    expect(ca.hasUsage).toBe(true);
    expect(ca.usableOutput).toBe(false);
    expect(ca.completionState).toBe("incomplete");
    expect(ca.logicalSuccess).toBe(false);
  });
  it("no usable output / empty choices → incomplete", () => {
    const ca = attempt({ finalJson: { choices: [] } });
    expect(ca.usableOutput).toBe(false);
    expect(ca.completionState).toBe("incomplete");
  });
  it("valid [DONE] with no output → incomplete, never success", () => {
    const parsed = parseSSEToOpenAIResponse("data: [DONE]\n\n", "m");
    expect(parsed).toBe(null); // existing parser/public handler preserves 502 behavior
    const ca = attempt({ finalJson: { choices: [] } });
    expect(ca.logicalSuccess).toBe(false);
  });
});

describe("forced SSE → JSON malformed SSE observation", () => {
  it("one malformed event followed by valid output is recoverable and still success", () => {
    let malformed = 0;
    const parsed = parseSSEToOpenAIResponse(
      'data: {broken json}\n\n' +
      'data: {"id":"x","choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
      'data: {"id":"x","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "m",
      { onMalformedLine: () => malformed++ },
    );
    const ca = attempt({ finalJson: parsed, malformedLines: malformed });
    expect(malformed).toBe(1);
    expect(ca.hasText).toBe(true);
    expect(ca.errorSeen).toBe(false); // recoverable by existing parser behavior
    expect(ca.logicalSuccess).toBe(true);
  });
  it("malformed-only stream → parser returns null; canonical observation is failure", () => {
    let malformed = 0;
    const parsed = parseSSEToOpenAIResponse('data: {totally broken}\n\n', "m", { onMalformedLine: () => malformed++ });
    expect(parsed).toBe(null); // current public handler returns existing 502
    const ca = attempt({ finalJson: null, malformedLines: malformed });
    expect(malformed).toBe(1);
    expect(ca.errorSeen).toBe(true);
    expect(ca.usableOutput).toBe(false);
    expect(ca.completionState).toBe("failure");
    expect(ca.completionType).toBe("malformed_sse");
    expect(ca.logicalSuccess).toBe(false);
  });
});

describe("forced SSE → JSON explicit failures + Responses terminals", () => {
  it("provider error envelope overrides HTTP 200 → failure", () => {
    const ca = attempt({ finalJson: { error: { message: "provider failed" } } });
    expect(ca.transportOk).toBe(true);
    expect(ca.errorSeen).toBe(true);
    expect(ca.completionState).toBe("failure");
    expect(ca.logicalSuccess).toBe(false);
  });
  it("Responses completed → success", () => {
    const ca = attempt({ finalJson: openaiText("ok"), responsesStatus: "completed" });
    expect(ca.completionState).toBe("success");
    expect(ca.completionType).toBe("response.completed");
  });
  it("Responses done → success", () => {
    const ca = attempt({ finalJson: openaiText("ok"), responsesStatus: "done" });
    expect(ca.completionState).toBe("success");
    expect(ca.completionType).toBe("response.done");
  });
  it("Responses failed → failure", () => {
    const ca = attempt({ finalJson: openaiText("partial"), responsesStatus: "failed" });
    expect(ca.errorSeen).toBe(true);
    expect(ca.completionState).toBe("failure");
    expect(ca.completionType).toBe("response.failed");
  });
  it("Responses incomplete → incomplete", () => {
    const ca = attempt({ finalJson: openaiText("partial"), responsesStatus: "incomplete" });
    expect(ca.completionState).toBe("incomplete");
    expect(ca.logicalSuccess).toBe(false);
  });
  it("Responses cancelled → cancelled, abortSeen false (provider cancel ≠ client abort)", () => {
    const ca = attempt({ finalJson: openaiText("partial"), responsesStatus: "cancelled" });
    expect(ca.completionState).toBe("cancelled");
    expect(ca.completionType).toBe("response.cancelled");
    expect(ca.abortSeen).toBe(false);
    expect(ca.logicalSuccess).toBe(false);
  });
});

describe("field semantics", () => {
  it("source=provider + no fake stream state + transport statuses", () => {
    const ca = attempt();
    expect(ca.source).toBe("provider");
    expect(ca.streamStarted).toBe(null);
    expect(ca.eofSeen).toBe(null);
    expect(ca.terminalState).toBe(null);
    expect(attempt({ status: 200 }).transportOk).toBe(true);
    expect(attempt({ status: 500 }).transportOk).toBe(false);
    expect(attempt({ status: undefined }).transportOk).toBe(null);
  });
  it("JSON-looking plain text without structured contract is NOT structured", () => {
    const ca = attempt({ finalJson: openaiText("{hello}") });
    expect(ca.hasText).toBe(true);
    expect(ca.hasStructuredOutput).toBe(false);
    expect(ca.usableOutput).toBe(true);
  });
});

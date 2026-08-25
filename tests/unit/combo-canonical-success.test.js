import { describe, it, expect, vi } from "vitest";

// Commit F: outer Fallback/Round-Robin now gates candidates on `candidateServed`
// — finalized canonicalAttempt.logicalSuccess for BUFFERED attempts, legacy
// result.success ONLY for null-attempt paths. This file exercises the buffered
// (non-streaming / forced-SSE) + null-attempt semantics via an injected
// handleSingleModel closure (no provider/network involved).

vi.mock("../../open-sse/services/providerCapabilities.js", () => ({
  validateComboRoles: () => [],
}));

const { handleComboChat } = await import("../../open-sse/services/combo.js");

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const jsonRes = (status, body, contentType = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });

// A finalized non-streaming canonicalAttempt (source=provider, already final).
const attempt = (overrides = {}) => ({
  source: "provider",
  transportOk: true,
  streamStarted: null,
  hasText: true,
  hasReasoning: false,
  hasToolCall: false,
  hasStructuredOutput: false,
  hasUsage: false,
  completionState: "success",
  completionType: "http_2xx_json",
  terminalState: null,
  terminalType: null,
  finishReason: "stop",
  eofSeen: null,
  errorSeen: false,
  abortSeen: false,
  usableOutput: true,
  logicalSuccess: true,
  outcome: "success",
  ...overrides,
});

const okBody = () => ({ id: "x", object: "chat.completion", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });

describe("Fallback: buffered candidate gating on finalized logicalSuccess", () => {
  it("text success (logicalSuccess=true) → candidate 1 served", async () => {
    const r200 = jsonRes(200, okBody());
    const fake = vi.fn(async () => ({ success: true, status: 200, response: r200, canonicalAttempt: attempt() }));
    const out = await handleComboChat({ body: { model: "c" }, models: ["a"], handleSingleModel: fake, log, comboName: "c", comboStrategy: "fallback" });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(200);
  });

  it("tool-call success (logicalSuccess=true) → candidate served (Case B)", async () => {
    const toolAttempt = attempt({ hasText: false, hasToolCall: true, completionState: "success", logicalSuccess: true });
    const r = jsonRes(200, { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
    const fake = vi.fn(async () => ({ success: true, status: 200, response: r, canonicalAttempt: toolAttempt }));
    const out = await handleComboChat({ body: { model: "c" }, models: ["a"], handleSingleModel: fake, log, comboName: "c", comboStrategy: "fallback" });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(200);
  });

  it("reasoning-only success (logicalSuccess=true) → candidate served (Case C)", async () => {
    const reasonAttempt = attempt({ hasText: false, hasReasoning: true, completionState: "success", logicalSuccess: true });
    const r = jsonRes(200, { choices: [{ message: { role: "assistant", content: "", reasoning_content: "think" }, finish_reason: "stop" }] });
    const fake = vi.fn(async () => ({ success: true, status: 200, response: r, canonicalAttempt: reasonAttempt }));
    const out = await handleComboChat({ body: { model: "c" }, models: ["a"], handleSingleModel: fake, log, comboName: "c", comboStrategy: "fallback" });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(200);
  });

  it("usage-only (logicalSuccess=false) → candidate 1 rejected, candidate 2 tried (Case E)", async () => {
    const usageAttempt = attempt({ hasText: false, hasReasoning: false, hasToolCall: false, completionState: "incomplete", usableOutput: false, logicalSuccess: false, outcome: "incomplete" });
    const r200 = jsonRes(200, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } });
    const r2 = jsonRes(200, okBody());
    let n = 0;
    const fake = vi.fn(async (b, m) => {
      n += 1;
      if (m === "a") return { success: true, status: 200, response: r200, canonicalAttempt: usageAttempt };
      return { success: true, status: 200, response: r2, canonicalAttempt: attempt() };
    });
    const out = await handleComboChat({ body: { model: "c" }, models: ["a", "b"], handleSingleModel: fake, log, comboName: "c", comboStrategy: "fallback" });
    expect(fake).toHaveBeenCalledTimes(2); // candidate 1 failed semantic → fell through
    expect(out.status).toBe(200);
  });

  it("empty 200 JSON (logicalSuccess=false) → candidate 2 attempted (Case G)", async () => {
    const emptyAttempt = attempt({ hasText: false, completionState: "incomplete", usableOutput: false, logicalSuccess: false, outcome: "incomplete" });
    const r200 = jsonRes(200, { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] });
    const r2 = jsonRes(200, okBody());
    const fake = vi.fn(async (b, m) => (m === "a" ? { success: true, status: 200, response: r200, canonicalAttempt: emptyAttempt } : { success: true, status: 200, response: r2, canonicalAttempt: attempt() }));
    const out = await handleComboChat({ body: { model: "c" }, models: ["a", "b"], handleSingleModel: fake, log, comboName: "c", comboStrategy: "fallback" });
    expect(fake).toHaveBeenCalledTimes(2);
    expect(out.status).toBe(200);
  });

  it("all candidates logically fail → existing all-failed 503", async () => {
    const fail = attempt({ hasText: false, completionState: "incomplete", usableOutput: false, logicalSuccess: false, outcome: "incomplete" });
    const fake = vi.fn(async (b, m) => ({ success: true, status: 200, response: jsonRes(200, { choices: [] }), canonicalAttempt: fail }));
    const out = await handleComboChat({ body: { model: "c" }, models: ["a", "b"], handleSingleModel: fake, log, comboName: "c", comboStrategy: "fallback" });
    expect(fake).toHaveBeenCalledTimes(2);
    expect(out.status).toBe(503);
  });

  it("forced-SSE malformed-only (success=false, logicalSuccess=false) → candidate 2 tried (Case B forced-SSE)", async () => {
    const malformed = { source: "provider", transportOk: true, completionState: "failure", completionType: "malformed_sse", errorSeen: true, logicalSuccess: false, outcome: "failure", hasText: false, usableOutput: false };
    const r502 = jsonRes(502, { error: { message: "Invalid SSE" } });
    const r2 = jsonRes(200, okBody());
    const fake = vi.fn(async (b, m) => (m === "a" ? { success: false, status: 502, response: r502, canonicalAttempt: malformed } : { success: true, status: 200, response: r2, canonicalAttempt: attempt() }));
    const out = await handleComboChat({ body: { model: "c" }, models: ["a", "b"], handleSingleModel: fake, log, comboName: "c", comboStrategy: "fallback" });
    expect(fake).toHaveBeenCalledTimes(2);
    expect(out.status).toBe(200);
  });
});

describe("Fallback: null-attempt paths preserve legacy result.success", () => {
  it("cache hit (canonicalAttempt=null) succeeds on result.success (no fabricated failure)", async () => {
    const cached = jsonRes(200, okBody());
    const fake = vi.fn(async () => ({ success: true, status: 200, fromCache: true, response: cached, canonicalAttempt: null }));
    const out = await handleComboChat({ body: { model: "c" }, models: ["a"], handleSingleModel: fake, log, comboName: "c", comboStrategy: "fallback" });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(200);
  });

  it("no-attempt failure (canonicalAttempt=null, success=false) → falls through", async () => {
    const f1 = jsonRes(500, { error: { message: "down" } });
    const f2 = jsonRes(200, okBody());
    const fake = vi.fn(async (b, m) => (m === "a" ? { success: false, status: 500, response: f1, canonicalAttempt: null } : { success: true, status: 200, response: f2, canonicalAttempt: attempt() }));
    const out = await handleComboChat({ body: { model: "c" }, models: ["a", "b"], handleSingleModel: fake, log, comboName: "c", comboStrategy: "fallback" });
    expect(fake).toHaveBeenCalledTimes(2);
    expect(out.status).toBe(200);
  });
});

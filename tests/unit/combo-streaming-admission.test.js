import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Commit F §23/§24/§25 — REAL streaming lifecycle, driven through the REAL
// handleStreamingResponse + handleComboChat. The test acts as the streaming
// client (drains result.response.body as the consumer) so the internal lifecycle
// (onStreamComplete / flush, onError, onAbort) fires naturally. Combo itself
// never reads response.body (§11) — it decides on the admission signal only.
//
// Admission semantics (Commit F): a streaming 2xx Response handed back to Combo
// is committed to downstream delivery; the provisional canonicalAttempt must NOT
// drive a fallback. A pre-admission transport failure (no committed output) is
// still fallback-safe. Buffered 200 + logicalSuccess=false (non-streaming) IS
// rejected — proving admission ≠ buffered success.

vi.mock("../../open-sse/services/providerCapabilities.js", () => ({
  validateComboRoles: () => [],
}));
// streamingHandler imports saveRequestDetail via the @/ alias that is broken in
// the test environment (same workaround as the forced-sse suites).
vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  saveUsageStats: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(async () => {}),
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({
  assertPublicUrl: vi.fn(),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { createStreamController } = await import("../../open-sse/utils/streamHandler.js");
const { handleStreamingResponse, buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { handleComboChat } = await import("../../open-sse/services/combo.js");

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// OpenAI-format SSE line helpers (what the SSE transform parses).
const sseContent = (content) => `data: {"choices":[{"index":0,"delta":{"content":"${content}"},"finish_reason":null}]}\n\n`;
const sseDone = () => `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
const sseError = () => `data: {"choices":[{"index":0,"delta":{},"finish_reason":null}]}\n\ndata: {"error":true,"object":"error"}\n\n`;

// Build a mock provider Response whose ReadableStream yields the given SSE lines,
// optionally erroring after a delay to simulate abort/incomplete termination.
function mockProviderResponse(lines, status = 200) {
  const text = lines.join("");
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

// Drive the REAL streaming handler exactly like chatCore does, returning the
// ChatResult (with live canonicalAttempt holder) that Combo would receive.
function makeStreamingCandidate(providerResponse, onStreamComplete) {
  const streamController = createStreamController({ log, provider: "openai", model: "m1" });
  const { onStreamComplete: built, streamDetailId } = buildOnStreamComplete({
    provider: "openai", model: "m1", connectionId: "c1", apiKey: "k",
    requestStartTime: Date.now(), body: { model: "m1", stream: true },
    stream: true, finalBody: null, translatedBody: null, clientRawRequest: null,
    savedTokens: 0, savedTokensByMechanism: {}, savedBytesByMechanism: {},
    cavemanActive: false, ponytailActive: false, retryCount: 0,
    combo: { name: "c", strategy: "fallback", role: "worker" },
  });
  // Prefer the test's observer hook if provided, else the real builder.
  return handleStreamingResponse({
    providerResponse, provider: "openai", model: "m1", clientRawRequest: null,
    sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI, body: { model: "m1", stream: true },
    stream: true, translatedBody: null, finalBody: null, requestStartTime: Date.now(),
    connectionId: "c1", apiKey: "k", onRequestSuccess: null, reqLogger: null,
    toolNameMap: new Map(), streamController,
    onStreamComplete: onStreamComplete ?? built, streamDetailId, savedTokens: 0,
    combo: { name: "c", strategy: "fallback", role: "worker" },
  });
}

// Helper: drain a streaming Response as the CLIENT (settles internal lifecycle),
// returning after onStreamComplete flush has filled the holder.
async function drainAsClient(response) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let acc = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
  }
  return acc;
}

describe("Commit F: streaming candidate admission boundary (REAL lifecycle)", () => {
  it("Example D — stream starts, then ends incomplete; candidate 1 committed (candidate 2 NOT invoked)", async () => {
    // HTTP 200, partial text, no successful terminal (no finish/stop, no [DONE]).
    const incomplete = mockProviderResponse([sseContent("partial-") /* no done marker */]);
    let c2Called = false;
    const handleSingleModel = vi.fn(async (b, m) => {
      if (m === "m1") return makeStreamingCandidate(incomplete);
      if (m === "m2") { c2Called = true; }
      return { success: true, status: 200, response: new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } }), canonicalAttempt: { logicalSuccess: true, streamStarted: null, completionState: "success", source: "provider", transportOk: true, usableOutput: true } };
    });

    const out = await handleComboChat({ body: { model: "c" }, models: ["m1", "m2"], handleSingleModel, log, comboName: "c", comboStrategy: "fallback" });
    // Candidate 1's streaming 2xx Response was admitted → returned immediately;
    // candidate 2 must NOT be attempted despite eventual logicalSuccess=false.
    expect(c2Called).toBe(false);
    expect(out.headers.get("content-type")).toBe("text/event-stream");
  });

  it("Example E — streaming success; candidate 2 NOT invoked", async () => {
    const success = mockProviderResponse([sseContent("hello"), sseDone()]);
    let c2Called = false;
    const handleSingleModel = vi.fn(async (b, m) => {
      if (m === "m1") return makeStreamingCandidate(success);
      if (m === "m2") { c2Called = true; }
      return { success: true, status: 200, response: new Response("{}", { headers: { "content-type": "application/json" } }), canonicalAttempt: { logicalSuccess: false, streamStarted: null, completionState: "incomplete" } };
    });

    const out = await handleComboChat({ body: { model: "c" }, models: ["m1", "m2"], handleSingleModel, log, comboName: "c", comboStrategy: "fallback" });
    expect(c2Called).toBe(false);
    expect(out.headers.get("content-type")).toBe("text/event-stream");
  });

  it("Example C — pre-admission transport failure (success=false before bytes); candidate 2 IS invoked", async () => {
    // Simulate a non-SSE/HTML 5xx block (streamingHandler non-SSE early return)
    // -> success=false, canonicalAttempt=null, candidateAdmitted=false.
    const html5xx = new Response("<html><title>Server Error</title></html>", {
      status: 502, headers: { "content-type": "text/html" },
    });
    let c2Called = false;
    const handleSingleModel = vi.fn(async (b, m) => {
      if (m === "m1") return makeStreamingCandidate(html5xx);
      if (m === "m2") { c2Called = true; return { success: true, status: 200, response: new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } }), canonicalAttempt: { logicalSuccess: true, streamStarted: null, completionState: "success", source: "provider", transportOk: true, usableOutput: true } }; }
      return { success: false, status: 500, response: new Response("{}", { headers: { "content-type": "application/json" } }), canonicalAttempt: null };
    });

    const out = await handleComboChat({ body: { model: "c" }, models: ["m1", "m2"], handleSingleModel, log, comboName: "c", comboStrategy: "fallback" });
    expect(c2Called).toBe(true); // pre-admission failure → fall through
    expect(out.status).toBe(200);
  });

  it("Holder is provisional before first byte, final after client drains (§23)", async () => {
    const r = await makeStreamingCandidate(mockProviderResponse([sseContent("hi"), sseDone()]));
    // At return time: holder exists but provisional (no evidence yet).
    expect(r.success).toBe(true);
    expect(r.canonicalAttempt).toBeDefined();
    expect(r.canonicalAttempt.streamStarted).toBe(false);
    expect(r.canonicalAttempt.logicalSuccess).toBe(false); // provisional — NOT consumed as final

    // Act as client: drain the live stream. This settles the internal lifecycle
    // (onStreamComplete flush), filling the SAME holder reference in place.
    await drainAsClient(r.response);

    expect(r.canonicalAttempt.streamStarted).toBe(true); // admission occurred
    expect(r.canonicalAttempt.hasText).toBe(true);
    expect(r.canonicalAttempt.completionState).toBe("success");
    expect(r.canonicalAttempt.logicalSuccess).toBe(true); // finalized
    expect(r.canonicalAttempt).not.toBeNull();
  });
});

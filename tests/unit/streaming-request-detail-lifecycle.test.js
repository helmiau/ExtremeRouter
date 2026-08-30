import { describe, it, expect, vi, beforeEach } from "vitest";

// Request-detail streaming lifecycle regression suite (§11/§12).
//
// Invariant under test: a streaming request-detail row is admitted as
// "streaming" (non-terminal) and finalized EXACTLY ONCE into a terminal status
// derived from the canonical attempt classification — never from transport
// success (HTTP 200 / result.success) alone.

vi.mock("../../open-sse/services/providerCapabilities.js", () => ({
  validateComboRoles: () => [],
}));

// Capture every request-detail write so lifecycle assertions can inspect them.
const detailWrites = [];
vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async (detail) => {
    detailWrites.push(detail);
    return detail;
  }),
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
const {
  mapCanonicalAttemptToRequestStatus,
  shouldSkipRequestDetailOverwrite,
} = await import("../../open-sse/utils/requestDetailStatus.js");

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const sseContent = (content) => `data: {"choices":[{"index":0,"delta":{"content":"${content}"},"finish_reason":null}]}\n\n`;
const sseReasoning = (content) => `data: {"choices":[{"index":0,"delta":{"reasoning_content":"${content}"},"finish_reason":null}]}\n\n`;
const sseToolCall = () => `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{}"}}]},"finish_reason":null}]}\n\n`;
const sseDone = () => `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;

// Controllable provider stream: enqueue lines, optionally hold open / error.
function mockProviderResponse({ lines = [], holdOpen = false, errorAfter = null } = {}) {
  const encoder = new TextEncoder();
  let controllerRef = null;
  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      for (const line of lines) controller.enqueue(encoder.encode(line));
      if (errorAfter) {
        setTimeout(() => controller.error(new Error(errorAfter)), 10);
      } else if (!holdOpen) {
        controller.close();
      }
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    }),
    controller: controllerRef,
  };
}

// Drive the REAL streaming handler exactly like chatCore does.
async function runStreamingCase({ lines = [], holdOpen = false, errorAfter = null } = {}) {
  const { response: providerResponse, controller: upstreamController } = mockProviderResponse({ lines, holdOpen, errorAfter });
  const streamController = createStreamController({ log, provider: "openai", model: "m1" });
  const { onStreamComplete: built, streamDetailId } = buildOnStreamComplete({
    provider: "openai", model: "m1", connectionId: "c1", apiKey: "k",
    requestStartTime: Date.now(), body: { model: "m1", stream: true },
    stream: true, finalBody: null, translatedBody: null, clientRawRequest: null,
    savedTokens: 0, savedTokensByMechanism: {}, savedBytesByMechanism: {},
    cavemanActive: false, ponytailActive: false, retryCount: 0,
    combo: { name: "c", strategy: "fallback", role: "worker" },
  });

  const result = await handleStreamingResponse({
    providerResponse, provider: "openai", model: "m1", clientRawRequest: null,
    sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI, body: { model: "m1", stream: true },
    stream: true, translatedBody: null, finalBody: null, requestStartTime: Date.now(),
    connectionId: "c1", apiKey: "k", onRequestSuccess: null, reqLogger: null,
    toolNameMap: new Map(), streamController,
    onStreamComplete: built, streamDetailId, savedTokens: 0,
    combo: { name: "c", strategy: "fallback", role: "worker" },
  });

  return { result, streamController, streamDetailId, upstreamController };
}

const writesFor = (id) => detailWrites.filter((d) => d.id === id);

// buildRequestDetail spreads overrides at top level, so the captured detail
// carries `id`. settle() lets the async save promises resolve before asserting.
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  detailWrites.length = 0;
});

describe("request-detail status mapper (canonical → terminal)", () => {
  it("maps each canonical classification to its terminal status", () => {
    expect(mapCanonicalAttemptToRequestStatus({ classification: "success" })).toBe("success");
    expect(mapCanonicalAttemptToRequestStatus({ classification: "provider_failure" })).toBe("failure");
    expect(mapCanonicalAttemptToRequestStatus({ classification: "transport_failure" })).toBe("error");
    expect(mapCanonicalAttemptToRequestStatus({ classification: "empty_output" })).toBe("empty_output");
    expect(mapCanonicalAttemptToRequestStatus({ classification: "incomplete" })).toBe("incomplete");
    expect(mapCanonicalAttemptToRequestStatus({ classification: "cancelled" })).toBe("cancelled");
  });

  it("maps a null/unknown attempt defensively to incomplete", () => {
    expect(mapCanonicalAttemptToRequestStatus(null)).toBe("incomplete");
    expect(mapCanonicalAttemptToRequestStatus({})).toBe("incomplete");
  });
});

describe("terminal-overwrite persistence guard", () => {
  it("allows streaming → terminal transitions", () => {
    expect(shouldSkipRequestDetailOverwrite("streaming", "success")).toBe(false);
    expect(shouldSkipRequestDetailOverwrite(null, "failure")).toBe(false);
  });

  it("allows identical-status refreshes (content upgrade)", () => {
    expect(shouldSkipRequestDetailOverwrite("success", "success")).toBe(false);
  });

  it("rejects terminal → different terminal reverts", () => {
    expect(shouldSkipRequestDetailOverwrite("success", "cancelled")).toBe(true);
    expect(shouldSkipRequestDetailOverwrite("cancelled", "success")).toBe(true);
    expect(shouldSkipRequestDetailOverwrite("failure", "success")).toBe(true);
  });
});

describe("streaming request-detail lifecycle", () => {
  it("Test A: admission persists a non-terminal 'streaming' status (never success)", async () => {
    const { result, streamDetailId } = await runStreamingCase({ lines: [sseContent("partial")], holdOpen: true });
    await settle();

    const writes = writesFor(streamDetailId);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes[0].status).toBe("streaming");
    for (const w of writes) {
      expect(w.status).not.toBe("success");
    }
    // Invariant §12: no terminal status before finalization.
    expect(writes.every((w) => ["streaming"].includes(w.status))).toBe(true);

    await result.response.body.cancel();
  });

  it("Test B: successful completion finalizes to 'success'", async () => {
    const { result, streamDetailId } = await runStreamingCase({ lines: [sseContent("hello"), sseDone()] });
    // Drain the client-facing stream so the transform flush runs.
    const reader = result.response.body.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    await settle();

    const writes = writesFor(streamDetailId);
    expect(writes[0].status).toBe("streaming");
    const finalWrite = writes[writes.length - 1];
    expect(finalWrite.status).toBe("success");
    // Lifecycle: exactly streaming → success (never success → something else).
    expect(writes.map((w) => w.status)).toEqual(["streaming", "success"]);
  });

  it("Test C: EOF without terminal finalizes to 'incomplete'", async () => {
    const { result, streamDetailId } = await runStreamingCase({ lines: [sseContent("partial-")] });
    const reader = result.response.body.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    await settle();

    const writes = writesFor(streamDetailId);
    expect(writes[writes.length - 1].status).toBe("incomplete");
  });

  it("Test D: client disconnect finalizes to 'cancelled'", async () => {
    const { result, streamController, streamDetailId } = await runStreamingCase({ lines: [sseContent("partial")], holdOpen: true });
    await settle();
    // Simulate the client closing the connection (cancel() path).
    await result.response.body.cancel();
    streamController.handleDisconnect("cancelled");
    await settle();

    const writes = writesFor(streamDetailId);
    expect(writes[0].status).toBe("streaming");
    expect(writes[writes.length - 1].status).toBe("cancelled");
  });

  it("Test E: upstream stream error finalizes to a failure state (never success)", async () => {
    const { result, streamDetailId } = await runStreamingCase({ lines: [sseContent("partial")], errorAfter: "upstream boom" });
    const reader = result.response.body.getReader();
    // Read until the stream errors out.
    try {
      while (!(await reader.read()).done) { /* drain */ }
    } catch { /* expected read error */ }
    await settle();

    const writes = writesFor(streamDetailId);
    const finalWrite = writes[writes.length - 1];
    expect(finalWrite.status).not.toBe("success");
    expect(["failure", "error"]).toContain(finalWrite.status);
  });

  it("Test F: empty 200 stream finalizes to 'empty_output' (not success)", async () => {
    const { result, streamDetailId } = await runStreamingCase({ lines: [] });
    const reader = result.response.body.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    await settle();

    const writes = writesFor(streamDetailId);
    expect(writes[writes.length - 1].status).toBe("empty_output");
  });

  it("Test G: reasoning-only output with a proper terminal is 'success'", async () => {
    const { result, streamDetailId } = await runStreamingCase({ lines: [sseReasoning("thinking..."), sseDone()] });
    const reader = result.response.body.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    await settle();

    const writes = writesFor(streamDetailId);
    expect(writes[writes.length - 1].status).toBe("success");
  });

  it("Test H: tool-call-only output with a proper terminal is 'success'", async () => {
    const { result, streamDetailId } = await runStreamingCase({ lines: [sseToolCall(), sseDone()] });
    const reader = result.response.body.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    await settle();

    const writes = writesFor(streamDetailId);
    expect(writes[writes.length - 1].status).toBe("success");
  });

  it("Test I: finalization is idempotent — completion claims, late abort cannot rewrite", async () => {
    const { result, streamController, streamDetailId } = await runStreamingCase({ lines: [sseContent("hello"), sseDone()], holdOpen: false });
    const reader = result.response.body.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    await settle();
    // Late client disconnect AFTER completion: must not add a second terminal write.
    streamController.handleDisconnect("late-cancel");
    await settle();

    const statuses = writesFor(streamDetailId).map((w) => w.status);
    const terminalWrites = statuses.filter((s) => s !== "streaming");
    expect(terminalWrites).toEqual(["success"]);
    expect(statuses).toEqual(["streaming", "success"]);
  });
});

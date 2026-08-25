import { describe, it, expect, vi } from "vitest";

// C.1 integration regression: malformed-only standard forced SSE must persist
// canonical failure BEFORE returning the historical 502 response.

const { saveRequestDetail, appendRequestLog } = vi.hoisted(() => ({
  saveRequestDetail: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
}));

// Literal @/ mocks sidestep the session's documented Vite alias issue.
vi.mock("@/lib/usageDb.js", () => ({ saveRequestDetail, appendRequestLog }));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: vi.fn() }));

const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

describe("C.1 malformed-only forced SSE persistence", () => {
  it("persists canonical malformed_sse failure while returning existing HTTP 502 unchanged", async () => {
    const result = await handleForcedSSEToJson({
      providerResponse: new Response("data: {definitely broken}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      sourceFormat: "openai",
      provider: "openai",
      model: "gpt-4o",
      body: { stream: false, messages: [{ role: "user", content: "test" }] },
      stream: true,
      translatedBody: {},
      finalBody: {},
      requestStartTime: Date.now() - 10,
      connectionId: "conn-1",
      apiKey: "key",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess: vi.fn(),
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    });

    // Public behavior is identical to the pre-C.1 early return.
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    await expect(result.response.clone().json()).resolves.toMatchObject({
      error: { message: "Invalid SSE response for non-streaming request" },
    });

    expect(saveRequestDetail).toHaveBeenCalledTimes(1);
    const detail = saveRequestDetail.mock.calls[0][0];
    expect(detail.status).toBe("error");
    expect(detail.canonicalAttempt).toMatchObject({
      source: "provider",
      transportOk: true,
      streamStarted: null,
      eofSeen: null,
      terminalState: null,
      hasText: false,
      hasReasoning: false,
      hasToolCall: false,
      hasStructuredOutput: false,
      hasUsage: false,
      errorSeen: true,
      abortSeen: false,
      completionState: "failure",
      completionType: "malformed_sse",
      usableOutput: false,
      logicalSuccess: false,
      outcome: "failure",
    });
  });

  it("malformed event followed by valid output remains existing recoverable success path", async () => {
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(
        'data: {broken}\n\n' +
        'data: {"id":"x","choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
        'data: {"id":"x","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
      sourceFormat: "openai",
      provider: "openai",
      model: "gpt-4o",
      body: { stream: false, messages: [{ role: "user", content: "test" }] },
      stream: true,
      translatedBody: {},
      finalBody: {},
      requestStartTime: Date.now() - 10,
      connectionId: "conn-1",
      apiKey: "key",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess: vi.fn(),
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    const detail = saveRequestDetail.mock.calls.at(-1)[0];
    expect(detail.status).toBe("success");
    expect(detail.canonicalAttempt.logicalSuccess).toBe(true);
    expect(detail.canonicalAttempt.errorSeen).toBe(false);
    expect(detail.canonicalAttempt.completionType).toBe("http_2xx_json");
  });

  it("[DONE]-only forced stream stays failure/incomplete (never success)", async () => {
    const result = await handleForcedSSEToJson({
      providerResponse: new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      sourceFormat: "openai",
      provider: "openai",
      model: "gpt-4o",
      body: { stream: false, messages: [{ role: "user", content: "test" }] },
      stream: true,
      translatedBody: {},
      finalBody: {},
      requestStartTime: Date.now() - 10,
      connectionId: "conn-1",
      apiKey: "key",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess: vi.fn(),
      trackDone: vi.fn(),
      appendLog: vi.fn(),
    });

    // [DONE]-only: parser returns null (no data events) → same existing 502
    // response, but the canonical semantics are VALID-EMPTY (malformedLines=0),
    // i.e. incomplete — never success, never malformed_sse (§13/§14).
    expect(result.response.status).toBe(502);
    const detail = saveRequestDetail.mock.calls.at(-1)[0];
    expect(detail.canonicalAttempt.logicalSuccess).toBe(false);
    expect(detail.canonicalAttempt.completionState).toBe("incomplete");
    expect(detail.canonicalAttempt.completionType).toBe("http_2xx_json");
    expect(detail.canonicalAttempt.errorSeen).toBe(false);
  });
});

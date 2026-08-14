import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { convertResponsesStreamToJson } = await import("../../open-sse/transformer/streamToJsonConverter.js");

// AbortError-compatible error (DOMException-like, as Node fetch produces)
function abortError() {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

// ReadableStream whose first read rejects with the given error
function failingStream(error) {
  return new ReadableStream({
    pull() { return Promise.reject(error); },
  });
}

function baseArgs(providerResponse) {
  return {
    providerResponse,
    sourceFormat: "openai",
    provider: "test-provider",
    model: "test-model",
    body: {},
    stream: false,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "conn-1",
    apiKey: "key-1",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    onRequestSuccess: async () => {},
    trackDone: () => {},
    appendLog: () => {},
    savedTokens: 0,
    savedTokensByMechanism: {},
    savedBytesByMechanism: {},
    cavemanActive: false,
    ponytailActive: false,
    retryCount: 0,
  };
}

describe("handleForcedSSEToJson client-abort handling", () => {
  let errorSpy;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("returns 499 (not 502) and logs nothing when the Chat Completions stream read aborts", async () => {
    const providerResponse = new Response(null, {
      headers: { "content-type": "text/event-stream" },
    });
    // Force providerResponse.text() to reject with AbortError (client cancel).
    providerResponse.text = () => Promise.reject(abortError());

    const result = await handleForcedSSEToJson(baseArgs(providerResponse));

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
    expect(result.error).toBe("Request aborted");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns 502 with the underlying cause for non-abort conversion failures", async () => {
    const providerResponse = new Response(null, {
      headers: { "content-type": "text/event-stream" },
    });
    providerResponse.text = () => Promise.reject(new Error("socket hang up"));

    const result = await handleForcedSSEToJson(baseArgs(providerResponse));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("Failed to convert streaming response to JSON");
    expect(result.error).toContain("socket hang up");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 499 when the Responses API stream read aborts (AbortError propagates)", async () => {
    const providerResponse = new Response(failingStream(abortError()), {
      headers: { "content-type": "text/event-stream" },
    });

    const result = await handleForcedSSEToJson(baseArgs(providerResponse));

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
    expect(result.error).toBe("Request aborted");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("convertResponsesStreamToJson rethrows AbortError instead of finalizing as failed", async () => {
    await expect(convertResponsesStreamToJson(failingStream(abortError()))).rejects.toMatchObject({ name: "AbortError" });
  });
});

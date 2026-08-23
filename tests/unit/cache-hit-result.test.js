import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

// The test environment has a pre-existing Vite alias break for `@/*`: the
// top-level `resolve.alias` is not applied, so `@/shared/...` and `@/lib/...`
// bare specifiers fail resolution. `vi.mock` intercepts by specifier string
// BEFORE resolution, so mocking these specifiers (the same trick the
// combo-context-observability suite uses for `@/lib/usageDb.js`) short-circuits
// the broken alias. The cache-hit path never reaches fetch, image encoding, or
// the data dir, so stubs are sufficient and the suite stays green.
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({
  assertPublicUrl: vi.fn(),
}));
vi.mock("@/lib/dataDir.js", () => ({
  DATA_DIR: "/tmp/test-data",
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("handleChatCore cache-hit result contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockReset();
    global.fetch = vi.fn(async () => {
      throw new Error("unexpected fetch — cache hit should not execute");
    });
  });

  it("returns success: true for a cache HIT (no upstream execute)", async () => {
    const isCacheableMod = await import("../../open-sse/services/semanticCache.js");
    const cachedBody = {
      id: "chatcmpl-cached",
      object: "chat.completion",
      model: "gpt-4o",
      usage: { prompt_tokens: 12, completion_tokens: 7 },
      choices: [{ message: { role: "assistant", content: "cached reply" }, finish_reason: "stop", index: 0 }],
    };
    vi.spyOn(isCacheableMod, "isCacheable").mockReturnValue(true);
    vi.spyOn(isCacheableMod, "cacheLookup").mockReturnValue({
      response: new Response(JSON.stringify(cachedBody), { status: 200, headers: { "content-type": "application/json" } }),
      similarity: 0.99,
      exact: true,
    });

    const result = await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hello there" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "test-conn",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
      semanticCacheEnabled: true,
    });

    expect(result.success).toBe(true);
    expect(result.fromCache).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("records fromCache metadata on the cache-hit result", async () => {
    const isCacheableMod = await import("../../open-sse/services/semanticCache.js");
    vi.spyOn(isCacheableMod, "isCacheable").mockReturnValue(true);
    vi.spyOn(isCacheableMod, "cacheLookup").mockReturnValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-cached-2",
        object: "chat.completion",
        model: "gpt-4o",
        usage: { prompt_tokens: 5, completion_tokens: 3 },
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      similarity: 0.92,
      exact: false,
    });

    const result = await handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "repeat question" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "test-conn",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
      semanticCacheEnabled: true,
    });

    expect(result.success).toBe(true);
    expect(result.cacheSimilarity).toBe(0.92);
    expect(result.url).toBe("(cache)");
  });

  // Bypass paths (warmup/skip/naming) must also carry success:true so the
  // single-model health/telemetry logic never misreads a synthetic response
  // as a failure (the same class of bug as the cache-hit regression).
  it("returns success:true for a bypass (warmup)", async () => {
    const result = await handleChatCore({
      body: { model: "claude-sonnet-4", stream: false, messages: [{ role: "user", content: "Warmup" }] },
      modelInfo: { provider: "claude", model: "claude-sonnet-4" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "test-conn",
      userAgent: "claude-cli/1.0",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
      sourceFormatOverride: "claude",
    });

    expect(result.success).toBe(true);
    expect(result.response).toBeInstanceOf(Response);
    expect(executeMock).not.toHaveBeenCalled();
  });
});

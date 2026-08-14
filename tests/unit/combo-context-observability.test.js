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

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { buildRequestDetail } = await import("../../open-sse/handlers/chatCore/requestDetail.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("buildRequestDetail combo passthrough", () => {
  it("carries combo context into the persisted detail record", () => {
    const combo = { name: "max-reasoning-swarm", strategy: "swarm", role: "manager", trafficClass: "user" };
    const detail = buildRequestDetail({
      provider: "kiro",
      model: "claude-sonnet-4.5",
      connectionId: "conn-1",
      latency: { ttft: 5, total: 10 },
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      request: {},
      status: "success",
      combo,
    });
    expect(detail.combo).toEqual(combo);
  });

  it("omits combo when absent (plain single-model request)", () => {
    const detail = buildRequestDetail({
      provider: "openai",
      model: "gpt-4o",
      latency: { ttft: 5, total: 10 },
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
      request: {},
    });
    expect(detail.combo).toBeUndefined();
  });
});

describe("handleChatCore combo wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
  });

  it("threads comboContext into saved request details on success", async () => {
    const { saveRequestDetail } = await import("@/lib/usageDb.js");
    const combo = { name: "my-fusion", strategy: "fusion", role: "panel", trafficClass: "panel" };

    await handleChatCore({
      body: { model: "cc/claude-opus-4-7", stream: false, messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider: "claude", model: "claude-opus-4-7" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "test-conn",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      comboContext: combo,
    });

    const saved = saveRequestDetail.mock.calls.map((c) => c[0]);
    expect(saved.length).toBeGreaterThan(0);
    // At least one record must carry the combo context (success path).
    const withCombo = saved.find((d) => d.combo);
    expect(withCombo).toBeTruthy();
    expect(withCombo.combo).toEqual(combo);
  });

  it("records combo context on provider error records", async () => {
    const { saveRequestDetail } = await import("@/lib/usageDb.js");
    const combo = { name: "fallback-a", strategy: "fallback", role: null, trafficClass: "user" };

    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });

    const result = await handleChatCore({
      body: { model: "cc/claude-opus-4-7", stream: false, messages: [{ role: "user", content: "hello" }] },
      modelInfo: { provider: "claude", model: "claude-opus-4-7" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      connectionId: "test-conn",
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      comboContext: combo,
    });

    expect(result.success).toBe(false);
    const saved = saveRequestDetail.mock.calls.map((c) => c[0]);
    const errRecord = saved.find((d) => d.status === "error");
    expect(errRecord).toBeTruthy();
    expect(errRecord.combo).toEqual(combo);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  resolveConolCredentials: vi.fn(),
  discoverConolModels: vi.fn(),
  discoverNotionWebModels: vi.fn(),
  getModelsByProviderId: vi.fn(),
  discoverInnerAiModels: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("open-sse/services/conolAuth.js", () => ({
  resolveConolCredentials: mocks.resolveConolCredentials,
}));

vi.mock("open-sse/services/conolModels.js", () => ({
  CONOL_FALLBACK_MODELS: [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", supportsVision: true },
  ],
  discoverConolModels: mocks.discoverConolModels,
}));

vi.mock("open-sse/services/notionWebModels.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    NOTION_WEB_FALLBACK_MODELS: [
      { id: "sonnet-5", name: "Sonnet 5" },
      { id: "notion-ai", name: "Notion AI (default)" },
    ],
    discoverNotionWebModels: mocks.discoverNotionWebModels,
  };
});

vi.mock("open-sse/config/providerModels.js", () => ({
  getModelsByProviderId: mocks.getModelsByProviderId,
}));

// Heavy modules the route imports but these tests do not exercise.
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/services/kiroModels.js", () => ({ resolveKiroModels: vi.fn() }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: vi.fn() }));
vi.mock("open-sse/services/qoderModels.js", () => ({ resolveQoderModels: vi.fn() }));
vi.mock("open-sse/services/zenmuxModels.js", () => ({
  getZenmuxModelsForPlan: vi.fn(),
  getZenmuxPlanForCtoken: vi.fn(),
}));
vi.mock("open-sse/executors/inner-ai.js", () => ({
  discoverInnerAiModels: mocks.discoverInnerAiModels,
}));

const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

const call = (id) => GET(new Request(`http://localhost/api/providers/${id}/models`), {
  params: Promise.resolve({ id }),
});

const connection = (provider, extra = {}) => ({
  id: `conn-${provider}`,
  provider,
  ...extra,
});

describe("web-cookie provider model discovery wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("conol-web: returns live discovery models when a session cookie exists", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(
      connection("conol-web", { apiKey: "session-token" })
    );
    mocks.resolveConolCredentials.mockReturnValue({ cookie: "__Secure-better-auth.session_token=x" });
    mocks.discoverConolModels.mockResolvedValue({
      models: [
        { id: "claude-fable-5", name: "Claude Fable 5", supportsVision: true },
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", supportsVision: false },
      ],
    });

    const res = await call("conol-web");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("conol-web");
    expect(body.models).toEqual([
      { id: "claude-fable-5", name: "Claude Fable 5", supportsVision: true },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", supportsVision: false },
    ]);
    expect(mocks.discoverConolModels).toHaveBeenCalledWith({ cookie: "__Secure-better-auth.session_token=x" });
    expect(body.warning).toBeUndefined();
  });

  it("conol-web: falls back to seed catalog with a warning when no cookie", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(connection("conol-web"));
    mocks.resolveConolCredentials.mockReturnValue({ cookie: "" });

    const res = await call("conol-web");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.models).toEqual([
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", supportsVision: true },
    ]);
    expect(body.warning).toMatch(/seed/);
    expect(mocks.discoverConolModels).not.toHaveBeenCalled();
  });

  it("conol-web: falls back to seed catalog when live discovery fails", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(
      connection("conol-web", { apiKey: "session-token" })
    );
    mocks.resolveConolCredentials.mockReturnValue({ cookie: "session=x" });
    mocks.discoverConolModels.mockRejectedValue(new Error("HTTP 403"));

    const res = await call("conol-web");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.models).toEqual([
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", supportsVision: true },
    ]);
    expect(body.warning).toMatch(/seed|failed/i);
  });

  it("notion-web: returns live discovery models with optional warning", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(
      connection("notion-web", { apiKey: "token_v2=abc" })
    );
    mocks.discoverNotionWebModels.mockResolvedValue({
      models: [
        { id: "fable-5", name: "Fable 5", notionCodename: "acai-budino-high" },
        { id: "sonnet-5", name: "Sonnet 5" },
      ],
      spaceId: "space-1",
      warning: "Notion hid 1 model(s) as unavailable",
    });

    const res = await call("notion-web");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.models).toEqual([
      { id: "fable-5", name: "Fable 5", notionCodename: "acai-budino-high" },
      { id: "sonnet-5", name: "Sonnet 5" },
    ]);
    expect(body.warning).toMatch(/Notion hid 1 model/);
    expect(mocks.discoverNotionWebModels).toHaveBeenCalledWith({ token: "token_v2=abc" });
  });

  it("notion-web: uses seed catalog when no token_v2 is present", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(connection("notion-web"));

    const res = await call("notion-web");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.models).toEqual([
      { id: "sonnet-5", name: "Sonnet 5" },
      { id: "notion-ai", name: "Notion AI (default)" },
    ]);
    expect(body.warning).toMatch(/seed/);
    expect(mocks.discoverNotionWebModels).not.toHaveBeenCalled();
  });

  it("notion-web: falls back to seed catalog when discovery throws", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(
      connection("notion-web", { apiKey: "token_v2=abc" })
    );
    mocks.discoverNotionWebModels.mockRejectedValue(new Error("getSpaces 401"));

    const res = await call("notion-web");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.models).toEqual([
      { id: "sonnet-5", name: "Sonnet 5" },
      { id: "notion-ai", name: "Notion AI (default)" },
    ]);
    expect(body.warning).toMatch(/seed/);
  });

  it("hyperagent: serves the bundled catalog (no live discovery API)", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(connection("hyperagent"));
    mocks.getModelsByProviderId.mockReturnValue([
      { id: "fable-latest", name: "Fable 5", contextLength: 1_000_000 },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1_000_000 },
    ]);

    const res = await call("hyperagent");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.provider).toBe("hyperagent");
    expect(body.models).toEqual([
      { id: "fable-latest", name: "Fable 5", contextLength: 1_000_000 },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1_000_000 },
    ]);
    expect(body.warning).toMatch(/no live discovery/);
    expect(mocks.getModelsByProviderId).toHaveBeenCalledWith("hyperagent");
  });

  it("inner-ai: returns the live plan-gated catalog when a token exists", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(
      connection("inner-ai", { apiKey: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyQGV4YW1wbGUuY29tIn0.x" })
    );
    mocks.discoverInnerAiModels.mockResolvedValue({
      models: [
        { id: "gpt-4o", name: "gpt-4o" },
        { id: "o3", name: "o3", planGated: true },
      ],
    });

    const res = await call("inner-ai");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.models).toEqual([
      { id: "gpt-4o", name: "gpt-4o" },
      { id: "o3", name: "o3", planGated: true },
    ]);
    expect(mocks.discoverInnerAiModels).toHaveBeenCalledWith({ token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyQGV4YW1wbGUuY29tIn0.x" });
    expect(body.warning).toBeUndefined();
  });

  it("inner-ai: falls back to seed catalog when discovery fails", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(
      connection("inner-ai", { apiKey: "eyJhbGciOiJIUzI1NiJ9.e30.x" })
    );
    mocks.discoverInnerAiModels.mockRejectedValue(new Error("HTTP 401"));
    mocks.getModelsByProviderId.mockReturnValue([
      { id: "gpt-4o", name: "gpt-4o" },
      { id: "o3", name: "o3" },
    ]);

    const res = await call("inner-ai");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.models).toEqual([
      { id: "gpt-4o", name: "gpt-4o" },
      { id: "o3", name: "o3" },
    ]);
    expect(body.warning).toMatch(/seed/);
  });

  it("inner-ai: seed catalog when no token is present", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(connection("inner-ai"));
    mocks.getModelsByProviderId.mockReturnValue([
      { id: "gpt-4o", name: "gpt-4o" },
      { id: "o3", name: "o3" },
    ]);

    const res = await call("inner-ai");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.models).toEqual([
      { id: "gpt-4o", name: "gpt-4o" },
      { id: "o3", name: "o3" },
    ]);
    expect(body.warning).toMatch(/seed/);
    expect(mocks.discoverInnerAiModels).not.toHaveBeenCalled();
  });

  it("hailuo-web: serves the bundled catalog (no live discovery API)", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(connection("hailuo-web"));
    mocks.getModelsByProviderId.mockReturnValue([{ id: "hailuo", name: "Hailuo (MiniMax Web)" }]);

    const res = await call("hailuo-web");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.models).toEqual([{ id: "hailuo", name: "Hailuo (MiniMax Web)" }]);
    expect(body.warning).toMatch(/no live discovery/);
    expect(mocks.getModelsByProviderId).toHaveBeenCalledWith("hailuo-web");
  });

  it("gemini-business: serves the bundled catalog (no live discovery API)", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(connection("gemini-business"));
    mocks.getModelsByProviderId.mockReturnValue([
      { id: "gemini-3-pro", name: "Gemini 3 Pro" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ]);

    const res = await call("gemini-business");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.models).toEqual([
      { id: "gemini-3-pro", name: "Gemini 3 Pro" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ]);
    expect(body.warning).toMatch(/no live discovery/);
    expect(mocks.getModelsByProviderId).toHaveBeenCalledWith("gemini-business");
  });
});

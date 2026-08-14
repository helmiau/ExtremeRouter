import { describe, expect, it, vi } from "vitest";

// Mock the network layer so we can script upstream responses (proxyAwareFetch
// captures globalThis.fetch at module load, so vi.mock is the reliable hook).
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { TencentAIStudioWebExecutor, MODEL_MAP } = await import("../../open-sse/executors/tencent-aistudio-web.js");
const { getExecutor } = await import("../../open-sse/executors/index.js");
const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
const { WEB_COOKIE_PROVIDERS } = await import("../../src/shared/constants/providers.js");

function entry() {
  return REGISTRY.find((r) => r.id === "tencent-aistudio-web");
}

function okResponse(body = "{}") {
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("tencent-aistudio-web registry (port of OmniRoute #10174)", () => {
  it("registers as a web-cookie provider with tasw alias", () => {
    const e = entry();
    expect(e).toBeDefined();
    expect(e.alias).toBe("tasw");
    expect(e.category).toBe("webCookie");
    expect(e.authType).toBe("cookie");
    expect(e.hasFree).toBe(true);
  });

  it("exposes the Hunyuan models without tool calling", () => {
    const ids = entry().models.map((m) => m.id);
    expect(ids).toContain("hy3-g");
    expect(ids).toContain("hunyuan-default");
    expect(ids).toContain("hunyuan-3d");
    for (const m of entry().models) expect(m.toolCalling).toBe(false);
  });

  it("appears in the UI web-cookie provider map", () => {
    const p = WEB_COOKIE_PROVIDERS["tencent-aistudio-web"];
    expect(p).toBeDefined();
    expect(p.alias).toBe("tasw");
    expect(p.name).toBe("Tencent AI Studio (Free)");
  });

  it("routes through the TencentAIStudioWebExecutor (and tasw alias)", () => {
    expect(getExecutor("tencent-aistudio-web")).toBeInstanceOf(TencentAIStudioWebExecutor);
    expect(getExecutor("tasw")).toBeInstanceOf(TencentAIStudioWebExecutor);
  });
});

describe("TencentAIStudioWebExecutor", () => {
  const exec = new TencentAIStudioWebExecutor();
  const baseInput = {
    model: "hy3-g",
    body: { model: "hy3-g", messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: { apiKey: "a=1; b=2" },
  };

  it("rejects with 401 when no cookie is supplied", async () => {
    fetchMock.mockReset();
    const out = await exec.execute({ ...baseInput, credentials: { apiKey: "" } });
    expect(out.response.status).toBe(401);
    const data = await out.response.json();
    expect(data.error.message).toContain("Cookie");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs OpenAI-style chat to /api/chat/HunyuanDefault with the cookie header", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(okResponse());
    const out = await exec.execute(baseInput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://aistudio.tencent.ai/api/chat/HunyuanDefault");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Cookie).toBe("a=1; b=2");
    expect(opts.headers.Origin).toBe("https://aistudio.tencent.ai");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("HunyuanDefault");
    expect(body.messages[0].content).toBe("hi");
    expect(out.response.status).toBe(200);
  });

  it("strips a leading Cookie: prefix from the pasted credential", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(okResponse());
    await exec.execute({ ...baseInput, credentials: { apiKey: "Cookie: a=1; b=2" } });
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Cookie).toBe("a=1; b=2");
  });

  it("maps hunyuan-3d to the Hunyuan3D endpoint and unknown models to HunyuanDefault", async () => {
    expect(MODEL_MAP["hunyuan-3d"]).toBe("Hunyuan3D");
    fetchMock.mockReset().mockResolvedValueOnce(okResponse());
    await exec.execute({ ...baseInput, model: "hunyuan-3d", body: { messages: [] } });
    expect(fetchMock.mock.calls[0][0]).toBe("https://aistudio.tencent.ai/api/chat/Hunyuan3D");
    fetchMock.mockReset().mockResolvedValueOnce(okResponse());
    await exec.execute({ ...baseInput, model: "does-not-exist", body: { messages: [] } });
    expect(fetchMock.mock.calls[0][0]).toBe("https://aistudio.tencent.ai/api/chat/HunyuanDefault");
  });

  it("turns 401/403 upstream into an expired-cookie error", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const out = await exec.execute(baseInput);
    expect(out.response.status).toBe(401);
    const data = await out.response.json();
    expect(data.error.message).toContain("session cookie");
  });
});

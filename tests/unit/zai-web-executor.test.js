// ZaiWebExecutor unit tests — ported from the audited OmniRoute PR #10329
// suite (tests/unit/executor-zai-web.test.ts) and adapted to ExtremeRouter's
// JS executor conventions (proxyFetch mocked at the module boundary).
//
// Covers: credential parsing, the live HMAC signature vector, frontend-version
// parsing, SSE frame parsing, thinking/VLM config resolution, and the direct
// request flow (new-chat + signed v2 completion + streaming/non-streaming).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const browserChatMock = vi.fn();
vi.mock("../../open-sse/services/zaiBrowserTransport.js", () => ({
  zaiBrowserChat: (...args) => browserChatMock(...args),
  browserModelName: (id) => String(id).split("/").at(-1),
  tokenPoolKey: (t) => String(t),
}));

const {
  ZaiWebExecutor,
  extractZaiToken,
  extractZaiCaptchaVerifyParam,
  extractZaiUserId,
  buildZaiSignature,
  parseZaiFrontendVersion,
  parseZaiFrame,
  foldMessages,
  resolveZaiThinkingConfig,
  resolveZaiVlmConfig,
  getZaiModelCapabilities,
} = await import("../../open-sse/executors/zai-web.js");

const ZAI_HOME_URL = "https://chat.z.ai/";
const ZAI_NEW_CHAT_URL = "https://chat.z.ai/api/v1/chats/new";
const ZAI_COMPLETION_PATH = "/api/v2/chat/completions";

const TEST_TOKEN = `e30.${Buffer.from(JSON.stringify({ id: "user-123" })).toString("base64url")}.sig`;
const TEST_CREDENTIAL = JSON.stringify({ token: TEST_TOKEN, captcha_verify_param: "captcha-proof" });

function sseResponse(bodyText) {
  return new Response(bodyText, { headers: { "Content-Type": "text/event-stream" } });
}

function installZaiFetch(completionResponse, capture = {}) {
  fetchMock.mockImplementation(async (url, init) => {
    const value = String(url);
    if (value === ZAI_HOME_URL) {
      return new Response('<script src="https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.1.79/assets/index.js"></script>');
    }
    if (value === ZAI_NEW_CHAT_URL) {
      capture.newChatInit = init;
      return Response.json({ id: "chat-123" });
    }
    if (new URL(value).pathname === ZAI_COMPLETION_PATH) {
      capture.completionUrl = value;
      capture.completionInit = init;
      return completionResponse();
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  browserChatMock.mockReset();
});
afterEach(() => {
  fetchMock.mockReset();
  browserChatMock.mockReset();
});

describe("extractZaiToken", () => {
  it("extracts the token value from a full cookie fragment", () => {
    expect(extractZaiToken("token=abc123; other=xyz")).toBe("abc123");
    expect(extractZaiToken("Cookie: other=xyz; token=abc123")).toBe("abc123");
  });

  it("extracts the current localStorage Bearer token and JSON credential", () => {
    expect(extractZaiToken("Bearer abc123")).toBe("abc123");
    expect(extractZaiToken("Authorization: Bearer abc123")).toBe("abc123");
    expect(extractZaiToken(TEST_CREDENTIAL)).toBe(TEST_TOKEN);
  });

  it("accepts a bare JWT/token with no cookie name prefix", () => {
    expect(extractZaiToken("eyJhbGciOiJIUzI1NiJ9.payload.sig")).toBe("eyJhbGciOiJIUzI1NiJ9.payload.sig");
    expect(extractZaiToken("plainsessiontoken")).toBe("plainsessiontoken");
  });

  it("returns empty string when no token is provided", () => {
    expect(extractZaiToken("")).toBe("");
    expect(extractZaiToken("other=xyz")).toBe("");
  });
});

describe("extractZaiCaptchaVerifyParam / extractZaiUserId", () => {
  it("reads the CAPTCHA proof from the JSON credential", () => {
    expect(extractZaiCaptchaVerifyParam(TEST_CREDENTIAL)).toBe("captcha-proof");
    expect(extractZaiCaptchaVerifyParam({ providerSpecificData: { captcha_verify_param: "nested" } })).toBe("nested");
  });

  it("reads the user id from the JWT payload", () => {
    expect(extractZaiUserId(TEST_TOKEN)).toBe("user-123");
    expect(extractZaiUserId("not-a-jwt")).toBe("");
  });
});

describe("buildZaiSignature", () => {
  it("reproduces the live frontend HMAC signature algorithm", () => {
    expect(
      buildZaiSignature({
        prompt: "Reply with exactly: OMNIROUTE_ZAI_WEB_TEST",
        requestId: "3b907de9-793c-41d1-8b8e-6ed6a714ee08",
        timestamp: 1784855934807,
        userId: "user-123",
      })
    ).toBe("14f17673ccd4ec86476549ebe60f181529572f7a0cfe8ba179206cf2d37cf442");
  });
});

describe("parseZaiFrontendVersion", () => {
  it("parses the deployed frontend version from the homepage asset path", () => {
    expect(parseZaiFrontendVersion("https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.1.79/assets/index.js")).toBe("prod-fe-1.1.79");
    expect(parseZaiFrontendVersion("<html></html>")).toBeNull();
  });
});

describe("parseZaiFrame", () => {
  it("parses the internal z.ai delta_content/phase SSE envelope", () => {
    expect(
      parseZaiFrame({ type: "chat:completion", data: { delta_content: "Hello", phase: "answer", done: false } })
    ).toEqual({ content: "Hello", reasoning: "", done: false });
  });

  it("routes thinking-phase content into the reasoning field", () => {
    expect(
      parseZaiFrame({ type: "chat:completion", data: { delta_content: "pondering...", phase: "thinking", done: false } })
    ).toEqual({ content: "", reasoning: "pondering...", done: false });
  });

  it("detects end-of-stream from the internal envelope", () => {
    expect(parseZaiFrame({ type: "chat:completion", data: { phase: "done", done: true } })?.done).toBe(true);
  });

  it("parses an OpenAI-shaped pass-through frame", () => {
    expect(parseZaiFrame({ choices: [{ delta: { content: "Hi there" }, finish_reason: null }] })).toEqual({
      content: "Hi there",
      reasoning: "",
      done: false,
    });
  });

  it("detects end-of-stream from an OpenAI-shaped finish_reason", () => {
    expect(parseZaiFrame({ choices: [{ delta: {}, finish_reason: "stop" }] })?.done).toBe(true);
  });

  it("returns null for frames with no usable delta", () => {
    expect(parseZaiFrame(null)).toBeNull();
    expect(parseZaiFrame({})).toBeNull();
    expect(parseZaiFrame({ data: { phase: "answer" } })).toBeNull();
  });

  it("surfaces explicit error frames as terminal errors", () => {
    expect(parseZaiFrame({ type: "chat:completion", data: { error: "expired captcha" } })).toEqual({
      content: "",
      reasoning: "",
      done: true,
      error: "expired captcha",
    });
  });
});

describe("foldMessages", () => {
  it("folds multimodal message content into text without leaking image payloads", () => {
    expect(
      foldMessages([
        { role: "user", content: "hi" },
        { role: "user", content: { foo: "bar" } },
        {
          role: "user",
          content: [
            { type: "text", text: "inspect this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
          ],
        },
      ])
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "" },
      { role: "user", content: "inspect this" },
    ]);
  });
});

describe("thinking/VLM config resolution", () => {
  it("enables Deep Think for every public model and limits effort to GLM-5.2", () => {
    expect(resolveZaiThinkingConfig("glm-5.2", {})).toEqual({ supported: true, enabled: true, effort: "max", effortSupported: true });
    expect(resolveZaiThinkingConfig("zw/glm-5.2", { reasoning_effort: "medium" })).toEqual({ supported: true, enabled: true, effort: "high", effortSupported: true });
    expect(resolveZaiThinkingConfig("glm-5.2", { reasoning: { effort: "high" } })).toEqual({ supported: true, enabled: true, effort: "high", effortSupported: true });
    expect(resolveZaiThinkingConfig("glm-5.2", { reasoning_effort: "off" })).toEqual({ supported: true, enabled: false, effort: "max", effortSupported: true });
    expect(resolveZaiThinkingConfig("GLM-5.1", { reasoning_effort: "max" })).toEqual({ supported: true, enabled: true, effort: "max", effortSupported: false });
  });

  it("maps GLM-5V-Turbo vision and internal VLM controls from live capabilities", () => {
    expect(getZaiModelCapabilities("zw/GLM-5v-Turbo")).toEqual({
      mcp: false,
      reasoningEffort: false,
      returnFc: true,
      thinking: true,
      vision: true,
      vlmTools: true,
      vlmWebSearch: true,
      vlmWebsiteMode: true,
      webSearch: true,
    });
    expect(resolveZaiVlmConfig("GLM-5v-Turbo", {})).toEqual({ toolsEnabled: true, webSearchEnabled: true, websiteModeEnabled: true });
    expect(
      resolveZaiVlmConfig("GLM-5v-Turbo", { features: { vlm_tools_enable: false, vlm_web_search_enable: false, vlm_website_mode: false } })
    ).toEqual({ toolsEnabled: false, webSearchEnabled: false, websiteModeEnabled: true });
    expect(resolveZaiVlmConfig("GLM-5.1", {})).toEqual({ toolsEnabled: false, webSearchEnabled: false, websiteModeEnabled: false });
    expect(resolveZaiVlmConfig("GLM-5.1", { web_search: true })).toEqual({ toolsEnabled: false, webSearchEnabled: true, websiteModeEnabled: false });
  });
});

describe("ZaiWebExecutor", () => {
  const executor = new ZaiWebExecutor();

  it("returns a credential error when no session credential is provided", async () => {
    const result = await executor.execute({
      model: "GLM-5.1",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "" },
      signal: null,
    });
    expect(result.response.status).toBe(400);
    const parsed = await result.response.json();
    expect(parsed.error.message).toMatch(/web-session credential/);
  });

  it("rejects image input on text-only models", async () => {
    const result = await executor.execute({
      model: "glm-5.2",
      body: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "inspect" },
              { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
            ],
          },
        ],
      },
      stream: false,
      credentials: { apiKey: TEST_TOKEN },
      signal: null,
    });
    expect(result.response.status).toBe(400);
    const parsed = await result.response.json();
    expect(parsed.error.message).toMatch(/GLM-5V-Turbo/);
  });

  it("creates a chat, signs the v2 request, and forwards the CAPTCHA proof", async () => {
    const capture = {};
    installZaiFetch(() => sseResponse("data: [DONE]\n\n"), capture);
    const result = await executor.execute({
      model: "GLM-5.1",
      body: { model: "GLM-5.1", messages: [{ role: "user", content: "hello" }], temperature: 0.4, web_search: true },
      stream: false,
      credentials: { apiKey: TEST_CREDENTIAL },
      signal: null,
    });
    expect(result.response.status).toBe(200);

    // New chat request.
    expect(capture.newChatInit).toBeTruthy();
    const newChatHeaders = capture.newChatInit.headers;
    expect(newChatHeaders.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    const newChatBody = JSON.parse(String(capture.newChatInit.body));
    expect(newChatBody.chat.models).toEqual(["GLM-5.1"]);
    expect(newChatBody.chat.history.currentId.length).toBe(36);
    expect(newChatBody.chat.enable_thinking).toBe(true);
    expect(newChatBody.chat.auto_web_search).toBe(true);

    // Signed v2 completion URL.
    const completionUrl = new URL(String(capture.completionUrl));
    expect(completionUrl.pathname).toBe(ZAI_COMPLETION_PATH);
    expect(completionUrl.searchParams.get("token")).toBe(TEST_TOKEN);
    expect(completionUrl.searchParams.get("user_id")).toBe("user-123");
    expect(completionUrl.searchParams.get("version")).toBe("0.0.1");
    expect(completionUrl.searchParams.get("signature_timestamp")).toBe(completionUrl.searchParams.get("timestamp"));

    const headers = capture.completionInit.headers;
    expect(headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(headers["X-FE-Version"]).toBe("prod-fe-1.1.79");
    expect(headers["X-Signature"]).toMatch(/^[a-f0-9]{64}$/);

    const parsedBody = JSON.parse(String(capture.completionInit.body));
    expect(parsedBody.model).toBe("GLM-5.1");
    expect(parsedBody.stream).toBe(true);
    expect(parsedBody.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(parsedBody.signature_prompt).toBe("hello");
    expect(parsedBody.captcha_verify_param).toBe("captcha-proof");
    expect(parsedBody.chat_id).toBe("chat-123");
    expect(parsedBody.params.temperature).toBe(0.4);
    expect(parsedBody.features.web_search).toBe(false);
    expect(parsedBody.features.auto_web_search).toBe(true);
    expect(parsedBody.features.enable_thinking).toBe(true);
    expect("reasoning_effort" in parsedBody.features).toBe(false);
  });

  it("aggregates streamed internal-envelope deltas into a non-streaming completion", async () => {
    installZaiFetch(() =>
      sseResponse(
        [
          `data: ${JSON.stringify({ type: "chat:completion", data: { delta_content: "Hel", phase: "answer", done: false } })}`,
          `data: ${JSON.stringify({ type: "chat:completion", data: { delta_content: "lo", phase: "answer", done: false } })}`,
          `data: ${JSON.stringify({ type: "chat:completion", data: { phase: "done", done: true } })}`,
          "data: [DONE]",
          "",
          "",
        ].join("\n")
      )
    );
    const result = await executor.execute({
      model: "GLM-5.1",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: TEST_CREDENTIAL },
      signal: null,
    });
    const completion = await result.response.json();
    expect(completion.choices[0].message.content).toBe("Hello");
    expect(completion.choices[0].finish_reason).toBe("stop");
  });

  it("streams internal-envelope deltas as OpenAI-shaped SSE chunks", async () => {
    installZaiFetch(() =>
      sseResponse(
        [
          `data: ${JSON.stringify({ type: "chat:completion", data: { delta_content: "Hi", phase: "answer", done: false } })}`,
          `data: ${JSON.stringify({ type: "chat:completion", data: { phase: "done", done: true } })}`,
          "",
          "",
        ].join("\n")
      )
    );
    const result = await executor.execute({
      model: "GLM-5.1",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: TEST_CREDENTIAL },
      signal: null,
    });
    const text = await result.response.text();
    expect(text).toContain('"content":"Hi"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
  });

  it("propagates upstream HTTP errors", async () => {
    installZaiFetch(() => new Response("session expired", { status: 401 }));
    const result = await executor.execute({
      model: "GLM-5.1",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: TEST_CREDENTIAL },
      signal: null,
    });
    expect(result.response.status).toBe(401);
  });

  // ── Browser transport (no CAPTCHA proof supplied) ────────────────────

  it("uses the browser transport when no CAPTCHA proof is provided and aggregates the captured SSE", async () => {
    browserChatMock.mockResolvedValue({
      ok: true,
      status: 200,
      contentType: "text/event-stream",
      body: Buffer.from(
        [
          `data: ${JSON.stringify({ type: "chat:completion", data: { delta_content: "Hel", phase: "answer", done: false } })}`,
          `data: ${JSON.stringify({ type: "chat:completion", data: { delta_content: "lo", phase: "answer", done: false } })}`,
          `data: ${JSON.stringify({ type: "chat:completion", data: { phase: "done", done: true } })}`,
          "data: [DONE]",
          "",
          "",
        ].join("\n")
      ),
    });
    const result = await executor.execute({
      model: "GLM-5.1",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: TEST_TOKEN },
      signal: null,
    });
    expect(result.response.status).toBe(200);
    expect(browserChatMock).toHaveBeenCalledTimes(1);
    const call = browserChatMock.mock.calls[0][0];
    expect(call.token).toBe(TEST_TOKEN);
    expect(call.prompt).toBe("hi");
    expect(call.modelId).toBe("GLM-5.1");
    // No signed-API requests should have been made.
    expect(fetchMock).not.toHaveBeenCalled();
    const completion = await result.response.json();
    expect(completion.choices[0].message.content).toBe("Hello");
    expect(completion.choices[0].finish_reason).toBe("stop");
  });

  it("streams the captured browser SSE as OpenAI-shaped chunks", async () => {
    browserChatMock.mockResolvedValue({
      ok: true,
      status: 200,
      contentType: "text/event-stream",
      body: Buffer.from(
        [
          `data: ${JSON.stringify({ type: "chat:completion", data: { delta_content: "Hi", phase: "answer", done: false } })}`,
          `data: ${JSON.stringify({ type: "chat:completion", data: { phase: "done", done: true } })}`,
          "",
          "",
        ].join("\n")
      ),
    });
    const result = await executor.execute({
      model: "GLM-5.1",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: TEST_TOKEN },
      signal: null,
    });
    const text = await result.response.text();
    expect(text).toContain('"content":"Hi"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
  });

  it("surfaces browser transport failures as 502 with the reason", async () => {
    browserChatMock.mockResolvedValue({
      ok: false,
      error: "guest sessions are limited to GLM-4.7",
    });
    const result = await executor.execute({
      model: "glm-5-turbo",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: TEST_TOKEN },
      signal: null,
    });
    expect(result.response.status).toBe(502);
    const parsed = await result.response.json();
    expect(parsed.error.message).toMatch(/GLM-4.7/);
  });

  it("propagates non-2xx responses from the browser transport", async () => {
    browserChatMock.mockResolvedValue({ ok: true, status: 403, body: Buffer.alloc(0) });
    const result = await executor.execute({
      model: "GLM-5.1",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: TEST_TOKEN },
      signal: null,
    });
    expect(result.response.status).toBe(403);
    const parsed = await result.response.json();
    expect(parsed.error.message).toMatch(/re-capture/);
  });

  it("requires a CAPTCHA proof when the browser transport is disabled", async () => {
    const prev = process.env.ER_ZAI_BROWSER;
    process.env.ER_ZAI_BROWSER = "off";
    try {
      const result = await executor.execute({
        model: "GLM-5.1",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: TEST_TOKEN },
        signal: null,
      });
      expect(result.response.status).toBe(400);
      expect(browserChatMock).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ER_ZAI_BROWSER;
      else process.env.ER_ZAI_BROWSER = prev;
    }
  });

  it("still uses the signed API when a CAPTCHA proof is supplied", async () => {
    const capture = {};
    installZaiFetch(() => sseResponse("data: [DONE]\n\n"), capture);
    const result = await executor.execute({
      model: "GLM-5.1",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: { apiKey: TEST_CREDENTIAL },
      signal: null,
    });
    expect(result.response.status).toBe(200);
    expect(browserChatMock).not.toHaveBeenCalled();
    expect(capture.completionInit).toBeTruthy();
  });
});

import { describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
const { mapModel, generateRequestToken, TheOldLlmExecutor } = await import("../../open-sse/executors/theoldllm.js");
const { parseFeloStreamLine, accumulateFeloStreamText, parseFeloCredential, FeloWebExecutor } = await import("../../open-sse/executors/felo-web.js");
const { AihordeExecutor } = await import("../../open-sse/executors/aihorde.js");
const { MimocodeExecutor, MIMO_SYSTEM_MARKER } = await import("../../open-sse/executors/mimocode.js");
const { getExecutor } = await import("../../open-sse/executors/index.js");
const { getPricingForModel } = await import("../../open-sse/providers/pricing.js");
const { stripUnsupportedParams } = await import("../../open-sse/translator/concerns/paramSupport.js");

function entry(id) {
  return REGISTRY.find((r) => r.id === id);
}

describe("free gateway registry (batch port)", () => {
  const gatewayIds = [
    "bazaarlink", "uncloseai", "dgrid", "llm7", "dahl", "hackclub",
    "g4f-groq", "g4f-gemini", "g4f-pollinations", "g4f-ollama", "g4f-nvidia",
    "theoldllm", "felo-web", "aihorde", "mimocode",
  ];

  for (const id of gatewayIds) {
    it(`${id} is registered with models`, () => {
      const e = entry(id);
      expect(e, `${id} should exist in registry`).toBeDefined();
      expect(Array.isArray(e.models) && e.models.length > 0).toBe(true);
    });
  }

  it("aliases match the OmniRoute catalog", () => {
    expect(entry("bazaarlink").alias).toBe("bzl");
    expect(entry("uncloseai").alias).toBe("unc");
    expect(entry("llm7").alias).toBe("llm7");
    expect(entry("hackclub").alias).toBe("hcb"); // "hc" already taken by hcnsec
    expect(entry("g4f-groq").alias).toBe("g4fgroq");
    expect(entry("theoldllm").alias).toBe("tllm");
    expect(entry("felo-web").alias).toBe("felo");
    expect(entry("mimocode").alias).toBe("mcode");
  });

  it("no-auth providers are flagged noAuth + free category", () => {
    for (const id of ["uncloseai", "hackclub", "g4f-groq", "g4f-gemini", "g4f-pollinations", "g4f-ollama", "g4f-nvidia", "theoldllm", "aihorde", "mimocode"]) {
      const e = entry(id);
      expect(e.noAuth, `${id} should be noAuth`).toBe(true);
      expect(e.category).toBe("free");
    }
  });

  it("aihorde carries the anonymous-key quirk timeout", () => {
    expect(entry("aihorde").transport.timeoutMs).toBe(120000);
  });
});

describe("free gateway pricing", () => {
  it("zero-cost models resolve to $0", () => {
    expect(getPricingForModel("bazaarlink", "auto:free")).toEqual({ input: 0, output: 0 });
    expect(getPricingForModel("dgrid", "dgridai/free")).toEqual({ input: 0, output: 0 });
    expect(getPricingForModel("mimocode", "mimo-auto")).toEqual({ input: 0, output: 0 });
    expect(getPricingForModel("theoldllm", "GPT_5_4")).toEqual({ input: 0, output: 0 });
  });
});

describe("aihorde param stripping", () => {
  it("drops tool params and flattens content parts", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ type: "function" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    };
    stripUnsupportedParams("aihorde", "google/gemma-4-31b", body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(body.messages[0].content).toBe("hi");
  });
});

describe("TheOldLlmExecutor", () => {
  const exec = new TheOldLlmExecutor();

  it("maps model names to upstream ids", () => {
    expect(mapModel("GPT_5_4")).toBe("GPT_5_4");
    expect(mapModel("gpt-5.4")).toBe("GPT_5_4");
    expect(mapModel("claude-4.6-opus")).toBe("CLAUDE_4_6_OPUS");
    expect(mapModel("claude sonnet 4")).toBe("CLAUDE_4_6_SONNET");
    expect(mapModel("gemini_3_pro")).toBe("gemini_3_pro");
    expect(mapModel("weird-gpt-5-x")).toBe("GPT_5_4");
  });

  it("generates a valid X-Request-Token shape", () => {
    const token = generateRequestToken();
    expect(token).toMatch(/^[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/);
  });

  it("passes through the upstream SSE on streaming and retries on 401", async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ));
    const out = await exec.execute({
      model: "gpt-5.4",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: {},
      log: { warn: () => {}, error: () => {} },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.response.status).toBe(200);
    const text = await out.response.text();
    expect(text).toContain("data: [DONE]");
  });
});

describe("FeloWebExecutor", () => {
  it("diffs answer snapshots into incremental text", () => {
    const line1 = 'data:{"content":"{\\"data\\":{\\"type\\":\\"answer\\",\\"data\\":{\\"text\\":\\"Hello\\"}}}"}';
    const line2 = 'data:{"content":"{\\"data\\":{\\"type\\":\\"answer\\",\\"data\\":{\\"text\\":\\"Hello world\\"}}}"}';
    const r1 = parseFeloStreamLine(line1, "");
    expect(r1.newText).toBe("Hello");
    const r2 = parseFeloStreamLine(line2, r1.nextPreviousText);
    expect(r2.newText).toBe(" world");
  });

  it("accumulates the final text from a raw body", () => {
    const body = [
      'data:{"content":"{\\"data\\":{\\"type\\":\\"answer\\",\\"data\\":{\\"text\\":\\"A\\"}}}"}',
      'data:{"content":"{\\"data\\":{\\"type\\":\\"answer\\",\\"data\\":{\\"text\\":\\"AB\\"}}}"}',
      'data:{"content":"{\\"data\\":{\\"type\\":\\"final_contexts\\",\\"data\\":{}}}"}',
    ].join("\n");
    expect(accumulateFeloStreamText(body)).toBe("AB");
  });

  it("parses cf_token/bearer/cookie credential formats", () => {
    expect(parseFeloCredential("cf_token=abc123")).toEqual({ cfToken: "abc123", bearer: "", cookie: "" });
    expect(parseFeloCredential("cf_token=abc; bearer=6h_x; cookie=a=b; c=d")).toEqual({ cfToken: "abc", bearer: "6h_x", cookie: "a=b; c=d" });
    expect(parseFeloCredential("turnstile=xyz")).toEqual({ cfToken: "xyz", bearer: "", cookie: "" });
    expect(parseFeloCredential("bare-token")).toEqual({ cfToken: "bare-token", bearer: "", cookie: "" });
    expect(parseFeloCredential("")).toEqual({ cfToken: "", bearer: "", cookie: "" });
    // felo-user-token cookie value doubles as the session bearer (mirrors the frontend)
    expect(parseFeloCredential("cookie=felo-user-token=6h_abc; visitor_id=v1")).toEqual({
      cfToken: "",
      bearer: "6h_abc",
      cookie: "felo-user-token=6h_abc; visitor_id=v1",
    });
  });

  it("tolerates the new `stream` event framing", () => {
    const inner = JSON.stringify({ data: { type: "answer", data: { text: "Hi" } } });
    const outer = JSON.stringify({ is_complete: false, content: inner });
    const line = `stream\t${outer}`;

    const r = parseFeloStreamLine(line, "");
    expect(r.newText).toBe("Hi");
  });

  it("rejects execution without any credentials", async () => {
    fetchMock.mockReset();
    const exec = new FeloWebExecutor();
    const out = await exec.execute({
      model: "felo-chat",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: {},
      log: { error: () => {} },
    });
    expect(out.response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends bearer/cookie on the thread POST so a logged-in session can bypass turnstile", async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce(new Response(JSON.stringify({ stream_key: "sk-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(
        'data:{"content":"{}"}\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ));
    const exec = new FeloWebExecutor();
    const out = await exec.execute({
      model: "felo-chat",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "bearer=6h_xyz; cookie=felo-user-token=6h_xyz" },
      log: { error: () => {} },
    });
    expect(out.response.status).toBe(200);
    const [, threadOpts] = fetchMock.mock.calls[0];
    expect(threadOpts.headers.Authorization).toBe("Bearer 6h_xyz");
    expect(threadOpts.headers.Cookie).toBe("felo-user-token=6h_xyz");
    // logged-in sessions don't send a cf_token at all (like the frontend)
    expect(JSON.parse(threadOpts.body).cf_token).toBeUndefined();
  });

  it("derives the Authorization bearer from a cookie-only paste", async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce(new Response(JSON.stringify({ stream_key: "sk-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(
        'data:{"content":"{}"}\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ));
    const exec = new FeloWebExecutor();
    const out = await exec.execute({
      model: "felo-chat",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "cookie=felo-user-token=6h_abc" },
      log: { error: () => {} },
    });
    expect(out.response.status).toBe(200);
    const [, threadOpts] = fetchMock.mock.calls[0];
    expect(threadOpts.headers.Authorization).toBe("Bearer 6h_abc");
    expect(threadOpts.headers.Cookie).toBe("felo-user-token=6h_abc");
    const [, streamOpts] = fetchMock.mock.calls[1];
    expect(streamOpts.headers.Authorization).toBe("Bearer 6h_abc");
    expect(streamOpts.headers.Cookie).toBe("felo-user-token=6h_abc");
  });

  it("opens a thread with cf_token and streams the answer", async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce(new Response(JSON.stringify({ stream_key: "sk-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(
        'data:{"content":"{\\"data\\":{\\"type\\":\\"answer\\",\\"data\\":{\\"text\\":\\"Hi there\\"}}}"}\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ));
    const exec = new FeloWebExecutor();
    const out = await exec.execute({
      model: "felo-chat",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "cf_token=test-token" },
      log: { error: () => {} },
    });
    expect(out.response.status).toBe(200);
    // cf_token must ride along in the thread payload
    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body).cf_token).toBe("test-token");
    const text = await out.response.text();
    expect(text).toContain("Hi there");
    expect(text).toContain("data: [DONE]");
  });

  it("sends bearer/cookie on the stream request when provided", async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce(new Response(JSON.stringify({ stream_key: "sk-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(
        'data:{"content":"{}"}\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ));
    const exec = new FeloWebExecutor();
    const out = await exec.execute({
      model: "felo-chat",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "cf_token=t; bearer=6h_xyz; cookie=a=b; c=d" },
      log: { error: () => {} },
    });
    expect(out.response.status).toBe(200);
    const [, streamOpts] = fetchMock.mock.calls[1];
    expect(streamOpts.headers.Authorization).toBe("Bearer 6h_xyz");
    expect(streamOpts.headers.Cookie).toBe("a=b; c=d");
  });
});

describe("AihordeExecutor", () => {
  it("injects the anonymous key when none is supplied", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const exec = new AihordeExecutor("aihorde");
    await exec.execute({
      model: "google/gemma-4-31b",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {},
    });
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer 0000000000");
  });
});

describe("MimocodeExecutor", () => {
  it("bootstraps a JWT then sends the chat with X-Mimo-Source", async () => {
    fetchMock.mockReset()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jwt: "header.payload.sig" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const exec = new MimocodeExecutor("mimocode");
    const out = await exec.execute({
      model: "mimo-auto",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {},
      log: { debug: () => {} },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [bootstrapUrl, bootstrapOpts] = fetchMock.mock.calls[0];
    expect(bootstrapUrl).toContain("/api/free-ai/bootstrap");
    expect(JSON.parse(bootstrapOpts.body).client).toBeTruthy();
    const [chatUrl, chatOpts] = fetchMock.mock.calls[1];
    expect(chatUrl).toContain("/api/free-ai/openai/chat");
    expect(chatOpts.headers["X-Mimo-Source"]).toBe("mimocode-cli-free");
    expect(chatOpts.headers.Authorization).toBe("Bearer header.payload.sig");
    const chatBody = JSON.parse(chatOpts.body);
    expect(chatBody.messages[0].role).toBe("system");
    expect(chatBody.messages[0].content).toContain(MIMO_SYSTEM_MARKER);
    expect(out.response.status).toBe(200);
  });
});

describe("executor routing", () => {
  it("routes custom providers through their executors", () => {
    expect(getExecutor("theoldllm")).toBeInstanceOf(TheOldLlmExecutor);
    expect(getExecutor("felo-web")).toBeInstanceOf(FeloWebExecutor);
    expect(getExecutor("aihorde")).toBeInstanceOf(AihordeExecutor);
    expect(getExecutor("mimocode")).toBeInstanceOf(MimocodeExecutor);
  });
});

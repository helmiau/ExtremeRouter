import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GeminiBusinessExecutor,
  parseStreamResponse,
  resolveGeminiBusinessCookie,
} from "../../open-sse/executors/gemini-business.js";

const originalFetch = global.fetch;

describe("GeminiBusinessExecutor", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("constructs with the correct provider", () => {
    const ex = new GeminiBusinessExecutor();
    expect(ex.provider).toBe("gemini-business");
  });

  it("preserves supported legacy cookie credential placements", () => {
    expect(resolveGeminiBusinessCookie({ cookie: "  __Secure-1PSID=legacy  " })).toBe(
      "__Secure-1PSID=legacy"
    );
    expect(
      resolveGeminiBusinessCookie({
        providerSpecificData: {
          "__Secure-1PSID": "__Secure-1PSID=psid",
          "__Secure-1PSIDTS": "__Secure-1PSIDTS=psidts",
        },
      })
    ).toBe("__Secure-1PSID=psid; __Secure-1PSIDTS=psidts");
  });

  it("returns 401 when no cookies are provided", async () => {
    const ex = new GeminiBusinessExecutor();
    const result = await ex.execute({
      model: "gemini-2.5-pro",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: {},
    });
    expect(result.response.status).toBe(401);
    const text = await result.response.text();
    expect(text).toContain("Missing Gemini Business cookies");
  });

  it("returns 400 when no user message is provided", async () => {
    const ex = new GeminiBusinessExecutor();
    const result = await ex.execute({
      model: "gemini-2.5-pro",
      body: { messages: [] },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=fake; __Secure-1PSIDTS=fake" },
    });
    expect(result.response.status).toBe(400);
    const text = await result.response.text();
    expect(text).toContain("No user message found");
  });

  it("reaches the upstream fetch and returns a parsed non-streaming completion", async () => {
    const inner = new Array(80).fill(null);
    inner[4] = [[null, ["Hello from Gemini Business"]]];
    const upstreamBody = `[["wrb.fr", null, ${JSON.stringify(JSON.stringify(inner))}]]`;

    let fetchCalled = false;
    global.fetch.mockImplementationOnce(async (url, init) => {
      fetchCalled = true;
      expect(url).toContain("/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.body).toContain("f.req=");
      return new Response(upstreamBody, { status: 200 });
    });

    const ex = new GeminiBusinessExecutor();
    const result = await ex.execute({
      model: "gemini-2.5-pro",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=fake; __Secure-1PSIDTS=fake" },
    });

    expect(fetchCalled).toBe(true);
    expect(result.response.status).toBe(200);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("Hello from Gemini Business");
  });

  it("streams the parsed text as OpenAI SSE chunks", async () => {
    const inner = new Array(80).fill(null);
    inner[4] = [[null, ["Streamed answer"]]];
    const upstreamBody = `[["wrb.fr", null, ${JSON.stringify(JSON.stringify(inner))}]]`;

    global.fetch.mockResolvedValueOnce(new Response(upstreamBody, { status: 200 }));

    const ex = new GeminiBusinessExecutor();
    const result = await ex.execute({
      model: "gemini-2.5-flash",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: true,
      credentials: { apiKey: "__Secure-1PSID=fake; __Secure-1PSIDTS=fake" },
    });
    const text = await result.response.text();
    expect(text).toMatch(/"content":"Streamed answer"/);
    expect(text).toMatch(/data: \[DONE\]/);
  });

  it("returns 403 with guidance when the account-chooser page is returned", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response("<html>auth.business.gemini.google/account-chooser</html>", { status: 200 })
    );
    const ex = new GeminiBusinessExecutor();
    const result = await ex.execute({
      model: "gemini-2.5-pro",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=fake; __Secure-1PSIDTS=fake" },
    });
    expect(result.response.status).toBe(403);
    const text = await result.response.text();
    expect(text).toContain("account-chooser");
  });

  it("returns 502 when the upstream body has no text", async () => {
    global.fetch.mockResolvedValueOnce(new Response(")]}'\n10\nnot json", { status: 200 }));
    const ex = new GeminiBusinessExecutor();
    const result = await ex.execute({
      model: "gemini-2.5-pro",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=fake; __Secure-1PSIDTS=fake" },
    });
    expect(result.response.status).toBe(502);
  });

  describe("parseStreamResponse", () => {
    it("extracts text from a single wrb.fr chunk", () => {
      const inner = new Array(80).fill(null);
      inner[4] = [[null, ["Hello, world!"]]];
      const raw = `[["wrb.fr", null, ${JSON.stringify(JSON.stringify(inner))}]]`;
      expect(parseStreamResponse(raw)).toBe("Hello, world!");
    });

    it("concatenates text from multiple wrb.fr chunks", () => {
      const makeChunk = (text) => {
        const inner = new Array(80).fill(null);
        inner[4] = [[null, [text]]];
        return `[["wrb.fr", null, ${JSON.stringify(JSON.stringify(inner))}]]`;
      };
      const raw = `)]}'\n10\n${makeChunk("First ")}\n5\n${makeChunk("chunk")}`;
      expect(parseStreamResponse(raw)).toBe("First chunk");
    });

    it("filters out non-string entries", () => {
      const inner = new Array(80).fill(null);
      inner[4] = [[null, ["clean ", 123, null, "text"]]];
      const raw = `[["wrb.fr", null, ${JSON.stringify(JSON.stringify(inner))}]]`;
      expect(parseStreamResponse(raw)).toBe("clean text");
    });

    it("returns empty string for malformed/empty/non-wrb.fr responses", () => {
      expect(parseStreamResponse(")]}'\n42\nnot json")).toBe("");
      expect(parseStreamResponse("")).toBe("");
      expect(parseStreamResponse(")]}'\n10\n[[\"other.rpc\", null, \"irrelevant\"]]")).toBe("");
    });
  });
});

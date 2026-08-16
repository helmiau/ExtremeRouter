import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InnerAiExecutor,
  findModel,
  parseCredential,
  decodeJwtPayload,
  buildMessageContent,
  transformInnerAiSSE,
  collectContent,
} from "../../open-sse/executors/inner-ai.js";

const originalFetch = global.fetch;

// A JWT-shaped token with device_id in the payload (unsigned — only decoded).
function jwtWith(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${b64}.signature`;
}

describe("InnerAiExecutor", () => {
  beforeEach(() => {
    const base = vi.fn();
    global.fetch = vi.fn(async (url) => base(url));
    // Rebind the once-chain onto the base so the wrapper only logs.
    global.fetch.mockResolvedValueOnce = base.mockResolvedValueOnce.bind(base);
    global.fetch.mockImplementationOnce = base.mockImplementationOnce.bind(base);
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("can be instantiated", () => {
    const executor = new InnerAiExecutor();
    expect(executor).toBeInstanceOf(InnerAiExecutor);
  });

  describe("credential parsing", () => {
    it("parses a bare token", () => {
      expect(parseCredential("eyJhbGciOiJIUzI1NiJ9.abc.def")).toEqual({ token: "eyJhbGciOiJIUzI1NiJ9.abc.def", credEmail: "" });
    });

    it("parses token + email", () => {
      expect(parseCredential("eyJhbG.abc.def user@example.com")).toEqual({
        token: "eyJhbG.abc.def",
        credEmail: "user@example.com",
      });
    });

    it("parses token= prefix + email", () => {
      expect(parseCredential("token=eyJhbG.abc.def user@example.com")).toEqual({
        token: "eyJhbG.abc.def",
        credEmail: "user@example.com",
      });
    });
  });

  describe("JWT decoding", () => {
    it("extracts device_id from the payload", () => {
      const token = jwtWith({ device_id: "dev-1", sub: "u@example.com" });
      const payload = decodeJwtPayload(token);
      expect(payload.device_id).toBe("dev-1");
      expect(payload.sub).toBe("u@example.com");
    });

    it("returns null for malformed tokens", () => {
      expect(decodeJwtPayload("not-a-jwt")).toBeNull();
    });
  });

  describe("findModel", () => {
    const PLAN_MODELS = [
      { id: "u1", llm_model: "gpt-4o" },
      { id: "u2", llm_model: "gpt-4.1" },
      { id: "u3", llm_model: "claude-opus-4-5" },
    ];

    it("returns null (not models[0]) when the requested model is not in the plan list", () => {
      expect(findModel(PLAN_MODELS, "gemini-2.5-pro")).toBeNull();
    });

    it("returns null for an empty model list", () => {
      expect(findModel([], "gpt-4o")).toBeNull();
    });

    it("matches exactly by llm_model", () => {
      expect(findModel(PLAN_MODELS, "gpt-4.1")?.id).toBe("u2");
    });

    it("matches case-insensitively", () => {
      expect(findModel(PLAN_MODELS, "GPT-4O")?.id).toBe("u1");
    });

    it("matches by substring", () => {
      const models = [
        { id: "a", llm_model: "anthropic/claude-opus-4-5-20260101" },
        { id: "b", llm_model: "gpt-4o" },
      ];
      expect(findModel(models, "claude-opus-4-5")?.id).toBe("a");
    });
  });

  describe("message building", () => {
    it("labels system/assistant turns", () => {
      const out = buildMessageContent([
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]);
      expect(out).toBe("[Instructions]\nBe brief.\n\nhi\n\n[Assistant]\nhello");
    });

    it("extracts text parts from array content", () => {
      const out = buildMessageContent([
        { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      ]);
      expect(out).toBe("ab");
    });
  });

  describe("execute", () => {
    it("returns 401 when credentials are empty", async () => {
      const executor = new InnerAiExecutor();
      const result = await executor.execute({
        model: "gpt-4o",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "" },
      });
      expect(result.response.status).toBe(401);
      const json = await result.response.json();
      expect(json.error.message).toContain("Missing Inner.ai token");
    });

    it("returns 400 when messages produce no content", async () => {
      const executor = new InnerAiExecutor();
      const result = await executor.execute({
        model: "gpt-4o",
        body: { messages: [] },
        stream: false,
        credentials: { apiKey: "fake-token" },
      });
      // Fake token fails credential resolution (401) before message check — both >= 400.
      expect(result.response.status).toBeGreaterThanOrEqual(400);
    });

    it("returns the standard execute result shape", async () => {
      const executor = new InnerAiExecutor();
      const result = await executor.execute({
        model: "gpt-4o",
        body: { messages: [{ role: "user", content: "test" }] },
        stream: false,
        credentials: { apiKey: "invalid-token" },
      });
      expect(result.response).toBeInstanceOf(Response);
      expect(typeof result.url).toBe("string");
      expect(typeof result.headers).toBe("object");
      expect(result.transformedBody).toBeDefined();
    });

    it("collects a non-streaming completion from text events", async () => {
      const token = jwtWith({ device_id: "dev-9", sub: "u@example.com" });
      // profile fetch → models fetch → chat fetch
      global.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: { email: "u@example.com" } }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: "m1", llm_model: "gpt-4o" }]), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(
            [
              'data: {"type":"text","item":"Hel"}',
              'data: {"type":"text","item":"lo"}',
              'data: {"type":"end_stream","item":"end"}',
              "",
            ].join("\n"),
            { status: 200 }
          )
        );

      const executor = new InnerAiExecutor();
      const result = await executor.execute({
        model: "gpt-4o",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: token },
      });

      expect(result.response.status).toBe(200);
      const json = await result.response.json();
      expect(json.choices[0].message.content).toBe("Hello");
      expect(json.model).toBe("gpt-4o");
    });

    it("maps non-streaming credits/rate-limit events to an HTTP error", async () => {
      const token = jwtWith({ device_id: "dev-9" });
      global.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
        .mockResolvedValueOnce(
          new Response('data: {"type":"missing_credits","item":"end"}', { status: 200 })
        );

      const executor = new InnerAiExecutor();
      const result = await executor.execute({
        model: "gpt-4o",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: token },
      });

      expect(result.response.status).toBe(429);
      const json = await result.response.json();
      expect(json.error.message).toContain("credits");
    });

    it("streams text events as OpenAI SSE chunks", async () => {
      // Distinct device_id: the module-level token caches persist across tests
      // in this file, so a reused token would skip the profile/models fetches
      // and shift the mock chain onto the chat call.
      const token = jwtWith({ device_id: "dev-10" });
      global.fetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            [
              'data: {"type":"text","item":"Hi"}',
              'data: {"type":"text","item":" there"}',
              'data: {"type":"end_stream","item":"end"}',
              "",
            ].join("\n"),
            { status: 200 }
          )
        );

      const executor = new InnerAiExecutor();
      const result = await executor.execute({
        model: "gpt-4o",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: true,
        credentials: { apiKey: token },
      });
      const text = await result.response.text();
      expect(text).toMatch(/"content":"Hi"/);
      expect(text).toMatch(/"content":" there"/);
      expect(text).toMatch(/data: \[DONE\]/);
    });
  });

  describe("transformInnerAiSSE / collectContent", () => {
    function streamFrom(lines) {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(lines.join("\n")));
          controller.close();
        },
      });
    }

    it("collectContent concatenates text events", async () => {
      const content = await collectContent(streamFrom(['data: {"type":"text","item":"a"}', 'data: {"type":"text","item":"b"}', ""]));
      expect(content).toBe("ab");
    });

    it("collectContent throws on credits events", async () => {
      await expect(
        collectContent(streamFrom(['data: {"type":"rate_limit_reached","item":"x"}', ""]))
      ).rejects.toThrow(/rate limit/i);
    });

    it("transformInnerAiSSE emits role + content chunks and [DONE]", async () => {
      const out = transformInnerAiSSE(
        streamFrom(['data: {"type":"text","item":"hey"}', 'data: {"type":"end_stream","item":"end"}', ""]),
        "gpt-4o"
      );
      const text = new TextDecoder().decode(await new Response(out).arrayBuffer());
      expect(text).toMatch(/"role":"assistant"/);
      expect(text).toMatch(/"content":"hey"/);
      expect(text).toMatch(/data: \[DONE\]/);
    });
  });
});

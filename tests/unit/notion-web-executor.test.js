import { describe, it, expect, afterEach } from "vitest";
import {
  NotionWebExecutor,
  __setTlsFetchOverrideForTesting,
  __resetNotionThreadSessionsForTests,
  buildNotionTranscript,
  estimateNotionUsage,
  extractNotionUpstreamError,
  normalizeNotionCookieInput,
  normalizeNotionWorkflowId,
  parseNotionInferenceStream,
  resolveNotionAgentOptions,
  resolveNotionWebCookie,
} from "../../open-sse/executors/notion-web.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  __setTlsFetchOverrideForTesting(null);
  __resetNotionThreadSessionsForTests();
  globalThis.fetch = originalFetch;
});

/** Mock the Chrome-JA3 path used by sendNotionInferenceRequest (not global fetch). */
function installNotionTlsMock(handler) {
  __setTlsFetchOverrideForTesting(async (url, options) => {
    const r = await handler(url, {
      headers: options.headers,
      body: options.body,
    });
    return {
      status: r.status,
      headers: new Headers(),
      text: r.text,
      body: null,
    };
  });
}

/** Cookie with space_id so execute() does not need a live getSpaces call. */
const COOKIE_WITH_SPACE = "token_v2=xyz; space_id=space-1; notion_user_id=user-1";

describe("NotionWebExecutor — registry consistency", () => {
  it("registers with a model catalog of web-picker labels (not food codenames)", async () => {
    const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
    const entry = REGISTRY.find((p) => p.id === "notion-web");
    expect(entry).toBeTruthy();
    expect(entry.alias).toBe("nw");
    const ids = (entry.models || []).map((m) => m.id);
    expect(ids).toContain("notion-ai");
    expect(ids.some((id) => id === "fable-5" || id === "gpt-5.6-sol" || id === "opus-4.8")).toBe(true);
    expect(
      ids.some((id) => id === "ambrosia-tart-high" || id === "orange-mousse" || id === "acai-budino-high")
    ).toBe(false);
  });
});

describe("NotionWebExecutor — instantiation & auth errors", () => {
  it("can be instantiated", () => {
    const executor = new NotionWebExecutor();
    expect(executor).toBeTruthy();
    expect(executor.getProvider()).toBe("notion-web");
  });

  it("returns 401 when no cookie credential is supplied", async () => {
    const executor = new NotionWebExecutor();
    const result = await executor.execute({
      model: "notion-ai",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {},
      signal: null,
    });
    expect(result.response.status).toBe(401);
    const errBody = await result.response.json();
    expect(errBody.error.message).toMatch(/token_v2/i);
  });

  it("returns 400 when no user message is present", async () => {
    const executor = new NotionWebExecutor();
    const result = await executor.execute({
      model: "notion-ai",
      body: { messages: [{ role: "assistant", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token_v2=fake" },
      signal: null,
    });
    expect(result.response.status).toBe(400);
  });
});

describe("NotionWebExecutor — upstream translation (mocked TLS fetch)", () => {
  it("posts createThread + config/context/user and returns a chat.completion", async () => {
    const executor = new NotionWebExecutor();
    let capturedUrl = "";
    let capturedHeaders = {};
    let capturedBody = null;
    installNotionTlsMock(async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts.headers || {};
      capturedBody = JSON.parse(String(opts.body));
      const ndjson = [
        JSON.stringify({ type: "patch-start", data: { s: [] } }),
        JSON.stringify({
          type: "record-map",
          recordMap: {
            thread_message: {
              m1: {
                value: {
                  value: {
                    step: {
                      type: "agent-inference",
                      value: [{ type: "text", content: '<lang primary="en-US"/>Hello there!' }],
                    },
                  },
                },
              },
            },
          },
        }),
      ].join("\n");
      return { status: 200, text: ndjson };
    });

    const result = await executor.execute({
      model: "notion-ai",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: COOKIE_WITH_SPACE },
      signal: null,
    });

    expect(capturedUrl).toBe("https://app.notion.com/api/v3/runInferenceTranscript");
    expect(capturedHeaders.Cookie).toBe(COOKIE_WITH_SPACE);
    expect(capturedHeaders["x-notion-space-id"]).toBe("space-1");
    expect(capturedHeaders["x-notion-active-user-header"]).toBe("user-1");
    expect(capturedHeaders["sec-ch-ua"]).toBeTruthy();
    expect(capturedHeaders["sec-fetch-dest"]).toBeTruthy();
    expect(capturedHeaders["sec-fetch-mode"]).toBe("cors");
    expect(capturedHeaders["sec-ch-ua-platform"]).toBeTruthy();
    expect(capturedHeaders["cache-control"]).toBe("no-cache");
    expect(capturedHeaders["pragma"]).toBe("no-cache");
    expect(capturedBody).toBeTruthy();
    expect(capturedBody.createThread).toBe(true);
    expect(typeof capturedBody.threadId).toBe("string");
    expect(capturedBody.threadId.length).toBeGreaterThan(0);
    expect(capturedBody.spaceId).toBe("space-1");
    expect(capturedBody.transcript[0].type).toBe("config");
    expect(capturedBody.transcript[1].type).toBe("context");
    expect(capturedBody.transcript[2].type).toBe("user");
    expect(capturedBody.transcript[2].value).toEqual([["hi"]]);

    expect(result.response.status).toBe(200);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("Hello there!");
  });

  it("injects a config transcript entry with the selected Notion model codename", async () => {
    const executor = new NotionWebExecutor();
    let capturedBody = null;
    installNotionTlsMock(async (_url, opts) => {
      capturedBody = JSON.parse(String(opts.body));
      return { status: 200, text: JSON.stringify({ value: [["ok"]] }) };
    });

    await executor.execute({
      model: "orange-mousse",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: COOKIE_WITH_SPACE },
      signal: null,
    });

    expect(capturedBody).toBeTruthy();
    expect(capturedBody.transcript[0].type).toBe("config");
    expect(capturedBody.transcript[0].value?.model).toBe("orange-mousse");
    expect(capturedBody.transcript[1].type).toBe("context");
    expect(capturedBody.transcript[2].type).toBe("user");
  });

  it("resolves friendly slug / provider-prefixed model ids to the Notion food codename", async () => {
    const executor = new NotionWebExecutor();
    let capturedBody = null;
    installNotionTlsMock(async (_url, opts) => {
      capturedBody = JSON.parse(String(opts.body));
      return { status: 200, text: JSON.stringify({ value: [["ok"]] }) };
    });

    const result = await executor.execute({
      model: "notion-web/gpt-5.6-sol",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: COOKIE_WITH_SPACE },
      signal: null,
    });

    expect(capturedBody).toBeTruthy();
    expect(capturedBody.transcript[0].type).toBe("config");
    expect(capturedBody.transcript[0].value?.model).toBe("orange-mousse");
    const json = await result.response.json();
    expect(json.model).toBe("gpt-5.6-sol");
  });

  it("resolves fable-5 to acai-budino-high for the transcript config entry", async () => {
    const executor = new NotionWebExecutor();
    let capturedBody = null;
    installNotionTlsMock(async (_url, opts) => {
      capturedBody = JSON.parse(String(opts.body));
      return { status: 200, text: JSON.stringify({ value: [["ok"]] }) };
    });

    const result = await executor.execute({
      model: "fable-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: COOKIE_WITH_SPACE },
      signal: null,
    });

    expect(capturedBody).toBeTruthy();
    expect(capturedBody.transcript[0].value?.model).toBe("acai-budino-high");
    const json = await result.response.json();
    expect(json.model).toBe("fable-5");
  });

  it("accepts a full cookie header verbatim (already containing token_v2=)", async () => {
    const executor = new NotionWebExecutor();
    let capturedHeaders = {};
    installNotionTlsMock(async (_url, opts) => {
      capturedHeaders = opts.headers || {};
      return { status: 200, text: JSON.stringify({ value: [["ok"]] }) };
    });

    await executor.execute({
      model: "notion-ai",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token_v2=xyz; space_id=abc-def" },
      signal: null,
    });

    expect(capturedHeaders.Cookie).toBe("token_v2=xyz; space_id=abc-def");
  });

  it("returns a pseudo-streamed SSE response with [DONE] when stream=true", async () => {
    const executor = new NotionWebExecutor();
    installNotionTlsMock(async () => ({
      status: 200,
      text: JSON.stringify({ value: [["Streamed reply"]] }),
    }));

    const result = await executor.execute({
      model: "notion-ai",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: COOKIE_WITH_SPACE },
      signal: null,
    });

    expect(result.response.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await result.response.text();
    expect(text).toMatch(/Streamed reply/);
    expect(text).toMatch(/data: \[DONE\]/);
  });

  it("returns 502 when Notion sends no parseable text (endpoint drift)", async () => {
    const executor = new NotionWebExecutor();
    installNotionTlsMock(async () => ({ status: 200, text: "not-json\n{}" }));

    const result = await executor.execute({
      model: "notion-ai",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: COOKIE_WITH_SPACE },
      signal: null,
    });
    expect(result.response.status).toBe(502);
  });

  it("returns a sanitized 403 error without leaking raw upstream error text shape", async () => {
    const executor = new NotionWebExecutor();
    installNotionTlsMock(async () => ({ status: 403, text: "Forbidden" }));

    const result = await executor.execute({
      model: "notion-ai",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "token_v2=expired; space_id=s1" },
      signal: null,
    });
    expect(result.response.status).toBe(403);
    const errBody = await result.response.json();
    expect(errBody.error.message).toMatch(/session expired|invalid/i);
    expect(errBody.error.code).toBe("HTTP_403");
    expect(errBody.error.message.includes("at /")).toBe(false);
  });

  it("returns 502 with a sanitized message when the TLS fetch itself throws", async () => {
    const executor = new NotionWebExecutor();
    installNotionTlsMock(async () => {
      throw new Error("getaddrinfo ENOTFOUND www.notion.so at /some/internal/path.ts:42");
    });

    const result = await executor.execute({
      model: "notion-ai",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: COOKIE_WITH_SPACE },
      signal: null,
    });
    expect(result.response.status).toBe(502);
    const errBody = await result.response.json();
    expect(errBody.error.message.includes("at /some/internal/path.ts")).toBe(false);
  });

  it("surfaces nested patch-start temporarily-unavailable as a typed error (not empty-body 502)", async () => {
    const executor = new NotionWebExecutor();
    installNotionTlsMock(async () => ({
      status: 200,
      text: JSON.stringify({
        type: "patch-start",
        data: {
          s: [
            {
              type: "error",
              message: "Something went wrong. Please try again later.",
              subType: "temporarily-unavailable",
              isRetryable: false,
            },
          ],
        },
        version: 1,
      }),
    }));

    const result = await executor.execute({
      model: "notion-ai",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: COOKIE_WITH_SPACE },
      signal: null,
    });
    // Nested temporarily-unavailable is treated as retryable → may land as 503 after retry.
    expect([502, 503]).toContain(result.response.status);
    const errBody = await result.response.json();
    expect(errBody.error.message).toMatch(/temporarily-unavailable|went wrong/i);
    expect(/No response from Notion AI/i.test(errBody.error.message)).toBe(false);
  });
});

describe("parseNotionInferenceStream", () => {
  it("returns empty string for empty input", () => {
    expect(parseNotionInferenceStream("")).toBe("");
  });

  it("keeps only the last non-empty cumulative frame (snapshot semantics)", () => {
    const ndjson = [
      JSON.stringify({ value: [["H"]] }),
      JSON.stringify({ value: [["He"]] }),
      JSON.stringify({ value: [["Hello world"]] }),
    ].join("\n");
    expect(parseNotionInferenceStream(ndjson)).toBe("Hello world");
  });

  it("skips unparseable lines without throwing", () => {
    const ndjson = ["not json", JSON.stringify({ value: [["ok"]] }), ""].join("\n");
    expect(parseNotionInferenceStream(ndjson)).toBe("ok");
  });

  it("prefers record-map agent-inference over empty patches and strips lang tags", () => {
    const ndjson = [
      JSON.stringify({ type: "patch-start", data: { s: [] } }),
      JSON.stringify({
        type: "record-map",
        recordMap: {
          thread_message: {
            m1: {
              value: {
                value: {
                  step: {
                    type: "agent-inference",
                    value: [{ type: "text", content: '<lang primary="en-US"/>final' }],
                  },
                },
              },
            },
          },
        },
      }),
    ].join("\n");
    expect(parseNotionInferenceStream(ndjson)).toBe("final");
  });

  it("extracts text from patch value/- append ops", () => {
    const ndjson = JSON.stringify({
      type: "patch",
      v: [{ o: "a", p: "/s/2/value/-", v: { type: "text", content: "from patch" } }],
    });
    expect(parseNotionInferenceStream(ndjson)).toBe("from patch");
  });
});

describe("buildNotionTranscript", () => {
  it("maps roles to Notion transcript entry types (config+context+user+agent)", () => {
    const transcript = buildNotionTranscript(
      [
        { role: "system", content: "be nice" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      { spaceId: "s1", userId: "u1" }
    );
    expect(transcript.map((t) => t.type)).toEqual(["config", "context", "user", "agent-inference"]);
    const ctx = transcript[1].value;
    expect(ctx.instructions).toBe("be nice");
    expect(ctx.spaceId).toBe("s1");
    expect(transcript[2].value).toEqual([["hi"]]);
    expect(transcript[3].value).toEqual([{ type: "text", content: "hello" }]);
    expect(transcript.every((t) => typeof t.id === "string" && t.id.length > 0)).toBe(true);
  });

  it("drops messages with empty content but keeps config+context", () => {
    const transcript = buildNotionTranscript([
      { role: "user", content: "" },
      { role: "user", content: "keep me" },
    ]);
    expect(transcript.length).toBe(3); // config + context + user
    expect(transcript[2].type).toBe("user");
  });

  it("accepts OpenAI content-parts arrays for system + user (agent clients)", () => {
    const transcript = buildNotionTranscript(
      [
        {
          role: "system",
          content: [
            { type: "text", text: "[VP-JB] follow tools" },
            { type: "text", text: "second system part" },
          ],
        },
        {
          role: "user",
          content: [{ type: "text", text: "find icon skill" }],
        },
      ],
      { spaceId: "s1" }
    );
    expect(transcript.map((t) => t.type)).toEqual(["config", "context", "user"]);
    const ctx = transcript[1].value;
    expect(String(ctx.instructions)).toMatch(/\[VP-JB\] follow tools/);
    expect(String(ctx.instructions)).toMatch(/second system part/);
    expect(transcript[2].value).toEqual([["find icon skill"]]);
  });

  it("accepts bare string parts inside content arrays", () => {
    const transcript = buildNotionTranscript([
      {
        role: "user",
        content: ["hello", "world"],
      },
    ]);
    expect(transcript[2].type).toBe("user");
    expect(transcript[2].value).toEqual([["hello\nworld"]]);
  });

  it("puts model food-codename on config when provided", () => {
    const transcript = buildNotionTranscript([{ role: "user", content: "hi" }], {
      notionModel: "acai-budino-high",
    });
    expect(transcript[0].value.model).toBe("acai-budino-high");
  });
});

describe("estimateNotionUsage", () => {
  it("scales with prompt and completion length (not a constant 2000)", () => {
    const short = estimateNotionUsage([{ role: "user", content: "hi" }], "PONG");
    const long = estimateNotionUsage([{ role: "user", content: "a".repeat(400) }], "b".repeat(400));
    expect(short.estimated).toBe(true);
    expect(short.prompt_tokens).toBeGreaterThanOrEqual(1);
    expect(short.completion_tokens).toBeGreaterThanOrEqual(1);
    expect(short.total_tokens).toBe(short.prompt_tokens + short.completion_tokens);
    expect(long.prompt_tokens).toBeGreaterThan(short.prompt_tokens);
    expect(long.completion_tokens).toBeGreaterThan(short.completion_tokens);
    // Never hardcode the USAGE_TOKEN_BUFFER default.
    expect(short.total_tokens).not.toBe(2000);
  });
});

describe("Notion upstream error extraction", () => {
  it("parses temporarily-unavailable NDJSON/JSON errors", () => {
    const err = extractNotionUpstreamError(
      JSON.stringify({
        id: "e141a6fd-79fa-4bec-9a19-ac41e9728ee6",
        type: "error",
        message: "Something went wrong. Please try again later.",
        subType: "temporarily-unavailable",
        isRetryable: false,
      })
    );
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/went wrong/i);
    expect(err.subType).toBe("temporarily-unavailable");
    expect(err.isRetryable).toBe(true); // subtype forces retryable
  });
});

describe("Notion custom agent + workflow id", () => {
  it("normalizes agent URL and dashless hex to UUID", () => {
    expect(
      normalizeNotionWorkflowId(
        "https://app.notion.com/agent/3a3fa5616e71804098510092923e14f9?wfv=chat"
      )
    ).toBe("3a3fa561-6e71-8040-9851-0092923e14f9");
    expect(normalizeNotionWorkflowId("3a3fa561-6e71-8040-9851-0092923e14f9")).toBe(
      "3a3fa561-6e71-8040-9851-0092923e14f9"
    );
  });

  it("reads workflow_id from cookie string", () => {
    const cookie =
      "token_v2=abc; space_id=space-1; workflow_id=3a3fa561-6e71-8040-9851-0092923e14f9";
    const agent = resolveNotionAgentOptions({ apiKey: cookie }, cookie);
    expect(agent.workflowId).toBe("3a3fa561-6e71-8040-9851-0092923e14f9");
  });

  it("buildNotionTranscript sets custom agent flags when workflowId present", () => {
    const transcript = buildNotionTranscript([{ role: "user", content: "hi" }], {
      spaceId: "space-1",
      userId: "user-1",
      agent: { workflowId: "3a3fa561-6e71-8040-9851-0092923e14f9" },
    });
    const config = transcript.find((t) => t.type === "config").value;
    const context = transcript.find((t) => t.type === "context").value;
    expect(config.isCustomAgent).toBe(true);
    expect(config.useCustomAgentDraft).toBe(true);
    expect(config.workflowId).toBe("3a3fa561-6e71-8040-9851-0092923e14f9");
    expect(context.surface).toBe("custom_agent");
    expect(context.workflowId).toBe("3a3fa561-6e71-8040-9851-0092923e14f9");
  });

  it("default AI transcript is not a custom agent", () => {
    const transcript = buildNotionTranscript([{ role: "user", content: "hi" }], {
      spaceId: "space-1",
      notionModel: "acai-budino-high",
    });
    const config = transcript.find((t) => t.type === "config").value;
    const context = transcript.find((t) => t.type === "context").value;
    expect(config.isCustomAgent).toBe(false);
    expect(context.surface).toBe("ai_module");
    expect(config.model).toBe("acai-budino-high");
  });
});

describe("resolveNotionWebCookie", () => {
  it("normalizes a bare token to token_v2=...", () => {
    expect(normalizeNotionCookieInput("abc")).toBe("token_v2=abc");
  });

  it("leaves an already-prefixed cookie untouched", () => {
    expect(normalizeNotionCookieInput("token_v2=abc")).toBe("token_v2=abc");
  });

  it("prefers apiKey over providerSpecificData", () => {
    const cookie = resolveNotionWebCookie({
      apiKey: "token_v2=direct",
      providerSpecificData: { token_v2: "ignored" },
    });
    expect(cookie).toBe("token_v2=direct");
  });

  it("assembles a cookie from structured providerSpecificData fields", () => {
    const cookie = resolveNotionWebCookie({
      providerSpecificData: {
        token_v2: "abc",
        space_id: "space-1",
        notion_browser_id: "browser-1",
      },
    });
    expect(cookie).toBe("token_v2=abc; space_id=space-1; notion_browser_id=browser-1");
  });

  it("returns empty string when no credential is present", () => {
    expect(resolveNotionWebCookie({})).toBe("");
  });
});

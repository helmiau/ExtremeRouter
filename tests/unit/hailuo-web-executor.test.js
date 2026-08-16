import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HailuoWebExecutor,
  pyQuote,
  getBodyToYy,
  generateYyHeader,
  buildHailuoPathAndQuery,
  foldHailuoMessages,
  extractHailuoMessageDelta,
  parseHailuoLine,
  extractHailuoMessageResultContent,
} from "../../open-sse/executors/hailuo-web.js";

const originalFetch = global.fetch;

describe("HailuoWebExecutor", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("can be instantiated", () => {
    const executor = new HailuoWebExecutor();
    expect(executor).toBeTruthy();
  });

  it("pyQuote percent-encodes exactly like Python's quote(s, safe='')", () => {
    const path = "/v4/api/chat/msg?device_platform=web&biz_id=2&app_id=3001";
    expect(pyQuote(path)).toBe(
      "%2Fv4%2Fapi%2Fchat%2Fmsg%3Fdevice_platform%3Dweb%26biz_id%3D2%26app_id%3D3001"
    );
    // Unreserved chars (letters, digits, _.-~) pass through untouched.
    expect(pyQuote("abcXYZ019_.-~")).toBe("abcXYZ019_.-~");
  });

  it("getBodyToYy matches the independently-computed MD5 chain", () => {
    const bodyToYy = getBodyToYy("1", "hello world", "0");
    expect(bodyToYy).toBe(
      "c4ca4238a0b923820dcc509a6f75849b" +
        "5eb63bbbe01eeed093cb22bb8f5acdc3" +
        "cfcd208495d565ef66e7dff9f98764da" +
        "d41d8cd98f00b204e9800998ecf8427e"
    );
  });

  it("getBodyToYy normalizes CRLF/CR/LF in msgContent before hashing", () => {
    const withCrlf = getBodyToYy("1", "hello\r\nworld", "0");
    const withLf = getBodyToYy("1", "helloworld", "0");
    expect(withCrlf).toBe(withLf);
  });

  it("generateYyHeader matches the independently-computed signature", () => {
    const path = "/v4/api/chat/msg?device_platform=web&biz_id=2&app_id=3001";
    const bodyToYy = getBodyToYy("1", "hello world", "0");
    const yy = generateYyHeader(path, bodyToYy, 1700000000000);
    expect(yy).toBe("6893d64988ecf45b1de1808b91ae855b");
  });

  it("builds a stable path_and_query with derived device_id/uuid when none is supplied", () => {
    const a = buildHailuoPathAndQuery("token-abc", undefined, 1700000000000);
    const b = buildHailuoPathAndQuery("token-abc", undefined, 1700000000000);
    expect(a).toBe(b);

    const params = new URL(`https://x${a}`).searchParams;
    expect(params.get("device_platform")).toBe("web");
    expect(params.get("uuid")?.length).toBe(32);
    expect(params.get("device_id")?.length).toBe(32);
  });

  it("honors user-supplied device_id/uuid over the derived fallback", () => {
    const path = buildHailuoPathAndQuery(
      "token-abc",
      { device_id: "real-device", uuid: "real-uuid" },
      1700000000000
    );
    const params = new URL(`https://x${path}`).searchParams;
    expect(params.get("device_id")).toBe("real-device");
    expect(params.get("uuid")).toBe("real-uuid");
  });

  it("folds text-only OpenAI history into a single msgContent block", () => {
    const folded = foldHailuoMessages([
      { role: "system", content: "Be nice." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
      { role: "user", content: "how are you?" },
    ]);
    expect(folded).toBe("System: Be nice.\n\nUser: hi\n\nAssistant: hello!\n\nUser: how are you?");
  });

  it("throws on tool-call content it cannot faithfully forward", () => {
    expect(() => foldHailuoMessages([{ role: "assistant", content: "", tool_calls: [{}] }])).toThrow();
    expect(() => foldHailuoMessages([{ role: "tool", content: "result" }])).toThrow();
  });

  it("diffs cumulative message_result content into deltas", () => {
    const state = { emittedLen: 0 };
    expect(extractHailuoMessageDelta("Hel", state)).toBe("Hel");
    expect(extractHailuoMessageDelta("Hello", state)).toBe("lo");
    expect(extractHailuoMessageDelta("Hello", state)).toBe("");
  });

  it("parses event:/data: SSE lines and swallows malformed data without throwing", () => {
    expect(parseHailuoLine("event: message_result")).toEqual({ type: "event", value: "message_result" });
    expect(parseHailuoLine('data: {"data":{"messageResult":{"content":"hi"}}}')).toEqual({
      type: "data",
      value: { data: { messageResult: { content: "hi" } } },
    });
    expect(parseHailuoLine("data: {not json")).toBeNull();
    expect(parseHailuoLine("not a recognized line")).toBeNull();
  });

  it("extracts message_result.content from a send_result/message_result event payload", () => {
    expect(
      extractHailuoMessageResultContent({ data: { messageResult: { content: "partial answer" } } })
    ).toBe("partial answer");
    expect(extractHailuoMessageResultContent({ data: { sendResult: { chatID: "1" } } })).toBeNull();
  });

  it("returns a 401 credential error when the token is missing", async () => {
    const executor = new HailuoWebExecutor();
    const result = await executor.execute({
      model: "hailuo",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "" },
    });
    const text = await result.response.text();
    expect(result.response.status).toBe(401);
    expect(text).toMatch(/token/i);
  });

  it("maps an upstream 401 (invalid/expired token) as a terminal error", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid token" }), { status: 401 })
    );
    const executor = new HailuoWebExecutor();
    const result = await executor.execute({
      model: "hailuo",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "expired-token" },
    });
    expect(result.response.status).toBe(401);
  });

  it("maps an upstream 429 as a transient (retryable) error", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })
    );
    const executor = new HailuoWebExecutor();
    const result = await executor.execute({
      model: "hailuo",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "some-token" },
    });
    expect(result.response.status).toBe(429);
  });

  it("collects a non-streaming completion from send_result/message_result/close_chunk SSE events", async () => {
    const sse = [
      "event: send_result",
      'data: {"data":{"sendResult":{"chatID":"c1","chatTitle":"hi"}}}',
      "event: message_result",
      'data: {"data":{"messageResult":{"content":"Hel"}}}',
      "event: message_result",
      'data: {"data":{"messageResult":{"content":"Hello"}}}',
      "event: close_chunk",
      "",
    ].join("\n");

    global.fetch.mockResolvedValueOnce(new Response(sse, { status: 200 }));

    const executor = new HailuoWebExecutor();
    const result = await executor.execute({
      model: "hailuo",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "some-token" },
    });
    const json = await result.response.json();

    expect(result.response.status).toBe(200);
    expect(json.choices[0].message.content).toBe("Hello");
    expect(new URL(result.url).pathname).toBe("/v4/api/chat/msg");
  });

  it("streams incremental deltas for a streaming request", async () => {
    const sse = [
      "event: message_result",
      'data: {"data":{"messageResult":{"content":"Hi"}}}',
      "event: message_result",
      'data: {"data":{"messageResult":{"content":"Hi there"}}}',
      "event: close_chunk",
      "",
    ].join("\n");

    global.fetch.mockResolvedValueOnce(new Response(sse, { status: 200 }));

    const executor = new HailuoWebExecutor();
    const result = await executor.execute({
      model: "hailuo",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "some-token" },
    });
    const text = await result.response.text();

    expect(text).toMatch(/"content":"Hi"/);
    expect(text).toMatch(/"content":" there"/);
    expect(text).toMatch(/data: \[DONE\]/);
  });
});

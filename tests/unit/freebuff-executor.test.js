import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// wreq-js is installed in this environment, so tlsFetch would hit the real
// network (and fail against a MITM'd TLS stack) instead of our fetch mock.
// Force the executor onto globalThis.fetch so the protocol is testable.
vi.mock("../../open-sse/utils/tlsClient.js", () => ({
  tlsFetch: (url, options = {}) => globalThis.fetch(url, options),
}));

const { default: FreeBuffExecutor } = await import("../../open-sse/executors/freebuff.js");

const executor = new FreeBuffExecutor();

function jsonResponse(body, status = 200) {
  const encoder = new TextEncoder();
  return {
    status,
    ok: status < 400,
    headers: { get: (k) => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    // Executor's non-stream path 502s on a null body — carry a real stream.
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify(body)));
        controller.close();
      },
    }),
  };
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    status: 200,
    ok: true,
    headers: { get: (k) => null },
    json: async () => ({}),
    text: async () => chunks.join(""),
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
  };
}

const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  delete globalThis.fetch;
  vi.clearAllMocks();
});

const CHAT_OK = { choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };

function routeFetch({ session = { status: "active", instanceId: "inst-abc123", expiresAt: new Date(Date.now() + 3600_000).toISOString() }, run = { runId: "run-xyz789" }, chat = jsonResponse(CHAT_OK, 200) }) {
  fetchMock.mockImplementation(async (url, opts = {}) => {
    if (url.endsWith("/api/v1/freebuff/session")) return jsonResponse(session, session.status === "active" ? 200 : 200);
    if (url.endsWith("/api/v1/agent-runs")) return jsonResponse(run, 200);
    if (url.endsWith("/api/v1/chat/completions")) return typeof chat === "function" ? chat(url, opts) : chat;
    return jsonResponse({ error: "unexpected" }, 500);
  });
}

const creds = (token = "tok-test-1") => ({ accessToken: token });

describe("FreeBuffExecutor protocol", () => {
  it("creates a session, starts a root run, and injects codebuff_metadata", async () => {
    routeFetch({});
    const res = await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [{ role: "user", content: "hi" }] }, stream: false, credentials: creds(), log });
    expect(res.response.status).toBe(200);

    // Session POST carries the x-freebuff-model header + CLI user agent.
    const sessionCall = fetchMock.mock.calls.find(([u]) => u.endsWith("/api/v1/freebuff/session"));
    expect(sessionCall[1].headers["x-freebuff-model"]).toBe("deepseek/deepseek-v4-flash");
    expect(sessionCall[1].headers.Authorization).toBe("Bearer tok-test-1");
    expect(sessionCall[1].headers["User-Agent"]).toBe("ai-sdk/openai-compatible/0.10.7/codebuff");

    // Root run: ancestorRunIds must be an EMPTY ARRAY (null 400s upstream);
    // carries the CLI user agent.
    const runCall = fetchMock.mock.calls.find(([u]) => u.endsWith("/api/v1/agent-runs"));
    const runBody = JSON.parse(runCall[1].body);
    expect(runBody).toEqual({ action: "START", agentId: "base2-free", ancestorRunIds: [] });
    expect(runCall[1].headers["User-Agent"]).toBe("ai-sdk/openai-compatible/0.10.7/codebuff");

    // Chat body carries the mandatory 4-field metadata envelope.
    const chatCall = fetchMock.mock.calls.find(([u]) => u.endsWith("/api/v1/chat/completions"));
    const chatBody = JSON.parse(chatCall[1].body);
    expect(chatBody.model).toBe("deepseek/deepseek-v4-flash");
    expect(chatBody.codebuff_metadata).toEqual({
      run_id: "run-xyz789",
      cost_mode: "free",
      client_id: expect.stringMatching(/^[0-9a-f]{13}$/),
      freebuff_instance_id: "inst-abc123",
    });

    // Chat carries the CLI-envelope x-freebuff-* headers (session binding).
    expect(chatCall[1].headers["x-freebuff-model"]).toBe("deepseek/deepseek-v4-flash");
    expect(chatCall[1].headers["x-freebuff-instance-id"]).toBe("inst-abc123");
    expect(chatCall[1].headers["User-Agent"]).toBe("ai-sdk/openai-compatible/0.10.7/codebuff");
  });

  it("reuses the connect-time session stored on the connection (no extra session POST)", async () => {
    routeFetch({});
    const connCreds = creds("tok-stored").accessToken && creds("tok-stored");
    connCreds.providerSpecificData = {
      instanceId: "inst-stored",
      sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    const res = await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [] }, stream: false, credentials: connCreds, log });
    expect(res.response.status).toBe(200);

    // No session POST — the stored session is reused; run + chat still fire.
    const sessionCalls = fetchMock.mock.calls.filter(([u]) => u.endsWith("/api/v1/freebuff/session"));
    expect(sessionCalls).toHaveLength(0);
    const chatCall = fetchMock.mock.calls.find(([u]) => u.endsWith("/api/v1/chat/completions"));
    expect(chatCall[1].headers["x-freebuff-instance-id"]).toBe("inst-stored");
  });

  it("reuses the session and root run on subsequent requests (one POST each)", async () => {
    routeFetch({});
    await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [] }, stream: false, credentials: creds("tok-reuse"), log });
    await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [] }, stream: false, credentials: creds("tok-reuse"), log });

    const sessionCalls = fetchMock.mock.calls.filter(([u]) => u.endsWith("/api/v1/freebuff/session"));
    const runCalls = fetchMock.mock.calls.filter(([u]) => u.endsWith("/api/v1/agent-runs"));
    expect(sessionCalls).toHaveLength(1);
    expect(runCalls).toHaveLength(1);
  });

  it("rotates the session when it expires (root run is re-created under the new session)", async () => {
    routeFetch({ session: { status: "active", instanceId: "inst-old", expiresAt: new Date(Date.now() - 1000).toISOString() } });
    await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [] }, stream: false, credentials: creds("tok-expire"), log });
    await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [] }, stream: false, credentials: creds("tok-expire"), log });
    // Expired at first call → re-created on second call, root run too.
    const sessionCalls = fetchMock.mock.calls.filter(([u]) => u.endsWith("/api/v1/freebuff/session"));
    const runCalls = fetchMock.mock.calls.filter(([u]) => u.endsWith("/api/v1/agent-runs"));
    expect(sessionCalls).toHaveLength(2);
    expect(runCalls).toHaveLength(2);
  });

  it("returns 503 Retry-After when the session is queued upstream", async () => {
    routeFetch({ session: { status: "queued", instanceId: "", expiresAt: "" } });
    const res = await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [] }, stream: false, credentials: creds("tok-queued"), log });
    expect(res.response.status).toBe(503);
    const data = await res.response.json();
    expect(data.error.code).toBe("queued");
  });

  it("maps upstream 403 free_mode_cli_required to a clear CLI-gate error (no auth cooldown)", async () => {
    fetchMock.mockImplementation(async (url, opts = {}) => {
      if (url.endsWith("/api/v1/freebuff/session")) return jsonResponse({ status: "active", instanceId: "inst-403", expiresAt: new Date(Date.now() + 3600_000).toISOString() }, 200);
      if (url.endsWith("/api/v1/agent-runs")) return jsonResponse({ runId: "run-403" }, 200);
      if (url.endsWith("/api/v1/chat/completions")) {
        return { status: 403, ok: false, headers: { get: () => null }, json: async () => ({}), text: async () => "{\"error\":\"Free mode is only available through the freebuff CLI (free_mode_cli_required)\"}", body: null };
      }
      return jsonResponse({}, 500);
    });

    const res = await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [] }, stream: false, credentials: creds("tok-403gate"), log });
    expect(res.response.status).toBe(403);
    const data = await res.response.json();
    expect(data.error.code).toBe("free_mode_cli_required");
    expect(data.error.message).toMatch(/restricted to the official CLI/);
    expect(data.error.message).not.toMatch(/invalid or expired/);

    // 403 is not an auth failure — the token is NOT put into cooldown.
    const res2 = await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [] }, stream: false, credentials: creds("tok-403gate"), log });
    expect(res2.response.status).toBe(403);
  });

  it("surfaces a 403 on session creation without claiming the token is invalid", async () => {
    fetchMock.mockImplementation(async (url) =>
      url.endsWith("/api/v1/freebuff/session") ? jsonResponse({ error: "free_mode_cli_required" }, 403) : jsonResponse({}, 500)
    );
    const res = await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [] }, stream: false, credentials: creds("tok-403session"), log });
    expect(res.response.status).toBe(403);
    const data = await res.response.json();
    expect(data.error.code).toBe("free_mode_cli_required");
    expect(data.error.message).not.toMatch(/invalid or expired/);
  });

  it("maps 401 to a re-login error and enters a per-token cooldown", async () => {
    fetchMock.mockImplementation(async (url) =>
      url.endsWith("/api/v1/freebuff/session") ? jsonResponse({ error: "unauthorized" }, 401) : jsonResponse({}, 500)
    );
    const res = await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [] }, stream: false, credentials: creds("tok-bad"), log });
    expect(res.response.status).toBe(401);
    expect((await res.response.json()).error.message).toMatch(/re-copy from freebuff\.llm\.pm/);

    // Second request within the 30-min cooldown is short-circuited.
    const res2 = await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [] }, stream: false, credentials: creds("tok-bad"), log });
    expect(res2.response.status).toBe(429);
  });

  it("steps a premium model down to Flash on 429 (official FALLBACK behavior)", async () => {
    const chatFn = vi.fn()
      .mockReturnValueOnce(jsonResponse({ error: "quota" }, 429))
      .mockReturnValueOnce(jsonResponse(CHAT_OK, 200));
    fetchMock.mockImplementation(async (url, opts = {}) => {
      if (url.endsWith("/api/v1/freebuff/session")) return jsonResponse({ status: "active", instanceId: "inst-step", expiresAt: new Date(Date.now() + 3600_000).toISOString() }, 200);
      if (url.endsWith("/api/v1/agent-runs")) return jsonResponse({ runId: "run-step" }, 200);
      if (url.endsWith("/api/v1/chat/completions")) return chatFn(url, opts);
      return jsonResponse({}, 500);
    });

    const res = await executor.execute({ model: "deepseek/deepseek-v4-pro", body: { messages: [] }, stream: false, credentials: creds("tok-premium"), log });
    expect(res.response.status).toBe(200);
    expect(chatFn).toHaveBeenCalledTimes(2);
    const secondChat = JSON.parse(chatFn.mock.calls[1][1].body);
    expect(secondChat.model).toBe("deepseek/deepseek-v4-flash");
  });

  it("passes non-premium 429 through with Retry-After", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url.endsWith("/api/v1/freebuff/session")) return jsonResponse({ status: "active", instanceId: "inst-429", expiresAt: new Date(Date.now() + 3600_000).toISOString() }, 200);
      if (url.endsWith("/api/v1/agent-runs")) return jsonResponse({ runId: "run-429" }, 200);
      if (url.endsWith("/api/v1/chat/completions")) {
        return { status: 429, ok: false, headers: { get: (k) => (k.toLowerCase() === "retry-after" ? "17" : null) }, json: async () => ({}), text: async () => "{}", body: null };
      }
      return jsonResponse({}, 500);
    });
    const res = await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [] }, stream: false, credentials: creds("tok-429"), log });
    expect(res.response.status).toBe(429);
  });

  it("forwards streaming SSE data lines and appends [DONE]", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url.endsWith("/api/v1/freebuff/session")) return jsonResponse({ status: "active", instanceId: "inst-sse", expiresAt: new Date(Date.now() + 3600_000).toISOString() }, 200);
      if (url.endsWith("/api/v1/agent-runs")) return jsonResponse({ runId: "run-sse" }, 200);
      if (url.endsWith("/api/v1/chat/completions")) {
        return sseResponse([
          'data: {"choices":[{"index":0,"delta":{"content":"hel"}}]}\n\n',
          ': keep-alive comment\n\n',
          'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
        ]);
      }
      return jsonResponse({}, 500);
    });

    const res = await executor.execute({ model: "deepseek/deepseek-v4-flash", body: { messages: [] }, stream: true, credentials: creds("tok-sse"), log });
    expect(res.response.status).toBe(200);
    const text = await res.response.text();
    expect(text).toContain('data: {"choices":[{"index":0,"delta":{"content":"hel"}}]}');
    expect(text).toContain('data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}');
    // Comments/heartbeats are stripped; [DONE] is preserved + appended.
    expect(text).not.toContain("keep-alive");
    expect(text).toContain("data: [DONE]");
  });
});

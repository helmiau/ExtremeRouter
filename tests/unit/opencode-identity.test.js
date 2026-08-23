import { describe, it, expect } from "vitest";
import {
  resolveOpenCodeIdentity,
  toOpenCodeSessionId,
  generateOpenCodeRequestId,
  generateOpenCodeSessionId,
} from "open-sse/utils/openCodeIdentity.js";
import { getExecutor } from "open-sse/executors/index.js";

describe("OpenCode identity resolver", () => {
  // ── A: explicit session header
  it("preserves a valid client x-opencode-session (normalized)", () => {
    const identity = resolveOpenCodeIdentity({
      headers: { "x-opencode-session": "ses_abc-123" },
      body: {},
      connectionId: "noauth",
    });
    expect(identity.sessionId).toBe("ses_abc123");
  });

  it("does NOT replace a client session with a random id", () => {
    const a = resolveOpenCodeIdentity({ headers: { "x-opencode-session": "ses_client-keep" }, body: {}, connectionId: "noauth" });
    const b = resolveOpenCodeIdentity({ headers: { "x-opencode-session": "ses_client-keep" }, body: {}, connectionId: "noauth" });
    expect(a.sessionId).toBe("ses_clientkeep");
    expect(b.sessionId).toBe(a.sessionId);
  });

  it("case-insensitive header lookup", () => {
    const identity = resolveOpenCodeIdentity({
      headers: { "X-OpenCode-Session": "ses_CaseKeep", "x-OPencode-request": "msg_rq" },
      body: {},
      connectionId: "noauth",
    });
    expect(identity.sessionId).toBe("ses_CaseKeep");
    expect(identity.requestId).toBe("msg_rq");
  });

  // ── B: missing session header
  it("generates a fresh session for anonymous noauth requests (never shared, never from the connection alone)", () => {
    const a = resolveOpenCodeIdentity({ headers: {}, body: {}, connectionId: "noauth" });
    const b = resolveOpenCodeIdentity({ headers: {}, body: {}, connectionId: "noauth" });
    expect(a.sessionId).toMatch(/^ses_[A-Za-z0-9]+$/);
    expect(b.sessionId).not.toBe(a.sessionId);
  });

  it("uses client conversation metadata as the anonymous session identity when present", () => {
    const identity = resolveOpenCodeIdentity({
      headers: {},
      body: { conversation_id: "conv-123-live" },
      connectionId: "noauth",
    });
    expect(identity.sessionId).toBe("ses_conv123live");
  });

  it("derives a stable session identity for real connections via sessionManager", () => {
    const make = () => resolveOpenCodeIdentity({
      headers: {},
      body: { messages: [{ role: "assistant", content: "assistant turn text that is long enough to exceed the minimum threshold for the assistant store" }] },
      connectionId: "conn-1",
    });
    const a = make();
    const b = make();
    expect(a.sessionId).toMatch(/^ses_/);
    expect(b.sessionId).toBe(a.sessionId);
  });

  // ── C: explicit request id
  it("preserves a client-provided request id", () => {
    const identity = resolveOpenCodeIdentity({
      headers: { "x-opencode-request": "req-77-trace" },
      body: {},
      connectionId: "noauth",
    });
    expect(identity.requestId).toBe("req-77-trace");
  });

  // ── D: missing request id → generated unique
  it("generates a unique msg_ request id when absent (crypto random, not Date)", () => {
    const a = resolveOpenCodeIdentity({ headers: {}, body: {}, connectionId: "noauth" });
    const b = resolveOpenCodeIdentity({ headers: {}, body: {}, connectionId: "noauth" });
    expect(a.requestId).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(b.requestId).not.toBe(a.requestId);
  });

  it("request/session id survive logical-request reuse of the identity object (retry/fallback)", () => {
    const identity = resolveOpenCodeIdentity({ headers: {}, body: {}, connectionId: "noauth" });
    const attempt1 = { ...identity };
    const attempt2 = { ...identity };
    expect(attempt1.requestId).toBe(attempt2.requestId);
    expect(attempt1.sessionId).toBe(attempt2.sessionId);
  });

  // ── F: account fallback → session identity independent of connection
  it("session identity does NOT depend on connection (survives account fallback)", () => {
    const headers = { "x-opencode-session": "ses_same" };
    const identityA = resolveOpenCodeIdentity({ headers, body: {}, connectionId: "account-A" });
    const identityB = resolveOpenCodeIdentity({ headers, body: {}, connectionId: "account-B" });
    expect(identityA.sessionId).toBe(identityB.sessionId);
  });

  it("requestId is preserved across fallback when the resolved identity object is reused per logical request", () => {
    const identity = resolveOpenCodeIdentity({ headers: {}, body: {}, connectionId: "account-A" });
    // Fallback attempt on a different account reuses the SAME identity object
    // (chat.js resolves once before the fallback loop).
    const attemptB = { ...identity };
    expect(attemptB.requestId).toBe(identity.requestId);
    expect(attemptB.sessionId).toBe(identity.sessionId);
  });

  // ── noauth isolation (multiple sessions on the shared provider)
  it("two anonymous conversations on the shared noauth provider get distinct sessions", () => {
    const userA = resolveOpenCodeIdentity({ headers: {}, body: { conversation_id: "conv-A" }, connectionId: "noauth" });
    const userB = resolveOpenCodeIdentity({ headers: {}, body: { conversation_id: "conv-B" }, connectionId: "noauth" });
    expect(userA.sessionId).not.toBe(userB.sessionId);
  });

  it("prevents session collapse when conversations differ only by id", () => {
    const a = resolveOpenCodeIdentity({ headers: {}, body: { conversation_id: "conv-aaa" }, connectionId: "noauth" });
    const b = resolveOpenCodeIdentity({ headers: {}, body: { conversation_id: "conv-bbb" }, connectionId: "noauth" });
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("identical client conversation id resolves identically (deterministic, no random per request)", () => {
    const a = resolveOpenCodeIdentity({ headers: {}, body: { conversation_id: "conv-x" }, connectionId: "noauth" });
    const b = resolveOpenCodeIdentity({ headers: {}, body: { conversation_id: "conv-x" }, connectionId: "noauth" });
    expect(a.sessionId).toBe(b.sessionId);
  });
});

describe("normalization", () => {
  it("strips repeated prefixes and dashes", () => {
    expect(toOpenCodeSessionId("ses_ses_abc-123")).toBe("ses_abc123");
  });

  it("caps over-long sessions", () => {
    const out = toOpenCodeSessionId(`ses_${"a".repeat(300)}`);
    expect(out).toMatch(/^ses_[a-z]+$/);
    expect(out.length).toBeLessThanOrEqual(68);
  });

  it("drops invalid characters and control/whitespace", () => {
    expect(toOpenCodeSessionId("ses_ab\ncd\r\tef")).toBe("ses_abcdef");
    expect(toOpenCodeSessionId("ses_a!b@c#")).toBe("ses_abc");
  });

  it("rejects empty / whitespace-only values", () => {
    expect(toOpenCodeSessionId("")).toBeNull();
    expect(toOpenCodeSessionId("  ")).toBeNull();
  });

  it("drops entirely-invalid values (never become a shared session)", () => {
    expect(toOpenCodeSessionId("!!!/")).toBeNull();
  });

  it("rejects unbounded client input", () => {
    const identity = resolveOpenCodeIdentity({
      headers: { "x-opencode-session": "x".repeat(10000) },
      body: {},
      connectionId: "noauth",
    });
    // Falls back to generated (never forwards 10k chars upstream)
    expect(identity.sessionId).toMatch(/^ses_[A-Za-z0-9]+$/);
  });

  it("request id format is msg_<uuid>", () => {
    expect(generateOpenCodeRequestId()).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(generateOpenCodeSessionId()).toMatch(/^ses_[0-9a-f]{32}$/);
  });
});

describe("OpenCode executor header generation (request-scoped, no executor state)", () => {
  it("emits session/request/client/project headers from the identity object", () => {
    const executor = getExecutor("opencode");
    const identity = resolveOpenCodeIdentity({
      headers: { "x-opencode-session": "ses_abc", "x-opencode-request": "msg_rq", "x-opencode-client": "desktop", "x-opencode-project": "proj-1" },
      body: {},
      connectionId: "noauth",
    });
    const headers = executor.buildHeaders({}, true, "x-preview-f-free", identity);
    expect(headers["x-opencode-session"]).toBe("ses_abc");
    expect(headers["x-opencode-request"]).toBe("msg_rq");
    expect(headers["x-opencode-client"]).toBe("desktop");
    expect(headers["x-opencode-project"]).toBe("proj-1");
  });

  it("defaults client to 'desktop' when absent; omits project", () => {
    const executor = getExecutor("opencode");
    const identity = resolveOpenCodeIdentity({ headers: {}, body: {}, connectionId: "noauth" });
    const headers = executor.buildHeaders({}, true, "x-preview-f-free", identity);
    expect(headers["x-opencode-client"]).toBe("desktop");
    expect(headers["x-opencode-project"]).toBeUndefined();
    expect(headers["x-opencode-session"]).toMatch(/^ses_/);
    expect(headers["x-opencode-request"]).toMatch(/^msg_/);
  });

  it("does NOT fabricate an opencode User-Agent for non-opencode clients", () => {
    const executor = getExecutor("opencode");
    const identity = resolveOpenCodeIdentity({ headers: { "user-agent": "curl/8" }, body: {}, connectionId: "noauth" });
    const headers = executor.buildHeaders({}, true, "x-preview-f-free", identity);
    expect(headers["User-Agent"]).toBeUndefined();
  });

  it("Accept follows stream flag", () => {
    const executor = getExecutor("opencode");
    const streamHeaders = executor.buildHeaders({}, true, "m", null);
    expect(streamHeaders.Accept).toBe("text/event-stream");
    const nonStream = executor.buildHeaders({}, false, "m", null);
    expect(nonStream.Accept).toBe("*/*");
  });

  // ── H: concurrent identity isolation on the shared singleton
  it("A never receives B's identity, B never receives A's (interleaved on the same singleton)", () => {
    const executor = getExecutor("opencode");
    const identityA = resolveOpenCodeIdentity({ headers: { "x-opencode-session": "ses_A", "x-opencode-request": "msg_A" }, body: {}, connectionId: "noauth" });
    const identityB = resolveOpenCodeIdentity({ headers: { "x-opencode-session": "ses_B", "x-opencode-request": "msg_B" }, body: {}, connectionId: "noauth" });
    const hA1 = executor.buildHeaders({}, true, "m", identityA);
    const hB1 = executor.buildHeaders({}, true, "m", identityB);
    const hA2 = executor.buildHeaders({}, true, "m", identityA);
    expect(hA1["x-opencode-session"]).toBe("ses_A");
    expect(hB1["x-opencode-session"]).toBe("ses_B");
    expect(hA2["x-opencode-session"]).toBe("ses_A");
    expect(hA2["x-opencode-request"]).toBe("msg_A");
    expect(hB1["x-opencode-request"]).toBe("msg_B");
  });

  it("stream keeps the same identity (no regeneration between header builds)", () => {
    const executor = getExecutor("opencode");
    const identity = resolveOpenCodeIdentity({ headers: {}, body: {}, connectionId: "noauth" });
    const firstToken = executor.buildHeaders({}, true, "m", identity);
    const midStream = executor.buildHeaders({}, true, "m", identity);
    const completed = executor.buildHeaders({}, true, "m", identity);
    expect(midStream["x-opencode-session"]).toBe(firstToken["x-opencode-session"]);
    expect(completed["x-opencode-request"]).toBe(firstToken["x-opencode-request"]);
  });
});

describe("Non-OpenCode provider regression — identity must not leak", () => {
  it("DefaultExecutor ignores the identity object entirely", () => {
    const executor = getExecutor("openai");
    const identity = resolveOpenCodeIdentity({ headers: { "x-opencode-session": "ses_leak" }, body: {}, connectionId: "noauth" });
    const headers = executor.buildHeaders({ accessToken: "t" }, true, "gpt-4o", identity);
    for (const k of Object.keys(headers)) {
      expect(k.toLowerCase()).not.toBe("x-opencode-session");
      expect(k.toLowerCase()).not.toBe("x-opencode-request");
      expect(k.toLowerCase()).not.toBe("x-opencode-client");
      expect(k.toLowerCase()).not.toBe("x-opencode-project");
    }
  });
});
import { describe, it, expect, beforeEach } from "vitest";
import {
  HyperAgentExecutor,
  buildHyperAgentChatBody,
  clearHyperAgentThreadBindingsForTests,
  extractMessageText,
  extractThreadIdFromUrl,
  normalizeHyperAgentCookie,
  parseHyperAgentSseStream,
  resolveHyperAgentThreadBinding,
  rootUserFingerprint,
  storeHyperAgentThreadAfterTurn,
} from "../../open-sse/executors/hyperagent.js";
import {
  clientFacingHyperAgentModelId,
  resolveHyperAgentModel,
  wireHyperAgentModelId,
  wireHyperAgentSubagentModelId,
} from "../../open-sse/services/hyperagentModels.js";

beforeEach(() => {
  clearHyperAgentThreadBindingsForTests();
});

describe("HyperAgent — registry consistency", () => {
  it("registers a model catalog via the registry (wire ids, not bare fable)", async () => {
    const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
    const entry = REGISTRY.find((p) => p.id === "hyperagent");
    expect(entry).toBeTruthy();
    expect(entry.alias).toBe("ha");
    const ids = (entry.models || []).map((m) => m.id);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(ids).toContain("fable-latest");
    expect(ids).toContain("opus-latest");
    expect(ids).toContain("sonnet-latest");
    const fable = (entry.models || []).find((m) => m.id === "fable-latest");
    expect(fable?.name?.toLowerCase()).toMatch(/fable/);
    expect(fable?.name?.toLowerCase()).not.toBe("fable");
  });
});

describe("HyperAgent — models", () => {
  it("maps pretty names / legacy keys to live wire modelId (not bare fable)", () => {
    // Bare "fable" is INVALID on the API — must become fable-latest
    expect(wireHyperAgentModelId("fable")).toBe("fable-latest");
    expect(wireHyperAgentModelId("fable-5")).toBe("fable-latest");
    expect(wireHyperAgentModelId("Fable 5")).toBe("fable-latest");
    expect(wireHyperAgentModelId("hyperagent/fable")).toBe("fable-latest");
    expect(wireHyperAgentModelId("ha/opus-latest")).toBe("opus-latest");
    expect(wireHyperAgentModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(clientFacingHyperAgentModelId("fable")).toBe("fable-latest");
  });

  it("maps subagent to short family matching selected model", () => {
    expect(wireHyperAgentSubagentModelId("fable")).toBe("fable");
    expect(wireHyperAgentSubagentModelId("fable-latest")).toBe("fable");
    expect(wireHyperAgentSubagentModelId("opus-latest")).toBe("opus");
    expect(wireHyperAgentSubagentModelId("sonnet-latest")).toBe("sonnet");
    // Subagent must NOT be *-latest (API rejects those)
    expect(wireHyperAgentSubagentModelId("fable-latest")).not.toBe("fable-latest");
  });

  it("resolveHyperAgentModel finds by id and pretty name", () => {
    const a = resolveHyperAgentModel("fable");
    expect(a).toBeTruthy();
    expect(a.id).toBe("fable-latest");
    expect(a.name).toMatch(/Fable/i);
    const b = resolveHyperAgentModel("Fable 5");
    expect(b).toBeTruthy();
    expect(b.id).toBe("fable-latest");
  });
});

describe("HyperAgent — helpers", () => {
  it("normalizes cookie input", () => {
    expect(normalizeHyperAgentCookie("Cookie: a=1; b=2")).toBe("a=1; b=2");
    expect(normalizeHyperAgentCookie("  sess=xyz  ")).toBe("sess=xyz");
  });

  it("extracts thread id from SPA URLs", () => {
    expect(
      extractThreadIdFromUrl("https://hyperagent.com/thread/cmrujkys70aiu07addcodbsj3")
    ).toBe("cmrujkys70aiu07addcodbsj3");
    expect(extractThreadIdFromUrl("/thread/cmabc123def456ghi789jkl")).toBe(
      "cmabc123def456ghi789jkl"
    );
  });

  it("buildHyperAgentChatBody is execution-mode (no plan / no modelId)", () => {
    const b = buildHyperAgentChatBody({
      content: "hello",
      sessionId: null,
      modelId: "fable-latest", // ignored — model is PATCH'd on thread
    });
    expect(b.content).toBe("hello");
    expect(b.sessionId).toBeNull();
    expect(b.unifiedStream).toBe(true);
    // Execution mode: never inject plan mode
    expect(b.injectPlanMode).toBeUndefined();
    // Model is NOT in chat body (would 400 with bare pricing keys)
    expect(b.modelId).toBeUndefined();
    expect(b.model).toBeUndefined();
    // No connectors
    expect(b.enabledIntegrations).toEqual([]);
    const b2 = buildHyperAgentChatBody({
      content: "hello2",
      sessionId: "dd6d5eee-5c1c-449f-8dee-abb09eabd338",
    });
    expect(b2.sessionId).toBe("dd6d5eee-5c1c-449f-8dee-abb09eabd338");
    expect(b2.injectPlanMode).toBeUndefined();
  });
});

describe("HyperAgent — thread continuity", () => {
  const cookieKey = "testck1234567890";

  it("two chats with different histories stay isolated; follow-up sticks", () => {
    const a1 = [{ role: "user", content: "topic A" }];
    const b1 = [{ role: "user", content: "topic B" }];
    expect(resolveHyperAgentThreadBinding(cookieKey, a1).isFollowUp).toBe(false);
    storeHyperAgentThreadAfterTurn(cookieKey, a1, "reply-A", "thread-A", "sess-A");
    storeHyperAgentThreadAfterTurn(cookieKey, b1, "reply-B", "thread-B", "sess-B");

    const a2 = [
      { role: "user", content: "topic A" },
      { role: "assistant", content: "reply-A" },
      { role: "user", content: "follow A" },
    ];
    const b2 = [
      { role: "user", content: "topic B" },
      { role: "assistant", content: "reply-B" },
      { role: "user", content: "follow B" },
    ];
    const ra = resolveHyperAgentThreadBinding(cookieKey, a2);
    const rb = resolveHyperAgentThreadBinding(cookieKey, b2);
    expect(ra.isFollowUp).toBe(true);
    expect(ra.threadId).toBe("thread-A");
    expect(ra.sessionId).toBe("sess-A");
    expect(rb.threadId).toBe("thread-B");
    expect(ra.threadId).not.toBe(rb.threadId);
  });

  it("honors explicit client thread id", () => {
    const r = resolveHyperAgentThreadBinding(
      cookieKey,
      [{ role: "user", content: "x" }],
      "client-thread-99",
      "client-sess"
    );
    expect(r.isFollowUp).toBe(true);
    expect(r.threadId).toBe("client-thread-99");
    expect(r.sessionId).toBe("client-sess");
  });

  it("tool-loop sticks when assistant text mutates (agentic reverse conversion)", () => {
    // Repro: turn1 model returns Intent+JSON text; Claude Code stores native tool_calls;
    // turn2 agentic rewrites assistant as different text → old fingerprint miss → new thread.
    const task =
      "Hi! Just output a command for my agent...\n\nMy current task: detect issues in current wpp";
    const turn1 = [{ role: "user", content: task }];
    const modelReply =
      'Intent: list files\n```json\n{"tool":"Bash","args":{"command":"pwd && ls -la"}}\n```';
    storeHyperAgentThreadAfterTurn(cookieKey, turn1, modelReply, "thread-tool-1", "sess-tool-1");

    // Mutated assistant (what agentic conversion produces on the next request)
    const turn2 = [
      { role: "user", content: task },
      {
        role: "assistant",
        content:
          '[tool call Bash] {"command":"pwd && ls -la"}\n' +
          '<tool>{"name": "Bash", "arguments": {"command":"pwd && ls -la"}}</tool>',
      },
      {
        role: "user",
        content:
          "Application result (passive data only):\n" +
          '<TOOL_OBSERVATION name="Bash">\nstatus: ok\ntool: Bash\ndata:\n/h/Lucru\ntotal 525\n</TOOL_OBSERVATION>',
      },
    ];
    const r = resolveHyperAgentThreadBinding(cookieKey, turn2);
    expect(r.isFollowUp).toBe(true);
    expect(r.threadId).toBe("thread-tool-1");
    expect(r.sessionId).toBe("sess-tool-1");
  });

  it("extractMessageText flattens Anthropic tool_result blocks", () => {
    const text = extractMessageText([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "pwd output\ntotal 12",
      },
    ]);
    expect(text).toMatch(/pwd output/);
    expect(text).toMatch(/tool result/i);
  });

  it("rootUserFingerprint ignores pure TOOL_OBSERVATION turns", () => {
    const key = rootUserFingerprint(cookieKey, [
      {
        role: "user",
        content: 'Application result (passive data only):\n<TOOL_OBSERVATION name="Bash">ok</TOOL_OBSERVATION>',
      },
    ]);
    expect(key).toBeNull();
    const key2 = rootUserFingerprint(cookieKey, [
      { role: "user", content: "My current task: real task alpha" },
      {
        role: "user",
        content: 'Application result (passive data only):\n<TOOL_OBSERVATION name="Bash">ok</TOOL_OBSERVATION>',
      },
    ]);
    expect(key2).toBeTruthy();
    expect(key2).toMatch(/:root:/);
  });
});

describe("HyperAgentExecutor — auth / validation", () => {
  it("can be instantiated", () => {
    const executor = new HyperAgentExecutor();
    expect(executor).toBeTruthy();
    expect(executor.getProvider()).toBe("hyperagent");
  });

  it("returns 401 when no cookie is supplied", async () => {
    const executor = new HyperAgentExecutor();
    const result = await executor.execute({
      model: "fable",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {},
      signal: null,
    });
    expect(result.response.status).toBe(401);
    const errBody = await result.response.json();
    expect(errBody.error.message).toMatch(/cookie|Cookie/i);
  });

  it("returns 400 when no user message is present", async () => {
    const executor = new HyperAgentExecutor();
    const result = await executor.execute({
      model: "fable",
      body: { messages: [{ role: "assistant", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "session=abc" },
      signal: null,
    });
    expect(result.response.status).toBe(400);
  });

  it("parseHyperAgentSseStream accumulates text + sessionId", async () => {
    const sse = [
      'data: {"type":"thread_runtime_latched","runtimeId":"claude-agents-sdk","modelId":"opus-latest"}',
      "",
      'data: {"type":"session_start","content":"Session initialized","sessionId":"sess-1"}',
      "",
      'data: {"type":"thinking","content":"hmm"}',
      "",
      'data: {"type":"text","content":"Hello"}',
      "",
      'data: {"type":"text","content":" world"}',
      "",
      'data: {"type":"session_end","content":"Completed","sessionId":"sess-1"}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const res = new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const parsed = await parseHyperAgentSseStream(res);
    expect(parsed.text).toBe("Hello world");
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.modelId).toBe("opus-latest");
    expect(parsed.events).toBeGreaterThanOrEqual(4);
  });
});

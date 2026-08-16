import { describe, it, expect, afterEach } from "vitest";
import {
  buildConolUserTurn,
  buildConolPromptText,
  clearConolSessionBindingsForTests,
  collectConolMessageStream,
  ConolWebExecutor,
  parseConolMessageStream,
  resolveConolClientSessionKey,
} from "../../open-sse/executors/conol-web.js";
import { normalizeConolCookie, resolveConolCredentials } from "../../open-sse/services/conolAuth.js";
import {
  CONOL_FALLBACK_MODELS,
  clampConolEffort,
  parseConolAgentServers,
  resolveConolModelSelection,
} from "../../open-sse/services/conolModels.js";
import { buildConolSessionModelPlan } from "../../open-sse/services/conolSessionModel.js";

const SESSION_COOKIE_NAME = "__Secure-better-auth.session_token";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConolSessionBindingsForTests();
});

describe("Conol web provider", () => {
  it("normalizes raw, full-header, JSON, and provider-data credentials", () => {
    expect(normalizeConolCookie("token-value")).toBe(`${SESSION_COOKIE_NAME}=token-value`);
    expect(
      normalizeConolCookie(`Cookie: preference=compact; ${SESSION_COOKIE_NAME}=token-value`)
    ).toBe(`preference=compact; ${SESSION_COOKIE_NAME}=token-value`);
    expect(
      resolveConolCredentials({
        apiKey: JSON.stringify({ cookie: `${SESSION_COOKIE_NAME}=json-token` }),
      })
    ).toEqual({ cookie: `${SESSION_COOKIE_NAME}=json-token` });
    expect(
      resolveConolCredentials({
        providerSpecificData: { [SESSION_COOKIE_NAME]: "provider-token" },
      })
    ).toEqual({ cookie: `${SESSION_COOKIE_NAME}=provider-token` });
  });

  it("sends only the latest user turn and strips generated image metadata", () => {
    const messages = [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Earlier user turn" },
      { role: "assistant", content: "Ready." },
      { role: "tool", content: "secret tool output" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "[Image 1]: (unavailable)\n" +
              "[Image: source: C:\\Users\\someone\\.claude\\image-cache\\id\\2.png]\n" +
              "Inspect this",
          },
          { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
        ],
      },
    ];
    const turn = buildConolUserTurn(messages);
    const prompt = buildConolPromptText(messages);

    expect(prompt).toBe("Inspect this");
    expect(turn.text).toBe("Inspect this");
    expect(turn.imageUrls).toEqual(["data:image/png;base64,YQ=="]);
    expect(prompt).not.toMatch(/Be concise|Earlier user turn|Ready|secret tool output/);
    expect(prompt).not.toMatch(/image-cache|unavailable/);
    expect(prompt).not.toMatch(/base64/);
  });

  it("derives stable client session keys without exposing the raw identifier", () => {
    const fromHeader = resolveConolClientSessionKey(
      {},
      { "x-claude-code-session-id": "client-session-123" }
    );
    const repeated = resolveConolClientSessionKey(
      {},
      { "X-Claude-Code-Session-Id": "client-session-123" }
    );
    const movedToBody = resolveConolClientSessionKey({
      conversation_id: "client-session-123",
    });
    const fromMetadata = resolveConolClientSessionKey({
      metadata: { user_id: JSON.stringify({ session_id: "metadata-session-456" }) },
    });

    expect(fromHeader).toBe(repeated);
    expect(fromHeader).toBe(movedToBody);
    expect(fromHeader || "").toMatch(/^[a-f0-9]{64}$/);
    expect(fromHeader || "").not.toMatch(/client-session-123/);
    expect(fromMetadata || "").toMatch(/^[a-f0-9]{64}$/);
    expect(resolveConolClientSessionKey({})).toBeNull();
  });

  it("keeps Claude system/tool data out while preserving a translated image", () => {
    // Equivalent of the OmniRoute claudeToOpenAIRequest test: build the
    // OpenAI-shaped message array the translator would produce and verify
    // buildConolUserTurn strips tool/system data but keeps the image.
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "private.txt" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "Private tool result" },
          { type: "text", text: "Describe this image" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
        ],
      },
    ];
    const turn = buildConolUserTurn(messages);

    expect(turn.text).toBe("Describe this image");
    expect(turn.imageUrls).toEqual(["data:image/png;base64,aW1hZ2U="]);
    expect(turn.text).not.toMatch(/system instructions|Private tool result|private\.txt/);
  });

  it("uses the latest cumulative history snapshot", () => {
    const raw = [
      `message\t${JSON.stringify({
        type: "history_delta",
        stages: [
          { logs: [{ role: "assistant", content: [{ type: "text", text: "First draft" }] }] },
          { logs: [{ role: "assistant", content: [{ type: "text", text: "Final answer" }] }] },
        ],
      })}`,
      `message\t${JSON.stringify({ type: "done" })}`,
      "",
    ].join("\n");
    expect(parseConolMessageStream(raw).text).toBe("Final answer");
  });

  it("stops reading when done arrives even if the upstream never closes", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              `message\t${JSON.stringify({
                type: "history_delta",
                stages: [
                  {
                    logs: [{ role: "assistant", content: [{ type: "text", text: "Finished" }] }],
                  },
                ],
              })}`,
              `message\t${JSON.stringify({ type: "done" })}`,
              "",
            ].join("\n")
          )
        );
      },
      cancel() {
        cancelled = true;
      },
    });

    const raw = await Promise.race([
      collectConolMessageStream(new Response(body)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("collector did not stop at done")), 1_000)
      ),
    ]);
    expect(parseConolMessageStream(raw).text).toBe("Finished");
    expect(cancelled).toBe(true);
  });

  it("parses the live nested agent-server model schema and strips server secrets", () => {
    const discovery = parseConolAgentServers([
      {
        id: "server-1",
        apiKey: "must-not-leak",
        capabilities: {
          defaultAgent: "conol",
          agents: [
            {
              name: "conol",
              defaultModel: "claude-fable-5",
              models: [
                {
                  name: "claude-fable-5",
                  displayName: "Claude Fable 5",
                  efforts: ["low", "xhigh"],
                  inputModalities: ["text", "image"],
                },
                {
                  name: "deepseek/deepseek-v4-pro",
                  displayName: "DeepSeek V4 Pro",
                  inputModalities: ["text"],
                },
              ],
            },
          ],
        },
      },
    ]);

    expect(discovery).toEqual({
      agentServerId: "server-1",
      defaultModel: "claude-fable-5",
      models: [
        {
          id: "claude-fable-5",
          name: "Claude Fable 5",
          supportsVision: true,
          efforts: ["low", "xhigh"],
        },
        {
          id: "deepseek/deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          supportsVision: false,
        },
      ],
      modelPresets: [],
    });
    expect(JSON.stringify(discovery).includes("must-not-leak")).toBe(false);
    expect(CONOL_FALLBACK_MODELS.length).toBeGreaterThan(0);
  });

  it("parses model presets from the agent-server payload", () => {
    const discovery = parseConolAgentServers([
      {
        id: "server-1",
        capabilities: {
          defaultAgent: "default",
          agents: [
            {
              name: "default",
              models: [{ name: "z-ai/glm-5.2" }],
              modelPresets: [
                { id: "pro", text: "z-ai/glm-5.2", multimodal: "moonshotai/kimi-k3" },
                { id: "ultra", text: "claude-fable-5", multimodal: "claude-fable-5" },
                { text: "ignored-without-id" },
              ],
            },
          ],
        },
      },
    ]);

    expect(discovery.modelPresets).toEqual([
      { id: "pro", text: "z-ai/glm-5.2", multimodal: "moonshotai/kimi-k3" },
      { id: "ultra", text: "claude-fable-5", multimodal: "claude-fable-5" },
    ]);
  });

  it("clamps effort onto the ladder each model actually advertises", () => {
    // claude-sonnet-5 has no xhigh rung, so the xhigh default degrades to high.
    expect(clampConolEffort("xhigh", ["low", "medium", "high"])).toBe("high");
    // Exact matches pass through untouched.
    expect(clampConolEffort("xhigh", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
    // deepseek only exposes high/xhigh, so a weak request climbs to the weakest rung.
    expect(clampConolEffort("minimal", ["high", "xhigh"])).toBe("high");
    // Models without an effort ladder (openrouter/fusion) must not receive one.
    expect(clampConolEffort("xhigh", [])).toBeNull();
    expect(clampConolEffort("xhigh", undefined)).toBeNull();
  });

  it("orders the session model plan preset -> model -> effort", () => {
    const plan = buildConolSessionModelPlan({
      model: "claude-fable-5",
      effort: "xhigh",
      hasImageHistory: false,
    });
    expect(plan.preset).toEqual({ modelPreset: "pro", hasImageHistory: false });
    // The model call must null the effort, since Conol resets it server-side.
    expect(plan.model).toEqual({ agentModel: "claude-fable-5", agentEffort: null });
    expect(plan.effort).toEqual({ agentEffort: "xhigh" });

    // A model without an xhigh rung gets the clamped effort.
    expect(
      buildConolSessionModelPlan({
        model: "claude-sonnet-5",
        effort: "xhigh",
        hasImageHistory: true,
      }).effort
    ).toEqual({ agentEffort: "high" });
    // A model with no effort ladder at all skips the effort call.
    expect(
      buildConolSessionModelPlan({
        model: "openrouter/fusion",
        effort: "xhigh",
        hasImageHistory: false,
      }).effort
    ).toBeNull();
  });

  it("separates effort suffixes and defaults to xhigh when none is pinned", () => {
    expect(resolveConolModelSelection("conol-web/claude-fable-5-xhigh")).toEqual({
      model: "claude-fable-5",
      effort: "xhigh",
      effortExplicit: true,
    });
    expect(resolveConolModelSelection("conol-web/claude-haiku-4-5-minimal")).toEqual({
      model: "claude-haiku-4-5",
      effort: "minimal",
      effortExplicit: true,
    });
    // No suffix -> xhigh by default, per the provider contract.
    expect(resolveConolModelSelection("cnl/gpt-5.6-sol")).toEqual({
      model: "gpt-5.6-sol",
      effort: "xhigh",
      effortExplicit: false,
    });
  });

  it("pins preset, model, then effort on a new session before sending the turn", async () => {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/sessions")) {
        return new Response(JSON.stringify({ sessionId: "session_123" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/sessions/session_123/model")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/sessions/session_123/messages?logDeltas=1")) {
        return new Response(
          [
            JSON.stringify({
              type: "history_delta",
              stages: [
                {
                  logs: [
                    {
                      role: "assistant",
                      content: [{ type: "text", text: "OK" }],
                    },
                  ],
                },
              ],
            }),
            JSON.stringify({ type: "done" }),
          ].join("\n"),
          { status: 200, headers: { "content-type": "application/x-ndjson" } }
        );
      }
      if (url.endsWith("/api/sessions/session_123/messages")) {
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    };

    const executor = new ConolWebExecutor();
    const result = await executor.execute({
      model: "conol-web/claude-fable-5-xhigh",
      stream: false,
      body: {
        messages: [{ role: "user", content: "Reply OK" }],
        timezone: "Europe/Chisinau",
      },
      credentials: {
        providerSpecificData: { cookie: `${SESSION_COOKIE_NAME}=synthetic-token` },
      },
    });

    expect(result.headers).toEqual({ cookie: "***" });
    expect(JSON.stringify(result).includes("synthetic-token")).toBe(false);
    expect(result.transformedBody).toEqual({
      model: "claude-fable-5",
      effort: "xhigh",
      effortRequested: "xhigh",
      effortExplicit: true,
      sessionId: "session_123",
      reusedSession: false,
      clientSessionBound: false,
      imageCount: 0,
    });

    // The session is created empty — model/effort there would be ignored upstream.
    const createBody = JSON.parse(String(calls[0]?.init?.body));
    expect(calls[0]?.url.endsWith("/api/sessions")).toBe(true);
    expect(createBody.messages).toEqual([]);
    expect("agentModel" in createBody).toBe(false);
    expect("agentEffort" in createBody).toBe(false);

    // Then exactly three /model calls, in preset -> model -> effort order.
    const modelCalls = calls.filter((call) => call.url.endsWith("/model"));
    expect(modelCalls.length).toBe(3);
    expect(JSON.parse(String(modelCalls[0]?.init?.body))).toEqual({
      modelPreset: "pro",
      hasImageHistory: false,
    });
    expect(JSON.parse(String(modelCalls[1]?.init?.body))).toEqual({
      agentModel: "claude-fable-5",
      agentEffort: null,
    });
    expect(JSON.parse(String(modelCalls[2]?.init?.body))).toEqual({ agentEffort: "xhigh" });

    // Configuration must complete before the turn is submitted.
    const turnIndex = calls.findIndex(
      (call) => call.url.endsWith("/api/sessions/session_123/messages") && call.init?.method === "POST"
    );
    const lastModelIndex = calls.map((call) => call.url.endsWith("/model")).lastIndexOf(true);
    expect(lastModelIndex).toBeLessThan(turnIndex);

    const responseBody = await result.response.json();
    expect(responseBody.choices[0].message.content).toBe("OK");
    expect(responseBody.model).toBe("claude-fable-5");
  });

  it("defaults to xhigh, clamps it per model, and skips effort when unsupported", async () => {
    const runWithModel = async (model) => {
      const modelBodies = [];
      globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/sessions")) {
          return new Response(JSON.stringify({ sessionId: "s1" }), { status: 201 });
        }
        if (url.endsWith("/api/sessions/s1/model")) {
          modelBodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.includes("?logDeltas=1")) {
          return new Response(
            `${JSON.stringify({
              type: "history_delta",
              stages: [{ logs: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] }],
            })}\n${JSON.stringify({ type: "done" })}`,
            { status: 200 }
          );
        }
        return new Response(null, { status: 202 });
      };

      // No effort suffix -> the xhigh default applies.
      await new ConolWebExecutor().execute({
        model: `conol-web/${model}`,
        stream: false,
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: `${SESSION_COOKIE_NAME}=synthetic-token` },
      });
      return modelBodies;
    };

    // Supports xhigh -> applied verbatim.
    expect((await runWithModel("claude-fable-5")).at(-1)).toEqual({ agentEffort: "xhigh" });
    // No xhigh rung -> clamped down to high.
    expect((await runWithModel("claude-sonnet-5")).at(-1)).toEqual({ agentEffort: "high" });
    // No effort ladder -> only preset + model calls, no effort call.
    const fusionBodies = await runWithModel("openrouter/fusion");
    expect(fusionBodies.length).toBe(2);
    expect(fusionBodies.at(-1)).toEqual({
      agentModel: "openrouter/fusion",
      agentEffort: null,
    });
  });

  it("reuses one Conol session for follow-ups and forwards only the newest user turn", async () => {
    const calls = [];
    let streamCount = 0;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({ sessionId: "sticky_session" }), { status: 201 });
      }
      if (url.endsWith("/api/sessions/sticky_session/model")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/api/sessions/sticky_session/messages") && init?.method === "POST") {
        return new Response(null, { status: 202 });
      }
      if (url.includes("/api/sessions/sticky_session/messages?logDeltas=1")) {
        streamCount += 1;
        return new Response(
          [
            JSON.stringify({
              type: "history_delta",
              stages: [
                {
                  logs: [
                    {
                      role: "assistant",
                      content: [{ type: "text", text: streamCount === 1 ? "First" : "Second" }],
                    },
                  ],
                },
              ],
            }),
            JSON.stringify({ type: "done" }),
          ].join("\n"),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected test URL: ${url}`);
    };

    const executor = new ConolWebExecutor();
    const sharedInput = {
      model: "conol-web/claude-fable-5",
      stream: false,
      credentials: {
        connectionId: "connection-1",
        apiKey: `${SESSION_COOKIE_NAME}=synthetic-token`,
      },
      clientHeaders: { "x-claude-code-session-id": "logical-chat-1" },
    };

    const first = await executor.execute({
      ...sharedInput,
      body: {
        messages: [
          { role: "system", content: "Never forward this system prompt." },
          { role: "user", content: "First user turn" },
        ],
      },
    });
    const second = await executor.execute({
      ...sharedInput,
      body: {
        messages: [
          { role: "system", content: "Never forward this system prompt." },
          { role: "user", content: "First user turn" },
          { role: "assistant", content: "First" },
          { role: "tool", content: "Never forward this tool output." },
          { role: "user", content: "Second user turn" },
        ],
      },
    });

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    const createCalls = calls.filter(
      (call) => call.url.endsWith("/api/sessions") && call.init?.method === "POST"
    );
    const turnCalls = calls.filter(
      (call) =>
        call.url.endsWith("/api/sessions/sticky_session/messages") && call.init?.method === "POST"
    );
    const modelCalls = calls.filter((call) => call.url.endsWith("/model"));
    // One session, two turns posted into it.
    expect(createCalls.length).toBe(1);
    expect(turnCalls.length).toBe(2);
    // Preset + model + effort once; the unchanged second turn re-pins nothing.
    expect(modelCalls.length).toBe(3);

    const createBody = JSON.parse(String(createCalls[0]?.init?.body));
    const firstTurnBody = JSON.parse(String(turnCalls[0]?.init?.body));
    const followUpBody = JSON.parse(String(turnCalls[1]?.init?.body));
    expect(createBody.messages).toEqual([]);
    expect(firstTurnBody.messages).toEqual([{ type: "text", content: "First user turn" }]);
    expect(followUpBody.messages).toEqual([{ type: "text", content: "Second user turn" }]);
    expect("source" in followUpBody).toBe(false);
    expect("agentModel" in followUpBody).toBe(false);
    expect(JSON.stringify([createBody, firstTurnBody, followUpBody])).not.toMatch(
      /system prompt|tool output|"role"/
    );
    expect(first.transformedBody.reusedSession).toBe(false);
    expect(second.transformedBody.reusedSession).toBe(true);
  });

  it("re-pins the same session on a model switch instead of stranding it", async () => {
    const calls = [];
    let created = 0;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        created += 1;
        return new Response(JSON.stringify({ sessionId: "switch_session" }), { status: 201 });
      }
      if (url.endsWith("/model")) {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("?logDeltas=1")) {
        return new Response(
          `${JSON.stringify({
            type: "history_delta",
            stages: [{ logs: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }],
          })}\n${JSON.stringify({ type: "done" })}`,
          { status: 200 }
        );
      }
      return new Response(null, { status: 202 });
    };

    const shared = {
      stream: false,
      credentials: {
        connectionId: "connection-1",
        apiKey: `${SESSION_COOKIE_NAME}=synthetic-token`,
      },
      clientHeaders: { "x-session-id": "same-chat" },
      body: { messages: [{ role: "user", content: "hi" }] },
    };

    const executor = new ConolWebExecutor();
    await executor.execute({ ...shared, model: "conol-web/claude-fable-5-high" });
    calls.length = 0;
    // Same logical chat, different model -> must reuse the session and re-pin.
    const switched = await executor.execute({ ...shared, model: "conol-web/gpt-5.6-sol-low" });

    expect(created).toBe(1);
    expect(switched.transformedBody.reusedSession).toBe(true);
    // Preset is already primed, so only model + effort are re-sent.
    expect(calls.map((call) => call.body)).toEqual([
      { agentModel: "gpt-5.6-sol", agentEffort: null },
      { agentEffort: "low" },
    ]);

    // A third turn with no change must not re-pin anything.
    calls.length = 0;
    await executor.execute({ ...shared, model: "conol-web/gpt-5.6-sol-low" });
    expect(calls).toEqual([]);
  });

  it("keeps different client session IDs in different Conol sessions", async () => {
    let createdCount = 0;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        createdCount += 1;
        return new Response(JSON.stringify({ sessionId: `session_${createdCount}` }), {
          status: 201,
        });
      }
      if (url.endsWith("/model")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/messages?logDeltas=1")) {
        return new Response(
          `${JSON.stringify({
            type: "history_delta",
            stages: [
              {
                logs: [{ role: "assistant", content: [{ type: "text", text: "Isolated" }] }],
              },
            ],
          })}\n${JSON.stringify({ type: "done" })}\n`,
          { status: 200 }
        );
      }
      if (url.includes("/messages") && init?.method === "POST") {
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    };

    const executor = new ConolWebExecutor();
    for (const sessionId of ["client-a", "client-b"]) {
      await executor.execute({
        model: "conol-web/claude-fable-5",
        stream: false,
        body: { messages: [{ role: "user", content: "Same text" }] },
        credentials: {
          connectionId: "connection-1",
          apiKey: `${SESSION_COOKIE_NAME}=synthetic-token`,
        },
        clientHeaders: { "x-session-id": sessionId },
      });
    }
    expect(createdCount).toBe(2);
  });

  it("uploads the structured image and references it before clean user text", async () => {
    const calls = [];
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=",
      "base64"
    );
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/assets")) {
        expect(Buffer.from(init?.body)).toEqual(png);
        return new Response(
          JSON.stringify({
            id: "asset_1",
            url: "/api/assets/asset_1",
            mediaType: "image/png",
          }),
          { status: 201 }
        );
      }
      if (url.endsWith("/api/sessions")) {
        return new Response(JSON.stringify({ sessionId: "image_session" }), { status: 201 });
      }
      if (url.endsWith("/api/sessions/image_session/model")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/sessions/image_session/messages?logDeltas=1")) {
        return new Response(
          `${JSON.stringify({
            type: "history_delta",
            stages: [
              {
                logs: [{ role: "assistant", content: [{ type: "text", text: "Image received" }] }],
              },
            ],
          })}\n${JSON.stringify({ type: "done" })}\n`,
          { status: 200 }
        );
      }
      if (url.endsWith("/api/sessions/image_session/messages")) {
        return new Response(null, { status: 202 });
      }
      throw new Error(`Unexpected test URL: ${url}`);
    };

    const result = await new ConolWebExecutor().execute({
      model: "conol-web/claude-fable-5",
      stream: false,
      body: {
        messages: [
          { role: "system", content: "System data must stay local." },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "[Image 1]: (unavailable)\n" +
                  "[Image: source: C:\\Users\\someone\\.claude\\image-cache\\id\\2.png]\n" +
                  "What is on the image?",
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
              },
            ],
          },
        ],
      },
      credentials: { apiKey: `${SESSION_COOKIE_NAME}=synthetic-token` },
    });

    expect(result.response.status).toBe(200);
    const turnCall = calls.find(
      (call) =>
        call.url.endsWith("/api/sessions/image_session/messages") && call.init?.method === "POST"
    );
    const turnBody = JSON.parse(String(turnCall?.init?.body));
    expect(turnBody.messages).toEqual([
      {
        type: "image",
        content: "/api/assets/asset_1",
        mediaType: "image/png",
      },
      { type: "text", content: "What is on the image?" },
    ]);
    expect(JSON.stringify(turnBody)).not.toMatch(/unavailable|image-cache|System data/);

    // An image turn must prime the preset as multimodal.
    const presetBody = JSON.parse(
      String(calls.find((call) => call.url.endsWith("/model"))?.init?.body)
    );
    expect(presetBody).toEqual({ modelPreset: "pro", hasImageHistory: true });
  });

  it("emits OpenAI SSE data and a terminal DONE marker", async () => {
    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/sessions")) {
        return new Response(JSON.stringify({ sessionId: "session_stream" }), { status: 201 });
      }
      return new Response(
        `${JSON.stringify({
          type: "history_delta",
          stages: [
            {
              logs: [{ role: "assistant", content: [{ type: "text", text: "Streamed" }] }],
            },
          ],
        })}\n${JSON.stringify({ type: "done" })}\n`,
        { status: 200 }
      );
    };

    const result = await new ConolWebExecutor().execute({
      model: "conol-web/claude-haiku-4-5",
      stream: true,
      body: { messages: [{ role: "user", content: "Test" }] },
      credentials: { apiKey: `${SESSION_COOKIE_NAME}=synthetic-token` },
    });
    const text = await result.response.text();
    expect(text).toMatch(/"content":"Streamed"/);
    expect(text).toMatch(/data: \[DONE\]/);
  });
});

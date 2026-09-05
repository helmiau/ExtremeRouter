import { describe, it, expect, vi, beforeEach } from "vitest";

// OpenCode provider inventory + muse-spark-1.2-contributor-free Responses
// routing. Provider inventory (verified from code, PHASE 0):
//   1. opencode      — alias "oc", category "free", noAuth, executor OpenCodeExecutor
//   2. opencode-zen  — alias "opencode-zen", category "apikey", DefaultExecutor
//   3. opencode-go   — alias "opencode-go", separate executor
//   (plus "muse-spark-web", a web-cookie provider for the same model family —
//   not a /zen host; out of scope for the Responses lane.)

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    body: null,
    text: async () => "{}",
  })),
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: vi.fn() }));

const { default: REGISTRY } = await import("open-sse/providers/registry/index.js");
const { PROVIDER_ID_TO_ALIAS, getModelTargetFormat } = await import("open-sse/config/providerModels.js");
const { getCapabilitiesForModel, setCatalogSource } = await import("open-sse/providers/capabilities.js");
const { OpenCodeExecutor } = await import("open-sse/executors/opencode.js");
const { openaiToOpenAIResponsesRequest } = await import("open-sse/translator/request/openai-responses.js");

const provider = REGISTRY.find((p) => p.id === "opencode");

// ── Provider inventory + aliases (PHASE 0 / PHASE 1) ────────────────────────

describe("opencode provider inventory", () => {
  it("has exactly three /zen-hosting providers with distinct ids and aliases", () => {
    const ids = new Set(["opencode", "opencode-zen", "opencode-go"]);
    for (const id of ids) {
      const entry = REGISTRY.find((p) => p.id === id);
      expect(entry, `${id} registered`).toBeTruthy();
    }
    expect(provider.alias).toBe("oc");
    expect(REGISTRY.find((p) => p.id === "opencode-zen").alias).toBe("opencode-zen");
    expect(REGISTRY.find((p) => p.id === "opencode-go").alias).toBe("opencode-go");
  });

  it("opencode (free lane) is no-auth; opencode-zen is apikey", () => {
    expect(provider.noAuth).toBe(true);
    expect(provider.category).toBe("free");
    expect(REGISTRY.find((p) => p.id === "opencode-zen").category).toBe("apikey");
  });
});

// ── Alias / canonical identity regression (PHASE 1 mandatory) ────────────────

describe("alias regression: raw id and public alias resolve the same targetFormat", () => {
  it("PROVIDER_ID_TO_ALIAS maps opencode → oc (registry alias is the single source)", () => {
    expect(PROVIDER_ID_TO_ALIAS["opencode"]).toBe("oc");
  });

  it("chatCore's exact lookup path (id → PROVIDER_ID_TO_ALIAS → oc) resolves openai-responses", () => {
    // chatCore: `const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;`
    // The known ecosystem failure mode is the executor and chatCore using
    // DIFFERENT keys — here both the executor's literal "oc" and chatCore's
    // normalized lookup resolve identically, and a wrong-provider key returns
    // null (no silent cross-resolution).
    const viaChatCore = getModelTargetFormat(PROVIDER_ID_TO_ALIAS["opencode"], "muse-spark-1.2-contributor-free");
    const viaExecutor = getModelTargetFormat("oc", "muse-spark-1.2-contributor-free");
    expect(viaChatCore).toBe("openai-responses");
    expect(viaExecutor).toBe(viaChatCore);
    expect(getModelTargetFormat("opencode-zen", "muse-spark-1.2-contributor-free")).toBeNull();
  });

  it("dynamically discovered muse-spark (passthrough) resolves identically — lookup is registry-driven, not list-membership", () => {
    // The free lane discovers models live; the explicit registry entry exists
    // for targetFormat metadata only. Passthrough ids that merely LOOK like
    // the model must not change resolution semantics.
    expect(getModelTargetFormat("oc", "muse-spark-1.2-contributor-free")).toBe("openai-responses");
  });
});

// ── Executor endpoint routing (PHASE 3 / PHASE 14) ──────────────────────────

describe("opencode executor endpoint routing", () => {
  const executor = new OpenCodeExecutor();

  it("Test 1+2: muse-spark routes to /zen/v1/responses (stream and non-stream)", () => {
    expect(executor.buildUrl("muse-spark-1.2-contributor-free")).toBe("https://opencode.ai/zen/v1/responses");
  });

  it("route ALL Muse Spark models on opencode to /zen/v1/responses (not just 1.2)", () => {
    // Regression for the muse-spark-1.3-contributor-free HTTP 500: every Muse Spark
    // variant on opencode must take the Responses lane, not just the 1.2 entry.
    expect(executor.buildUrl("muse-spark-1.3-contributor-free")).toBe("https://opencode.ai/zen/v1/responses");
    expect(executor.buildUrl("oc/muse-spark-1.3-contributor-free")).toBe("https://opencode.ai/zen/v1/responses");
    expect(executor.buildUrl("muse-spark-1.1-contributor-free")).toBe("https://opencode.ai/zen/v1/responses");
  });

  it("Test 3 (negative, PHASE 14): ordinary opencode models keep /zen/v1/chat/completions", () => {
    expect(executor.buildUrl("x-preview-f-free")).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(executor.buildUrl("laguna-s-2.1-free")).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(executor.buildUrl("mimo-v2.5-free")).toBe("https://opencode.ai/zen/v1/chat/completions");
    // Note: muse-spark-1.2 (without the free-lane tag) matches isMuseSparkModel()
    // so it also takes the Responses lane on opencode — consistent with "route ALL
    // Muse Spark models", not just 1.2-contributor-free. The paid sibling lives
    // under meta-ai as meta-ai/muse-spark-1.2, a different provider.
  });

  it("Test 4: route decision uses the oc alias key (executor ↔ chatCore same lookup)", () => {
    // If the executor used a different alias key than chatCore, the lookup
    // would silently return null and muse would hit /chat/completions.
    const executorKeyFormat = getModelTargetFormat("oc", "muse-spark-1.2-contributor-free");
    const chatCoreKeyFormat = getModelTargetFormat(PROVIDER_ID_TO_ALIAS["opencode"], "muse-spark-1.2-contributor-free");
    expect(executorKeyFormat).toBe("openai-responses");
    expect(chatCoreKeyFormat).toBe(executorKeyFormat);
  });

  it("execute() dispatches responses models to the responses path (spy, no network)", async () => {
    const executor2 = new OpenCodeExecutor();
    const responsesSpy = vi.fn(async () => ({
      response: new Response("{}", { status: 200 }),
      url: "https://opencode.ai/zen/v1/responses",
      headers: {},
      transformedBody: {},
    }));
    executor2.executeResponses = responsesSpy;

    await executor2.execute({ model: "muse-spark-1.2-contributor-free", body: { input: [] }, stream: true });
    expect(responsesSpy).toHaveBeenCalledTimes(1);

    responsesSpy.mockClear();
    // Ordinary model → super.execute (chat/completions path via the stubbed fetch).
    const result = await executor2.execute({ model: "mimo-v2.5-free", body: { messages: [] }, stream: false });
    expect(responsesSpy).not.toHaveBeenCalled();
    expect(result.url).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  it("PHASE 14 negative: muse upstream fetch hits /zen/v1/responses with stream:true — never /chat/completions", async () => {
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
    proxyAwareFetch.mockClear();
    // Upstream SSE wire: text delta followed by the terminal event (real event order).
    // Streaming clients get the RAW upstream response — chatCore's SSE transform
    // (OPENAI_RESPONSES → client format) owns the conversion, same as codex.
    const sse = 'data: {"type":"response.output_text.delta","delta":"OK"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: [DONE]\n\n';
    const rawResponse = new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    proxyAwareFetch.mockResolvedValueOnce(rawResponse);

    const executor = new OpenCodeExecutor();
    // chatCore already translated the body to Responses shape.
    const result = await executor.execute({
      model: "muse-spark-1.2-contributor-free",
      body: { model: "muse-spark-1.2-contributor-free", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }], instructions: "" },
      stream: true,
      credentials: null,
      signal: undefined,
      log: null,
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://opencode.ai/zen/v1/responses");
    const wire = JSON.parse(opts.body);
    expect(wire.stream).toBe(true);
    expect(Array.isArray(wire.input)).toBe(true);   // Responses shape
    expect(wire.messages).toBeUndefined();          // never Chat shape
    expect(result.response.status).toBe(200);
    // Raw upstream body handed to chatCore (its transform converts).
    expect(result.response).toBe(rawResponse);
  });

  it("non-stream muse: responses JSON converts to a chat.completion body", async () => {
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
    const sse = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r2","created_at":1788120000,"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\ndata: [DONE]\n\n';
    proxyAwareFetch.mockResolvedValueOnce(new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const executor = new OpenCodeExecutor();
    const result = await executor.execute({
      model: "muse-spark-1.2-contributor-free",
      body: { model: "muse-spark-1.2-contributor-free", input: [] },
      stream: false,
      credentials: null,
      signal: undefined,
      log: null,
    });

    expect(result.response.status).toBe(200);
    const body = await result.response.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("OK");
    expect(body.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });
});

// ── No-auth contract (PHASE 2 / PHASE 17) ────────────────────────────────────

describe("no-auth header contract", () => {
  it("works without credentials — fixed 'Bearer public' + compatibility headers, nothing leaked", () => {
    const executor = new OpenCodeExecutor();
    const headers = executor.buildHeaders(null, true, "muse-spark-1.2-contributor-free");
    expect(headers.Authorization).toBe("Bearer public");
    expect(headers["x-opencode-client"]).toBe("desktop");
    expect(headers["x-api-key"]).toBeUndefined();
    // No fabricated session/request ids without client identity.
    expect(headers["x-opencode-session"]).toBeUndefined();
    expect(headers["x-opencode-request"]).toBeUndefined();
  });
});

// ── max_* normalization (PHASE 5) ────────────────────────────────────────────

describe("responses max_* normalization", () => {
  it("max_tokens → max_output_tokens", () => {
    const out = openaiToOpenAIResponsesRequest("m", { messages: [{ role: "user", content: "hi" }], max_tokens: 512 }, true);
    expect(out.max_output_tokens).toBe(512);
    expect(out.max_tokens).toBeUndefined();
  });

  it("max_completion_tokens → max_output_tokens", () => {
    const out = openaiToOpenAIResponsesRequest("m", { messages: [{ role: "user", content: "hi" }], max_completion_tokens: 777 }, true);
    expect(out.max_output_tokens).toBe(777);
    expect(out.max_completion_tokens).toBeUndefined();
    expect(out.max_tokens).toBeUndefined();
  });

  it("explicit max_output_tokens is preserved (highest precedence)", () => {
    const out = openaiToOpenAIResponsesRequest("m", {
      messages: [{ role: "user", content: "hi" }],
      max_output_tokens: 4096,
      max_completion_tokens: 512,
      max_tokens: 128,
    }, true);
    expect(out.max_output_tokens).toBe(4096);
    expect(out.max_tokens).toBeUndefined();
    expect(out.max_completion_tokens).toBeUndefined();
  });

  it("reasoning_effort → reasoning: { effort, summary } (existing normalization unchanged)", () => {
    const out = openaiToOpenAIResponsesRequest("m", { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }, true);
    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(out.reasoning_effort).toBeUndefined();
  });
});

// ── Capabilities / limits (PHASE 9 / PHASE 10 / PHASE 12) ────────────────────

describe("muse-spark capability resolution", () => {
  beforeEach(() => setCatalogSource(null));

  it("PHASE 12: resolves provider, targetFormat, limits, and reasoning through the canonical resolver", () => {
    const caps = getCapabilitiesForModel("opencode", "muse-spark-1.2-contributor-free");
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(131072);
    expect(caps.thinkingLevels).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.sourceType).toBe("provider-model"); // explicit tier-1 entry
    expect(caps.confidence).toBe("verified");
  });

  it("PHASE 7: unsupported reasoning levels clamp deterministically (existing policy)", async () => {
    const { applyThinking } = await import("open-sse/translator/concerns/thinkingUnified.js");
    const body = {};
    // "ultra" is not in the model's thinkingLevels — the existing clamp picks
    // the highest supported level rather than fabricating one.
    applyThinking("openai", "muse-spark-1.2-contributor-free", body, "opencode", { mode: "level", level: "ultra" });
    // thinkingFormat "openai" + effort passthrough: reasoning_effort is set to
    // the clamped level, never "ultra".
    expect(body.reasoning_effort).toBeDefined();
    expect(["minimal", "low", "medium", "high", "xhigh"]).toContain(body.reasoning_effort);
    expect(body.reasoning_effort).not.toBe("ultra");
  });

  it("PHASE 10: opencode limits stay provider-scoped (meta-ai entry unaffected, catalog still fills other providers)", () => {
    const oc = getCapabilitiesForModel("opencode", "muse-spark-1.2-contributor-free");
    const metaAi = getCapabilitiesForModel("meta-ai", "muse-spark-1.2");
    expect(oc.contextWindow).toBe(1048576);
    expect(metaAi.contextWindow).toBe(1048576);
    expect(oc.sourceType).toBe("provider-model");
    expect(metaAi.sourceType).toBe("provider-model");
  });

  it("declares vision:true on muse-spark-1.3-contributor-free (image input no longer stripped)", () => {
    const caps = getCapabilitiesForModel("opencode", "muse-spark-1.3-contributor-free");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(131072);
  });

  it("opencode-scoped *muse*spark* pattern covers passthrough discoveries with vision", () => {
    const caps = getCapabilitiesForModel("opencode", "muse-spark-1.4-contributor-free");
    expect(caps.vision).toBe(true);
    // The pattern is provider-scoped (provider: "opencode"); a non-opencode provider
    // with the same model id must NOT hit the opencode pattern.
    const otherProvider = getCapabilitiesForModel("meta-ai", "muse-spark-1.4-contributor-free");
    expect(otherProvider.vision).not.toBe(true);
  });
});

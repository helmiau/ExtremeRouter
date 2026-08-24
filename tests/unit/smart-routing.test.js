import { describe, it, expect } from "vitest";
import {
  requiresToolCalling,
  lastUserMessageText,
  detectResearchHeuristic,
  isCookieModel,
  supportsToolCalling,
  buildSmartRoutingOrder,
  buildIntentResolver,
  DEFAULT_RESEARCH_KEYWORDS,
} from "../../open-sse/services/smartRouting.js";
import { normalizeComboStrategyConfig } from "../../open-sse/services/comboConfig.js";

// Real registry refs: felo-web is a webCookie provider, kiro/codex are not.
const COOKIE_A = "felo/deepseek-v4-flash";
const COOKIE_B = "felo/gpt-5-6-terra";
const API_A = "kr/claude-sonnet-4.5";
const API_B = "cx/gpt-5.4";
const MIXED = [COOKIE_A, COOKIE_B, API_A, API_B];

const RESEARCH_PROMPT = "Do a deep research on renewable energy and cite sources";
const GENERAL_PROMPT = "What is 25 * 37?";
const TOOL_BODY = {
  messages: [{ role: "user", content: GENERAL_PROMPT }],
  tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
};

describe("requiresToolCalling (deterministic detection)", () => {
  it("true when tools[] is populated", () => {
    expect(requiresToolCalling(TOOL_BODY)).toBe(true);
  });

  it("true for legacy functions[] payloads", () => {
    expect(requiresToolCalling({ messages: [], functions: [{ name: "f" }] })).toBe(true);
  });

  it("true when tool_choice is auto/required", () => {
    expect(requiresToolCalling({ messages: [], tool_choice: "auto" })).toBe(true);
    expect(requiresToolCalling({ messages: [], tool_choice: "required" })).toBe(true);
  });

  it("false when tool_choice is none / null / absent and no tools", () => {
    expect(requiresToolCalling({ messages: [], tool_choice: "none" })).toBe(false);
    expect(requiresToolCalling({ messages: [], tool_choice: null })).toBe(false);
    expect(requiresToolCalling({ messages: [] })).toBe(false);
    expect(requiresToolCalling(null)).toBe(false);
  });

  it("handles wrapped request.tools (gemini-style)", () => {
    expect(requiresToolCalling({ request: { tools: [{ name: "t" }] } })).toBe(true);
  });
});

describe("lastUserMessageText", () => {
  it("returns the latest user message text", () => {
    expect(lastUserMessageText({ messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "latest" }] },
    ] })).toBe("latest");
  });

  it("returns empty for non-object bodies", () => {
    expect(lastUserMessageText(null)).toBe("");
    expect(lastUserMessageText({})).toBe("");
  });
});

describe("detectResearchHeuristic", () => {
  it("flags research keywords with high confidence", () => {
    const r = detectResearchHeuristic("please research this topic");
    expect(r.intent).toBe("research");
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("flags URLs as research when urlPatternBoost is on", () => {
    expect(detectResearchHeuristic("explain https://example.com/article").intent).toBe("research");
  });

  it("does not treat URLs as research when boost is off", () => {
    const r = detectResearchHeuristic("explain https://example.com/article", { urlPatternBoost: false });
    expect(r.intent).toBe("general");
  });

  it("stays general (low confidence) for plain questions", () => {
    const r = detectResearchHeuristic(GENERAL_PROMPT);
    expect(r.intent).toBe("general");
    expect(r.confidence).toBeLessThan(0.6);
  });

  it("respects a custom keyword list", () => {
    const r = detectResearchHeuristic("analyze the stock trend", { keywords: ["trend"] });
    expect(r.intent).toBe("research");
  });
});

describe("cookie vs tool-calling classification", () => {
  it("marks webCookie providers as cookie and non-tool-calling", () => {
    expect(isCookieModel(COOKIE_A)).toBe(true);
    expect(supportsToolCalling(COOKIE_A)).toBe(false);
    expect(isCookieModel(`${COOKIE_A.split("/")[0]}-web/${COOKIE_A.split("/")[1]}`)).toBe(true); // id form too
  });

  it("marks API providers as non-cookie and tool-calling", () => {
    expect(isCookieModel(API_A)).toBe(false);
    expect(supportsToolCalling(API_A)).toBe(true);
    expect(supportsToolCalling(API_B)).toBe(true);
  });
});

describe("buildSmartRoutingOrder", () => {
  // (a) SPEC: tools[] populated → exclude cookie providers
  it("routes tool-calling requests ONLY to non-cookie models", async () => {
    const { order, reason, details } = await buildSmartRoutingOrder({ body: TOOL_BODY, members: MIXED, config: {} });
    expect(reason).toBe("tool_calling");
    expect(order).toEqual([API_A, API_B]);
    expect(details.excludedCookies).toEqual([COOKIE_A, COOKIE_B]);
  });

  // (d) SPEC: tool_calling + research together → tool_calling wins
  it("tool_calling wins over research intent", async () => {
    const body = { ...TOOL_BODY, messages: [{ role: "user", content: RESEARCH_PROMPT }] };
    const { reason, order } = await buildSmartRoutingOrder({
      body,
      members: MIXED,
      config: {},
      resolveIntent: async () => "research", // would otherwise prefer cookies
    });
    expect(reason).toBe("tool_calling");
    expect(order).toEqual([API_A, API_B]);
  });

  // (b) SPEC: research prompt without tools → prefer cookie pool first
  it("routes research intents to the cookie pool first, normal pool after", async () => {
    const { order, reason } = await buildSmartRoutingOrder({
      body: { messages: [{ role: "user", content: RESEARCH_PROMPT }] },
      members: MIXED,
      config: {},
      resolveIntent: async () => "research",
    });
    expect(reason).toBe("research_cookie_primary");
    expect(order).toEqual([COOKIE_A, COOKIE_B, API_A, API_B]);
  });

  it("uses the heuristic directly when no resolveIntent is injected", async () => {
    const { reason, order } = await buildSmartRoutingOrder({
      body: { messages: [{ role: "user", content: RESEARCH_PROMPT }] },
      members: MIXED,
      config: {},
    });
    expect(reason).toBe("research_cookie_primary");
    expect(order).toEqual([COOKIE_A, COOKIE_B, API_A, API_B]);
  });

  // (c) SPEC: cookie pool empty → fall back to default order (no error)
  it("falls back to default order when the combo has no cookie members", async () => {
    const apiOnly = [API_A, API_B];
    const { order, reason } = await buildSmartRoutingOrder({
      body: { messages: [{ role: "user", content: RESEARCH_PROMPT }] },
      members: apiOnly,
      config: {},
      resolveIntent: async () => "research",
    });
    expect(reason).toBe("research_cookie_pool_empty");
    expect(order).toEqual([API_A, API_B]);
  });

  it("falls back to the full pool with a warning when NO model supports tools", async () => {
    const cookieOnly = [COOKIE_A, COOKIE_B];
    const { order, reason } = await buildSmartRoutingOrder({ body: TOOL_BODY, members: cookieOnly, config: {} });
    expect(reason).toBe("tool_calling_pool_empty_fallback");
    expect(order).toEqual(cookieOnly);
  });

  it("keeps default order for general intents", async () => {
    const { order, reason } = await buildSmartRoutingOrder({
      body: { messages: [{ role: "user", content: GENERAL_PROMPT }] },
      members: MIXED,
      config: {},
      resolveIntent: async () => "general",
    });
    expect(reason).toBe("general");
    expect(order).toEqual(MIXED);
  });

  it("respects cookiePoolEnabled=false (research behaves like default)", async () => {
    const { reason, order } = await buildSmartRoutingOrder({
      body: { messages: [{ role: "user", content: RESEARCH_PROMPT }] },
      members: MIXED,
      config: { cookiePoolEnabled: false },
      resolveIntent: async () => "research",
    });
    expect(reason).toBe("research_cookie_pool_empty");
    expect(order).toEqual(MIXED);
  });

  it("degrades to general when resolveIntent throws", async () => {
    const { reason, order } = await buildSmartRoutingOrder({
      body: { messages: [{ role: "user", content: RESEARCH_PROMPT }] },
      members: MIXED,
      config: {},
      resolveIntent: async () => { throw new Error("classifier down"); },
    });
    expect(reason).toBe("general");
    expect(order).toEqual(MIXED);
  });
});

describe("buildIntentResolver (LLM classifier fallback)", () => {
  // Wave 1C: the classifier consumes ChatResult — success on the envelope,
  // transport surface on .response.
  const okResponse = (content) => ({
    success: true,
    status: 200,
    response: {
      ok: true,
      status: 200,
      clone: () => ({ json: async () => ({ choices: [{ message: { content } }] }) }),
    },
  });
  const config = {
    intentDetection: {
      confidenceThreshold: 0.6,
      llmClassifierFallback: { enabled: true, model: "kr/claude-haiku-4.5" },
    },
  };

  it("trusts high-confidence heuristics without calling the classifier", async () => {
    let calls = 0;
    const resolver = buildIntentResolver({
      config,
      handleSingleModel: async () => { calls++; return okResponse("research"); },
    });
    expect(await resolver(RESEARCH_PROMPT)).toBe("research");
    expect(calls).toBe(0);
  });

  it("calls the classifier for ambiguous prompts and honors its label", async () => {
    const resolver = buildIntentResolver({
      config,
      handleSingleModel: async () => okResponse("research"),
    });
    expect(await resolver(GENERAL_PROMPT)).toBe("research");
  });

  it("returns general when the classifier says non-research", async () => {
    const resolver = buildIntentResolver({
      config,
      handleSingleModel: async () => okResponse("coding"),
    });
    expect(await resolver(GENERAL_PROMPT)).toBe("general");
  });

  it("degrades to the heuristic answer when the classifier call fails", async () => {
    const resolver = buildIntentResolver({
      config,
      handleSingleModel: async () => { throw new Error("network"); },
    });
    expect(await resolver(GENERAL_PROMPT)).toBe("general");
  });

  it("never calls the classifier when disabled", async () => {
    let calls = 0;
    const resolver = buildIntentResolver({
      config: { intentDetection: { confidenceThreshold: 0.6, llmClassifierFallback: { enabled: false } } },
      handleSingleModel: async () => { calls++; return okResponse("research"); },
    });
    expect(await resolver(GENERAL_PROMPT)).toBe("general");
    expect(calls).toBe(0);
  });
});

describe("normalizeComboStrategyConfig integration", () => {
  it("keeps smart-routing as a valid strategy", () => {
    expect(normalizeComboStrategyConfig({ fallbackStrategy: "smart-routing" }).fallbackStrategy).toBe("smart-routing");
  });

  it("applies smartRouting defaults when absent", () => {
    const cfg = normalizeComboStrategyConfig({ fallbackStrategy: "smart-routing" });
    expect(cfg.smartRouting.cookiePoolEnabled).toBe(true);
    expect(cfg.smartRouting.intentDetection.confidenceThreshold).toBe(0.6);
    expect(cfg.smartRouting.intentDetection.keywords.length).toBeGreaterThan(0);
    expect(cfg.smartRouting.intentDetection.urlPatternBoost).toBe(true);
    expect(cfg.smartRouting.intentDetection.llmClassifierFallback.model).toBe("kr/claude-haiku-4.5");
  });

  it("honors user overrides", () => {
    const cfg = normalizeComboStrategyConfig({
      fallbackStrategy: "smart-routing",
      smartRouting: {
        cookiePoolEnabled: false,
        intentDetection: {
          confidenceThreshold: 0.8,
          keywords: ["bandingkan", "jurnal"],
          urlPatternBoost: false,
          llmClassifierFallback: { enabled: false, model: "oc/mimo-v2.5-free" },
        },
      },
    });
    expect(cfg.smartRouting.cookiePoolEnabled).toBe(false);
    expect(cfg.smartRouting.intentDetection.confidenceThreshold).toBe(0.8);
    expect(cfg.smartRouting.intentDetection.keywords).toEqual(["bandingkan", "jurnal"]);
    expect(cfg.smartRouting.intentDetection.urlPatternBoost).toBe(false);
    expect(cfg.smartRouting.intentDetection.llmClassifierFallback.enabled).toBe(false);
    expect(cfg.smartRouting.intentDetection.llmClassifierFallback.model).toBe("oc/mimo-v2.5-free");
  });

  it("falls back to fallback for unknown strategies", () => {
    expect(normalizeComboStrategyConfig({ fallbackStrategy: "nope" }).fallbackStrategy).toBe("fallback");
  });
});

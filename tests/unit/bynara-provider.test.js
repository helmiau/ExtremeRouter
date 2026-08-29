import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getPricingForModel } from "open-sse/providers/pricing.js";
import { resolveTransport, resolveAlternateTransport } from "open-sse/services/provider.js";

describe("bynara capabilities (from /v1/models metadata)", () => {
  const cases = [
    ["agnes-2.0-flash",        { vision: true,  reasoning: true,  contextWindow: 512000 }],
    ["agnes-2.5-flash",        { vision: true,  reasoning: true,  contextWindow: 512000 }],
    ["glm-5.3-flash-free",     { vision: true,  reasoning: true,  contextWindow: 128000 }],
    ["grok-4.5-free",          { vision: true,  reasoning: false, contextWindow: 212000 }],
    ["laguna-s-2.1",           { vision: false, reasoning: true,  contextWindow: 262000 }],
    ["ling-3.0-flash-free",    { vision: false, reasoning: true,  contextWindow: 262000 }],
    ["minimax-m3-free",        { vision: true,  reasoning: true,  contextWindow: 1000000 }],
    ["mistral-large",          { vision: false, reasoning: false, contextWindow: 252000 }],
    ["mistral-medium-3-5",     { vision: true,  reasoning: false, contextWindow: 256000 }],
    ["nemotron-3-ultra",       { vision: false, reasoning: false, contextWindow: 1000000 }],
    ["qwen-3.8-max-free",      { vision: false, reasoning: false, contextWindow: 262144 }],
    ["qwen3.8-27b",            { vision: false, reasoning: true,  contextWindow: 1000000 }],
    ["qwen3.8-flash-free",     { vision: true,  reasoning: true,  contextWindow: 1000000 }],
    ["stepfun-3.7-flash",      { vision: true,  reasoning: true,  contextWindow: 262000 }],
    ["tencent-hy3-free",       { vision: false, reasoning: false, contextWindow: 262000 }],
    ["deepseek-v4-flash",      { vision: false, reasoning: true,  contextWindow: 1000000 }],
  ];

  it.each(cases)("%s matches the gateway metadata", (model, expected) => {
    const c = getCapabilitiesForModel("bynara", model);
    expect(c.vision).toBe(expected.vision);
    expect(c.reasoning).toBe(expected.reasoning);
    expect(c.contextWindow).toBe(expected.contextWindow);
  });

  it("resolves identically via the by alias", () => {
    expect(getCapabilitiesForModel("by", "agnes-2.0-flash")).toEqual(
      getCapabilitiesForModel("bynara", "agnes-2.0-flash")
    );
  });

  it("keeps the safe default floor for unlisted passthrough models", () => {
    const c = getCapabilitiesForModel("bynara", "some-brand-new-model");
    expect(c.contextWindow).toBe(200000); // DEFAULT_CAPABILITIES
    expect(c.vision).toBe(false);
  });
});

describe("bynara pricing (USD per 1M tokens, from router.bynara.id/pricing)", () => {
  const cases = [
    ["agnes-2.0-flash",     { input: 0.03, output: 0.11 }],
    ["agnes-2.5-flash",     { input: 0.06, output: 0.28 }],
    ["grok-4.5-free",       { input: 0.40, output: 0.64 }],
    ["laguna-s-2.1",        { input: 0.00, output: 0.00 }],
    ["ling-3.0-flash-free", { input: 0.01, output: 0.02 }],
    ["mistral-large",       { input: 0.15, output: 0.45 }],
    ["mistral-medium-3-5",  { input: 0.30, output: 1.51 }],
    ["nemotron-3-ultra",    { input: 0.00, output: 0.00 }],
    ["stepfun-3.7-flash",   { input: 0.04, output: 0.23 }],
    ["tencent-hy3-free",    { input: 0.03, output: 0.11 }],
  ];

  it.each(cases)("%s is priced at bynara's pay-as-you-go rate", (model, expected) => {
    const p = getPricingForModel("bynara", model);
    expect(p).not.toBeNull();
    expect(p.input).toBeCloseTo(expected.input, 4);
    expect(p.output).toBeCloseTo(expected.output, 4);
  });

  it("resolves identically via the by alias", () => {
    expect(getPricingForModel("by", "mistral-large")).toEqual(
      getPricingForModel("bynara", "mistral-large")
    );
  });
});

describe("bynara cross-transport fallback (Anthropic /v1/messages)", () => {
  it("picks the OpenAI endpoint for OpenAI clients and the Claude endpoint for Anthropic clients", () => {
    expect(resolveTransport("bynara", "openai")?.format).toBe("openai");
    expect(resolveTransport("bynara", "openai")?.baseUrl).toContain("/chat/completions");
    expect(resolveTransport("bynara", "claude")?.format).toBe("claude");
    expect(resolveTransport("bynara", "claude")?.baseUrl).toBe("https://router.bynara.id/v1/messages");
  });

  it("falls back to /v1/messages with Bearer auth (docs: key as Bearer token, NOT x-api-key)", () => {
    const alt = resolveAlternateTransport("bynara", "openai");
    expect(alt).not.toBeNull();
    expect(alt.format).toBe("claude");
    expect(alt.baseUrl).toBe("https://router.bynara.id/v1/messages");
    // The docs explicitly say to authenticate /v1/messages with the key as a
    // Bearer token — x-api-key would 401 on this gateway.
    expect(alt.auth).toEqual({ combined: true, header: "Authorization", scheme: "bearer" });
    expect(alt.auth.header).not.toBe("x-api-key");
  });

  it("returns null for single-endpoint providers (no fallback possible)", () => {
    expect(resolveAlternateTransport("openai", "openai")).toBeNull();
  });
});

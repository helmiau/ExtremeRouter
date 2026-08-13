import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getPricingForModel } from "open-sse/providers/pricing.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";

// ── F6: alias → id normalization (single source of truth in the lookups) ────

describe("alias normalization", () => {
  it("resolves provider aliases to ids for capabilities", () => {
    // cx/gpt-5.6-sol: id-keyed PROVIDER_CAPABILITIES.codex must now win for the alias too
    expect(getCapabilitiesForModel("cx", "gpt-5.6-sol").vision).toBe(true);
    expect(getCapabilitiesForModel("cx", "gpt-5.6-sol").contextWindow).toBe(372000);
    expect(getCapabilitiesForModel("cx", "gpt-5.6-sol").maxOutput).toBe(128000);
    // ma/muse-spark-1.2: provider-scoped meta-ai reasoning must apply for the alias
    expect(getCapabilitiesForModel("ma", "muse-spark-1.2").reasoning).toBe(true);
    // th/claude-opus-5 + cbcn/glm-5.2: provider-scoped tables via aliases
    expect(getCapabilitiesForModel("th", "claude-opus-5").thinkingFormat).toBe("claude-adaptive");
    expect(getCapabilitiesForModel("cbcn", "glm-5.2").reasoning).toBe(true);
  });

  it("resolves provider aliases to ids for pricing (gh → github)", () => {
    const ghRate = { input: 1.75, output: 14, cached: 0.175, reasoning: 14, cache_creation: 1.75 };
    expect(getPricingForModel("gh", "gpt-5.3-codex")).toEqual(ghRate);
    expect(getPricingForModel("github", "gpt-5.3-codex")).toEqual(ghRate);
  });

  it("resolves provider aliases to ids for thinking levels", () => {
    expect(getThinkingLevels("cx", "gpt-5.6-sol")).toContain("ultra");
    expect(getThinkingLevels("kr", "claude-sonnet-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // kiro legacy families still hide the picker (tag-only reasoning) — unchanged
    expect(getThinkingLevels("kr", "claude-sonnet-4.5")).toBeNull();
  });

  it("leaves unknown/custom provider ids untouched", () => {
    expect(getCapabilitiesForModel("my-custom-node", "some-model").contextWindow).toBe(200000);
    expect(getPricingForModel("my-custom-node", "some-model")).toBeNull();
  });
});

// ── F2: bare o1/o3/o4 ids lost reasoning + vision ──────────────────────────

describe("o-series bare ids", () => {
  it("o1/o3/o4 (no dash) get reasoning + vision", () => {
    for (const [provider, model] of [
      ["openai", "o1"],
      ["openai", "o3"],
      ["chatgpt-web", "o3"],
      ["copilot-web", "o1"],
      ["copilot-web", "o3"],
      ["puter", "o3"],
      ["openai", "o4-mini"],
    ]) {
      const c = getCapabilitiesForModel(provider, model);
      expect(c.reasoning, `${provider}/${model}`).toBe(true);
      expect(c.vision, `${provider}/${model}`).toBe(true);
      expect(c.thinkingFormat).toBe("openai");
    }
  });

  it("keeps the narrower window for o1-mini (specific pattern wins)", () => {
    expect(getCapabilitiesForModel("openai", "o1-mini").contextWindow).toBe(128000);
  });

  it("bare o3 has pricing", () => {
    expect(getPricingForModel("openai", "o3")).not.toBeNull();
    expect(getPricingForModel("openai", "o3").input).toBe(10);
  });
});

// ── F3: MiMo-V2.5 reasoning (models.dev: reasoning:true) ────────────────────

describe("MiMo-V2.5 family", () => {
  it("reasons across providers", () => {
    for (const [provider, model] of [
      ["xiaomi-mimo", "mimo-v2.5"],
      ["xiaomi-mimo", "mimo-v2.5-pro"],
      ["opencode-go", "mimo-v2.5"],
      ["opencode-go", "mimo-v2.5-high"],
      ["opencode-go", "mimo-v2.5-max"],
      ["forge", "mimo-v2.5"],
      ["deepinfra", "XiaomiMiMo/MiMo-V2.5-Pro"],
      ["huggingchat", "XiaomiMiMo/MiMo-V2.5-Pro"],
    ]) {
      expect(getCapabilitiesForModel(provider, model).reasoning, `${provider}/${model}`).toBe(true);
    }
  });

  it("keeps 1M context and adds audio/video input", () => {
    const c = getCapabilitiesForModel("xiaomi-mimo", "mimo-v2.5");
    expect(c.contextWindow).toBe(1048576);
    expect(c.audioInput).toBe(true);
    expect(c.videoInput).toBe(true);
  });
});

// ── F4: Cohere Command A Reasoning ──────────────────────────────────────────

describe("command-a-reasoning", () => {
  it("reasons with 256k context", () => {
    const c = getCapabilitiesForModel("huggingchat", "CohereLabs/command-a-reasoning-08-2025");
    expect(c.reasoning).toBe(true);
    expect(c.contextWindow).toBe(256000);
  });
});

// ── F5: Muse Spark vision ───────────────────────────────────────────────────

describe("Muse Spark vision", () => {
  it("muse-spark-1.x has vision via provider id and alias", () => {
    expect(getCapabilitiesForModel("meta-ai", "muse-spark-1.2").vision).toBe(true);
    expect(getCapabilitiesForModel("ma", "muse-spark-1.1").vision).toBe(true);
    expect(getCapabilitiesForModel("meta-ai", "muse-spark-1.2-contributor").vision).toBe(true);
  });
});

// ── F7: kimi-latest vision ──────────────────────────────────────────────────

describe("kimi-latest vision", () => {
  it("accepts image input", () => {
    expect(getCapabilitiesForModel("kimi", "kimi-latest").vision).toBe(true);
    expect(getCapabilitiesForModel("kmc", "kimi-latest").vision).toBe(true);
  });
});

// ── F8: GLM-5.2 context window ──────────────────────────────────────────────

describe("GLM-5.2 context", () => {
  it("exposes 1M context while glm-5 stays 200k", () => {
    expect(getCapabilitiesForModel("tokenrouter", "glm-5.2").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("zhipuai", "glm-5").contextWindow).toBe(200000);
    expect(getCapabilitiesForModel("openai", "z-ai/glm-5.2").contextWindow).toBe(1000000);
  });
});

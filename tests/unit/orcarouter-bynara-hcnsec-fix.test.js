import { describe, it, expect, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getPricingForModel } from "open-sse/providers/pricing.js";
import { PROVIDERS } from "open-sse/providers/index.js";
import { DefaultExecutor } from "open-sse/executors/default.js";
import { applyThinking } from "open-sse/translator/concerns/thinkingUnified.js";

describe("orcarouter baseUrl + thinking", () => {
  it("posts to /v1/chat/completions (not bare /v1)", () => {
    expect(PROVIDERS.orcarouter.baseUrl).toBe(
      "https://api.orcarouter.ai/v1/chat/completions"
    );
    const ex = new DefaultExecutor("orcarouter", PROVIDERS.orcarouter);
    expect(ex.buildUrl("qwen/qwen3.8-27b-free", true)).toBe(
      "https://api.orcarouter.ai/v1/chat/completions"
    );
    expect(ex.buildUrl("qwen/qwen3.8-27b-free", false)).toBe(
      "https://api.orcarouter.ai/v1/chat/completions"
    );
  });

  it("uses openai thinkingFormat on transport", () => {
    expect(PROVIDERS.orcarouter.thinkingFormat).toBe("openai");
  });

  it("pins qwen3.8-27b-free caps from live model card (text, 64k, reasoning)", () => {
    const c = getCapabilitiesForModel("orcarouter", "qwen/qwen3.8-27b-free");
    expect(c.vision).toBe(false);
    expect(c.reasoning).toBe(true);
    expect(c.thinkingFormat).toBe("openai");
    expect(c.contextWindow).toBe(65536);
    expect(c.maxOutput).toBe(65536);
  });

  it("emits openai reasoning_effort (not native deepseek thinking block)", () => {
    const body = applyThinking(
      "openai",
      "deepseek/deepseek-v4-pro-free",
      { messages: [], reasoning_effort: "high" },
      "orcarouter"
    );
    expect(body.reasoning_effort).toBeTruthy();
    expect(body.thinking).toBeUndefined();
  });

  it("prices free tier at $0 and paid deepseek-v4-pro from live card", () => {
    expect(getPricingForModel("orcarouter", "qwen/qwen3.8-27b-free")).toMatchObject({
      input: 0,
      output: 0,
    });
    const paid = getPricingForModel("orcarouter", "deepseek/deepseek-v4-pro");
    expect(paid.input).toBeCloseTo(0.442, 4);
    expect(paid.output).toBeCloseTo(0.884, 4);
    expect(paid.cached).toBeCloseTo(0.06, 4);
  });
});

describe("bynara deepseek-v4 thinkingFormat openai", () => {
  it("pins deepseek-v4-pro-free to openai thinking (not deepseek native)", () => {
    const c = getCapabilitiesForModel("bynara", "deepseek-v4-pro-free");
    expect(c.reasoning).toBe(true);
    expect(c.thinkingFormat).toBe("openai");
    expect(c.vision).toBe(false);
    expect(c.thinkingMaxEffort).toBe(true);
  });

  it("transport thinkingFormat override is openai", () => {
    expect(PROVIDERS.bynara.thinkingFormat).toBe("openai");
  });

  it("applyThinking emits reasoning_effort only (no thinking:{type})", () => {
    const body = applyThinking(
      "openai",
      "deepseek-v4-pro-free",
      { messages: [], reasoning_effort: "high" },
      "bynara"
    );
    expect(body.reasoning_effort).toBeTruthy();
    expect(body.thinking).toBeUndefined();
  });
});

describe("hcnsec soft 429 retry + openai thinking", () => {
  it("retries 429 twice in-place", () => {
    expect(PROVIDERS.hcnsec.retry).toEqual({ "429": 2 });
  });

  it("uses openai thinkingFormat on transport", () => {
    expect(PROVIDERS.hcnsec.thinkingFormat).toBe("openai");
  });

  it("applyThinking for DeepSeek-V4-Pro uses openai shape", () => {
    const body = applyThinking(
      "openai",
      "DeepSeek-V4-Pro",
      { messages: [], reasoning_effort: "high" },
      "hcnsec"
    );
    expect(body.reasoning_effort).toBeTruthy();
    expect(body.thinking).toBeUndefined();
  });
});

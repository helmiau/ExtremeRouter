import { describe, it, expect } from "vitest";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { applyThinking } from "open-sse/translator/concerns/thinkingUnified.js";

/**
 * Advertised thinking-effort levels, validated against official vendor docs
 * (2026-08): Claude platform effort docs (low/medium/high/xhigh/max), xAI
 * Grok 4.5 reasoning docs (low/medium/high), Moonshot Kimi K3 docs
 * (low/high/max, always-on), Z.ai migrate-to-GLM-5.2 docs (high/max), and
 * OpenAI GPT-5.x reasoning docs. These assertions pin the picker + wire to the
 * vendor enums so a doc drift can't silently change what users can select.
 */
describe("thinking-effort levels vs vendor docs", () => {
  it("Claude 5 family advertises the full official effort enum", () => {
    // platform.claude.com/docs: low | medium | high | xhigh | max
    expect(getThinkingLevels("kiro", "claude-sonnet-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getThinkingLevels("kiro", "claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getThinkingLevels("kiro", "claude-haiku-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("Grok 4.5 advertises exactly low/medium/high (xAI docs)", () => {
    expect(getThinkingLevels("xai", "grok-4.5")).toEqual(["low", "medium", "high"]);
  });

  it("Kimi K3 advertises exactly low/high/max and cannot disable (Moonshot docs)", () => {
    expect(getThinkingLevels("kimi", "kimi-k3")).toEqual(["low", "high", "max"]);
    const caps = getCapabilitiesForModel("kimi", "kimi-k3");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.thinkingMaxEffort).toBe(true);
  });

  it("GLM-5.2 advertises exactly high/max (Z.ai migrate docs) and older GLM keeps no effort", () => {
    expect(getThinkingLevels("zhipuai", "glm-5.2")).toEqual(["high", "max"]);
    // Older GLM families are not restricted to high/max (generic EFFORT fallback)
    expect(getThinkingLevels("zhipuai", "glm-5")).toContain("minimal");
    expect(getThinkingLevels("zhipuai", "glm-4.7")).toContain("low");
  });

  it("Codex GPT-5.6 Sol/Terra advertise the full range + ultra (codex backend)", () => {
    expect(getThinkingLevels("codex", "gpt-5.6-sol")).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(getThinkingLevels("codex", "gpt-5.6-terra")).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(getThinkingLevels("codex", "gpt-5.6-luna")).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("Muse Spark advertises its native minimal..xhigh tiers", () => {
    expect(getCapabilitiesForModel("meta-ai", "muse-spark-1.2").thinkingLevels).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(getThinkingLevels("meta-ai", "muse-spark-1.2")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });
});

describe("GLM-5.2 reasoning_effort wiring (zai format)", () => {
  const body = () => ({ model: "glm-5.2", messages: [{ role: "user", content: "hi" }] });

  it("sets reasoning_effort=max for max/xhigh/ultra requests", () => {
    const out = applyThinking("openai", "glm-5.2", body(), "zhipuai", { mode: "level", level: "max" });
    expect(out.reasoning_effort).toBe("max");
    expect(out.thinking).toEqual({ type: "enabled" });
  });

  it("sets reasoning_effort=high for high/low/medium requests", () => {
    const out = applyThinking("openai", "glm-5.2", body(), "zhipuai", { mode: "level", level: "high" });
    expect(out.reasoning_effort).toBe("high");
    const low = applyThinking("openai", "glm-5.2", body(), "zhipuai", { mode: "level", level: "low" });
    expect(low.reasoning_effort).toBe("high");
  });

  it("does not send reasoning_effort for older GLM (4.x/5/5.1 reject it)", () => {
    const out = applyThinking("openai", "glm-5", body(), "zhipuai", { mode: "level", level: "high" });
    expect(out.reasoning_effort).toBeUndefined();
    const out47 = applyThinking("openai", "glm-4.7", body(), "zhipuai", { mode: "level", level: "max" });
    expect(out47.reasoning_effort).toBeUndefined();
    expect(out47.thinking).toEqual({ type: "enabled" });
  });

  it("disables thinking via enable_thinking:false", () => {
    const out = applyThinking("openai", "glm-5.2", body(), "zhipuai", { mode: "none" });
    expect(out.enable_thinking).toBe(false);
    expect(out.thinking).toBeUndefined();
    expect(out.reasoning_effort).toBeUndefined();
  });
});

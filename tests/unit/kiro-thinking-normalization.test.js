import { describe, it, expect } from "vitest";
import { resolveKiroModelIntent, applyKiroThinkingOverride, resolveKiroEffortPath } from "../../open-sse/config/kiroConstants.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

describe("resolveKiroEffortPath", () => {
  it("returns kiro-claude for Claude 5 family", () => {
    expect(resolveKiroEffortPath("claude-sonnet-5")).toBe("kiro-claude");
    expect(resolveKiroEffortPath("claude-opus-5")).toBe("kiro-claude");
    expect(resolveKiroEffortPath("claude-haiku-5")).toBe("kiro-claude");
  });

  it("returns null for legacy Claude 4.x (NOT native effort)", () => {
    expect(resolveKiroEffortPath("claude-sonnet-4.5")).toBeNull();
    expect(resolveKiroEffortPath("claude-opus-4.6")).toBeNull();
  });

  it("returns kiro-gpt for GPT-5.6 family", () => {
    expect(resolveKiroEffortPath("gpt-5.6-sol")).toBe("kiro-gpt");
    expect(resolveKiroEffortPath("gpt-5.6-terra")).toBe("kiro-gpt");
    expect(resolveKiroEffortPath("gpt-5.6-luna")).toBe("kiro-gpt");
  });

  it("returns null for non-Claude/GPT families", () => {
    expect(resolveKiroEffortPath("glm-5")).toBeNull();
    expect(resolveKiroEffortPath("deepseek-3.2")).toBeNull();
    expect(resolveKiroEffortPath("qwen3-coder-next")).toBeNull();
    expect(resolveKiroEffortPath("MiniMax-M2.5")).toBeNull();
  });
});

describe("resolveKiroModelIntent", () => {
  it("strips (high) suffix before resolving synthetic variants", () => {
    const intent = resolveKiroModelIntent("claude-sonnet-4.5-thinking-agentic(high)");
    expect(intent.model).toBe("claude-sonnet-4.5-thinking-agentic");
    expect(intent.upstream).toBe("claude-sonnet-4.5");
    expect(intent.agentic).toBe(true);
    expect(intent.thinking).toBe(true);
    expect(intent.thinkingOverride).toEqual({ mode: "level", level: "high" });
  });

  it("strips (medium) suffix for glm models", () => {
    const intent = resolveKiroModelIntent("glm-5-thinking-agentic(medium)");
    expect(intent.upstream).toBe("glm-5");
    expect(intent.agentic).toBe(true);
    expect(intent.thinking).toBe(true);
    expect(intent.thinkingOverride).toEqual({ mode: "level", level: "medium" });
  });

  it("returns null override when no suffix present", () => {
    const intent = resolveKiroModelIntent("claude-sonnet-5");
    expect(intent.thinkingOverride).toBeNull();
    expect(intent.upstream).toBe("claude-sonnet-5");
  });

  it("handles budget suffix like (8192)", () => {
    const intent = resolveKiroModelIntent("claude-sonnet-5(8192)");
    expect(intent.thinkingOverride).toEqual({ mode: "budget", budget: 8192 });
    expect(intent.upstream).toBe("claude-sonnet-5");
  });

  it("handles none/off suffix", () => {
    const intent = resolveKiroModelIntent("claude-sonnet-5(none)");
    expect(intent.thinkingOverride).toEqual({ mode: "none" });
  });
});

describe("applyKiroThinkingOverride", () => {
  it("returns body unchanged when override is null", () => {
    const body = { messages: [] };
    expect(applyKiroThinkingOverride(body, null)).toBe(body);
  });

  it("sets output_config.effort for level override", () => {
    const body = { messages: [] };
    const result = applyKiroThinkingOverride(body, { mode: "level", level: "high" });
    expect(result.output_config).toEqual({ effort: "high" });
  });

  it("merges with existing output_config", () => {
    const body = { messages: [], output_config: { foo: "bar" } };
    const result = applyKiroThinkingOverride(body, { mode: "level", level: "medium" });
    expect(result.output_config).toEqual({ foo: "bar", effort: "medium" });
  });

  it("sets thinking budget for budget override", () => {
    const body = { messages: [], reasoning_effort: "high" };
    const result = applyKiroThinkingOverride(body, { mode: "budget", budget: 8192 });
    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(result.reasoning_effort).toBeUndefined();
  });

  it("sets effort to mode name for auto/none", () => {
    const result = applyKiroThinkingOverride({}, { mode: "auto" });
    expect(result.output_config.effort).toBe("auto");
  });
});

describe("getThinkingLevels for Kiro", () => {
  it("does not advertise native intensity for legacy Kiro models", () => {
    expect(getThinkingLevels("kiro", "claude-sonnet-4.5")).toBeNull();
    expect(getThinkingLevels("kiro", "glm-5")).toBeNull();
    expect(getThinkingLevels("kiro", "deepseek-3.2")).toBeNull();
  });

  it("advertises native levels for Claude 5 family", () => {
    const levels = getThinkingLevels("kiro", "claude-sonnet-5");
    expect(levels).toContain("high");
    expect(levels).toContain("medium");
    expect(levels).toContain("low");
  });

  it("advertises native levels for GPT-5.6 family", () => {
    const levels = getThinkingLevels("kiro", "gpt-5.6-sol");
    expect(levels).toContain("high");
    expect(levels).toContain("xhigh");
    expect(levels).toContain("max");
  });
});

describe("getThinkingLevels for explicit thinkingLevels caps", () => {
  it("kimi-k3 → low/high/max only", () => {
    expect(getThinkingLevels("moonshot", "kimi-k3")).toEqual(["low", "high", "max"]);
  });
  it("laguna-s-2.1 → low/medium/high/xhigh", () => {
    expect(getThinkingLevels("cline", "poolside/laguna-s-2.1:free")).toEqual(["low", "medium", "high", "xhigh"]);
  });
  it("step-3.7 → low/medium/high only", () => {
    expect(getThinkingLevels("stepfun", "step-3.7-flash")).toEqual(["low", "medium", "high"]);
  });
  it("older step-3 flash keeps default effort set (no explicit list)", () => {
    const levels = getThinkingLevels("stepfun", "step-3-flash");
    expect(levels).toContain("minimal");
    expect(levels).toContain("medium");
    expect(levels).not.toContain("max");
  });
});

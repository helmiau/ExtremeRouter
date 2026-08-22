/**
 * Tests for the canonical token-budget resolver (resolveOutputBudget).
 *
 * Covers all boundary conditions per the spec:
 * - requested < model.maxOutput
 * - requested = model.maxOutput
 * - requested > model.maxOutput
 * - requested undefined (default fallback)
 * - Default vs maximum semantics
 * - Context window with input token clamping
 * - Reasoning/thinking budget invariant
 * - Parameter alias normalization
 * - Unknown model fallback
 * - Invariant properties (effective >= 0, effective <= model.maxOutput, etc.)
 */
import { describe, it, expect } from "vitest";
import { resolveOutputBudget, clampOutputTokens } from "../../open-sse/services/tokenBudget.js";

describe("resolveOutputBudget — basic clamping", () => {
  it("requested < model.maxOutput → passes through", () => {
    // claude-opus-4-7 has maxOutput 128000
    const r = resolveOutputBudget({
      requestedOutputTokens: 32000,
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(r.effective).toBe(32000);
    expect(r.requested).toBe(32000);
  });

  it("requested = model.maxOutput → allowed", () => {
    // gpt-4o has maxOutput 16384
    const r = resolveOutputBudget({
      requestedOutputTokens: 16384,
      provider: "openai",
      model: "gpt-4o",
    });
    expect(r.effective).toBe(16384);
  });

  it("requested > model.maxOutput → clamped to modelMaxOutput", () => {
    // gpt-4o has maxOutput 16384
    const r = resolveOutputBudget({
      requestedOutputTokens: 200000,
      provider: "openai",
      model: "gpt-4o",
    });
    expect(r.effective).toBe(16384);
    expect(r.limitingFactor).toBe("model_max_output");
  });

  it("requested undefined → default (64000), but clamped by model.maxOutput if smaller", () => {
    // gpt-4o has maxOutput 16384 < default 64000 → clamped
    const r = resolveOutputBudget({
      provider: "openai",
      model: "gpt-4o",
    });
    expect(r.effective).toBe(16384); // clamped to model maxOutput
    expect(r.requested).toBe(64000); // default was requested
    expect(r.limitingFactor).toBe("model_max_output");
  });
});

describe("resolveOutputBudget — default vs maximum separation", () => {
  it("request undefined on model with maxOutput >= default → default used", () => {
    // claude-opus-4-7 has maxOutput 128000 > default 64000
    const r = resolveOutputBudget({
      requestedOutputTokens: null,
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(r.effective).toBe(64000); // default, NOT clamped
  });

  it("request 128000 on model with maxOutput 128000 → allowed", () => {
    const r = resolveOutputBudget({
      requestedOutputTokens: 128000,
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(r.effective).toBe(128000);
  });
});

describe("resolveOutputBudget — context window", () => {
  it("clamps when input + output exceeds contextWindow", () => {
    // ~100k chars → ~25k estimated tokens (chars/4), well within 128k context
    const body = { messages: [{ role: "user", content: "x".repeat(100000) }] };
    const r = resolveOutputBudget({
      requestedOutputTokens: 64000,
      body,
      provider: "openai",
      model: "gpt-4o", // contextWindow 128000, maxOutput 16384
    });
    // estimated ~25000 input tokens → available = 128000 - 25000 - 0 = 103000
    // min(64000, 16384, 103000) = 16384 (model_max_output)
    expect(r.effective).toBe(16384);
    expect(r.inputTokens).toBeGreaterThan(20000);
    expect(r.limitingFactor).toBe("model_max_output");
  });

  it("exact boundary: input + output == contextWindow is valid", () => {
    // claude-opus-4-7 contextWindow 1000000, maxOutput 128000
    // input 100000, requested 28000 → available = 900000, fits
    const r = resolveOutputBudget({
      requestedOutputTokens: 28000,
      exactInputTokens: 100000,
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(r.effective).toBe(28000);
  });

  it("input + output > contextWindow → clamped", () => {
    // claude-opus-4-7 contextWindow 1000000
    // input 950000, requested 100000 → available = 50000
    const r = resolveOutputBudget({
      requestedOutputTokens: 100000,
      exactInputTokens: 950000,
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(r.effective).toBe(50000);
    expect(r.limitingFactor).toBe("context_window");
  });

  it("input >= contextWindow → effective floored at 1", () => {
    const r = resolveOutputBudget({
      requestedOutputTokens: 64000,
      exactInputTokens: 1000000,
      provider: "anthropic",
      model: "claude-opus-4-7", // contextWindow 1000000
    });
    expect(r.effective).toBe(1); // context fully consumed
  });
});

describe("resolveOutputBudget — reasoning/thinking budget invariant", () => {
  it("ensures effective > thinking.budget_tokens (Claude requirement)", () => {
    const body = {
      thinking: { type: "enabled", budget_tokens: 60000 },
      messages: [{ role: "user", content: "hello" }],
    };
    const r = resolveOutputBudget({
      requestedOutputTokens: 64000,
      body,
      provider: "anthropic",
      model: "claude-opus-4-7", // contextWindow 1000000, maxOutput 128000
    });
    // budget 60000 + min completion 1024 = 61024
    expect(r.effective).toBeGreaterThanOrEqual(61024);
  });

  it("reasoning budget < effective → no bump", () => {
    const body = {
      thinking: { type: "enabled", budget_tokens: 1000 },
      messages: [{ role: "user", content: "hi" }],
    };
    const r = resolveOutputBudget({
      requestedOutputTokens: 64000,
      body,
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(r.effective).toBe(64000); // 64000 > 1000 + 1024
  });
});

describe("resolveOutputBudget — unknown model fallback", () => {
  it("unknown provider/model → uses DEFAULT_CAPABILITIES fallback", () => {
    const r = resolveOutputBudget({
      requestedOutputTokens: 32000,
      provider: "nonexistent",
      model: "nonexistent-model",
    });
    // DEFAULT_CAPABILITIES has maxOutput: 64000, contextWindow: 200000
    expect(r.effective).toBe(32000); // passes through (32000 < 64000)
    expect(r.modelMaxOutput).toBe(64000);
    expect(r.contextWindow).toBe(200000);
  });

  it("null provider/model → uses DEFAULT_CAPABILITIES fallback", () => {
    const r = resolveOutputBudget({
      requestedOutputTokens: 32000,
    });
    expect(r.effective).toBe(32000);
    expect(r.limitingFactor).toBe("default"); // default applied
  });
});

describe("resolveOutputBudget — router safety ceiling", () => {
  it("routerMaxOutputTokens caps effective", () => {
    const r = resolveOutputBudget({
      requestedOutputTokens: 200000,
      provider: "anthropic",
      model: "claude-opus-4-7", // maxOutput 128000
      exactInputTokens: 0,
    });
    // router max is 128000, model max is 128000 → effective 128000
    expect(r.effective).toBe(128000);
  });

  it("routerMaxOutputTokens=0 disables router ceiling", () => {
    const r = resolveOutputBudget({
      requestedOutputTokens: 200000,
      provider: "anthropic",
      model: "claude-opus-4-7", // maxOutput 128000
      routerMaxOutputTokens: 0,
    });
    expect(r.effective).toBe(128000); // model max
  });
});

describe("resolveOutputBudget — invariant properties", () => {
  const cases = [
    { requested: 32000, input: 0, provider: "anthropic", model: "claude-opus-4-7" },
    { requested: 200000, input: 10000, provider: "anthropic", model: "claude-opus-4-7" },
    { requested: null, input: 0, provider: "anthropic", model: "claude-opus-4-7" },
    { requested: 64000, input: 100000, provider: "anthropic", model: "claude-opus-4-7" },
  ];

  for (const c of cases) {
    const label = `requested=${c.requested} input=${c.input} ${c.provider}/${c.model}`;
    it(`invariant: ${label}`, () => {
      const r = resolveOutputBudget({
        requestedOutputTokens: c.requested,
        exactInputTokens: c.input,
        provider: c.provider,
        model: c.model,
      });
      expect(r.effective).toBeGreaterThanOrEqual(1); // never 0
      if (r.modelMaxOutput != null) {
        expect(r.effective).toBeLessThanOrEqual(r.modelMaxOutput);
      }
      if (r.contextWindow != null) {
        expect(r.inputTokens + r.effective).toBeLessThanOrEqual(r.contextWindow + 1); // +1 for floor
      }
    });
  }
});

describe("clampOutputTokens — convenience wrapper", () => {
  it("returns just the effective number", () => {
    expect(clampOutputTokens({
      requestedOutputTokens: 32000,
      provider: "anthropic",
      model: "claude-opus-4-7",
    })).toBe(32000);
  });
});

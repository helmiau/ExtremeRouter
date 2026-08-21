import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { applyThinking } from "open-sse/translator/concerns/thinkingUnified.js";

// TokenRouter's qwen backend only accepts reasoning_effort low|medium
// (high/max/none/auto rejected by the validator, xhigh 422s upstream).
describe("tokenrouter qwen thinking clamp", () => {
  const provider = "tokenrouter";
  const model = "qwen/qwen3.8-max-free";

  it("resolves openai thinking format with low/medium levels only", () => {
    const caps = getCapabilitiesForModel(provider, model);
    expect(caps.thinkingFormat).toBe("openai");
    expect(caps.thinkingLevels).toEqual(["low", "medium"]);
    expect(caps.thinkingCanDisable).toBe(false);
  });

  it("clamps out-of-range effort to medium (never crashes upstream)", () => {
    for (const value of ["xhigh", "high", "max"]) {
      const body = applyThinking("openai", model, { reasoning_effort: value }, provider);
      expect(body.reasoning_effort).toBe("medium");
    }
  });

  it("clamps disable request to low instead of emitting invalid none", () => {
    const body = applyThinking("openai", model, { reasoning_effort: "none" }, provider);
    expect(body.reasoning_effort).toBe("low");
  });

  it("leaves other providers on the native qwen wire format", () => {
    const caps = getCapabilitiesForModel("orcarouter", model);
    expect(caps.thinkingFormat).toBe("qwen");
  });
});

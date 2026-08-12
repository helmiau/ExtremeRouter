import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

// xai/grok-4.5: effort levels low/medium/high, 500k context. Verified against
// open-sse/providers/registry/xai.js transport + pricing.js, per the design
// intent of cek (a)(b)(c): the provider advertises these levels, not minimal/max.
describe("grok-4.5 thinking capabilities", () => {
  it("advertises exactly low/medium/high (no minimal, no max)", () => {
    expect(getThinkingLevels("xai", "grok-4.5")).toEqual(["low", "medium", "high"]);
  });

  it("keeps grok-4 (legacy) on the EFFORT fallback (minimal included)", () => {
    expect(getThinkingLevels("xai", "grok-4")).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("grok-4.5 has 500k context cap", () => {
    expect(getCapabilitiesForModel("xai", "grok-4.5").contextWindow).toBe(500000);
  });

  it("grok-4.5 caps: reasoning + vision + openai wire format", () => {
    const caps = getCapabilitiesForModel("xai", "grok-4.5");
    expect(caps.reasoning).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.search).toBe(true);
    expect(caps.thinkingFormat).toBe("openai");
  });
});

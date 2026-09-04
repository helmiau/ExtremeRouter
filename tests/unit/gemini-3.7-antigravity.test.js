import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import antigravityRegistry from "../../open-sse/providers/registry/antigravity.js";
import geminiRegistry from "../../open-sse/providers/registry/gemini.js";
import { MODEL_PRICING } from "../../open-sse/providers/pricing.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { MITM_TOOLS } from "../../src/shared/constants/cliTools.js";

describe("Gemini 3.7 Flash Support & Config", () => {
  it("registers gemini-3.7-flash tiered models in antigravity provider registry", () => {
    const agIds = antigravityRegistry.models.map((m) => m.id);
    expect(agIds).toContain("gemini-3.7-flash-high");
    expect(agIds).toContain("gemini-3.7-flash-medium");
    expect(agIds).toContain("gemini-3.7-flash-low");
    expect(agIds).not.toContain("gemini-3.7-flash");
  });

  it("registers gemini-3.7-flash in gemini provider registry", () => {
    const geminiIds = geminiRegistry.models.map((m) => m.id);
    expect(geminiIds).toContain("gemini-3.7-flash");
    expect(geminiIds).toContain("gemini-3.6-flash");
  });

  it("resolves capabilities correctly for gemini-3.7 models with official limits", () => {
    const caps = getCapabilitiesForModel("antigravity", "gemini-3.7-flash-high");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
  });

  it("defines pricing matching gemini-3.6-flash baseline", () => {
    expect(MODEL_PRICING["gemini-3.7-flash"]).toEqual(MODEL_PRICING["gemini-3.6-flash"]);
    expect(MODEL_PRICING["gemini-3.7-flash-high"]).toEqual(MODEL_PRICING["gemini-3.6-flash-high"]);
    expect(MODEL_PRICING["gemini-3.7-flash-medium"]).toEqual(MODEL_PRICING["gemini-3.6-flash-medium"]);
    expect(MODEL_PRICING["gemini-3.7-flash-low"]).toEqual(MODEL_PRICING["gemini-3.6-flash-low"]);
  });

  it("resolves tiered upstream ids to the single plain wire id", () => {
    expect(getModelUpstreamId("ag", "gemini-3.7-flash-high")).toBe("gemini-3.7-flash-tiered");
    expect(getModelUpstreamId("ag", "gemini-3.7-flash-medium")).toBe("gemini-3.7-flash-tiered");
    expect(getModelUpstreamId("ag", "gemini-3.7-flash-low")).toBe("gemini-3.7-flash-tiered");
  });

  it("exposes 3.7 tiers on MITM tool aliases without changing default first model", () => {
    const ag = MITM_TOOLS.antigravity;
    expect(ag.defaultModels[0]?.id).toBe("gemini-3.5-flash-low");
    for (const id of ["gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low"]) {
      expect(ag.modelAliases).toContain(id);
      expect(ag.defaultModels.some((m) => m.id === id)).toBe(true);
    }
  });
});

describe("Gemini 3.8 Flash Support & Config", () => {
  it("registers gemini-3.8-flash tiered models in antigravity provider registry", () => {
    const agIds = antigravityRegistry.models.map((m) => m.id);
    expect(agIds).toContain("gemini-3.8-flash-high");
    expect(agIds).toContain("gemini-3.8-flash-medium");
    expect(agIds).toContain("gemini-3.8-flash-low");
    expect(agIds).toContain("gemini-3.8-flash");
  });

  it("resolves capabilities correctly for gemini-3.8 models with official limits", () => {
    const caps = getCapabilitiesForModel("antigravity", "gemini-3.8-flash-high");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
  });

  it("defines pricing matching gemini-3.7-flash baseline", () => {
    expect(MODEL_PRICING["gemini-3.8-flash"]).toEqual(MODEL_PRICING["gemini-3.7-flash"]);
    expect(MODEL_PRICING["gemini-3.8-flash-high"]).toEqual(MODEL_PRICING["gemini-3.7-flash-high"]);
    expect(MODEL_PRICING["gemini-3.8-flash-medium"]).toEqual(MODEL_PRICING["gemini-3.7-flash-medium"]);
    expect(MODEL_PRICING["gemini-3.8-flash-low"]).toEqual(MODEL_PRICING["gemini-3.7-flash-low"]);
  });

  it("resolves tiered upstream ids to the single plain wire id", () => {
    expect(getModelUpstreamId("ag", "gemini-3.8-flash-high")).toBe("gemini-3.8-flash-tiered");
    expect(getModelUpstreamId("ag", "gemini-3.8-flash-medium")).toBe("gemini-3.8-flash-tiered");
    expect(getModelUpstreamId("ag", "gemini-3.8-flash-low")).toBe("gemini-3.8-flash-tiered");
  });

  it("exposes 3.8 tiers on MITM tool aliases without changing default first model", () => {
    const ag = MITM_TOOLS.antigravity;
    expect(ag.defaultModels[0]?.id).toBe("gemini-3.5-flash-low");
    for (const id of ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "gemini-3.8-flash"]) {
      expect(ag.modelAliases).toContain(id);
      expect(ag.defaultModels.some((m) => m.id === id)).toBe(true);
    }
  });
});

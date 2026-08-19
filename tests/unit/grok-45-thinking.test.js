import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

// xai/grok-4.5: effort levels low/medium/high, 500k context.
// xai/grok-4.6: effort levels low/medium/high/xhigh, 500k context, $2/$6.
// Verified against open-sse/providers/registry/xai.js + pricing.js + docs.x.ai.
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

describe("grok-4.6 thinking capabilities + pricing", () => {
  it("advertises low/medium/high/xhigh (no minimal)", () => {
    expect(getThinkingLevels("xai", "grok-4.6")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("has 500k context + reasoning + vision + openai format", () => {
    const caps = getCapabilitiesForModel("xai", "grok-4.6");
    expect(caps.contextWindow).toBe(500000);
    expect(caps.reasoning).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.search).toBe(true);
    expect(caps.thinkingFormat).toBe("openai");
    expect(caps.thinkingLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(caps.thinkingMaxEffort).toBe(true);
  });

  it("is priced at $2/$6 with $0.50 cached (official xAI rate)", () => {
    const p = getPricingForModel("xai", "grok-4.6");
    expect(p).not.toBeNull();
    expect(p.input).toBeCloseTo(2, 4);
    expect(p.output).toBeCloseTo(6, 4);
    expect(p.cached).toBeCloseTo(0.5, 4);
  });

  it("grok-4.5 pricing stays $2/$6 with $0.30 cached", () => {
    const p = getPricingForModel("xai", "grok-4.5");
    expect(p.input).toBeCloseTo(2, 4);
    expect(p.output).toBeCloseTo(6, 4);
    expect(p.cached).toBeCloseTo(0.3, 4);
  });
});

describe("xai quota tracker (local gateway spend)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns local gateway spend quotas when no mgmtKey and no history", async () => {
    vi.doMock("@/lib/usageDb.js", () => ({
      getUsageHistory: async () => [],
    }));
    const { getXaiUsage } = await import("../../open-sse/services/usage/xai.js");
    const out = await getXaiUsage({ connectionId: "conn-1", providerSpecificData: {} });
    expect(out.quotas["Gateway spend"]).toBeDefined();
    expect(out.quotas["Gateway spend"].used).toBe(0);
    expect(out.quotas["Gateway tokens"].used).toBe(0);
    expect(out.message).toMatch(/no public billing API/i);
  });

  it("aggregates cost + tokens from usageHistory for the connection", async () => {
    vi.doMock("@/lib/usageDb.js", () => ({
      getUsageHistory: async ({ connectionId, provider }) => {
        expect(connectionId).toBe("conn-xai");
        expect(provider).toBe("xai");
        return [
          { cost: 0.012, promptTokens: 1000, completionTokens: 200 },
          { cost: 0.008, promptTokens: 500, completionTokens: 100, tokens: { prompt: 500, completion: 100 } },
        ];
      },
    }));
    const { getXaiUsage } = await import("../../open-sse/services/usage/xai.js");
    const out = await getXaiUsage({ connectionId: "conn-xai", providerSpecificData: {} });
    expect(out.quotas["Gateway spend"].used).toBeCloseTo(0.02, 6);
    expect(out.quotas["Gateway tokens"].used).toBe(1800);
    expect(out.credits.used).toBeCloseTo(0.02, 6);
    expect(out.message).toMatch(/local gateway spend/i);
  });

  it("acknowledges mgmtKey even when Management API is unreachable", async () => {
    vi.doMock("@/lib/usageDb.js", () => ({
      getUsageHistory: async () => [],
    }));
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: async () => ({ ok: false, status: 404 }),
    }));
    const { getXaiUsage } = await import("../../open-sse/services/usage/xai.js");
    const out = await getXaiUsage({
      connectionId: "conn-2",
      providerSpecificData: { mgmtKey: "mgmt-test-key" },
    });
    expect(out.message).toMatch(/Management API key is set/i);
    expect(out.quotas["Gateway spend"]).toBeDefined();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

const mockFetchWithTimeout = vi.fn();
vi.mock("../../open-sse/services/usage/shared.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchWithTimeout: (...args) => mockFetchWithTimeout(...args),
  };
});

function jsonResponse(status, data) {
  return { ok: status < 400, status, json: async () => data };
}

describe("getAntigravityUsage — 4 Consolidated Quota Families", () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it("consolidates Gemini 3.7 / 3.6 / Gemini tiers into a single Gemini Family quota bucket alongside Claude and GPT-OSS", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse(200, {
      cloudaicompanionProject: "project-1",
      currentTier: { name: "Pro" },
    }));
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse(200, {
      models: {
        "gemini-3.7-flash-high": {
          displayName: "Gemini 3.7 Flash (High)",
          quotaInfo: { remainingFraction: 0.6, resetTime: "2026-08-25T12:00:00Z" },
        },
        "gemini-3.7-flash-medium": {
          displayName: "Gemini 3.7 Flash (Medium)",
          quotaInfo: { remainingFraction: 0.6, resetTime: "2026-08-25T12:00:00Z" },
        },
        "gemini-3.6-flash-high": {
          displayName: "Gemini 3.6 Flash (High)",
          quotaInfo: { remainingFraction: 0.6, resetTime: "2026-08-25T12:00:00Z" },
        },
        "claude-sonnet-4-6": {
          displayName: "Claude Sonnet 4.6 (Thinking)",
          quotaInfo: { remainingFraction: 0.85, resetTime: "2026-08-25T14:00:00Z" },
        },
        "claude-opus-4-6-thinking": {
          displayName: "Claude Opus 4.6 (Thinking)",
          quotaInfo: { remainingFraction: 0.90, resetTime: "2026-08-25T14:00:00Z" },
        },
        "gpt-oss-120b-medium": {
          displayName: "GPT-OSS 120B (Medium)",
          quotaInfo: { remainingFraction: 1.0, resetTime: "2026-08-25T14:00:00Z" },
        },
        "internal-model": {
          displayName: "Internal",
          isInternal: true,
          quotaInfo: { remainingFraction: 0.5 },
        },
      },
    }));

    const usage = await getAntigravityUsage("access-token", {}, {});

    // Exactly 4 consolidated families:
    expect(Object.keys(usage.quotas)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
      "gemini-family",
    ]);

    expect(usage.quotas["gemini-family"]).toMatchObject({
      used: 400,
      total: 1000,
      remainingPercentage: 60,
      displayName: "Gemini Family",
    });

    expect(usage.quotas["claude-sonnet-4-6"]).toMatchObject({
      used: 150,
      total: 1000,
      remainingPercentage: 85,
      displayName: "Claude Sonnet 4.6 (Thinking)",
    });

    expect(usage.quotas["claude-opus-4-6-thinking"]).toMatchObject({
      used: 100,
      total: 1000,
      remainingPercentage: 90,
      displayName: "Claude Opus 4.6 (Thinking)",
    });

    expect(usage.quotas["gpt-oss-120b-medium"]).toMatchObject({
      used: 0,
      total: 1000,
      remainingPercentage: 100,
      displayName: "GPT-OSS 120B (Medium)",
    });

    expect(usage.quotas).not.toHaveProperty("internal-model");
  });

  it("normalizes provider quota data for UI display in 4 family order", async () => {
    const { parseQuotaData } = await import("../../src/app/(dashboard)/dashboard/quota/components/ProviderLimits/utils.js");

    const data = {
      quotas: {
        "gemini-family": {
          displayName: "Gemini Family",
          used: 400,
          total: 1000,
          remainingPercentage: 60,
          resetAt: "2026-08-25T12:00:00Z",
        },
        "claude-sonnet-4-6": {
          displayName: "Claude Sonnet 4.6 (Thinking)",
          used: 150,
          total: 1000,
          remainingPercentage: 85,
          resetAt: "2026-08-25T14:00:00Z",
        },
        "gpt-oss-120b-medium": {
          displayName: "GPT-OSS 120B (Medium)",
          used: 0,
          total: 1000,
          remainingPercentage: 100,
          resetAt: "2026-08-25T14:00:00Z",
        },
        "claude-opus-4-6-thinking": {
          displayName: "Claude Opus 4.6 (Thinking)",
          used: 100,
          total: 1000,
          remainingPercentage: 90,
          resetAt: "2026-08-25T14:00:00Z",
        },
      },
    };

    const normalized = parseQuotaData("antigravity", data);
    expect(normalized).toHaveLength(4);
    expect(normalized.map(q => q.name)).toEqual([
      "Claude Sonnet 4.6 (Thinking)",
      "Claude Opus 4.6 (Thinking)",
      "GPT-OSS 120B (Medium)",
      "Gemini Family",
    ]);
  });
});

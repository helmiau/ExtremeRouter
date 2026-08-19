import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetchWithTimeout = vi.fn();
vi.mock("open-sse/services/usage/shared.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchWithTimeout: (...args) => mockFetchWithTimeout(...args),
  };
});

function jsonResponse(status, data) {
  return { ok: status < 400, status, json: async () => data };
}

describe("getAntigravityUsage — Gemini 3.7 Flash in importantModels", () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it("returns quotas for Gemini 3.7 Flash tiers so dashboard can render usage bars", async () => {
    const { getAntigravityUsage } = await import("open-sse/services/usage/google.js");

    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse(200, {
      cloudaicompanionProject: "project-1",
      currentTier: { name: "Pro" },
    }));
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse(200, {
      models: {
        "gemini-3.7-flash-high": {
          displayName: "Gemini 3.7 Flash (High)",
          quotaInfo: { remainingFraction: 0.85, resetTime: "2026-08-25T12:00:00Z" },
        },
        "gemini-3.7-flash-medium": {
          displayName: "Gemini 3.7 Flash (Medium)",
          quotaInfo: { remainingFraction: 0.6, resetTime: "2026-08-25T12:00:00Z" },
        },
        "gemini-3.7-flash-low": {
          displayName: "Gemini 3.7 Flash (Low)",
          quotaInfo: { remainingFraction: 0.35, resetTime: "2026-08-25T12:00:00Z" },
        },
        "internal-model": {
          displayName: "Internal",
          isInternal: true,
          quotaInfo: { remainingFraction: 0.5 },
        },
      },
    }));

    const usage = await getAntigravityUsage("access-token", {}, {});

    expect(usage.quotas["gemini-3.7-flash-high"]).toMatchObject({
      used: 150,
      total: 1000,
      remainingPercentage: 85,
      displayName: "Gemini 3.7 Flash (High)",
    });
    expect(usage.quotas["gemini-3.7-flash-medium"]).toMatchObject({
      used: 400,
      total: 1000,
      remainingPercentage: 60,
    });
    expect(usage.quotas["gemini-3.7-flash-low"]).toMatchObject({
      used: 650,
      total: 1000,
      remainingPercentage: 35,
    });
    expect(usage.quotas).not.toHaveProperty("internal-model");
  });
});

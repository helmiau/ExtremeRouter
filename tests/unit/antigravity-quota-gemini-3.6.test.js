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

describe("getAntigravityUsage — Gemini consolidation in Gemini Family", () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it("consolidates multiple Gemini models into a single Gemini Family bucket", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    // subscription info call → cloudaicompanionProject
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse(200, {
      cloudaicompanionProject: "project-1",
      currentTier: { name: "Pro" },
    }));
    // quota API call
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse(200, {
      models: {
        "gemini-3.6-flash-high": {
          displayName: "Gemini 3.6 Flash (High)",
          quotaInfo: { remainingFraction: 0.8, resetTime: "2026-07-25T12:00:00Z" },
        },
        "gemini-3.6-flash-medium": {
          displayName: "Gemini 3.6 Flash (Medium)",
          quotaInfo: { remainingFraction: 0.8, resetTime: "2026-07-25T12:00:00Z" },
        },
        "gemini-3.5-flash-low": {
          displayName: "Gemini 3.5 Flash (Medium)",
          quotaInfo: { remainingFraction: 0.8, resetTime: "2026-07-25T12:00:00Z" },
        },
        "internal-model": {
          displayName: "Internal",
          isInternal: true,
        },
      },
    }));

    const usage = await getAntigravityUsage("access-token", {}, {});

    expect(Object.keys(usage.quotas)).toEqual(["gemini-family"]);
    expect(usage.quotas["gemini-family"]).toMatchObject({
      used: 200,
      total: 1000,
      remainingPercentage: 80,
      displayName: "Gemini Family",
    });
  });

  it("filters out non-quota and internal models", async () => {
    const { getAntigravityUsage } = await import("open-sse/services/usage/google.js");

    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse(200, {
      cloudaicompanionProject: "project-1",
      currentTier: { name: "Pro" },
    }));
    mockFetchWithTimeout.mockResolvedValueOnce(jsonResponse(200, {
      models: {
        "gemini-3.6-flash-high": {
          displayName: "Gemini 3.6 Flash (High)",
          quotaInfo: { remainingFraction: 0.8, resetTime: "2026-07-25T12:00:00Z" },
        },
        "internal-model": {
          displayName: "Internal",
          isInternal: true,
        },
        "unknown-tool-model": {
          displayName: "Unknown",
        },
      },
    }));

    const usage = await getAntigravityUsage("access-token", {}, {});

    expect(usage.quotas).not.toHaveProperty("internal-model");
    expect(usage.quotas).not.toHaveProperty("unknown-tool-model");
    expect(Object.keys(usage.quotas)).toEqual(["gemini-family"]);
  });
});

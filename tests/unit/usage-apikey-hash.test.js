// Guards P0 security: the gateway API key (sk-…) must never be persisted raw.
// saveRequestUsage stores a sha256 hash + masked prefix; migration 006 scrubs
// legacy usageHistory rows and usageDaily rollups that still hold raw keys.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const runMock = vi.fn();
const getMock = vi.fn();
const allMock = vi.fn();

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({ run: runMock, get: getMock, all: allMock, transaction: (fn) => fn() })),
}));

vi.mock("../../src/lib/db/helpers/metaStore.js", () => ({
  getMeta: vi.fn(async () => "0"),
  setMeta: vi.fn(async () => {}),
}));

vi.mock("../../src/lib/db/repos/pricingRepo.js", () => ({
  getPricingForModel: vi.fn(async () => null),
}));

vi.mock("open-sse/providers/pricing.js", () => ({
  getPricingForModel: vi.fn(() => null),
  calculateCostFromTokens: vi.fn(() => 0),
}));

const sha256 = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");

const {
  hashApiKey, maskApiKey, isLikelyRawKey, sanitizeApiKey, scrubDailyByApiKey,
} = await import("../../src/lib/db/helpers/usageKeySanitize.js");

describe("usage API key sanitization (P0)", () => {
  describe("helpers", () => {
    const RAW = "sk-machineid-abc123-crc88888";

    it("hashApiKey produces a stable non-reversible identifier", () => {
      const h1 = hashApiKey(RAW);
      expect(h1).toBe(`sha256:${sha256(RAW)}`);
      expect(hashApiKey(RAW)).toBe(h1);
      expect(h1).not.toContain(RAW);
      expect(hashApiKey("")).toBeNull();
      expect(hashApiKey(undefined)).toBeNull();
    });

    it("maskApiKey never contains the secret beyond the first 8 chars", () => {
      const m = maskApiKey(RAW);
      expect(m).toBe(RAW.slice(0, 8) + "***");
      expect(RAW).not.toBe(m);
      expect(m).not.toContain(RAW.slice(8));
    });

    it("isLikelyRawKey distinguishes raw keys from masked/hashed values", () => {
      expect(isLikelyRawKey(RAW)).toBe(true);
      expect(isLikelyRawKey(maskApiKey(RAW))).toBe(false);
      expect(isLikelyRawKey(hashApiKey(RAW))).toBe(false);
      expect(isLikelyRawKey("")).toBe(false);
      expect(isLikelyRawKey(null)).toBe(false);
    });

    it("sanitizeApiKey returns hash + masked prefix", () => {
      const { hash, prefix } = sanitizeApiKey(RAW);
      expect(hash).toBe(`sha256:${sha256(RAW)}`);
      expect(prefix).toBe(RAW.slice(0, 8) + "***");
    });

    it("scrubDailyByApiKey rewrites map keys and meta without raw keys", () => {
      const day = {
        requests: 2,
        byApiKey: {
          [`${RAW}|gpt-4o|openai`]: {
            requests: 2, promptTokens: 10, completionTokens: 20, cachedTokens: 0, cost: 0.01,
            rawModel: "gpt-4o", provider: "openai", apiKey: RAW,
          },
        },
      };
      const out = scrubDailyByApiKey(day);
      const entry = Object.values(out.byApiKey)[0];
      const key = Object.keys(out.byApiKey)[0];
      expect(key).toContain(`sha256:${sha256(RAW)}|`);
      expect(key).not.toContain(RAW);
      expect(entry.apiKeyHash).toBe(`sha256:${sha256(RAW)}`);
      expect(entry.apiKeyPrefix).toBe(RAW.slice(0, 8) + "***");
      expect(entry.apiKey).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain(RAW);
    });
  });

  describe("saveRequestUsage write path", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      getMock.mockReturnValue(null); // no existing row, no daily row, no meta row
      allMock.mockReturnValue([]);
      // usageRepo owns this global; seed it so prune is skipped without NPE
      global._usagePrune = global._usagePrune || { lastAt: 0 };
      global._usagePrune.lastAt = Date.now();
    });

    it("persists only hash + masked prefix, never the raw key", async () => {
      const { saveRequestUsage } = await import("../../src/lib/db/repos/usageRepo.js");
      const RAW = "sk-machineid-xyz789-crc11111";

      await saveRequestUsage({
        provider: "openai", model: "gpt-4o",
        tokens: { prompt_tokens: 10, completion_tokens: 20 },
        timestamp: "2026-08-18T00:00:00.000Z",
        apiKey: RAW,
        endpoint: "/v1/chat/completions",
      });

      const insertCall = runMock.mock.calls.find(([sql]) => sql.startsWith("INSERT INTO usageHistory"));
      expect(insertCall).toBeTruthy();
      const params = insertCall[1];
      expect(params.join("\n")).not.toContain(RAW);
      expect(params[4]).toBe(RAW.slice(0, 8) + "***"); // apiKey column: masked prefix
      expect(params[5]).toBe(`sha256:${sha256(RAW)}`);  // apiKeyHash column

      // daily upsert data must not carry the raw key either
      const dailyCall = runMock.mock.calls.find(([sql]) => sql.includes("usageDaily"));
      expect(dailyCall).toBeTruthy();
      expect(dailyCall[1][1]).not.toContain(RAW);
      expect(dailyCall[1][1]).toContain(`sha256:${sha256(RAW)}`);
    });

    it("dedupes on apiKeyHash rather than the (now masked) apiKey column", async () => {
      const { saveRequestUsage } = await import("../../src/lib/db/repos/usageRepo.js");
      const RAW = "sk-machineid-dup000-crc22222";
      getMock.mockReturnValueOnce(null); // first save: no existing row
      await saveRequestUsage({
        provider: "openai", model: "gpt-4o",
        tokens: { prompt_tokens: 1, completion_tokens: 1 },
        timestamp: "2026-08-18T00:00:00.000Z",
        apiKey: RAW,
      });

      const dedupeSql = getMock.mock.calls[0][0];
      expect(dedupeSql).toContain("apiKeyHash");
      expect(dedupeSql).not.toContain("COALESCE(apiKey,");
    });
  });
});
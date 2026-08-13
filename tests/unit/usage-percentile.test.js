import { describe, it, expect } from "vitest";
import { percentile, latencyStats } from "../../src/lib/usageStats.js";

describe("percentile (nearest-rank, floor convention)", () => {
  it("returns null for empty or non-array input", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile(null, 95)).toBeNull();
    expect(percentile(undefined, 95)).toBeNull();
  });

  it("returns the only element for a single sample", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("clamps the index to the last element for small samples", () => {
    // 3 samples: floor(0.95*3) = 2 → index 2 (last element)
    expect(percentile([10, 20, 30], 95)).toBe(30);
    expect(percentile([10, 20, 30], 50)).toBe(20); // floor(1.5) = 1
  });

  it("uses the floor index convention on sorted input", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(sorted, 50)).toBe(51); // floor(50) → index 50 → 51
    expect(percentile(sorted, 95)).toBe(96); // floor(95) → index 95 → 96
  });

  it("does not mutate the input", () => {
    const input = [5, 1, 4, 2, 3];
    const copy = [...input];
    percentile(input, 50);
    expect(input).toEqual(copy);
  });
});

describe("latencyStats", () => {
  it("returns zeros/null for no samples", () => {
    expect(latencyStats([])).toEqual({ avg: 0, p50: null, p95: null, sampleCount: 0 });
  });

  it("filters non-positive values like the usage pipeline does", () => {
    const stats = latencyStats([0, -5, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(stats.sampleCount).toBe(10); // 0 and -5 excluded → 100..1000
    expect(stats.avg).toBe(550);
  });

  it("computes avg + p50 + p95", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const stats = latencyStats(values);
    expect(stats.sampleCount).toBe(100);
    expect(stats.avg).toBe(51); // round((1+100)/2)
    expect(stats.p50).toBe(51);
    expect(stats.p95).toBe(96);
  });
});

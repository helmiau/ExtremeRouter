import { describe, it, expect } from "vitest";
import {
  LATENCY_MIN_SAMPLES,
  hasEnoughLatencySamples,
  formatLatencyMs,
  latencyDisplay,
} from "../../src/shared/utils/latencyDisplay.js";

describe("LATENCY_MIN_SAMPLES", () => {
  it("is 10", () => {
    expect(LATENCY_MIN_SAMPLES).toBe(10);
  });
});

describe("hasEnoughLatencySamples", () => {
  it("warns only when the count is known AND below the threshold", () => {
    expect(hasEnoughLatencySamples(3)).toBe(false);
    expect(hasEnoughLatencySamples(9)).toBe(false);
    expect(hasEnoughLatencySamples(10)).toBe(true);
    expect(hasEnoughLatencySamples(500)).toBe(true);
  });

  it("treats a missing sample count as display-as-is (backward compat)", () => {
    expect(hasEnoughLatencySamples(null)).toBe(true);
    expect(hasEnoughLatencySamples(undefined)).toBe(true);
  });
});

describe("formatLatencyMs", () => {
  it("formats ms and seconds", () => {
    expect(formatLatencyMs(123)).toBe("123ms");
    expect(formatLatencyMs(1000)).toBe("1.0s");
    expect(formatLatencyMs(2345)).toBe("2.3s");
    expect(formatLatencyMs(null)).toBe("—");
    expect(formatLatencyMs(undefined)).toBe("—");
  });
});

describe("latencyDisplay", () => {
  it("returns the formatted value with enough samples", () => {
    expect(latencyDisplay(150, 50)).toEqual({ value: "150ms", insufficient: false });
  });

  it("marks insufficient data when samples are known and below the threshold", () => {
    expect(latencyDisplay(150, 3)).toEqual({ value: "insufficient data", insufficient: true });
  });

  it("shows the value when the sample count is unknown", () => {
    expect(latencyDisplay(150, null)).toEqual({ value: "150ms", insufficient: false });
  });

  it("renders a dash for null latency regardless of samples", () => {
    expect(latencyDisplay(null, 3)).toEqual({ value: "—", insufficient: false });
    expect(latencyDisplay(undefined, 50)).toEqual({ value: "—", insufficient: false });
  });
});

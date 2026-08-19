// Guards the shared status contract (src/shared/constants/usageStatus.js):
// every consumer — server error-rate, error chart, provider health timeline,
// dashboard donut, live logs, activity strip — must agree on what counts as
// an error so KPIs can never contradict each other.
import { describe, it, expect } from "vitest";
import {
  USAGE_ERROR_STATUSES, USAGE_OK_STATUSES,
  isUsageErrorStatus, isUsageOkStatus, classifyUsageStatus,
} from "../../src/shared/constants/usageStatus.js";

describe("usage status contract", () => {
  it("classifies the six canonical error strings as errors", () => {
    for (const s of ["error", "failed", "unauthorized", "forbidden", "timeout", "blocked"]) {
      expect(isUsageErrorStatus(s), s).toBe(true);
      expect(classifyUsageStatus(s), s).toBe("error");
    }
  });

  it("is case-insensitive and tolerant of whitespace", () => {
    expect(isUsageErrorStatus("  Timeout ")).toBe(true);
    expect(isUsageOkStatus("OK")).toBe(true);
  });

  it("classifies ok/success as ok", () => {
    for (const s of ["ok", "success"]) {
      expect(isUsageOkStatus(s), s).toBe(true);
      expect(classifyUsageStatus(s), s).toBe("ok");
    }
  });

  it("classifies numeric HTTP codes", () => {
    expect(classifyUsageStatus("200")).toBe("ok");
    expect(classifyUsageStatus("301")).toBe("ok");
    expect(classifyUsageStatus("404")).toBe("error");
    expect(classifyUsageStatus("500")).toBe("error");
    expect(classifyUsageStatus(429)).toBe("error");
  });

  it("treats unknown / empty / null statuses as ok (non-error)", () => {
    // Matches the error-rate convention: only known error statuses count.
    expect(classifyUsageStatus("pending")).toBe("ok");
    expect(classifyUsageStatus("")).toBe("ok");
    expect(classifyUsageStatus(null)).toBe("ok");
    expect(classifyUsageStatus(undefined)).toBe("ok");
    expect(isUsageErrorStatus(undefined)).toBe(false);
  });

  it("exposes the sets so consumers never re-define the list", () => {
    expect(USAGE_ERROR_STATUSES.has("timeout")).toBe(true);
    expect(USAGE_ERROR_STATUSES.has("success")).toBe(false);
    expect(USAGE_OK_STATUSES.has("ok")).toBe(true);
    // Guard: the server health-timeline bug was Number("ok") → NaN counted
    // as error. classifyUsageStatus must never classify "ok" as error.
    expect(classifyUsageStatus("ok")).not.toBe("error");
  });
});
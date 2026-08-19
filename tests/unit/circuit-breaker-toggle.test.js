import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import {
  isCircuitOpen,
  recordBreakerFailure,
  clearAllBreakers,
  getBreakerStates,
} from "open-sse/services/circuitBreaker.js";

const ON = {
  circuitBreaker: {
    enabled: true,
    failureThreshold: 1,
    windowMs: 60_000,
    cooldownMs: 30_000,
    halfOpenMaxCalls: 1,
  },
};

const OFF = {
  circuitBreaker: {
    enabled: false,
    failureThreshold: 1,
    windowMs: 60_000,
    cooldownMs: 30_000,
    halfOpenMaxCalls: 1,
  },
};

afterEach(() => {
  clearAllBreakers();
});

describe("circuitBreaker.enabled toggle", () => {
  it("never reports OPEN when enabled is false", () => {
    recordBreakerFailure("prov-off", 503, OFF);
    expect(isCircuitOpen("prov-off", OFF)).toBe(false);
    expect(getBreakerStates()).toEqual([]);
  });

  it("trips OPEN when enabled, then ignores open state once disabled", () => {
    recordBreakerFailure("prov-on", 503, ON);
    expect(isCircuitOpen("prov-on", ON)).toBe(true);
    expect(isCircuitOpen("prov-on", OFF)).toBe(false);
  });

  it("clearAllBreakers drops in-memory OPEN state", () => {
    recordBreakerFailure("prov-clear", 503, ON);
    expect(getBreakerStates().length).toBeGreaterThan(0);
    expect(clearAllBreakers()).toBe(true);
    expect(getBreakerStates()).toEqual([]);
    expect(isCircuitOpen("prov-clear", ON)).toBe(false);
  });
});

describe("settingsRepo deep-merge of circuitBreaker", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "er-breaker-toggle-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterAll(() => {
    try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win lock */ }
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("partial { enabled } patch preserves sibling thresholds", async () => {
    await db.updateSettings({
      circuitBreaker: {
        enabled: true,
        failureThreshold: 7,
        windowMs: 12_000,
        cooldownMs: 45_000,
        halfOpenMaxCalls: 3,
      },
    });

    await db.updateSettings({ circuitBreaker: { enabled: false } });
    const after = await db.getSettings();

    expect(after.circuitBreaker.enabled).toBe(false);
    expect(after.circuitBreaker.failureThreshold).toBe(7);
    expect(after.circuitBreaker.windowMs).toBe(12_000);
    expect(after.circuitBreaker.cooldownMs).toBe(45_000);
    expect(after.circuitBreaker.halfOpenMaxCalls).toBe(3);
  });
});

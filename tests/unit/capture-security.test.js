// Security hardening for the cookie-capture feature:
//  - buildCdpWarning drives the UI nudge to close the debug browser
//  - isChromiumVersionOutput gates PATH-resolved browser binaries
//  - verifyChromiumBinary execs `<path> --version` and requires a browser banner
//  - isCdpReachable tracks first-seen time (stale debug-browser detection)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  buildCdpWarning,
  CDP_STALE_AFTER_MS,
} = await import("../../src/shared/utils/cdpWarning.js");
const {
  isChromiumVersionOutput,
  verifyChromiumBinary,
  isCdpReachable,
  getCdpUpSince,
  __resetCdpTrackingForTests,
} = await import("../../src/lib/browserDebug.js");

describe("buildCdpWarning", () => {
  const NOW = 1_000_000;

  it("returns null for missing/invalid cdpUpSinceMs", () => {
    expect(buildCdpWarning(null, NOW)).toBe(null);
    expect(buildCdpWarning(undefined, NOW)).toBe(null);
    expect(buildCdpWarning(0, NOW)).toBe(null);
    expect(buildCdpWarning(Number.NaN, NOW)).toBe(null);
  });

  it("fresh debug browser: warning without the stale lead", () => {
    const w = buildCdpWarning(NOW - 60_000, NOW); // up 1 minute
    expect(w.stale).toBe(false);
    expect(w.minutes).toBe(1);
    expect(w.text).not.toContain("has been running for");
    expect(w.text).toContain("any local process can read its cookies");
  });

  it("stale debug browser (>10 min): leads with the runtime", () => {
    const w = buildCdpWarning(NOW - CDP_STALE_AFTER_MS - 60_000, NOW);
    expect(w.stale).toBe(true);
    expect(w.minutes).toBe(11);
    expect(w.text).toContain("Debug browser has been running for 11 min.");
  });
});

describe("isChromiumVersionOutput", () => {
  it("accepts real browser version banners", () => {
    expect(isChromiumVersionOutput("Google Chrome 126.0.6478.62")).toBe(true);
    expect(isChromiumVersionOutput("Brave Browser 1.67.123 Chromium: 125.0.6422.60")).toBe(true);
    expect(isChromiumVersionOutput("Microsoft Edge 126.0.2592.61")).toBe(true);
    expect(isChromiumVersionOutput("Chromium 125.0.6422.60")).toBe(true);
    expect(isChromiumVersionOutput("HeadlessShell/125.0.6422.60")).toBe(true);
  });

  it("rejects non-browser output (PATH hijack payloads)", () => {
    expect(isChromiumVersionOutput("v24.15.0")).toBe(false);
    expect(isChromiumVersionOutput("Python 3.12.3")).toBe(false);
    expect(isChromiumVersionOutput("zsh: command not found: brave")).toBe(false);
    expect(isChromiumVersionOutput("")).toBe(false);
    expect(isChromiumVersionOutput(null)).toBe(false);
  });
});

describe("verifyChromiumBinary", () => {
  it("rejects a real executable whose --version is not a browser banner (node)", async () => {
    // process.execPath is a real spawnable binary; `node --version` prints
    // "vX.Y.Z" — exercises the spawn/stdout plumbing end-to-end.
    const ok = await verifyChromiumBinary(process.execPath, { timeoutMs: 10_000 });
    expect(ok).toBe(false);
  }, 15_000);
});

describe("isCdpReachable first-seen tracking", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    __resetCdpTrackingForTests();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetCdpTrackingForTests();
  });

  it("records the first successful probe and stays sticky", async () => {
    const t0 = Date.now();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    expect(await isCdpReachable()).toBe(true);
    const since = getCdpUpSince();
    expect(since).toBeGreaterThanOrEqual(t0);
    await new Promise((r) => setTimeout(r, 5));
    expect(await isCdpReachable()).toBe(true);
    expect(getCdpUpSince()).toBe(since); // unchanged on later probes
  });

  it("unreachable probes never set first-seen", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await isCdpReachable()).toBe(false);
    expect(getCdpUpSince()).toBe(null);
  });
});

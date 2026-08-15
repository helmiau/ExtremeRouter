import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import {
  getBrowserCandidates,
  resolveBrowserPath,
  findInstalledBrowser,
  CDP_PORT,
} from "../../src/lib/browserDebug.js";

describe("browserDebug (cross-platform browser detection)", () => {
  it("knows Windows candidates for Brave/Chrome/Edge/Chromium", () => {
    const c = getBrowserCandidates("win32");
    expect(c.map((x) => x.id)).toEqual(["brave", "chrome", "edge", "chromium"]);
    expect(c[0].paths.some((p) => p.toLowerCase().includes("bravesoftware"))).toBe(true);
    expect(c[1].paths.some((p) => p.toLowerCase().includes("chrome"))).toBe(true);
    expect(c[2].paths.some((p) => p.toLowerCase().includes("msedge"))).toBe(true);
  });

  it("knows macOS candidates under /Applications", () => {
    const c = getBrowserCandidates("darwin");
    expect(c.map((x) => x.id)).toEqual(["brave", "chrome", "edge", "chromium"]);
    expect(c[0].paths[0]).toContain("/Applications/Brave Browser.app");
    expect(c[1].paths[0]).toContain("/Applications/Google Chrome.app");
    expect(c[2].paths[0]).toContain("/Applications/Microsoft Edge.app");
  });

  it("knows Linux candidates as PATH commands", () => {
    const c = getBrowserCandidates("linux");
    expect(c.map((x) => x.id)).toEqual(["brave", "chrome", "edge", "chromium"]);
    expect(c[0].commands).toContain("brave-browser");
    expect(c[3].commands).toContain("chromium");
  });

  it("returns an empty list for unknown platforms", () => {
    expect(getBrowserCandidates("freebsd")).toEqual([]);
  });

  it("resolves the first existing path of a candidate", () => {
    const spy = vi.spyOn(fs, "accessSync");
    spy.mockImplementation((p) => {
      if (p === "C:/fake/brave.exe") return;
      throw new Error("ENOENT");
    });
    const got = resolveBrowserPath({ paths: ["C:/nope/brave.exe", "C:/fake/brave.exe"] });
    expect(got).toBe("C:/fake/brave.exe");
    spy.mockRestore();
  });

  it("returns null when no path or command exists", () => {
    const spy = vi.spyOn(fs, "accessSync");
    spy.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(resolveBrowserPath({ paths: ["C:/nope/brave.exe"], commands: ["definitely-not-a-real-cmd-xyz"] })).toBeNull();
    spy.mockRestore();
  });

  it("prefers the ER_CAPTURE_BROWSER override", async () => {
    const spy = vi.spyOn(fs, "accessSync");
    spy.mockImplementation(() => undefined); // every candidate "exists"
    const prev = process.env.ER_CAPTURE_BROWSER;
    process.env.ER_CAPTURE_BROWSER = "chrome";
    try {
      const got = await findInstalledBrowser();
      expect(got.id).toBe("chrome");
      expect(got.path).toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.ER_CAPTURE_BROWSER;
      else process.env.ER_CAPTURE_BROWSER = prev;
      spy.mockRestore();
    }
  });

  it("falls back to the first installed browser (Brave first)", async () => {
    const spy = vi.spyOn(fs, "accessSync");
    spy.mockImplementation(() => undefined);
    const prev = process.env.ER_CAPTURE_BROWSER;
    if (prev !== undefined) delete process.env.ER_CAPTURE_BROWSER;
    try {
      const got = await findInstalledBrowser();
      expect(got.id).toBe("brave");
    } finally {
      if (prev !== undefined) process.env.ER_CAPTURE_BROWSER = prev;
      spy.mockRestore();
    }
  });

  it("exports a stable default CDP port", () => {
    expect(CDP_PORT).toBe(9222);
  });
});

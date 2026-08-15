import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

const browserDebug = {
  CDP_PORT: 9222,
  detectPlatform: vi.fn(() => "win32"),
  findInstalledBrowser: vi.fn(),
  isBrowserRunning: vi.fn(),
  isCdpReachable: vi.fn(),
  launchAndWait: vi.fn(),
};
vi.mock("../../src/lib/browserDebug.js", () => browserDebug);

let POST;
beforeEach(async () => {
  vi.clearAllMocks();
  browserDebug.detectPlatform.mockReturnValue("win32");
  browserDebug.isCdpReachable.mockResolvedValue(false);
  browserDebug.findInstalledBrowser.mockResolvedValue({
    id: "chrome",
    name: "Google Chrome",
    path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  browserDebug.isBrowserRunning.mockResolvedValue(false);
  browserDebug.launchAndWait.mockResolvedValue(true);
  const mod = await import("../../src/app/api/providers/felo-capture/launch/route.js");
  POST = mod.POST;
});

describe("POST /api/providers/felo-capture/launch", () => {
  it("reports when CDP is already active", async () => {
    browserDebug.isCdpReachable.mockResolvedValue(true);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(res.body.alreadyRunning).toBe(true);
    expect(browserDebug.findInstalledBrowser).not.toHaveBeenCalled();
  });

  it("detects the OS and launches the installed browser", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(browserDebug.detectPlatform).toHaveBeenCalled();
    expect(browserDebug.launchAndWait).toHaveBeenCalledWith(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    );
    expect(res.body).toMatchObject({
      launched: true,
      browser: { id: "chrome", name: "Google Chrome" },
      port: 9222,
      platform: "win32",
    });
  });

  it("404 when no supported browser is installed", async () => {
    browserDebug.findInstalledBrowser.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_browser");
    expect(browserDebug.launchAndWait).not.toHaveBeenCalled();
  });

  it("409 when the browser is already running without CDP", async () => {
    browserDebug.isBrowserRunning.mockResolvedValue(true);
    const res = await POST();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("browser_running");
    expect(browserDebug.launchAndWait).not.toHaveBeenCalled();
  });

  it("500 when the browser never opens the debug port", async () => {
    browserDebug.launchAndWait.mockResolvedValue(false);
    const res = await POST();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("launch_timeout");
  });
});

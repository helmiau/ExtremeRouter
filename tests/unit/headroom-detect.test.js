import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(() => { throw new Error("not found"); }),
}));

vi.mock("child_process", () => ({
  execSync: mocks.execSync,
}));

import { getHeadroomStatus, isLoopbackHeadroomUrl, probeProxyRunning } from "../../src/lib/headroom/detect.js";

afterEach(() => {
  vi.clearAllMocks();
  delete global.fetch;
});

describe("headroom detect", () => {
  it("treats a reachable external proxy as running without local CLI", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));

    const status = await getHeadroomStatus("http://headroom:8787");

    expect(status.installed).toBe(false);
    expect(status.running).toBe(true);
    expect(status.localUrl).toBe(false);
    expect(status.canStart).toBe(false);
    // Probes /livez (instant) instead of /health (slow upstream check).
    expect(global.fetch).toHaveBeenCalledWith("http://headroom:8787/livez", expect.any(Object));
  });

  it("recognizes loopback URLs for managed local mode", () => {
    expect(isLoopbackHeadroomUrl("http://localhost:8787")).toBe(true);
    expect(isLoopbackHeadroomUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopbackHeadroomUrl("http://headroom:8787")).toBe(false);
    expect(isLoopbackHeadroomUrl("not-a-url")).toBe(false);
  });

  it("probeProxyRunning: /livez 200 reports running without touching /health", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    expect(await probeProxyRunning("http://127.0.0.1:8787")).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe("http://127.0.0.1:8787/livez");
  });

  it("probeProxyRunning: /livez 503 means not ready → not running", async () => {
    global.fetch = vi.fn(async () => new Response("starting", { status: 503 }));
    expect(await probeProxyRunning("http://127.0.0.1:8787")).toBe(false);
  });

  it("probeProxyRunning: old headroom without /livez falls back to /health", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    expect(await probeProxyRunning("http://127.0.0.1:8787")).toBe(true);
    expect(global.fetch.mock.calls[1][0]).toBe("http://127.0.0.1:8787/health");
  });

  it("probeProxyRunning: /health fallback 503 (unhealthy upstream) → not running", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("unhealthy", { status: 503 }));
    expect(await probeProxyRunning("http://127.0.0.1:8787")).toBe(false);
  });

  it("probeProxyRunning: connection failure or timeout → not running", async () => {
    global.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    expect(await probeProxyRunning("http://127.0.0.1:8787")).toBe(false);
  });
});

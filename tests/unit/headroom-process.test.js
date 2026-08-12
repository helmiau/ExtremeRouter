import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// startHeadroomProxy double-closed the shared log fd: the post-startup
// fs.closeSync(outFd) AND the child "exit" listener both closed it. When the
// proxy exited AFTER a successful startup, the second close threw
// "EBADF: bad file descriptor" inside the event listener, crashing the
// gateway via uncaughtException. These tests pin the close-once contract.
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => {
    throw new Error("not found");
  }),
  findHeadroomBinary: vi.fn(() => "/fake/bin/headroom"),
}));

vi.mock("child_process", () => ({
  spawn: mocks.spawn,
  execSync: mocks.execSync,
}));

vi.mock("../../src/lib/headroom/detect.js", () => ({
  findHeadroomBinary: mocks.findHeadroomBinary,
}));

let tmpDir;
let startHeadroomProxy;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "er-headroom-proc-"));
  process.env.DATA_DIR = tmpDir;
  // isPidAlive uses process.kill(pid, 0) — pretend every pid is alive so the
  // 8s startup watchdog resolves instead of rejecting on a fake pid.
  vi.spyOn(process, "kill").mockReturnValue(true);
  ({ startHeadroomProxy } = await import("../../src/lib/headroom/process.js"));
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeChild(pid = 4242) {
  const exitHandlers = [];
  const child = {
    pid,
    unref: vi.fn(),
    once: vi.fn((ev, cb) => {
      if (ev === "exit") exitHandlers.push(cb);
    }),
    emitExit: (code) => exitHandlers.forEach((cb) => cb(code)),
  };
  mocks.spawn.mockReturnValue(child);
  return child;
}

function spyFd() {
  const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation(() => {});
  vi.spyOn(fs, "openSync").mockReturnValue(7);
  return closeSpy;
}

describe("startHeadroomProxy fd lifecycle", () => {
  it("closes the log fd exactly once when the proxy exits AFTER a successful startup (EBADF regression)", async () => {
    vi.useFakeTimers();
    const closeSpy = spyFd();
    const child = makeChild();

    const p = startHeadroomProxy({ port: 8787 });
    await vi.advanceTimersByTimeAsync(8000); // startup watchdog fires → resolve
    await expect(p).resolves.toEqual({ pid: 4242, alreadyRunning: false });
    expect(closeSpy).toHaveBeenCalledTimes(1); // post-startup close only

    // Proxy exits later — the exit listener must NOT close the fd again.
    child.emitExit(0);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("closes the fd once on early exit and rejects with EARLY_EXIT", async () => {
    vi.useFakeTimers();
    const closeSpy = spyFd();
    const child = makeChild();

    const p = startHeadroomProxy({ port: 8787 });
    child.emitExit(1); // proxy dies during startup window
    await expect(p).rejects.toMatchObject({ code: "EARLY_EXIT" });
    expect(closeSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("rejects with SPAWN_FAILED and closes once when spawn returns no pid", async () => {
    mocks.spawn.mockReturnValue({ unref: vi.fn() });
    const closeSpy = spyFd();

    await expect(startHeadroomProxy({ port: 8787 })).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("spawns the proxy with the log fd attached and detached lifecycle", async () => {
    vi.useFakeTimers();
    spyFd();
    makeChild();

    const p = startHeadroomProxy({ port: 9000 });
    await vi.advanceTimersByTimeAsync(8000);
    await p;

    expect(mocks.spawn).toHaveBeenCalledWith(
      "/fake/bin/headroom",
      ["proxy", "--port", "9000"],
      expect.objectContaining({ detached: true, stdio: ["ignore", 7, 7] })
    );
    vi.useRealTimers();
  });
});

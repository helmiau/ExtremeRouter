import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

const connectOverCDPMock = vi.fn();
vi.mock("playwright-core", () => ({
  chromium: { connectOverCDP: (...args) => connectOverCDPMock(...args) },
}));

let POST;
let fetchSpy;

function makeBrowser({ cookies }) {
  const closePage = vi.fn().mockResolvedValue();
  const closeBrowser = vi.fn().mockResolvedValue();
  const page = {
    goto: vi.fn().mockResolvedValue(),
    waitForTimeout: vi.fn().mockResolvedValue(),
    close: closePage,
  };
  const context = {
    cookies: vi.fn().mockResolvedValue(cookies),
    newPage: async () => page,
  };
  connectOverCDPMock.mockResolvedValue({
    contexts: () => [context],
    close: closeBrowser,
  });
  return { closePage, closeBrowser, context };
}

// Sequence the global fetch mock: call 1 = CDP probe, call 2 = user/info.
function mockFetchSequence({ cdpOk = true, infoOk = true, infoData = null } = {}) {
  fetchSpy
    .mockResolvedValueOnce({ ok: cdpOk })
    .mockResolvedValueOnce({
      ok: infoOk,
      json: async () => (infoData ? { data: infoData } : {}),
    });
}

beforeEach(async () => {
  vi.clearAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch");
  const mod = await import("../../src/app/api/providers/felo-capture/route.js");
  POST = mod.POST;
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("POST /api/providers/felo-capture", () => {
  it("409 with guidance when Brave is not reachable over CDP", async () => {
    mockFetchSequence({ cdpOk: false });
    const res = await POST();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("brave_not_reachable");
    expect(connectOverCDPMock).not.toHaveBeenCalled();
  });

  it("captures the session cookie and profile from the running Brave", async () => {
    mockFetchSequence({
      infoData: { name: "NgenSal", email: "radensalman07@gmail.com", picture: "", uid: "u1" },
    });
    const { closePage, closeBrowser } = makeBrowser({
      cookies: [
        { name: "felo-user-token", value: "6h_abc123" },
        { name: "visitor_id", value: "vid-1" },
      ],
    });

    const res = await POST();
    expect(res.status).toBe(200);
    expect(res.body.credential).toBe("cookie=felo-user-token=6h_abc123; visitor_id=vid-1");
    expect(res.body.profile.name).toBe("NgenSal");
    expect(res.body.profile.email).toBe("radensalman07@gmail.com");
    expect(res.body.loggedIn).toBe(true);
    // Only our tab + the CDP connection are closed — the user's Brave lives on.
    expect(closePage).toHaveBeenCalled();
    expect(closeBrowser).toHaveBeenCalled();
    // user/info is called with the RAW token (no `Bearer ` prefix).
    const infoCall = fetchSpy.mock.calls.find(([u]) => String(u).includes("user/info"));
    expect(infoCall).toBeTruthy();
    expect(infoCall[1].headers.Authorization).toBe("6h_abc123");
  });

  it("401 when Brave is running but no Felo session exists", async () => {
    mockFetchSequence();
    makeBrowser({ cookies: [{ name: "visitor_id", value: "vid-1" }] });

    const res = await POST();
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("not_logged_in");
  });

  it("returns the cookie credential even if the profile fetch fails", async () => {
    mockFetchSequence({ infoOk: false });
    const { closePage } = makeBrowser({
      cookies: [{ name: "felo-user-token", value: "6h_xyz" }],
    });

    const res = await POST();
    expect(res.status).toBe(200);
    expect(res.body.credential).toBe("cookie=felo-user-token=6h_xyz");
    expect(res.body.profile).toBeNull();
    expect(res.body.loggedIn).toBe(false);
    expect(closePage).toHaveBeenCalled();
  });
});

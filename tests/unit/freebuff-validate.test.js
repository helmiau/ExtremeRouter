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

// Avoid touching real models/DB in the validate route.
vi.mock("../../src/models/index.js", () => ({
  getProviderNodeById: vi.fn(async () => null),
}));
vi.mock("../../src/models.js", () => ({
  getProviderNodeById: vi.fn(async () => null),
}));

// Import the heavy validate route ONCE at module level (mocks above are
// hoisted, so this picks them up) — re-importing per test under batch
// concurrency repeatedly pays the full import chain cost.
const { POST } = await import("../../src/app/api/providers/validate/route.js");

let fetchMock;
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  delete globalThis.fetch;
});

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status < 400,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  };
}

describe("POST /api/providers/validate — freebuff", () => {
  // The validate route has a heavy import chain (open-sse config, translator,
  // models) — under batch concurrency it can exceed vitest's 5s default.
  const opts = { timeout: 30_000 };
  it("validates a freebuff authToken via the codebuff session endpoint", opts, async () => {
    fetchMock.mockResolvedValue(jsonResponse({ instanceId: "inst-1" }));
    const res = await POST({ json: async () => ({ provider: "freebuff", apiKey: "tok-ok" }) });
    expect(res.body.valid).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://codebuff.com/api/v1/freebuff/session");
    expect(opts.headers.Authorization).toBe("Bearer tok-ok");
    expect(opts.headers["x-freebuff-model"]).toBe("deepseek/deepseek-v4-flash");
  });

  it("returns invalid with re-login message on 401", opts, async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
    const res = await POST({ json: async () => ({ provider: "freebuff", apiKey: "tok-bad" }) });
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toContain("re-copy from freebuff.llm.pm");
  });

  it("returns invalid on 403", opts, async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "forbidden" }, 403));
    const res = await POST({ json: async () => ({ provider: "freebuff", apiKey: "tok-forbidden" }) });
    expect(res.body.valid).toBe(false);
  });

  it("treats 5xx as unverifiable (conservative — not marked valid)", opts, async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    const res = await POST({ json: async () => ({ provider: "freebuff", apiKey: "tok-5xx" }) });
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toContain("Freebuff returned 500");
  });
});

// zai-web validation semantics — ported from the audited OmniRoute PR #10329
// (tests/unit/zai-web-auth-semantics.test.ts) and adapted to ExtremeRouter's
// validate route (POST /api/providers/validate).
//
// Covers:
//  - token-only Bearer probe of GET https://chat.z.ai/api/v1/users/user/settings
//  - 200 → valid; 401 → invalid/expired; 403 → invalid (NOT labeled expired)
//  - 429/5xx → treated as accepted (token valid, upstream busy)
//  - credential parsing (JSON {token}, Bearer, token=, bare)

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

// Import the heavy validate route ONCE at module level.
const { POST } = await import("../../src/app/api/providers/validate/route.js");

let fetchMock;
let lastCall;
let nextStatus = 200;

function probeResponse(status) {
  return {
    status,
    ok: status >= 200 && status < 400,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => "",
    body: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  lastCall = null;
  nextStatus = 200;
  fetchMock = vi.fn(async (url, init) => {
    lastCall = { url, init };
    return probeResponse(nextStatus);
  });
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  delete globalThis.fetch;
});

function makeRequest(apiKey) {
  return { json: async () => ({ provider: "zai-web", apiKey, providerSpecificData: {} }) };
}

describe("POST /api/providers/validate — zai-web auth semantics", () => {
  const opts = { timeout: 30_000 };

  it("uses the token-only authenticated user-settings GET", opts, async () => {
    nextStatus = 200;
    const res = await POST(makeRequest("synthetic-zai-token"));
    expect(res.body.valid).toBe(true);
    expect(res.body.error).toBeNull();

    expect(lastCall.url).toBe("https://chat.z.ai/api/v1/users/user/settings");
    expect(lastCall.init.method).toBe("GET");
    expect(lastCall.init.headers.Authorization).toBe("Bearer synthetic-zai-token");
    expect(lastCall.init.headers.Cookie).toBeUndefined();
  });

  it("preserves exact 401 as invalid/expired credentials", opts, async () => {
    nextStatus = 401;
    const res = await POST(makeRequest("synthetic-zai-token"));
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });

  it("preserves 403 without labeling it expired", opts, async () => {
    nextStatus = 403;
    const res = await POST(makeRequest("synthetic-zai-token"));
    expect(res.body.valid).toBe(false);
    expect(res.body.error).not.toMatch(/invalid or expired/i);
    expect(res.body.error).toMatch(/403/);
  });

  it("preserves rate-limit and server statuses as accepted credentials", opts, async () => {
    for (const status of [429, 503]) {
      nextStatus = status;
      const res = await POST(makeRequest("synthetic-zai-token"));
      expect(res.body.valid).toBe(true);
      expect(res.body.error).toBeNull();
    }
  });

  it("extracts the token from a JSON credential before probing", opts, async () => {
    nextStatus = 200;
    const jsonCred = JSON.stringify({ token: "tok-from-json", captcha_verify_param: "proof" });
    await POST(makeRequest(jsonCred));
    expect(lastCall.init.headers.Authorization).toBe("Bearer tok-from-json");
  });

  it("accepts token=... cookie fragments and Bearer prefixes", opts, async () => {
    nextStatus = 200;
    await POST(makeRequest("token=abc123; other=xyz"));
    expect(lastCall.init.headers.Authorization).toBe("Bearer abc123");

    await POST(makeRequest("Authorization: Bearer abc123"));
    expect(lastCall.init.headers.Authorization).toBe("Bearer abc123");
  });

  it("rejects credentials that contain no usable token", opts, async () => {
    const res = await POST(makeRequest("other=xyz"));
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toMatch(/no z\.ai token found/i);
  });
});

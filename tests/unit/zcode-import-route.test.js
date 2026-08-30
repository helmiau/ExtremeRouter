import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock next/server (ESM-only in this setup — mirror freebuff-import-route).
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock the DB model layer before importing the route module.
const createProviderConnectionMock = vi.fn(async (data) => ({ id: "conn-1", ...data }));
vi.mock("@/models", () => ({
  createProviderConnection: (...args) => createProviderConnectionMock(...args),
}));

// Mock fs readFile so the config path probe is deterministic.
const readFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: (...args) => readFileMock(...args),
}));

let POST, GET;
beforeEach(async () => {
  vi.clearAllMocks();
  readFileMock.mockReset();
  const mod = await import("../../src/app/api/oauth/zcode/import/route.js");
  POST = mod.POST;
  GET = mod.GET;
});

const START_PLAN_CONFIG = {
  provider: {
    "builtin:zai-start-plan": {
      name: "Z.ai - Coding Plan",
      kind: "anthropic",
      options: {
        apiKey: "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiYWJjIn0.sig",
        baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
      },
      enabled: true,
    },
    "builtin:zai-coding-plan": {
      options: { apiKey: "7ff94ea3eef84070bfd7ee9608b67115.3EGKTgWpncdK6SJp", baseURL: "https://api.z.ai/api/anthropic" },
      enabled: false,
      systemDisabledReason: "coding_plan_not_entitled",
    },
  },
};

function jsonResponse(body, status = 200) {
  return { status, ok: status < 400, json: async () => body };
}

beforeEach(() => {
  createProviderConnectionMock.mockClear();
  readFileMock.mockReset();
});

describe("zcode config import route", () => {
  it("imports the enabled start-plan JWT with the coding key as sibling", async () => {
    readFileMock.mockResolvedValue(JSON.stringify(START_PLAN_CONFIG));

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(createProviderConnectionMock).toHaveBeenCalledTimes(1);
    const arg = createProviderConnectionMock.mock.calls[0][0];
    expect(arg.provider).toBe("zcode");
    expect(arg.authType).toBe("oauth");
    // Start Plan JWT is the primary credential
    expect(arg.apiKey).toBe("eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiYWJjIn0.sig");
    expect(arg.providerSpecificData).toMatchObject({
      authMethod: "config_import",
      planId: "builtin:zai-start-plan",
      // unentitled sibling coding key still stored for the paid legs
      codingApiKey: "7ff94ea3eef84070bfd7ee9608b67115.3EGKTgWpncdK6SJp",
    });
    expect(arg.providerSpecificData.sourcePath).toContain(".zcode");
  });

  it("falls back to a disabled-but-present coding-plan key when no start plan exists", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({
      provider: {
        "builtin:zai-coding-plan": {
          options: { apiKey: "id.secret" },
          enabled: false,
        },
      },
    }));

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    const arg = createProviderConnectionMock.mock.calls[0][0];
    expect(arg.apiKey).toBe("id.secret");
    expect(arg.providerSpecificData.planId).toBe("builtin:zai-coding-plan");
    expect(arg.providerSpecificData.codingApiKey).toBeUndefined();
  });

  it("returns 404 when no config file exists", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    const res = await POST();
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 404 when the config has no provider credentials", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ provider: {} }));
    const res = await POST();
    expect(res.status).toBe(404);
  });

  it("returns 400 on malformed JSON", async () => {
    readFileMock.mockResolvedValue("{not json");
    const res = await POST();
    expect(res.status).toBe(400);
  });

  it("GET returns import instructions", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.provider).toBe("zcode");
    expect(body.method).toBe("config_import");
  });
});

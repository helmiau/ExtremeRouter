import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getSettingsMock = vi.fn();
const getAdapterMock = vi.fn();

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: getAdapterMock,
}));

vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({
  getSettings: getSettingsMock,
}));

const { redactSecretsDeep } = await import("../../src/lib/db/repos/requestDetailsRepo.js");

describe("request detail observability safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OBSERVABILITY_ENABLED;
    getAdapterMock.mockResolvedValue({});
    getSettingsMock.mockResolvedValue({ enableObservability: false });
  });

  afterEach(() => {
    delete process.env.OBSERVABILITY_ENABLED;
  });

  it("redacts gateway keys, bearer tokens, and JWTs recursively", () => {
    const value = redactSecretsDeep({
      messages: [{ content: "use sk-abcdefghijklmnopqrstuvwxyz now" }],
      headers: { authorization: "Bearer secret-token-value" },
      nested: { jwt: "eyJheaderValue.eyJpayloadValue.signatureValue" },
    });
    const text = JSON.stringify(value);
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("Bearer secret-token-value");
    expect(text).not.toContain("eyJheaderValue.eyJpayloadValue.signatureValue");
    expect(text.match(/\[REDACTED\]/g)?.length).toBe(3);
  });

  it("leaves ordinary content and primitives unchanged", () => {
    expect(redactSecretsDeep({ role: "user", content: "hello" })).toEqual({ role: "user", content: "hello" });
    expect(redactSecretsDeep([null, 0, false])).toEqual([null, 0, false]);
  });
});

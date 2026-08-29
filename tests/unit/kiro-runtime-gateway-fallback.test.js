// Locks the kiro.dev gateway-first behavior: for gateway-acceptable tokens
// (not api_key/external_idp/idc) the runtime.us-east-1.kiro.dev endpoint is tried
// first, and a 401/403/404 there falls back to the region-resolved AWS
// CodeWhisperer host. 400 stays terminal. Mirrors 9router's
// KIRO_ENDPOINT_FALLBACK_STATUSES.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");

const GW = "https://runtime.us-east-1.kiro.dev/generateAssistantResponse";
const CW = "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse";
const Q = "https://q.us-east-1.amazonaws.com/generateAssistantResponse";

function makeExec(authMethod) {
  const ex = new KiroExecutor();
  ex._lastCredentials = {
    accessToken: "token",
    providerSpecificData: authMethod ? { authMethod, region: "us-east-1" } : {},
  };
  return ex;
}

function res(status, ok) {
  return { status, ok, headers: { get: () => "" } };
}

beforeEach(() => fetchMock.mockReset());

describe("Kiro gateway-first endpoint ordering", () => {
  it("tries runtime.us-east-1.kiro.dev first for gateway-acceptable OAuth auth", () => {
    for (const method of ["builder-id", "google", "github"]) {
      const ex = makeExec(method);
      const urls = ex.getOrderedBaseUrls(ex._lastCredentials);
      expect(urls[0]).toBe(GW);
      expect(urls[1]).toBe(CW);
      expect(urls[2]).toBe(Q);
    }
  });

  it("routes CodeWhisperer-surface auth (api_key) to the AWS host first", () => {
    const ex = makeExec("api_key");
    const urls = ex.getOrderedBaseUrls(ex._lastCredentials);
    expect(urls[0]).toBe(CW);
    expect(urls[1]).toBe(Q);
    // gateway is a last-ditch fallback for these; never the first attempt
    expect(urls[2]).toBe(GW);
  });
});

describe("Kiro gateway 401/403/404 fallback (shouldRetry)", () => {
  it("advances to the AWS host on 401/403/404 from the gateway leg", () => {
    const ex = makeExec("builder-id");
    expect(ex.shouldRetry(401, 0)).toBe(true);
    expect(ex.shouldRetry(403, 0)).toBe(true);
    expect(ex.shouldRetry(404, 0)).toBe(true);
  });

  it("treats a 401/403/404 from an AWS host as final (no further fallback)", () => {
    const ex = makeExec("builder-id");
    expect(ex.shouldRetry(401, 1)).toBe(false);
    expect(ex.shouldRetry(403, 2)).toBe(false);
  });

  it("keeps malformed-body 400 terminal on the gateway leg", () => {
    const ex = makeExec("builder-id");
    expect(ex.shouldRetry(400, 0)).toBe(false);
  });

  it("preserves base 429 rate-limit fallback behavior", () => {
    const ex = makeExec("builder-id");
    expect(ex.shouldRetry(429, 0)).toBe(true);
    expect(ex.shouldRetry(429, 2)).toBe(false); // last host
  });

  it("never gateway-falls-back for api_key / idc / external_idp tokens", () => {
    for (const method of ["api_key", "idc", "external_idp"]) {
      const ex = makeExec(method);
      expect(ex.shouldRetry(401, 0)).toBe(false);
      expect(ex.shouldRetry(403, 0)).toBe(false);
      expect(ex.shouldRetry(404, 0)).toBe(false);
    }
  });

  it("falls back to base behavior when auth method is unknown/missing", () => {
    const ex = makeExec(undefined);
    expect(ex.shouldRetry(429, 0)).toBe(true);
    expect(ex.shouldRetry(401, 0)).toBe(true); // treated as gateway-acceptable
  });
});

describe("Kiro execute — gateway 403 falls back to AWS success", () => {
  it("issues two requests and serves the AWS response", async () => {
    const ex = makeExec("builder-id");
    fetchMock
      .mockResolvedValueOnce(res(403, false)) // gateway rejects token
      .mockResolvedValueOnce(res(200, true)); // AWS host succeeds
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: ex._lastCredentials });
    expect(out.response.status).toBe(200);
    expect(out.url).toBe(CW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(GW);
    expect(fetchMock.mock.calls[1][0]).toBe(CW);
  });

  it("stays terminal on a malformed-body 400 from the gateway", async () => {
    const ex = makeExec("builder-id");
    fetchMock.mockResolvedValue(res(400, false));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: ex._lastCredentials });
    expect(out.response.status).toBe(400);
    expect(out.url).toBe(GW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
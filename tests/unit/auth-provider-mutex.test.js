// Unit tests for the per-provider selection mutex in src/sse/services/auth.js.
//
// Verifies:
//   1. Credential selection for DIFFERENT providers runs in PARALLEL (a slow
//      provider A does not block provider B).
//   2. Credential selection for the SAME provider stays SERIALIZED (prevents
//      race on shared rotation state: lastUsedAt / consecutiveUseCount).
//
// Uses a timing-based check with a generous threshold: two 100ms selections in
// parallel finish ~100ms; serialized they take ~200ms. The 150ms split is wide
// enough to be robust on slow CI runners.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  updateProviderConnection: vi.fn(async () => ({})),
  validateApiKey: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
}));
vi.mock("open-sse/services/circuitBreaker.js", () => ({
  isCircuitOpen: vi.fn(() => false),
  breakerKey: vi.fn((provider) => provider), // direct key in tests
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));

import { getProviderConnections } from "@/lib/localDb";
import { getProviderCredentials } from "@/sse/services/auth.js";

const DELAY_MS = 100;
// Parallel selections finish ~DELAY_MS; serialized ~2×DELAY_MS. The parallel
// bound is looser than the serialized bound: under heavy batch concurrency the
// two overlapping 100ms sleeps can stretch (observed 180ms), but serialized
// stays ~200ms+, so the discrimination window is preserved.
const PARALLEL_THRESHOLD_MS = 190;
const SERIALIZED_THRESHOLD_MS = 150;

function conn(provider) {
  return [{
    id: `${provider}-1`,
    provider,
    authType: "apikey",
    apiKey: "sk-test",
    accessToken: null,
    refreshToken: null,
    providerSpecificData: {},
    isActive: true,
    priority: 1,
  }];
}

function mockConnectionsWithDelay(provider) {
  getProviderConnections.mockImplementation(async ({ provider: p }) => {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    return conn(p);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("per-provider selection mutex", () => {
  it("different providers select credentials in PARALLEL", async () => {
    mockConnectionsWithDelay();
    const t0 = Date.now();
    await Promise.all([
      getProviderCredentials("provA"),
      getProviderCredentials("provB"),
    ]);
    const elapsed = Date.now() - t0;
    // Parallel: both 100ms delays overlap → ~100ms total, well under the
    // bound. A global mutex would serialize them → ~200ms.
    expect(elapsed).toBeLessThan(PARALLEL_THRESHOLD_MS);
  });

  it("same provider selections stay SERIALIZED", async () => {
    mockConnectionsWithDelay();
    const t0 = Date.now();
    await Promise.all([
      getProviderCredentials("provA"),
      getProviderCredentials("provA"),
    ]);
    const elapsed = Date.now() - t0;
    // Serial: two 100ms delays run back-to-back → ~200ms, above the threshold.
    expect(elapsed).toBeGreaterThanOrEqual(SERIALIZED_THRESHOLD_MS);
  });

  it("provider aliases key the same mutex (same provider via alias)", async () => {
    mockConnectionsWithDelay();
    const t0 = Date.now();
    await Promise.all([
      getProviderCredentials("kiro"),
      getProviderCredentials("kr"), // alias of kiro
    ]);
    const elapsed = Date.now() - t0;
    // Both resolve to provider id "kiro" → same mutex → serialized.
    expect(elapsed).toBeGreaterThanOrEqual(SERIALIZED_THRESHOLD_MS);
  });
});

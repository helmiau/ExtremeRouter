import { describe, it, expect } from "vitest";
import { buildHealthOverview } from "../../open-sse/services/healthOverview.js";

const now = Date.now();

function health(provider, { total = 10, failures = 0, latency = 500 } = {}) {
  return {
    provider,
    total,
    successes: total - failures,
    failures,
    successRate: total > 0 ? (total - failures) / total : null,
    avgLatencyMs: latency,
    p50LatencyMs: latency,
    p95LatencyMs: latency,
    p99LatencyMs: latency,
    lastError: failures > 0 ? "500" : null,
    lastErrorAt: null,
  };
}

function breaker(key, state = "closed", cooldownRemainingMs = null) {
  return { provider: key, state, failures: 3, openedAt: null, cooldownEndsAt: null, cooldownRemainingMs };
}

function conn(provider, overrides = {}) {
  return { id: `c-${provider}-${Math.random().toString(36).slice(2, 6)}`, provider, displayName: `${provider} acct`, ...overrides };
}

describe("buildHealthOverview", () => {
  it("merges health + breaker + connections into per-provider rows", () => {
    const rows = buildHealthOverview({
      healthList: [health("openai", { total: 20, failures: 2 })],
      breakerList: [breaker("openai", "open", 12000)],
      connections: [conn("openai", { testStatus: "active" })],
    });

    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.id).toBe("openai");
    expect(r.health.total).toBe(20);
    expect(r.breaker.state).toBe("open");
    expect(r.breaker.cooldownRemainingMs).toBe(12000);
    expect(r.connections).toHaveLength(1);
    expect(r.worstStatus).toBe("active");
    expect(r.lockedConnections).toBe(0);
  });

  it("groups proxy-keyed breakers under the provider stem", () => {
    const rows = buildHealthOverview({
      healthList: [],
      breakerList: [breaker("workbuddy:proxy:pool-a", "halfOpen")],
      connections: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("workbuddy");
    expect(rows[0].breaker.state).toBe("halfOpen");
  });

  it("prefers the plain (non-proxy) breaker entry over proxy variants", () => {
    const rows = buildHealthOverview({
      healthList: [],
      breakerList: [breaker("workbuddy:proxy:pool-a", "open"), breaker("workbuddy", "closed")],
      connections: [],
    });

    expect(rows[0].breaker.state).toBe("closed");
  });

  it("flags connections whose rateLimitedUntil is still in the future as locked", () => {
    const rows = buildHealthOverview({
      healthList: [],
      breakerList: [],
      connections: [
        conn("gemini-cli", { testStatus: "unavailable", rateLimitedUntil: new Date(now + 60_000).toISOString() }),
        conn("gemini-cli", { testStatus: "active", rateLimitedUntil: null }),
      ],
    });

    const r = rows[0];
    expect(r.id).toBe("gemini-cli");
    expect(r.cooldownActive).toBe(true);
    expect(r.lockedConnections).toBe(1);
    expect(r.worstStatus).toBe("unavailable");
    expect(r.connections[0].cooldownActive).toBe(true);
    expect(r.connections[1].cooldownActive).toBe(false);
  });

  it("does not treat an expired rateLimitedUntil as locked", () => {
    const rows = buildHealthOverview({
      healthList: [],
      breakerList: [],
      connections: [conn("codex", { rateLimitedUntil: new Date(now - 60_000).toISOString() })],
    });

    expect(rows[0].cooldownActive).toBe(false);
    expect(rows[0].lockedConnections).toBe(0);
  });

  it("sorts by request volume desc, then provider id", () => {
    const rows = buildHealthOverview({
      healthList: [health("a", { total: 5 }), health("b", { total: 20 }), health("c", { total: 5 })],
      breakerList: [],
      connections: [],
    });

    expect(rows.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("includes providers that only have connections (no traffic yet)", () => {
    const rows = buildHealthOverview({
      healthList: [],
      breakerList: [],
      connections: [conn("kiro", { testStatus: "active" })],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("kiro");
    expect(rows[0].health).toBeNull();
    expect(rows[0].connections).toHaveLength(1);
  });
});

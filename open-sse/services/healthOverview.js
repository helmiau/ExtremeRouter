/**
 * Provider Health Overview — aggregates three live sources into one
 * heatmap-ready view per provider:
 *
 *   1. healthMonitor   — sliding-window success rate + latency percentiles
 *   2. circuitBreaker  — breaker state + cooldown per (provider, proxy) key
 *   3. providerConnections — per-connection lock/cooldown state persisted in
 *      localDb (testStatus, rateLimitedUntil, backoffLevel, lastError)
 *
 * The aggregation is pure (inputs injected) so it can be unit-tested without
 * touching the DB; the API route wires in the real sources.
 */

function breakerProviderStem(key) {
  const base = String(key || "").split(":")[0];
  return base || key;
}

function isCooldownActive(rateLimitedUntil) {
  if (!rateLimitedUntil) return false;
  const ts = new Date(rateLimitedUntil).getTime();
  return Number.isFinite(ts) && ts > Date.now();
}

function connectionLabel(conn) {
  return conn?.displayName || conn?.name || conn?.email || conn?.id || "unknown";
}

/**
 * Build the per-provider overview.
 *
 * @param {Object} sources
 * @param {Array}  sources.healthList   - getAllProviderHealth() output
 * @param {Array}  sources.breakerList  - getBreakerStates() output
 * @param {Array}  sources.connections  - active provider connections
 * @returns {Array} heatmap rows, sorted by request volume (then provider id)
 */
export function buildHealthOverview({ healthList = [], breakerList = [], connections = [] } = {}) {
  const byProvider = new Map();

  const ensure = (id) => {
    let e = byProvider.get(id);
    if (!e) {
      e = {
        id,
        health: null,
        breaker: null,
        connections: [],
        // Derived connection status (worst case across the provider's conns).
        lockedConnections: 0,
        cooldownActive: false,
        worstStatus: null,
      };
      byProvider.set(id, e);
    }
    return e;
  };

  for (const h of healthList) {
    const e = ensure(h.provider);
    e.health = h;
  }

  for (const b of breakerList) {
    const stem = breakerProviderStem(b.provider);
    const e = ensure(stem);
    // Prefer the plain (non-proxy) entry; fall back to any proxy variant.
    if (!e.breaker || b.provider === stem) e.breaker = b;
  }

  for (const conn of connections) {
    if (!conn || typeof conn.provider !== "string" || !conn.provider) continue;
    const e = ensure(conn.provider);
    const cooldown = isCooldownActive(conn.rateLimitedUntil);
    e.connections.push({
      id: conn.id,
      label: connectionLabel(conn),
      email: conn.email || null,
      testStatus: conn.testStatus || null,
      rateLimitedUntil: conn.rateLimitedUntil || null,
      cooldownActive: cooldown,
      backoffLevel: Number(conn.backoffLevel) || 0,
      lastError: conn.lastError || null,
      lastErrorAt: conn.lastErrorAt || null,
    });
    if (cooldown) {
      e.cooldownActive = true;
      e.lockedConnections++;
    }
    // Track the "worst" testStatus for at-a-glance cell coloring.
    if (conn.testStatus === "unavailable" || conn.testStatus === "quota_exhausted") {
      e.worstStatus = "unavailable";
    } else if (!e.worstStatus && conn.testStatus === "active") {
      e.worstStatus = "active";
    }
  }

  return [...byProvider.values()]
    .map((e) => ({
      id: e.id,
      health: e.health,
      breaker: e.breaker,
      connections: e.connections,
      lockedConnections: e.lockedConnections,
      cooldownActive: e.cooldownActive,
      worstStatus: e.worstStatus,
    }))
    .sort((a, b) => (b.health?.total || 0) - (a.health?.total || 0) || a.id.localeCompare(b.id));
}

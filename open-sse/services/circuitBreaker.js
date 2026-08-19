/**
 * Per-Provider Circuit Breaker.
 *
 * State machine: CLOSED → OPEN → HALF_OPEN → CLOSED (or back to OPEN).
 *
 *   CLOSED:    normal traffic. Failures are recorded in a rolling window.
 *              When failures >= threshold within windowMs → trip to OPEN.
 *   OPEN:      ALL traffic to this provider is blocked for cooldownMs.
 *              After cooldownMs → transition to HALF_OPEN.
 *   HALF_OPEN: a limited number of probe requests are allowed.
 *              First success → CLOSED (reset). First failure → OPEN again.
 *
 * Only "retryable" failures count toward the threshold: 5xx server errors,
 * network/timeout errors, and 429 rate limits. Client errors (400/401/402/
 * 403/404) do NOT count — they indicate a request problem, not provider health.
 *
 * PROXY-AWARE: state is keyed by `provider:proxyKey` (breakerKey()). A dead
 * proxy trips the breaker only for that (provider, proxy) pair, so traffic
 * through other proxies or direct connections keeps flowing. Calls that pass
 * no proxy config fall back to the plain provider key (backward compatible).
 *
 * State is in-memory (resets on restart). This is intentional: a fresh start
 * should give every provider a clean slate.
 */
import { EventEmitter } from "node:events";

// Singleton on global to survive Next.js dev hot-reload.
if (!global._circuitBreakers) {
  global._circuitBreakers = new Map(); // provider[:proxyKey] → BreakerState
  global._breakerEmitter = new EventEmitter();
  global._breakerEmitter.setMaxListeners(50);
}
const breakers = global._circuitBreakers;
export const breakerEmitter = global._breakerEmitter;

// Default config (overridable via settings.circuitBreaker).
export const BREAKER_DEFAULTS = {
  enabled: true,
  failureThreshold: 5,
  windowMs: 60000,
  cooldownMs: 30000,
  halfOpenMaxCalls: 1,
};

/**
 * Compute the breaker key for a provider + proxy combo.
 * Direct traffic → just the provider id (backward compatible with the
 * original per-provider breaker). Proxied traffic → "provider:proxy:<id>"
 * so one dead proxy does NOT trip the breaker for the provider's other
 * proxies or its direct connections.
 *
 * @param {string} provider - provider id (or alias)
 * @param {Object} [proxyConfig] - resolved proxy config (providerSpecificData
 *   after resolveConnectionProxyConfig: connectionProxyEnabled, Url, PoolId...)
 * @returns {string}
 */
export function breakerKey(provider, proxyConfig) {
  const pc = proxyConfig && typeof proxyConfig === "object" ? proxyConfig : {};
  if (!pc.connectionProxyEnabled) return provider;
  const poolId = pc.connectionProxyPoolId || "";
  const url = pc.connectionProxyUrl || "";
  return `${provider}:proxy:${poolId || url}`;
}

/**
 * Is this status code a "retryable" failure that should count toward the breaker?
 * 5xx = server error (provider down/buggy). 429 = rate limit (provider overloaded).
 * 0 = network/timeout error. Client errors (4xx except 429) don't count.
 */
export function isRetryableFailure(status) {
  const s = Number(status) || 0;
  return s === 0 || s === 429 || s >= 500;
}

// key = breakerKey(provider, proxyConfig); falls back to provider when omitted.
function resolveKey(provider, key) {
  return key || provider;
}

function getOrCreate(key) {
  let b = breakers.get(key);
  if (!b) {
    b = {
      key,
      state: "closed",
      failures: [], // { ts, status }
      openedAt: null,
      cooldownEndsAt: null,
      halfOpenCalls: 0,
      // A3 GC: last activity (any read/mutation) — used to evict idle entries.
      lastActivityAt: Date.now(),
    };
    breakers.set(key, b);
  }
  return b;
}

function emit(key) {
  const b = breakers.get(key);
  if (!b) return;
  breakerEmitter.emit("breaker:update", {
    provider: b.key,
    state: b.state,
    failures: b.failures.length,
    openedAt: b.openedAt,
    cooldownEndsAt: b.cooldownEndsAt,
  });
}

/**
 * Should traffic to this provider be blocked right now?
 * Returns true if the breaker is OPEN (block) or HALF_OPEN at capacity.
 *
 * NOTE: this function has a SIDE EFFECT — in HALF_OPEN state it atomically
 * claims a probe slot (increments halfOpenCalls). Use it at the point where
 * you actually intend to send traffic. For a read-only "would this be blocked?"
 * check (e.g. pre-filtering a combo model list), use `isBreakerBlocking()`
 * instead to avoid consuming probe slots.
 */
export function isCircuitOpen(provider, settings = {}, key = null) {
  const cfg = { ...BREAKER_DEFAULTS, ...(settings?.circuitBreaker || {}) };
  if (!cfg.enabled) return false;

  const k = resolveKey(provider, key);
  const b = getOrCreate(k);
  b.lastActivityAt = Date.now();
  const now = Date.now();

  if (b.state === "open") {
    if (b.cooldownEndsAt && now >= b.cooldownEndsAt) {
      // Cooldown elapsed → transition to HALF_OPEN, allow a probe.
      b.state = "halfOpen";
      b.halfOpenCalls = 0;
      emit(k);
    } else {
      return true; // still OPEN → block
    }
  }

  if (b.state === "halfOpen") {
    if (b.halfOpenCalls >= cfg.halfOpenMaxCalls) {
      return true; // probe in flight → block additional traffic
    }
    // H1 FIX: Atomically claim a probe slot so concurrent requests can't all
    // pass the half-open gate simultaneously (synchronous = no interleaving).
    b.halfOpenCalls++;
  }

  return false; // CLOSED or HALF_OPEN with capacity → allow
}

/**
 * Read-only check: would traffic to this provider be blocked right now?
 *
 * Mirrors the blocking logic of `isCircuitOpen` WITHOUT claiming a probe slot
 * or transitioning state. Use this for pre-filtering (e.g. skipping
 * breaker-open models from a combo list before attempting them) so we don't
 * consume the single HALF_OPEN probe slot during a read-only inspection.
 *
 * A model flagged blocking here is skipped proactively; if every model is
 * flagged (combo fully depleted), callers should still attempt the original
 * list as a last resort because the lazy OPEN→HALF_OPEN transition inside
 * isCircuitOpen may have fired by the time the attempt runs.
 */
export function isBreakerBlocking(provider, settings = {}, key = null) {
  const cfg = { ...BREAKER_DEFAULTS, ...(settings?.circuitBreaker || {}) };
  if (!cfg.enabled) return false;

  const k = resolveKey(provider, key);
  const b = breakers.get(k);
  if (!b) return false; // no state = never tripped = not blocking

  const now = Date.now();

  if (b.state === "open") {
    // If cooldown elapsed, the next real isCircuitOpen call will transition to
    // HALF_OPEN — so from a read-only view we consider it NOT blocking (the
    // attempt should proceed so isCircuitOpen can claim the probe).
    if (b.cooldownEndsAt && now >= b.cooldownEndsAt) return false;
    return true; // still in cooldown → blocking
  }

  if (b.state === "halfOpen") {
    // At capacity = a probe is already in flight → additional traffic blocked.
    return b.halfOpenCalls >= cfg.halfOpenMaxCalls;
  }

  return false; // CLOSED → not blocking
}

/**
 * Record a successful request. Resets the breaker to CLOSED (clears failures).
 */
export function recordBreakerSuccess(provider, settings = {}, key = null) {
  const cfg = { ...BREAKER_DEFAULTS, ...(settings?.circuitBreaker || {}) };
  if (!cfg.enabled) return;
  const k = resolveKey(provider, key);
  const b = getOrCreate(k);
  b.lastActivityAt = Date.now();
  if (b.state !== "closed" || b.failures.length > 0) {
    b.state = "closed";
    b.failures = [];
    b.openedAt = null;
    b.cooldownEndsAt = null;
    b.halfOpenCalls = 0;
    emit(k);
  }
}

/**
 * Record a failure. If threshold reached within window → trip to OPEN.
 * Only call this for retryable failures (use isRetryableFailure first).
 */
export function recordBreakerFailure(provider, status, settings = {}, key = null) {
  const cfg = { ...BREAKER_DEFAULTS, ...(settings?.circuitBreaker || {}) };
  if (!cfg.enabled) return;

  const k = resolveKey(provider, key);
  const b = getOrCreate(k);
  b.lastActivityAt = Date.now();
  const now = Date.now();

  // In HALF_OPEN, any failure re-trips immediately.
  if (b.state === "halfOpen") {
    b.state = "open";
    b.openedAt = now;
    b.cooldownEndsAt = now + cfg.cooldownMs;
    b.halfOpenCalls = 0;
    b.failures = [{ ts: now, status }];
    emit(k);
    return;
  }

  // CLOSED: record failure, prune expired, check threshold.
  if (b.state === "closed") {
    b.failures.push({ ts: now, status });
    // Prune failures outside the rolling window.
    const cutoff = now - cfg.windowMs;
    b.failures = b.failures.filter((f) => f.ts >= cutoff);

    if (b.failures.length >= cfg.failureThreshold) {
      b.state = "open";
      b.openedAt = now;
      b.cooldownEndsAt = now + cfg.cooldownMs;
      emit(k);
    }
  }
  // If already OPEN, ignore (we don't count failures while blocked).
}

/**
 * Release a claimed half-open probe slot without recording success or failure.
 * Use this when a request that passed the half-open gate is aborted or throws
 * an unhandled exception before reaching recordBreakerSuccess/Failure.
 * Without this, the slot leaks and the breaker sticks at capacity indefinitely.
 */
export function releaseBreakerProbe(provider, key = null) {
  const k = resolveKey(provider, key);
  const b = breakers.get(k);
  if (!b) return;
  b.lastActivityAt = Date.now();
  if (b.state !== "halfOpen") return;
  if (b.halfOpenCalls > 0) {
    b.halfOpenCalls--;
  }
}

// A3 GC: evict closed entries that have been idle for GC_IDLE_MS, at most once
// per GC_INTERVAL_MS (driven by getBreakerStates reads, so no extra timer).
// Only CLOSED entries are evicted — open/half-open entries carry transient
// cooldown state that should not be forgotten, and they resolve on their own.
const GC_IDLE_MS = 10 * 60 * 1000; // 10 min
const GC_INTERVAL_MS = 60 * 1000;  // sweep at most once per minute
let _lastSweepAt = 0;

function sweepIdleBreakers(now) {
  if (now - _lastSweepAt < GC_INTERVAL_MS) return;
  _lastSweepAt = now;
  const cutoff = now - GC_IDLE_MS;
  for (const [k, b] of breakers) {
    if (b.state === "closed" && (b.lastActivityAt || 0) < cutoff) {
      breakers.delete(k);
    }
  }
}

/**
 * Snapshot all breaker states (for dashboard / health page).
 */
export function getBreakerStates() {
  const now = Date.now();
  sweepIdleBreakers(now);
  const out = [];
  for (const b of breakers.values()) {
    // Refresh HALF_OPEN transition for accurate display.
    let displayState = b.state;
    let cooldownRemaining = null;
    if (b.state === "open" && b.cooldownEndsAt) {
      cooldownRemaining = Math.max(0, b.cooldownEndsAt - now);
      if (cooldownRemaining === 0) displayState = "halfOpen";
    }
    out.push({
      provider: b.key,
      state: displayState,
      failures: b.failures.length,
      openedAt: b.openedAt,
      cooldownEndsAt: b.cooldownEndsAt,
      cooldownRemainingMs: cooldownRemaining,
    });
  }
  return out;
}

/**
 * Get the cooldownEndsAt (epoch ms) for a breaker key, or null if the breaker
 * has no state / is not OPEN. Used by callers that must report an accurate
 * retry-after (e.g. getProviderCredentials returning rateLimited) instead of
 * hardcoding a cooldown.
 */
export function getBreakerCooldownEndsAt(provider, key = null) {
  const k = resolveKey(provider, key);
  const b = breakers.get(k);
  if (!b) return null;
  return b.state === "open" && b.cooldownEndsAt ? b.cooldownEndsAt : null;
}

/**
 * Drop every breaker entry. Used when the feature is toggled off so a later
 * re-enable starts from a clean slate instead of resurrecting stale OPEN state.
 */
export function clearAllBreakers() {
  if (breakers.size === 0) return false;
  breakers.clear();
  return true;
}

/**
 * Manually reset a breaker (for dashboard "force close" action).
 * When `key` is null, resets EVERY breaker entry for this provider
 * (all proxy variants) — matching the old per-provider semantics.
 */
export function resetBreaker(provider, key = null) {
  if (key) {
    const b = breakers.get(key);
    if (!b) return false;
    b.state = "closed";
    b.failures = [];
    b.openedAt = null;
    b.cooldownEndsAt = null;
    b.halfOpenCalls = 0;
    emit(key);
    return true;
  }
  // Reset all entries whose key is the provider itself or prefixed by it.
  let resetAny = false;
  for (const [k, b] of breakers) {
    if (k === provider || k.startsWith(`${provider}:`)) {
      b.state = "closed";
      b.failures = [];
      b.openedAt = null;
      b.cooldownEndsAt = null;
      b.halfOpenCalls = 0;
      emit(k);
      resetAny = true;
    }
  }
  return resetAny;
}

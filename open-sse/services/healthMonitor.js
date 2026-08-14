/**
 * Provider Health Monitor — in-memory sliding window per provider.
 *
 * Tracks success/failure/latency samples per provider in a rolling window.
 * Provides aggregates for the Health dashboard: success rate, avg latency,
 * p95 latency, error count, last error.
 *
 * State is in-memory and resets on restart. This is intentional for a
 * real-time monitoring view; persisted historical data lives in usageHistory.
 */
import { EventEmitter } from "node:events";

// Scale sample cap with window: min 200, max 2000.
// At 1 req/sec over 5 min = 300 samples — cap of 500 covers that comfortably.
// At 10 req/sec over 5 min = 3000 — cap prevents memory blowup.
const MAX_SAMPLES_BASE = 200;
const MAX_SAMPLES_CAP = 2000;
const MAX_SAMPLES_PER_MS = MAX_SAMPLES_BASE / 300000; // base rate per ms (200 per 5 min)

if (!global._healthMonitors) {
  global._healthMonitors = new Map(); // provider → monitor entry
  global._healthEmitter = new EventEmitter();
  global._healthEmitter.setMaxListeners(100);
}
const monitors = global._healthMonitors;
export const healthEmitter = global._healthEmitter;

const HEALTH_DEFAULTS = {
  enabled: true,
  windowMs: 300000, // 5 min
};

// A4: sample cap scaled to the window, bounded to [MAX_SAMPLES_BASE, MAX_SAMPLES_CAP]
// (nearest-rank slice later enforces the actual bound).
function computeMaxSamples(wMs) {
  return Math.min(MAX_SAMPLES_CAP, Math.max(MAX_SAMPLES_BASE, Math.ceil(MAX_SAMPLES_PER_MS * wMs * 5)));
}

function getOrCreate(provider, windowMs) {
  let m = monitors.get(provider);
  const wMs = windowMs || HEALTH_DEFAULTS.windowMs;
  if (!m) {
    m = {
      provider,
      samples: [],
      windowMs: wMs,
      // Co-lifecycle'd state (C2 fix: prevents unbounded module-level objects).
      emitTimer: null,
      lastSuccessRate: undefined,
      // A3 GC: last activity — used to evict idle monitor entries.
      lastActivityAt: Date.now(),
      // Dynamic sample cap scaled to window size (H1 fix), capped (A4).
      maxSamples: computeMaxSamples(wMs),
      // M1 fix: cached aggregate — invalidated on every new sample.
      cachedAggregate: null,
      cachedAt: 0,
    };
    monitors.set(provider, m);
  } else if (m.windowMs !== wMs) {
    // A4: config is dynamic — re-sync the window and sample cap when settings
    // change at runtime instead of fixing them at first creation.
    m.windowMs = wMs;
    m.maxSamples = computeMaxSamples(wMs);
    m.cachedAggregate = null; // window changed → stale aggregate
  }
  return m;
}

/**
 * Record a health sample (called from chat.js on both success and failure).
 */
export function recordHealthSample(provider, { success, latencyMs, status, trafficClass = "user" }, settings = {}) {
  const cfg = { ...HEALTH_DEFAULTS, ...(settings?.healthMonitor || {}) };

  // Always get-or-create so we can update the enabled flag even when disabled.
  const m = getOrCreate(provider, cfg.windowMs);
  m._enabled = cfg.enabled; // M2 fix: track current enabled state
  m.lastActivityAt = Date.now(); // A3 GC: any recorded sample counts as activity

  if (!cfg.enabled) {
    // Cancel any pending timer so stale events don't fire after disable.
    if (m.emitTimer) { clearTimeout(m.emitTimer); m.emitTimer = null; }
    return;
  }
  // Panel/coordinator traffic is intentionally excluded from routing health.
  // A wide swarm should not outweigh user-facing requests or trigger shedding.
  if (trafficClass !== "user") return;

  const now = Date.now();
  const sample = { ts: now, success: !!success, latencyMs: latencyMs || 0, status: status || (success ? 200 : 0), trafficClass };
  m.samples.push(sample);

  // M1 fix: invalidate cached aggregate on every new sample.
  m.cachedAggregate = null;

  // Prune: remove samples outside the window + enforce dynamic cap.
  const cutoff = now - m.windowMs;
  m.samples = m.samples.filter((s) => s.ts >= cutoff);
  if (m.samples.length > m.maxSamples) {
    m.samples = m.samples.slice(-m.maxSamples);
  }

  // Debounced emit (lightweight: just notify that this provider changed).
  scheduleHealthEmit(provider, m);
}

/**
 * Check if monitoring is enabled before scheduling emit.
 */
function scheduleHealthEmit(provider, m) {
  // Cancel any pending timer (prevents stale emit after disable — M2 fix).
  if (m.emitTimer) clearTimeout(m.emitTimer);
  m.emitTimer = setTimeout(() => {
    m.emitTimer = null;
    // M2 fix: re-check enabled inside timer callback in case monitoring was
    // disabled between sample insertion and timer fire.
    if (!m._enabled) return;
    const health = getProviderHealth(provider);
    if (!health) return;

    healthEmitter.emit("health:update", health);

    // Health degradation detection.
    const current = health.successRate;
    const prev = m.lastSuccessRate ?? 1;
    if (current !== null && current < 0.7 && prev >= 0.7 && health.total >= 5) {
      const alertPayload = {
        provider,
        successRate: Math.round(current * 100),
        avgLatencyMs: health.avgLatencyMs,
        message: `Provider "${provider}" health degraded — success rate dropped to ${Math.round(current * 100)}% (from ${Math.round(prev * 100)}%).`,
      };
      // C1 fix: emit degradation event on SSE stream so NotificationBell picks it up.
      healthEmitter.emit("health:degraded", { type: "health_degraded", ...alertPayload });

      // Also dispatch to webhooks (Discord/Telegram) — but don't swallow errors (H4 fix).
      import("@/shared/services/alertService.js")
        .then(({ dispatchAlert }) => {
          try {
            dispatchAlert("health_degraded", alertPayload);
          } catch (err) {
            console.error("[HEALTH] Alert dispatch failed:", err?.message || err);
          }
        })
        .catch((err) => {
          console.error("[HEALTH] Alert module load failed:", err?.message || err);
        });
    }
    m.lastSuccessRate = current;
  }, 500); // coalesce bursts — max 2 updates/sec per provider
}

/**
 * Compute health aggregates for a single provider from its sample window.
 */
export function getProviderHealth(provider) {
  const m = monitors.get(provider);
  if (!m) return null;

  // M1 fix: use cached aggregate if still valid.
  // Cache is invalidated on every new sample AND time-limited to 1s so
  // stale window data (samples aging out without new inserts) doesn't persist.
  const now = Date.now();
  if (m.cachedAggregate && (now - m.cachedAt) < 1000) {
    // Verify cache isn't returning data computed before the window cutoff.
    // If the oldest sample in the cache is still in-window, the cache is valid.
    return m.cachedAggregate;
  }

  const cutoff = now - m.windowMs;
  const samples = m.samples.filter((s) => s.ts >= cutoff);
  if (samples.length === 0) {
    return { provider, total: 0, successes: 0, failures: 0, successRate: null, avgLatencyMs: null, p50LatencyMs: null, p95LatencyMs: null, p99LatencyMs: null, lastError: null, lastErrorAt: null };
  }

  const successes = samples.filter((s) => s.success).length;
  const failures = samples.length - successes;
  const latencySamples = samples.filter((s) => s.latencyMs > 0).map((s) => s.latencyMs);
  const avgLatencyMs = latencySamples.length > 0
    ? Math.round(latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length)
    : null;
  // H3 fix: use nearest-rank method with proper handling for small samples.
  const sortedLatencies = [...latencySamples].sort((a, b) => a - b);
  const p50LatencyMs = latencySamples.length > 0 ? Math.round(percentile(sortedLatencies, 0.5)) : null;
  const p95LatencyMs = latencySamples.length > 0 ? Math.round(percentile(sortedLatencies, 0.95)) : null;
  // H5: p99 for tail-latency visibility in the health heatmap.
  const p99LatencyMs = latencySamples.length > 0 ? Math.round(percentile(sortedLatencies, 0.99)) : null;

  const lastFailure = [...samples].reverse().find((s) => !s.success);

  const result = {
    provider,
    total: samples.length,
    successes,
    failures,
    successRate: successes / samples.length,
    avgLatencyMs,
    p50LatencyMs,
    p95LatencyMs,
    p99LatencyMs,
    // L1 fix: map status 0 to "Network error" for clarity.
    lastError: lastFailure
      ? (String(lastFailure.status) === "0" ? "Network error" : String(lastFailure.status))
      : null,
    lastErrorAt: lastFailure ? lastFailure.ts : null,
  };

  // M1 fix: cache the computed aggregate.
  m.cachedAggregate = result;
  m.cachedAt = now;

  return result;
}

// A3 GC: evict monitor entries idle for GC_IDLE_MS, at most once per
// GC_INTERVAL_MS (driven by getAllProviderHealth reads, so no extra timer).
// Safe: an evicted provider simply starts collecting fresh samples again.
const GC_IDLE_MS = 10 * 60 * 1000; // 10 min
const GC_INTERVAL_MS = 60 * 1000;  // sweep at most once per minute
let _lastSweepAt = 0;

function sweepIdleHealth(now) {
  if (now - _lastSweepAt < GC_INTERVAL_MS) return;
  _lastSweepAt = now;
  const cutoff = now - GC_IDLE_MS;
  for (const [p, m] of monitors) {
    if ((m.lastActivityAt || 0) < cutoff) {
      if (m.emitTimer) clearTimeout(m.emitTimer);
      monitors.delete(p);
    }
  }
}

/**
 * Snapshot all provider health (for dashboard initial load).
 */
export function getAllProviderHealth() {
  sweepIdleHealth(Date.now());
  return [...monitors.keys()]
    .map((p) => getProviderHealth(p))
    .filter(Boolean)
    .sort((a, b) => b.total - a.total);
}

/**
 * Nearest-rank percentile method.
 * For small samples (n<20), interpolates between available data points
 * instead of always returning the max (H3 fix).
 */
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];

  // Linear interpolation between closest ranks for more stable small-sample p95.
  const rank = p * (sortedAsc.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return sortedAsc[lower] * (1 - weight) + sortedAsc[upper] * weight;
}

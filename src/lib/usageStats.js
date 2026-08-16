// Shared usage-statistics helpers. The percentile convention here is the
// codebase-wide nearest-rank style (same one previously inlined in both
// usageRepo.getUsageStats and /api/usage/leaderboard):
//   sorted[Math.min(N - 1, Math.floor(p / 100 * N))]
// Keeping it in one place guarantees the global stats, the leaderboard, and
// any per-model aggregation can never drift apart.

/**
 * Nearest-rank percentile of a SORTED ascending array.
 * @param {number[]} sortedValues  ascending-sorted numbers
 * @param {number} p  percentile 0..100 (e.g. 50, 95)
 * @returns {number|null} the value at the percentile, or null for empty input
 */
export function percentile(sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  const idx = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
  return sortedValues[idx];
}

/**
 * Aggregate latency/TTFT samples into avg + p50 + p95 + sampleCount.
 * @param {number[]} values  raw ms samples (unsorted)
 * @returns {{avg: number, p50: number|null, p95: number|null, sampleCount: number}}
 */
export function latencyStats(values) {
  const list = Array.isArray(values) ? values.filter((v) => typeof v === "number" && v > 0) : [];
  if (list.length === 0) return { avg: 0, p50: null, p95: null, sampleCount: 0 };
  const sorted = [...list].sort((a, b) => a - b);
  const sum = list.reduce((a, b) => a + b, 0);
  return {
    avg: Math.round(sum / list.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    sampleCount: list.length,
  };
}

/**
 * Aggregate usage-history rows into per-model latency stats, keyed by fullModel
 * "provider/model". Single source of truth for the combo simulator's per-member
 * latency lookup (same percentile convention as the global stats and the
 * leaderboard). Non-positive latency rows are skipped (error/pre-migration rows).
 *
 * @param {Array<object>} history  rows with provider, model, latencyTtftMs,
 *   latencyTotalMs (getUsageHistory output)
 * @returns {Object<string, {provider, model, fullModel, sampleCount, avgTtft,
 *   avgLatency, p50, p95}>} keyed by fullModel
 */
export function aggregateModelLatency(history) {
  const ttftByModel = {};
  const latencyByModel = {};
  for (const row of history || []) {
    const p = row?.provider || "unknown";
    const model = row?.model;
    if (!model) continue;
    const fullModel = `${p}/${model}`;
    if (row.latencyTtftMs > 0) {
      if (!ttftByModel[fullModel]) ttftByModel[fullModel] = [];
      ttftByModel[fullModel].push(row.latencyTtftMs);
    }
    if (row.latencyTotalMs > 0) {
      if (!latencyByModel[fullModel]) latencyByModel[fullModel] = [];
      latencyByModel[fullModel].push(row.latencyTotalMs);
    }
  }
  const mean = (arr) => (arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  const out = {};
  for (const [fullModel, lat] of Object.entries(latencyByModel)) {
    const ttfts = ttftByModel[fullModel] || [];
    const sortedLat = [...lat].sort((a, b) => a - b);
    const slash = fullModel.indexOf("/");
    out[fullModel] = {
      provider: slash > 0 ? fullModel.slice(0, slash) : fullModel,
      model: slash > 0 ? fullModel.slice(slash + 1) : fullModel,
      fullModel,
      sampleCount: lat.length,
      avgTtft: mean(ttfts),
      avgLatency: mean(lat),
      p50: percentile(sortedLat, 50),
      p95: percentile(sortedLat, 95),
    };
  }
  return out;
}

// Statuses recorded in usageHistory that count as a provider SUCCESS. Everything
// else (429/404/503/0/"error"/"failed"/…) is a failure for the reliability axis.
// 499 (client abort) is excluded entirely — it is a cancellation, not a provider
// outcome (same convention as the health samples).
export const USAGE_SUCCESS_STATUS = new Set(["ok", "success", "200", ""]);

/**
 * Per-model outcome counts from usage-history rows: ok vs total. A row is a
 * failure unless its status is a known success value; 499 (client abort) rows
 * are dropped from both counts. Keyed by fullModel "provider/model" as recorded
 * (providers are already canonical in usage rows).
 *
 * @param {Array<object>} history  getUsageHistory output
 * @returns {Object<string, {ok: number, total: number, successRate: number|null}>}
 */
export function computeModelOutcomes(history) {
  const counts = {};
  for (const row of history || []) {
    if (!row?.provider || !row?.model) continue;
    const status = String(row.status || "ok").toLowerCase();
    if (status === "499") continue; // client abort — not a provider outcome
    const key = `${row.provider}/${row.model}`;
    if (!counts[key]) counts[key] = { ok: 0, total: 0 };
    counts[key].total++;
    if (USAGE_SUCCESS_STATUS.has(status)) counts[key].ok++;
  }
  const out = {};
  for (const [key, c] of Object.entries(counts)) {
    out[key] = { ...c, successRate: c.total > 0 ? c.ok / c.total : null };
  }
  return out;
}

/**
 * Per-model success rate 0..1 keyed by fullModel. Requires ≥ 2 samples before
 * emitting a rate (a single sample would report 100%/0% on noise).
 *
 * @param {Array<object>} history  getUsageHistory output
 * @returns {Object<string, number>} fullModel → success rate
 */
export function computeModelReliability(history) {
  const out = {};
  for (const [key, c] of Object.entries(computeModelOutcomes(history))) {
    if (c.total >= 2) out[key] = c.successRate;
  }
  return out;
}

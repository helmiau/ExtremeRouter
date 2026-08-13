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

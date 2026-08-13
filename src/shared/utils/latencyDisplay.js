// Shared latency display helpers — one source of truth for how latency values
// are formatted and when a p50/p95 is trustworthy. Used by the leaderboard
// table, the usage latency chart, and (later) the combo simulator.

/** Minimum non-zero latency samples before a percentile is worth showing. */
export const LATENCY_MIN_SAMPLES = 10;

/**
 * True when a percentile value may be displayed without the insufficient-data
 * warning. Missing sampleCount (older payloads / unknown) is treated as
 * "display as-is" — we only warn when we KNOW the sample count is too small.
 * @param {number|null|undefined} sampleCount
 * @returns {boolean}
 */
export function hasEnoughLatencySamples(sampleCount) {
  return sampleCount == null || sampleCount >= LATENCY_MIN_SAMPLES;
}

/**
 * Format a latency in ms → "123ms" / "1.2s", "—" for null/undefined.
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatLatencyMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Build the display text for a latency percentile with the sample guard:
 * returns the formatted value when there are enough samples (or the count is
 * unknown), otherwise the "insufficient data" marker.
 * @param {number|null|undefined} ms
 * @param {number|null|undefined} sampleCount
 * @returns {{value: string, insufficient: boolean}}
 */
export function latencyDisplay(ms, sampleCount) {
  if (ms == null) return { value: "—", insufficient: false };
  if (!hasEnoughLatencySamples(sampleCount)) {
    return { value: "insufficient data", insufficient: true };
  }
  return { value: formatLatencyMs(ms), insufficient: false };
}

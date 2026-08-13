// Server-side cache for key-gated /v1/models catalogs (suggested-models route).
//
// The upstream catalog is relatively static and the endpoint requires an API
// key, so the filtered result is cached per (url, connectionId, type). Without
// this, every page open / client-cache miss (refresh, new browser) would hit
// upstream through the proxy again — wasteful for a list that rarely changes.
//
// Keys include the connectionId because a gateway returns exactly the aliases
// the key is entitled to: two connections to the same provider can see
// different catalogs.

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — same ballpark as the client cache
const MAX_ENTRIES = 200;

const cache = new Map(); // key -> { data, expiresAt }

/**
 * Stable cache key for a catalog fetch.
 * @param {string} url - models endpoint URL (resolved from registry config)
 * @param {string|null} connectionId - owning connection (null → public fetch)
 * @param {string} type - FILTERS key (bynara, openai, …)
 * @returns {string}
 */
export function suggestedModelsCacheKey(url, connectionId, type) {
  return `${url}::${connectionId || "public"}::${type}`;
}

/**
 * @param {string} key
 * @returns {Array|null} cached filtered models, or null on miss/expiry
 */
export function getCachedSuggestedModels(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

/**
 * Store a filtered model list. Sweeps expired entries once the map grows, and
 * evicts the oldest entry if the sweep isn't enough — bounded memory, no leak.
 * @param {string} key
 * @param {Array} data
 */
export function setCachedSuggestedModels(key, data) {
  if (cache.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now >= v.expiresAt) cache.delete(k);
    }
    if (cache.size >= MAX_ENTRIES) {
      cache.delete(cache.keys().next().value);
    }
  }
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Test/telemetry helper. */
export function clearSuggestedModelsCache() {
  cache.clear();
}

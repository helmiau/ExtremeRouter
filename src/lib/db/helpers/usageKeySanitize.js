import { createHash } from "node:crypto";

const HASH_PREFIX = "sha256:";
const MASK_SUFFIX = "***";

/** Return stable non-reversible identifier for a gateway API key. */
export function hashApiKey(key) {
  if (typeof key !== "string" || !key) return null;
  if (key.startsWith(HASH_PREFIX)) return key;
  return `${HASH_PREFIX}${createHash("sha256").update(key, "utf8").digest("hex")}`;
}

/** Preserve the existing dashboard display shape without retaining the secret. */
export function maskApiKey(key) {
  if (typeof key !== "string" || !key) return null;
  if (key.startsWith(HASH_PREFIX)) return `${HASH_PREFIX}${key.slice(HASH_PREFIX.length, HASH_PREFIX.length + 8)}…`;
  if (key.endsWith(MASK_SUFFIX)) return key;
  if (key.length <= 8) return `${key.charAt(0)}${MASK_SUFFIX}`;
  return `${key.slice(0, 8)}${MASK_SUFFIX}`;
}

/** Values already scrubbed by this helper or by the old API response layer. */
export function isLikelyRawKey(value) {
  return typeof value === "string"
    && value.length > 0
    && value !== "local-no-key"
    && !value.startsWith(HASH_PREFIX)
    && !value.endsWith(MASK_SUFFIX);
}

export function sanitizeApiKey(key) {
  if (!isLikelyRawKey(key)) {
    return {
      hash: typeof key === "string" && key.startsWith(HASH_PREFIX) ? key : null,
      prefix: typeof key === "string" && key.endsWith(MASK_SUFFIX) ? key : null,
    };
  }
  return { hash: hashApiKey(key), prefix: maskApiKey(key) };
}

/**
 * Rewrite legacy usageDaily.byApiKey entries without retaining raw keys.
 * Returns a new day object so migration callers can safely compare/write it.
 */
export function scrubDailyByApiKey(day) {
  if (!day || typeof day !== "object" || !day.byApiKey || typeof day.byApiKey !== "object") return day;

  const byApiKey = {};
  for (const [oldKey, value] of Object.entries(day.byApiKey)) {
    const meta = value && typeof value === "object" ? { ...value } : {};
    const raw = typeof meta.apiKey === "string" ? meta.apiKey : null;
    const keyParts = oldKey.split("|");
    const keyValue = keyParts[0];
    const sourceKey = raw || (isLikelyRawKey(keyValue) ? keyValue : null);
    const sanitized = sanitizeApiKey(sourceKey);
    const apiKeyHash = sanitized.hash || meta.apiKeyHash || null;
    const apiKeyPrefix = sanitized.prefix || meta.apiKeyPrefix || null;
    const nextKey = apiKeyHash
      ? `${apiKeyHash}|${keyParts.slice(1).join("|")}`
      : oldKey;

    delete meta.apiKey;
    if (apiKeyHash) meta.apiKeyHash = apiKeyHash;
    if (apiKeyPrefix) meta.apiKeyPrefix = apiKeyPrefix;
    byApiKey[nextKey] = meta;
  }

  return { ...day, byApiKey };
}

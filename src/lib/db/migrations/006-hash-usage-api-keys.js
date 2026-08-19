// Migration 006: stop persisting raw gateway API keys in usage tables.
//
// usageHistory.apiKey and usageDaily.data.byApiKey previously stored the full
// sk-… key. This migration replaces them with a sha256 hash + masked prefix:
//   - adds the apiKeyHash column (write path fills it going forward)
//   - backfills existing rows that still hold raw keys
//   - rewrites legacy usageDaily rollups via scrubDailyByApiKey
//
// Idempotent: rows already holding masked/hashed values are skipped, so a
// re-run (e.g. schema auto-sync) is safe.
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { hashApiKey, maskApiKey, isLikelyRawKey, scrubDailyByApiKey } from "../helpers/usageKeySanitize.js";

export default {
  version: 6,
  name: "hash-usage-api-keys",
  up(db) {
    const cols = (db.all("PRAGMA table_info(usageHistory)") || []).map((c) => c.name);
    if (!cols.includes("apiKeyHash")) {
      db.exec("ALTER TABLE usageHistory ADD COLUMN apiKeyHash TEXT");
    }

    // 1. Backfill history rows that still carry raw keys.
    const rows = db.all("SELECT id, apiKey FROM usageHistory WHERE apiKey IS NOT NULL AND apiKey != ''");
    for (const row of rows) {
      if (!isLikelyRawKey(row.apiKey)) continue;
      db.run("UPDATE usageHistory SET apiKeyHash = ?, apiKey = ? WHERE id = ?", [
        hashApiKey(row.apiKey), maskApiKey(row.apiKey), row.id,
      ]);
    }

    // 2. Rewrite legacy daily rollups (byApiKey map keys + meta.apiKey).
    const days = db.all("SELECT dateKey, data FROM usageDaily");
    for (const d of days) {
      const day = parseJson(d.data, {});
      if (!day || !day.byApiKey) continue;
      const scrubbed = scrubDailyByApiKey(day);
      if (scrubbed !== day) {
        db.run("UPDATE usageDaily SET data = ? WHERE dateKey = ?", [stringifyJson(scrubbed), d.dateKey]);
      }
    }
  },
};

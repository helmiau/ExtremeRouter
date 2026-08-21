// Migration 007: rewrite uiAlias-prefixed data to canonical routing aliases.
//
// The dashboard used to conflate `uiAlias` (display-only badge token) with the
// routing `alias` when building provider/model strings
// (src/shared/constants/providers.js). Rows stored under that regime carry
// tokens the gateway cannot resolve (bynara models stored as "by/…") or, worse,
// resolve to a DIFFERENT provider (tokenrouter models stored as "tr/…" route to
// trae, which owns the canonical "tr" alias).
//
// This rewrites those tokens once to the registry entry's `alias` (or id). The
// only cross-provider collision is "tr" (trae canonical vs tokenrouter uiAlias):
// the rewrite is skipped while a trae connection exists, because the token
// could then genuinely mean trae.
//
// Idempotent: after the rewrite, no key/member carries a uiAlias prefix, so
// re-runs are a no-op.
import REGISTRY from "open-sse/providers/registry/index.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function buildUiAliasRewriteMap() {
  const map = new Map();
  for (const r of REGISTRY) {
    const canonical = r.alias || r.id;
    if (r.uiAlias && r.uiAlias !== canonical) map.set(r.uiAlias, canonical);
  }
  return map;
}

export default {
  version: 7,
  name: "canonicalize-ui-alias-data",
  up(db) {
    const rewrite = buildUiAliasRewriteMap();
    const traeConnected = !!db.get("SELECT 1 FROM providerConnections WHERE provider = ? LIMIT 1", ["trae"]);
    if (traeConnected) rewrite.delete("tr");

    const rewritePrefix = (value) => {
      const s = String(value);
      const sep = s.indexOf("/");
      if (sep <= 0) return s;
      const canonical = rewrite.get(s.slice(0, sep));
      return canonical ? canonical + s.slice(sep) : s;
    };

    // 1. Custom model keys: kv scope "customModels", key = "prefix|id|kind".
    const customRows = db.all("SELECT key FROM kv WHERE scope = ?", ["customModels"]);
    for (const row of customRows) {
      const sep = row.key.indexOf("|");
      if (sep <= 0) continue;
      const prefix = row.key.slice(0, sep);
      if (!rewrite.has(prefix)) continue;
      const newKey = rewrite.get(prefix) + row.key.slice(sep);
      const exists = db.get("SELECT 1 FROM kv WHERE scope = ? AND key = ?", ["customModels", newKey]);
      if (exists) db.run("DELETE FROM kv WHERE scope = ? AND key = ?", ["customModels", row.key]);
      else db.run("UPDATE kv SET key = ? WHERE scope = ? AND key = ?", [newKey, "customModels", row.key]);
    }

    // 2. Combo members: combos.models is a JSON array of "prefix/model" strings.
    const combos = db.all("SELECT id, models FROM combos");
    for (const combo of combos) {
      const models = parseJson(combo.models);
      if (!Array.isArray(models)) continue;
      const next = models.map(rewritePrefix);
      if (JSON.stringify(next) !== JSON.stringify(models)) {
        db.run("UPDATE combos SET models = ? WHERE id = ?", [stringifyJson(next), combo.id]);
      }
    }
  },
};

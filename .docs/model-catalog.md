# Dynamic Model Capability Catalog

Keeps model capability metadata fresh by syncing **[models.dev](https://models.dev)**
in the background, so a newly released model gains vision or a wider context
window without a hand edit to `open-sse/providers/capabilities.js`.

> **Dynamic catalog metadata is an external evidence source. It never overrides
> explicit ExtremeRouter/provider configuration** — the hand-written capability
> tables and provider-specific entries always win.

## What it syncs, and what it deliberately does not

Two layers with deliberately different keys (the same logical model served by
two gateways can have different limits):

| Layer | Key | Source rule |
|---|---|---|
| **Modalities** (`vision`, `pdf`, `audioInput`, `videoInput`) | canonical **model** id (vendor prefix / `:variant` stripped, lowercased) | A **majority** (≥50%) of models.dev providers offering the model must declare the modality — one reseller mislabelling a text model cannot flip `vision` on |
| **Limits** (`contextWindow`, `maxOutput`) | **provider + model** | Only the matching provider's own numbers (direct id match or the alias map in `src/lib/modelCatalog/normalize.js`) |

Not synced: `reasoning`, `tool_call`, pricing, thinking formats, `search`. Those
stay hand-maintained — they change routing behavior in ways an external catalog
should not decide.

## Precedence

```
1. PROVIDER_CAPABILITIES[provider][model]   (explicit provider/model override — short-circuits everything)
2. hand-written tiers (MODEL_CAPABILITIES / PATTERN_CAPABILITIES / floor)
3. registryLimits (provider's own declared contextWindow/maxOutput)
4. synced catalog delta                     ← new, lowest evidence tier
5. DEFAULT_CAPABILITIES floor
```

Rules enforced in `getCapabilitiesForModel`:

- The catalog **fills** capabilities the matched tier did not explicitly
  declare; a hand-written `vision: false` stays `false` even when models.dev
  says `true` (and vice versa). Tier-1 provider entries are never refined.
- Catalog **limits** replace a resolved value only when they diverge by more
  than 10% (gateways round: 200000 vs 202752), and registry-declared limits
  always outrank catalog limits.
- Catalog results carry `confidence: "inferred"` (never `verified`) and, when
  the catalog contributed anything, a
  `catalog: { modalities: [...], limits: true }` provenance object plus
  `sourceType: "dynamic-catalog"` for catalog-sourced limits — so
  "why does ExtremeRouter think this model supports vision?" is answerable
  from the resolved object alone.
- Unknown stays unknown: a capability absent from the catalog contributes
  nothing and is never manufactured into `false` or `true`.

## Refresh lifecycle

```
startup (initializeApp)                     — never blocks boot
  → load persisted snapshot from disk       — last-known-good from a previous run
  → MODEL_CATALOG_STARTUP_DELAY (60s)
  → worker thread: download → parse → normalize → atomic write
  → main thread: load small validated snapshot into memory (atomic swap)
  → success: next sync in 24h | failure: retry in 30min (bounded backoff)
```

- **Worker thread**: the upstream payload is ~4.4MB / 7,488 models / 211
  providers and takes ~180ms to `JSON.parse` — long enough to stall concurrent
  SSE traffic, so the download/parse/normalize runs off the main thread. The
  main thread only loads the small validated delta snapshot (tens of KB).
- **ETag**: an unchanged catalog costs one empty 304 request.
- **No overlap**: a sync while one is running is a no-op (`syncModelCatalog`
  returns `null`).
- **Failure isolation**: network errors, HTTP 5xx, malformed JSON, oversized
  payloads, and invalid records all keep the last-known-good snapshot; sync
  failures never touch request handling (§ invariant: a catalog bug cannot
  cause a 500).

## Storage

One small JSON file: `<DATA_DIR>/model-catalog.json`
(`{ schemaVersion, source, syncedAt, etag, models, providers }`), written
atomically (tmp + rename) by the worker, validated then swapped into memory by
the main thread. Lookups after that are plain object reads — **no filesystem or
network access on the request hot path**.

## Status / manual refresh

`GET /api/models/catalog-sync` →
`{ enabled, state: ready|syncing|stale|unavailable, lastSuccessAt, lastAttemptAt, lastError, etag, modelCount, providerCount, stale, ... }`

`POST /api/models/catalog-sync` → run a sync now (503 if one is already
running). Both sit under `/api/models`, so the standard dashboard
authentication applies.

## Configuration (`open-sse/config/runtimeConfig.js`)

| Env | Default | Meaning |
|---|---|---|
| `MODEL_CATALOG` | on | `off` disables the background sync (local tables only) |
| `MODEL_CATALOG_URL` | `https://models.dev/api.json` | https-only catalog source |
| `MODEL_CATALOG_STARTUP_DELAY` | 60000 | ms before the first sync |
| `MODEL_CATALOG_REFRESH_INTERVAL` | 24h | refresh cadence after a success |
| `MODEL_CATALOG_RETRY_BACKOFF` | 30min | retry cadence after a failure |
| `MODEL_CATALOG_REQUEST_TIMEOUT` | 60000 | upstream fetch timeout |
| `MODEL_CATALOG_WORKER_TIMEOUT` | 120000 | worker hard-stop |
| `MODEL_CATALOG_MAX_STALENESS` | 7d | `stale` flag threshold (reporting only) |

## When models.dev is unavailable

Nothing happens to routing. The gateway runs entirely on the hand-written
capability tables (+ registry limits); a stale or missing catalog is reported
via the status endpoint but never disables anything.

## Known limitations

- Provider coverage for **limits** requires a direct id match or an entry in
  `PROVIDER_ID_TO_CATALOG`; unmapped reseller/multi-model gateways keep their
  local numbers (their models still get **modalities**, which are model-level).
- The catalog does not decide `reasoning`/`tools`/thinking wire formats.
- models.dev itself can be wrong — hence majority voting, tolerance, and the
  strict precedence above. Catalog data is treated as evidence, not authority.

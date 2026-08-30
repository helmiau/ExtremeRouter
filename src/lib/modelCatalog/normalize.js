// Pure core of the Dynamic Model Capability Catalog sync.
//
// Everything here is deterministic and side-effect free apart from the
// caller-provided fetchImpl — the worker shell (worker.js) and the tests both
// drive it. NO app imports, NO bundler aliases: the worker thread cannot
// resolve "open-sse/*", so this module must stay dependency-free.
//
// models.dev shape (https://models.dev/api.json):
//   { "<providerId>": { models: { "<modelId>": {
//       modalities: { input: ["text","image","pdf","audio","video"] },
//       limit: { context, output } } } } }

// models.dev input modality → ExtremeRouter capability key.
const MODALITY_BY_INPUT = {
  image: "vision",
  pdf: "pdf",
  audio: "audioInput",
  video: "videoInput",
};

// ExtremeRouter provider id → models.dev provider id (context/output limits
// only). Direct id matches need no entry. Providers absent here keep whatever
// the local capability tables resolve — documented limitation, not an error.
const PROVIDER_ID_TO_CATALOG = {
  glm: "zai",
  "glm-cn": "zhipuai",
  claude: "anthropic",
  gemini: "google",
  "gemini-cli": "google",
  antigravity: "google",
  vertex: "google",
  kimi: "moonshotai",
  "kimi-coding": "moonshotai",
  moonshot: "moonshotai",
  qwen: "alibaba",
  "qwen-cloud": "alibaba-cn",
  alibaba: "alibaba",
  "alibaba-cn": "alibaba-cn",
  deepseek: "deepseek",
  xai: "xai",
  openai: "openai",
  openrouter: "openrouter",
  minimax: "minimax",
  "minimax-cn": "minimax-cn",
  bytedance: "bytedance",
  "internvl": "internvl",
};

// "zai-org/GLM-4.6V:free" → "glm-4.6v" — vendor prefix and :variant suffix
// stripped, lowercased. Must match catalogSource.js catalogBaseId exactly.
export function catalogBaseId(modelId) {
  if (!modelId || typeof modelId !== "string") return "";
  const withoutVendor = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  return withoutVendor.toLowerCase().split(":")[0];
}

function isPositiveLimit(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e9;
}

/**
 * Build the ExtremeRouter catalog delta from a raw models.dev payload.
 *
 * Two layers with deliberately different keys:
 *   - Modalities belong to the MODEL — every gateway serving it runs the same
 *     weights — so they are keyed by base model id and need a MAJORITY of
 *     catalog sources to declare them (one reseller mislabelling a text model
 *     must not flip vision on).
 *   - Context/output limits belong to the GATEWAY — each truncates differently
 *     — so they are keyed provider + model, and only the matching provider's
 *     own numbers are kept.
 *
 * The delta only holds values that MEANINGFULLY differ from what the local
 * capability tables already resolve (tolerance) or that they do not declare —
 * keeping the snapshot small and the hot-path merge cheap.
 *
 * @param {object} rawCatalog   - parsed models.dev payload
 * @param {Array}  entries      - [{provider, model, contextLength, current}] registry snapshot
 * @param {object} opts         - { minModalityShare, limitTolerance }
 * @returns {{ models: object, providers: object }}
 */
export function buildCatalogDelta(rawCatalog, entries, opts = {}) {
  const minShare = typeof opts.minModalityShare === "number" ? opts.minModalityShare : 0.5;
  const tolerance = typeof opts.limitTolerance === "number" ? opts.limitTolerance : 0.1;

  if (!rawCatalog || typeof rawCatalog !== "object" || Array.isArray(rawCatalog)) {
    return { models: {}, providers: {} };
  }

  // Index once: per provider for limits, majority-tallied for modalities.
  // Malformed records are skipped, never fatal (§19).
  const byProvider = {};
  const tally = {};
  for (const [providerId, provider] of Object.entries(rawCatalog)) {
    if (!provider || typeof provider !== "object" || !provider.models || typeof provider.models !== "object") continue;
    const models = {};
    // Modality majority is counted at PROVIDER × canonical-model granularity:
    // multiple ids from one provider can normalize to the same model
    // (foo, foo:free, foo:preview …) and represent ONE provider vote — they
    // must not inflate the denominator. First record wins (deterministic:
    // the same upstream payload yields the same representative).
    const counted = new Set();
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!model || typeof model !== "object") continue;
      const id = catalogBaseId(modelId);
      if (!id) continue;

      const modalities = model.modalities && typeof model.modalities === "object" ? model.modalities : null;
      const inputs = modalities && Array.isArray(modalities.input) ? modalities.input.filter((m) => typeof m === "string") : [];
      const context = model.limit && isPositiveLimit(model.limit.context) ? model.limit.context : null;
      const output = model.limit && isPositiveLimit(model.limit.output) ? model.limit.output : null;
      if (!inputs.length && !context && !output) continue;

      // Per-provider map for the LIMITS layer — gateway-scoped, kept as-is
      // (last record wins); deduplication applies to modality votes only.
      models[id] = { inputs, context, output };

      if (counted.has(id)) continue;
      counted.add(id);

      const counts = tally[id] || (tally[id] = { total: 0 });
      counts.total += 1;
      for (const input of inputs) {
        const key = MODALITY_BY_INPUT[input];
        if (key) counts[key] = (counts[key] || 0) + 1;
      }
    }
    if (Object.keys(models).length) byProvider[providerId] = models;
  }

  // Modalities: model-level, majority-voted.
  const modelsOut = {};
  for (const [id, counts] of Object.entries(tally)) {
    const declared = {};
    for (const key of Object.values(MODALITY_BY_INPUT)) {
      if ((counts[key] || 0) / counts.total >= minShare) declared[key] = true;
    }
    if (Object.keys(declared).length) modelsOut[id] = declared;
  }

  // Limits: gateway-level, resolved against the matching catalog provider.
  const providersOut = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.provider !== "string" || typeof entry.model !== "string") continue;
    const direct = byProvider[entry.provider];
    const alias = PROVIDER_ID_TO_CATALOG[entry.provider];
    const upstreamProvider = direct ? entry.provider : alias && byProvider[alias] ? alias : null;
    if (!upstreamProvider) continue;

    const upstream = byProvider[upstreamProvider][catalogBaseId(entry.model)];
    if (!upstream) continue;

    const delta = {};
    const { context, output } = upstream;
    const current = entry.current && typeof entry.current === "object" ? entry.current : {};

    // Context: only when the local tables have no registry-declared length for
    // this endpoint AND the resolved value diverges beyond tolerance.
    if (context && !entry.contextLength && diverges(context, current.contextWindow, tolerance)) {
      delta.contextWindow = context;
    }
    // Output: no registry-declared equivalent — compare with the resolved cap.
    if (output && diverges(output, current.maxOutput, tolerance)) {
      delta.maxOutput = output;
    }
    if (Object.keys(delta).length) {
      (providersOut[entry.provider] || (providersOut[entry.provider] = {}))[entry.model] = delta;
    }
  }

  return { models: modelsOut, providers: providersOut };
}

function diverges(next, current, tolerance) {
  if (typeof current !== "number" || !Number.isFinite(current) || current <= 0) return true;
  return Math.abs(next - current) / current > tolerance;
}

/**
 * Conditional fetch + validate + normalize, worker-callable with an injected
 * fetch. Returns one of:
 *   { status: "unchanged" }                              — HTTP 304 (ETag hit)
 *   { status: "updated", etag, snapshot, bytes }         — fresh payload accepted
 * Rejects on transport failure, HTTP error, oversized payload, malformed JSON,
 * or a payload that is not shaped like the models.dev catalog.
 *
 * @param {{ url, etag, timeoutMs, maxPayloadBytes, entries, minModalityShare, limitTolerance }} opts
 * @param {Function} [fetchImpl]
 */
export async function fetchAndNormalizeCatalog(opts, fetchImpl = globalThis.fetch) {
  const {
    url, etag = null, timeoutMs = 60_000, maxPayloadBytes = 25 * 1024 * 1024,
    entries = [], minModalityShare = 0.5, limitTolerance = 0.1,
  } = opts;

  if (typeof url !== "string" || !url.startsWith("https://")) {
    throw new Error("catalog url must be https");
  }

  const headers = { accept: "application/json" };
  if (etag) headers["if-none-match"] = etag;
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 304) return { status: "unchanged" };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxPayloadBytes) {
    throw new Error(`catalog payload too large (${declaredLength} bytes)`);
  }

  const text = await response.text();
  if (text.length > maxPayloadBytes) {
    throw new Error(`catalog payload too large (${text.length} bytes)`);
  }

  let rawCatalog;
  try {
    rawCatalog = JSON.parse(text);
  } catch {
    throw new Error("catalog payload is not valid JSON");
  }
  if (!rawCatalog || typeof rawCatalog !== "object" || Array.isArray(rawCatalog)
    || !Object.keys(rawCatalog).length) {
    throw new Error("catalog payload has unexpected shape");
  }

  const { models, providers } = buildCatalogDelta(rawCatalog, entries, { minModalityShare, limitTolerance });
  const nextEtag = response.headers.get("etag") || null;

  return {
    status: "updated",
    etag: nextEtag,
    bytes: Buffer.byteLength(text),
    providerCount: Object.keys(rawCatalog).length,
    snapshot: {
      schemaVersion: 1,
      source: "models.dev",
      // syncedAt: a new payload was downloaded and installed.
      // validatedAt: the (same) payload was validated against upstream — set
      // here and re-advanced on every 304 by the scheduler.
      syncedAt: Date.now(),
      validatedAt: Date.now(),
      etag: nextEtag,
      models,
      providers,
    },
  };
}

export { PROVIDER_ID_TO_CATALOG };

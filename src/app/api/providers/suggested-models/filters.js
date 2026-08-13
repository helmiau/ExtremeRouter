// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

// Normalize a context field value to a number: gateways may return strings
// ("262144" or "200K"). Non-numeric / non-positive values are dropped so the
// UI never renders "NaNk ctx".
function coerceContext(v) {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function openaiStyleMap(models) {
  // The route pre-extracts json.data/models, but accept a raw envelope too so
  // direct calls (tests) behave like the other config-driven mappers.
  const list = Array.isArray(models?.data)
    ? models.data
    : Array.isArray(models?.models)
      ? models.models
      : Array.isArray(models)
        ? models
        : [];
  return list
    .map((m) => {
      const id = m?.id || m?.model || m?.name;
      if (!id || typeof id !== "string") return null;
      // Skip embedding-only entries when the catalog tags them
      const kind = m?.object || m?.type || m?.capabilities?.type;
      if (kind === "embedding" || /embed/i.test(id)) return null;
      return {
        id,
        name: m?.name || m?.display_name || m?.displayName || id,
        // context_window first: several OpenAI-compatible gateways (bynara,
        // forge, …) report the window under that name even on "openai"-typed
        // catalogs; context_length/max_model_len are the other conventions.
        contextLength: coerceContext(
          m?.context_window ?? m?.context_length ?? m?.contextLength ?? m?.max_model_len
        ),
      };
    })
    .filter(Boolean);
}

// Config-driven mapper for OpenAI-compatible gateways whose /v1/models returns
// per-model metadata under gateway-specific field names. Field names are
// declared as DATA (field lists), so a new gateway (or a renamed field) is a
// one-line config change — no mapping code to touch. Unknown fields degrade
// gracefully: contextLength stays undefined and bools coerce to false, which
// is never worse than the generic OpenAI shape.
//   contextFields — first present value becomes contextLength
//   boolFields    — coerced !!value and copied (vision, reasoning, …)
//   rawFields     — copied verbatim when present (weight, …)
function mapModelsWithFields(raw, { contextFields = [], boolFields = [], rawFields = [] } = {}) {
  const models = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []);
  return models
    .map((m) => {
      const id = m?.id || m?.model || m?.name;
      if (!id || typeof id !== "string") return null;
      const out = {
        id,
        name: m?.name || m?.display_name || m?.displayName || id,
      };
      for (const f of contextFields) {
        const v = coerceContext(m?.[f]);
        if (v) {
          out.contextLength = v;
          break;
        }
      }
      for (const f of boolFields) out[f] = !!m?.[f];
      for (const f of rawFields) if (m?.[f] !== undefined) out[f] = m[f];
      return out;
    })
    .filter(Boolean);
}

// Metadata field names shared by the gateway-type parsers below: most report
// context as context_window (bynara) or a context_length variant (forge,
// tokenrouter, hcnsec), with explicit vision/reasoning flags.
const GATEWAY_META_FIELDS = {
  contextFields: ["context_window", "context_length", "contextLength", "max_model_len"],
  boolFields: ["vision", "reasoning"],
};

export const FILTERS = {
  // Standard OpenAI /v1/models shape — used by hcnsec, forge, tokenrouter,
  // featherless, venice, vercel-ai-gateway, etc.
  openai: openaiStyleMap,

  // AgentRouter — /api/pricing returns { data: [{ model_name, ... }] }
  agentrouter: (data) => {
    const models = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    return models
      .map((m) => ({
        id: m.model_name || m.id || m.name,
        name: m.model_name || m.id || m.name,
      }))
      .filter((m) => m.id);
  },

  // InxoraStudio Labs — /api/ai/models returns { models: [...], plan: "..." }
  // with per-model accessibility + chat flags. Keep only accessible chat models.
  inxora: (data) => {
    const models = Array.isArray(data?.models) ? data.models : (Array.isArray(data) ? data : []);
    return models
      .filter((m) => m?.accessible !== false && m?.chat !== false)
      .map((m) => ({
        id: m.id || m.name,
        name: m.displayName || m.name || m.id,
      }))
      .filter((m) => m.id);
  },

  // 1min.ai — /models returns model objects with `modelId` as the wire id.
  // UNIFY_CHAT_WITH_AI returns a bare array; CODE_GENERATOR wraps in { models, total }.
  "1min": (data) => {
    const models = Array.isArray(data?.models) ? data.models : (Array.isArray(data) ? data : []);
    return models.map((m) => ({
      id: m.modelId || m.model || m.id || m.name,
      name: m.name || m.modelId || m.model || m.id,
      contextLength: m.creditMetadata?.CONTEXT || undefined,
    })).filter((m) => m.id);
  },

  "openrouter-free": (models) =>
    models
      .filter(
        (m) =>
          m.pricing?.prompt === "0" &&
          m.pricing?.completion === "0" &&
          m.context_length >= 200000
      )
      .map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length }))
      .sort((a, b) => b.contextLength - a.contextLength),

  "opencode-free": (models) =>
    models
      .filter((m) => m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id))
      .map((m) => ({ id: m.id, name: m.id })),

  // models.dev returns a large catalog; keep only mimo models
  "mimo-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => m.id?.startsWith("mimo") || m.name?.toLowerCase().includes("mimo"))
      .map((m) => ({ id: m.id, name: m.name || m.id })),

  // Bynara (router.bynara.id) — /v1/models returns
  //   { object: "list", data: [{ id, object, owned_by, context_window, weight,
  //                              vision, reasoning }] }
  bynara: (data) => mapModelsWithFields(data, {
    contextFields: ["context_window", "context_length"],
    boolFields: ["vision", "reasoning"],
    rawFields: ["weight"],
  }),

  // Forge Workspace — OpenAI-compatible gateway; /v1/models reports metadata
  // (context_window / context_length + vision/reasoning) under gateway field
  // names, absorbed by the shared config-driven mapper.
  forge: (data) => mapModelsWithFields(data, GATEWAY_META_FIELDS),

  // TokenRouter — OpenAI-compatible gateway; /v1/models is key-gated, catalog
  // auto-filters by the key's tier. Field names may vary per gateway — the
  // config-driven mapper covers the common context_window/context_length +
  // vision/reasoning conventions.
  tokenrouter: (data) => mapModelsWithFields(data, GATEWAY_META_FIELDS),

  // HCNsec — OpenAI-compatible gateway; /v1/models is key-gated (fetched via
  // the authenticated suggested-models proxy). Same config-driven mapping.
  hcnsec: (data) => mapModelsWithFields(data, GATEWAY_META_FIELDS),
};

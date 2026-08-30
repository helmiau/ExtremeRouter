// Read side of the Dynamic Model Capability Catalog (models.dev background sync).
//
// SERVER-ONLY module: imports node:fs. capabilities.js is bundled into the
// browser (useModelCaps), so it cannot import this file — the server installs
// the reader into it via setCatalogSource() at startup, and tests may install
// fakes the same way.
//
// Hot-path contract (Invariant 5): the snapshot is held in memory and swapped
// by REFERENCE after each sync / at startup. Lookups are plain object reads —
// no fs.statSync, no readFile, no JSON.parse per request. (This deliberately
// improves on the 9Router reference, which re-stat()'d the file per lookup.)

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

export const CATALOG_FILE = path.join(DATA_DIR, "model-catalog.json");
export const CATALOG_SCHEMA_VERSION = 1;

// Upper sanity bound for a token limit — anything larger is a malformed record,
// not a real window (§19: reject pathological values before they enter memory).
export const MAX_TOKEN_LIMIT = 100_000_000;

const EMPTY_SNAPSHOT = Object.freeze({ models: Object.freeze({}), providers: Object.freeze({}), meta: null });

let snapshot = EMPTY_SNAPSHOT;

/**
 * Validate a parsed snapshot object. Returns a normalized immutable snapshot,
 * or null when the payload is malformed (caller keeps the last-known-good).
 *
 * Accepted shape (written by src/lib/modelCatalog/worker.js):
 *   { schemaVersion: 1, source, syncedAt, etag,
 *     models:    { [baseModelId]: { vision?, pdf?, audioInput?, videoInput?: true } },
 *     providers: { [providerId]: { [modelId]: { contextWindow?, maxOutput? } } } }
 */
export function validateCatalogSnapshot(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.schemaVersion !== CATALOG_SCHEMA_VERSION) return null;
  if (!parsed.models || typeof parsed.models !== "object" || Array.isArray(parsed.models)) return null;
  if (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) return null;

  const models = {};
  for (const [id, modalities] of Object.entries(parsed.models)) {
    if (typeof id !== "string" || !id || !modalities || typeof modalities !== "object") continue;
    const clean = {};
    for (const key of ["vision", "pdf", "audioInput", "videoInput"]) {
      if (modalities[key] === true) clean[key] = true;
    }
    if (Object.keys(clean).length) models[id] = Object.freeze(clean);
  }

  const providers = {};
  for (const [providerId, entries] of Object.entries(parsed.providers)) {
    if (typeof providerId !== "string" || !providerId || !entries || typeof entries !== "object") continue;
    const byModel = {};
    for (const [modelId, limits] of Object.entries(entries)) {
      if (typeof modelId !== "string" || !modelId || !limits || typeof limits !== "object") continue;
      const clean = {};
      for (const key of ["contextWindow", "maxOutput"]) {
        const v = limits[key];
        if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_TOKEN_LIMIT) clean[key] = v;
      }
      if (Object.keys(clean).length) byModel[modelId] = Object.freeze(clean);
    }
    if (Object.keys(byModel).length) providers[providerId] = Object.freeze(byModel);
  }

  return Object.freeze({
    models: Object.freeze(models),
    providers: Object.freeze(providers),
    meta: Object.freeze({
      syncedAt: typeof parsed.syncedAt === "number" ? parsed.syncedAt : null,
      etag: typeof parsed.etag === "string" ? parsed.etag : null,
      modelCount: Object.keys(models).length,
      providerCount: Object.keys(providers).length,
    }),
  });
}

/**
 * Atomically swap the in-memory snapshot (Invariant: readers never observe
 * partial state — the whole object is replaced in one assignment).
 */
export function setCatalogSnapshot(next) {
  snapshot = next && next.models ? next : EMPTY_SNAPSHOT;
}

export function getCatalogSnapshot() {
  return snapshot;
}

/**
 * Load the snapshot written by the background syncer. Called at startup and
 * right after a successful sync. Returns true when a snapshot was loaded.
 * A missing/corrupt file leaves the current snapshot untouched (last-known-good).
 */
export function loadCatalogSnapshotFromDisk() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
  } catch {
    return false; // no snapshot yet, or corrupt — keep whatever is in memory
  }
  const validated = validateCatalogSnapshot(parsed);
  if (!validated) return false;
  setCatalogSnapshot(validated);
  return true;
}

// ── Lookup helpers (pure in-memory reads; the resolver's injected source) ────

// "zai-org/GLM-4.6V:free" → "glm-4.6v" — mirrors the resolver's vendor-prefix
// stripping, plus case normalization and OpenRouter-style :variant suffixes.
export function catalogBaseId(modelId) {
  if (!modelId || typeof modelId !== "string") return "";
  const withoutVendor = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  return withoutVendor.toLowerCase().split(":")[0];
}

/** Model-level modality evidence (modalities belong to the model, not a gateway). */
export function getCatalogModalities(modelId) {
  if (!modelId) return null;
  const models = snapshot.models;
  return models[modelId] || models[catalogBaseId(modelId)] || null;
}

/**
 * Gateway-level limits (each provider truncates differently — keyed by
 * provider + model, never by model name alone).
 */
export function getCatalogLimits(providerId, modelId) {
  if (!providerId || !modelId) return null;
  const byProvider = snapshot.providers[providerId];
  if (!byProvider) return null;
  return byProvider[modelId] || byProvider[catalogBaseId(modelId)] || null;
}

/** Install the reader into capabilities.js (server-only; tests install fakes). */
export async function installCatalogSource() {
  const { setCatalogSource } = await import("./capabilities.js");
  setCatalogSource({
    getModalities: getCatalogModalities,
    getLimits: getCatalogLimits,
  });
}

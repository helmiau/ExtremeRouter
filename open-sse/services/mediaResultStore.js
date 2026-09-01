// Provider-agnostic media-result registry + retrieval (delivery abstraction).
//
// Goal: generated media that requires provider-authenticated download must never
// be exposed directly to clients as the raw provider URL. A provider artifact is
// registered here and the client only ever receives an ExtremeRouter-owned URL
// (/api/v1/media/results/<opaque-id>). This layer is reusable by Bynara, Runway,
// and future image/audio providers — it contains NO provider-specific branches.
//
// STORAGE MODEL — process-global singleton:
//   Each App Router route is compiled by webpack as its OWN bundle. A top-level
//   `const store = new Map()` would therefore exist ONCE PER BUNDLE, so a UUID
//   registered by the video-generation POST route would be invisible to the
//   media-results GET route (they live in different bundles) — the cross-route
//   404 bug. To keep ONE store per process, the Map is held on a well-known
//   globalThis key (via Symbol.for, so every duplicated module instance reads
//   the same property). All route bundles share the same underlying Map.
//
//   v1 storage: in-memory Map, process-local. Generated artifacts have short
//   lifetimes, so in-memory is acceptable. State is LOST on restart and is not
//   shared across multiple Node processes (documented). No permanent media
//   database or object storage is introduced.
//
// Access model: playback is capability-based — the opaque id (a random UUID) IS
// the access token, because a browser <video> tag cannot send an Authorization
// header. The originating principal / connection id is recorded for auditing; it
// is NOT required (or used) to gate playback, which would break inline <video>.
//
// Provider credentials are resolved server-side at retrieval time via an injected
// `getCredentials(provider, ...)` function (the route passes the real provider
// connection lookup). This keeps the generic layer decoupled from src auth code,
// and the client never receives provider secrets.

import { randomUUID } from "node:crypto";
import { safeFetchMediaResult } from "../utils/mediaResultDownload.js";

// Internal lifetime for a registered result (expiring-provider URLs are bounded
// by this too — we never keep a provider URL forever). 30 minutes is plenty for an
// inline <video> preview and avoids unbounded retention.
export const DEFAULT_MEDIA_RESULT_TTL_MS = 30 * 60 * 1000;

// Symbol.for → the SAME symbol from every duplicated module instance, so all of
// them address one global property even though each bundle re-evaluates the file.
const MEDIA_RESULT_STORE_KEY = Symbol.for("extremerouter.mediaResultStore.map");

// process-global singleton. The first module instance to run creates the Map and
// publishes it; every later (duplicated) instance finds it already published and
// reuses it. HMR reloads re-evaluate the module but reuse the SAME map — they can
// never spawn a second store.
function getProcessStore() {
  const g = globalThis;
  if (!g[MEDIA_RESULT_STORE_KEY] || !(g[MEDIA_RESULT_STORE_KEY] instanceof Map)) {
    g[MEDIA_RESULT_STORE_KEY] = new Map();
  }
  return g[MEDIA_RESULT_STORE_KEY];
}

const store = getProcessStore();

export function mediaResultPath(id) {
  return `/api/v1/media/results/${id}`;
}

/**
 * Register a provider artifact as an ExtremeRouter media resource.
 * @param {object} p
 * @param {string} p.provider - provider id
 * @param {string} p.mediaType - "video" | "image" | "audio" (carry-through, future-proof)
 * @param {{kind: string, url: string}} p.source - provider artifact reference (remote-url)
 * @param {string} [p.connectionId] - originating provider connection (for the exact credential)
 * @param {string} [p.contentType] - expected MIME (optional; verified at retrieval)
 * @param {number} [p.ttlMs] - override internal TTL
 * @returns {{id: string, expiresAt: number}}
 */
export function registerMediaResult({ provider, mediaType = "video", source, connectionId, contentType, ttlMs = DEFAULT_MEDIA_RESULT_TTL_MS }) {
  const id = randomUUID(); // opaque — never the provider task id
  const expiresAt = Date.now() + ttlMs;
  store.set(id, { id, provider, mediaType, source, connectionId, contentType, expiresAt, createdAt: Date.now() });
  return { id, expiresAt };
}

export function getMediaResult(id) {
  return store.get(id) || null;
}

export function deleteMediaResult(id) {
  return store.delete(id);
}

export function clearMediaResults() {
  store.clear();
}

export function sizeMediaResults() {
  return store.size;
}

/**
 * Resolve a registered provider artifact and fetch it server-side, defensively.
 * @param {string} id - opaque result id
 * @param {object} [options]
 * @param {Function} [options.getCredentials] - `getProviderCredentials(provider, exclude, model, opts)` (from src auth)
 * @param {number} [options.nowMs] - injectable clock for deterministic expiry tests
 * @returns {Promise<{ok:true, buffer: Buffer, mimeType: string} | {ok:false, status: number, message: string}>}
 */
export async function resolveMediaResult(id, options = {}) {
  const { nowMs = Date.now() } = options;
  const rec = store.get(id);
  if (!rec) return { ok: false, status: 404, message: "Media result not found" };
  if (typeof rec.expiresAt === "number" && nowMs > rec.expiresAt) {
    store.delete(id);
    return { ok: false, status: 410, message: "Media result expired" };
  }
  if (typeof rec.source?.url !== "string" || !rec.source.url) {
    return { ok: false, status: 502, message: "Media result has no source artifact" };
  }

  // Resolve the provider credential server-side for authenticated artifacts.
  let credentials = null;
  const getCredentials = options.getCredentials;
  if (getCredentials) {
    try {
      credentials = await getCredentials(rec.provider, null, null, { preferredConnectionId: rec.connectionId });
    } catch {
      credentials = null;
    }
  }

  const headers = {};
  const key = credentials?.apiKey || credentials?.accessToken;
  if (credentials && key) headers.Authorization = `Bearer ${key}`;

  const media = await safeFetchMediaResult(rec.source.url, { headers });
  if (!media) {
    return { ok: false, status: 502, message: "Failed to retrieve media artifact" };
  }
  return { ok: true, buffer: media.buffer, mimeType: media.mimeType };
}
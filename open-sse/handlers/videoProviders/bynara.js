// Bynara — text-to-video via async submit + poll.
//
// Verified contract (router.bynara.id/docs):
//   Submit  : POST https://api-images.bynara.id/v1/videos  → 202 { id, status:"pending", created }
//   Auth    : Authorization: Bearer <sk-nry-…> (same key as Bynara LLM)
//   Body    : { model, mode:"t2v", prompt, negative_prompt?, resolution?, ratio?, duration?, seed?, watermark? }
//             Text-to-video is an explicit `mode:"t2v"` — no image input is ever sent.
//   Poll    : GET https://api-images.bynara.id/v1/videos/{id} (~5s)
//             statuses: pending/processing → continue; succeeded → output; failed/error/cancelled → failure
//   Result  : on `succeeded`, a RELATIVE url `/v1/videos/{id}/download` (expiring) → resolve against the media host.
//
// Live verification was NOT possible (no Bynara credential in this environment);
// the contract above is docs-verified. Job-level failure payload shape is not
// fully documented, so failure extraction is defensive (see normalizeFailure) and
// an unknown/terminal state is never treated as success.
import { sleep, nowSec, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "../imageProviders/_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const BASE_URL = PROVIDER_MEDIA["bynara"]?.videoConfig?.baseUrl;
const MEDIA_ORIGIN = BASE_URL ? new URL(BASE_URL).origin : "https://api-images.bynara.id";

// Verified Bynara T2V constraints.
const MAX_PROMPT_LENGTH = 3500;
const DURATION = { min: 3, max: 15, default: 5 };
const RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"]);
const RESOLUTIONS = new Set(["720p", "1080p"]);
const MAX_SEED = 2147483647;

function fail(message) {
  const err = new Error(message);
  err.isValidationError = true;
  return err;
}

function assertString(value, label, { required = false, max = MAX_PROMPT_LENGTH } = {}) {
  if (value === undefined || value === null) {
    if (required) throw fail(`Missing required field: ${label}`);
    return null;
  }
  if (typeof value !== "string") throw fail(`${label} must be a string`);
  if (required && !value.trim()) throw fail(`${label} must not be empty`);
  if (value.length > max) throw fail(`${label} exceeds ${max} characters`);
  return value;
}

function assertDuration(body) {
  if (body.duration === undefined || body.duration === null) return DURATION.default;
  const d = body.duration;
  if (!Number.isInteger(d)) throw fail(`duration must be an integer seconds (${DURATION.min}-${DURATION.max})`);
  if (d < DURATION.min || d > DURATION.max) throw fail(`duration out of range (${DURATION.min}-${DURATION.max})`);
  return d;
}

function assertResolution(body) {
  if (body.resolution === undefined || body.resolution === null || body.resolution === "") return undefined;
  if (typeof body.resolution !== "string" || !RESOLUTIONS.has(body.resolution)) {
    throw fail(`unsupported resolution '${body.resolution}' (720p or 1080p)`);
  }
  return body.resolution;
}

function assertRatio(body) {
  if (body.ratio === undefined || body.ratio === null || body.ratio === "") return undefined;
  if (typeof body.ratio !== "string" || !RATIOS.has(body.ratio)) {
    throw fail(`unsupported ratio '${body.ratio}'`);
  }
  return body.ratio;
}

function assertSeed(body) {
  if (body.seed === undefined || body.seed === null) return undefined;
  if (!Number.isInteger(body.seed) || body.seed < 0 || body.seed > MAX_SEED) {
    throw fail(`seed must be an integer 0..${MAX_SEED}`);
  }
  return body.seed;
}

function assertWatermark(body) {
  if (body.watermark === undefined || body.watermark === null) return undefined;
  if (typeof body.watermark !== "boolean") throw fail("watermark must be a boolean");
  return body.watermark;
}

// Defensive extraction of a provider failure reason. Bynara's job-level failure
// payload is not fully documented, so we try several shapes and never let an
// unknown field win over a clear "failed" status.
function normalizeFailure(s) {
  const msg =
    s?.error?.message ||
    s?.failure?.message ||
    s?.error ||
    s?.message ||
    s?.failureCode ||
    s?.code ||
    "Bynara video generation failed";
  // Preserve the request id for diagnostics when present (never credentials).
  const reqId = typeof s?.request_id === "string" ? ` (request_id: ${s.request_id})` : "";
  return `${msg}${reqId}`;
}

export default {
  async: true,
  buildUrl: () => BASE_URL,
  buildHeaders: (creds) => {
    const key = creds?.apiKey || creds?.accessToken;
    return { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  },
  buildBody: (model, body) => {
    // Validation happens before any provider contact (the core turns a thrown
    // buildBody error into a 400 invalid request — the provider is never called).
    const prompt = assertString(body.prompt, "prompt", { required: true });
    const negativePrompt = assertString(body.negative_prompt, "negative_prompt");

    const payload = {
      model,
      mode: "t2v",
      prompt,
      duration: assertDuration(body),
    };
    if (negativePrompt) payload.negative_prompt = negativePrompt;
    const resolution = assertResolution(body);
    if (resolution !== undefined) payload.resolution = resolution;
    const ratio = assertRatio(body);
    if (ratio !== undefined) payload.ratio = ratio;
    const seed = assertSeed(body);
    if (seed !== undefined) payload.seed = seed;
    const watermark = assertWatermark(body);
    if (watermark !== undefined) payload.watermark = watermark;
    // T2V: no promptImage / image / image_url(s) are ever sent.
    return payload;
  },
  // Submit performed by the core (buildUrl+buildBody→POST). Read the task id,
  // then poll GET /v1/videos/{id} until success/failure or timeout.
  async parseResponse(response, { headers }) {
    const { id } = await response.json();
    if (!id) throw new Error("Bynara: no task id returned");
    const taskUrl = `${BASE_URL}/${id}`;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const r = await fetch(taskUrl, { headers });
      if (!r.ok) {
        if (r.status === 404) throw new Error(`Bynara: task ${id} was cancelled or no longer exists`);
        throw new Error(`Bynara status ${r.status}`);
      }
      const s = await r.json();
      const status = s?.status;
      if (status === "succeeded") {
        if (typeof s.url !== "string" || !s.url) {
          throw new Error("Bynara: task succeeded with no output url");
        }
        return s;
      }
      if (["failed", "error", "cancelled", "canceled"].includes(status)) {
        throw new Error(normalizeFailure(s));
      }
      // pending / queued / processing / running / unknown → keep polling (bounded
      // by timeout). Unknown statuses are never treated as success.
    }
    throw new Error("Bynara polling timeout");
  },
  normalize: (responseBody) => {
    const url = responseBody?.url;
    const resolved = typeof url === "string" && url ? new URL(url, MEDIA_ORIGIN).toString() : "";
    return {
      created: Number(responseBody?.created) ? responseBody.created : nowSec(),
      data: typeof url === "string" && url ? [{ url: resolved }] : [],
    };
  },
};
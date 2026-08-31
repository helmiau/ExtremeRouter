// Runway ML — text-to-video via async submit + /tasks/{id} polling.
//
// Contract verified against the current official Runway Dev OpenAPI
// (docs.dev.runwayml.com/openapi.json):
//   Endpoint : POST /v1/text_to_video     (a dedicated Text-to-Video endpoint)
//   Model    : gen4.5                     (branch in the text_to_video oneOf)
//   Required : model, promptText, ratio, duration
//   ratio    : "1280:720" | "720:1280"
//   duration : integer 2..10
//   promptImage : NOT accepted for text-only generation — it is never sent.
//   Submit resp : { id, estimatedCost }   → poll GET /v1/tasks/{id}
//   Task statuses : SUCCEEDED → { output: [urls], cost } ; FAILED/CANCELLED →
//   { failure, failureCode }; otherwise queued/processing → keep polling. 404 →
//   task deleted/cancelled.
//
// Live upstream verification was NOT possible (no Runway credential is present
// in this environment). The endpoint, model, and field contract above come from
// the official OpenAPI spec only.
import { sleep, nowSec, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "../imageProviders/_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const BASE_URL = PROVIDER_MEDIA["runwayml"]?.videoConfig?.baseUrl;

// Gen-4.5 accepts exactly these two text-to-video ratios.
const GEN45_RATIOS = new Set(["1280:720", "720:1280"]);
const GEN45_DURATION = { min: 2, max: 10 };
const DEFAULT_RATIO = "1280:720";
const DEFAULT_DURATION = 5;

// Map the gateway's aspect-ratio/size hints to a Gen-4.5 pixel ratio. Explicit
// supported ratios pass through; recognized aspect hints map to a pixel ratio;
// any other ratio/size string is rejected rather than silently sent upstream.
function resolveRatio(body) {
  if (typeof body.ratio === "string" && body.ratio.trim()) {
    const r = body.ratio.trim();
    if (GEN45_RATIOS.has(r)) return r;
    // Normalize the gateway's common aspect hints to a Gen-4.5 pixel ratio.
    if (r === "16:9") return "1280:720";
    if (r === "9:16") return "720:1280";
    throw new Error(`unsupported ratio '${r}' (Gen-4.5 supports 1280:720 or 720:1280)`);
  }
  const size = typeof body.size === "string" ? body.size.trim() : "";
  if (!size || size === "auto") return DEFAULT_RATIO;
  if (/^9:16$/.test(size) || size === "1024x1792" || size === "1024x1536") return "720:1280";
  if (/^16:9$/.test(size) || size === "1792x1024" || size === "1536x1024") return "1280:720";
  throw new Error(`unsupported ratio from size '${size}' (Gen-4.5 supports 1280:720 or 720:1280)`);
}

function resolveDuration(body) {
  if (body.duration === undefined || body.duration === null) return DEFAULT_DURATION;
  const d = body.duration;
  if (!Number.isInteger(d)) throw new Error(`unsupported duration '${d}' (must be an integer seconds)`);
  if (d < GEN45_DURATION.min || d > GEN45_DURATION.max) {
    throw new Error(`unsupported duration '${d}' (Gen-4.5 supports ${GEN45_DURATION.min}-${GEN45_DURATION.max}s)`);
  }
  return d;
}

export default {
  async: true,
  // Text-to-video: always /v1/text_to_video, never image_to_video.
  buildUrl: () => `${BASE_URL}/text_to_video`,
  buildHeaders: (creds) => {
    const key = creds?.apiKey || creds?.accessToken;
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "X-Runway-Version": "2024-11-06",
    };
  },
  buildBody: (model, body) => {
    const ratio = resolveRatio(body);
    const duration = resolveDuration(body);
    const payload = {
      model,
      promptText: body.prompt,
      ratio,
      duration,
    };
    // gen4.5 seed is an optional integer — pass it through when provided.
    if (Number.isInteger(body.seed)) payload.seed = body.seed;
    // Text-only generation: promptImage is intentionally never included.
    return payload;
  },
  // Submit already performed by the core (buildUrl+buildBody→POST). Here we
  // read the task id and poll until SUCCEEDED/FAILED/CANCELLED or timeout.
  async parseResponse(response, { headers }) {
    const { id } = await response.json();
    if (!id) throw new Error("Runway: no task id returned");
    const taskUrl = `${BASE_URL}/tasks/${id}`;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const r = await fetch(taskUrl, { headers });
      if (!r.ok) {
        if (r.status === 404) throw new Error("Runway: task was cancelled or no longer exists");
        throw new Error(`Runway status ${r.status}`);
      }
      const s = await r.json();
      if (s.status === "SUCCEEDED") {
        if (!Array.isArray(s.output) || s.output.length === 0) throw new Error("Runway: task succeeded with no output");
        return s;
      }
      if (s.status === "FAILED" || s.status === "CANCELLED") {
        throw new Error(s.failure || s.failureCode || "Runway video generation failed");
      }
      // else queued/processing/running → keep polling
    }
    throw new Error("Runway polling timeout");
  },
  normalize: (responseBody) => {
    const output = responseBody?.output;
    let urls = [];
    if (Array.isArray(output)) urls = output;
    else if (typeof output === "string") urls = [output];
    else if (output && typeof output === "object" && typeof output.url === "string") urls = [output.url];
    return { created: nowSec(), data: urls.map((url) => ({ url })) };
  },
};
// xAI — Grok Imagine Video 1.5 text-to-video via async submit + poll.
//
// Contract verified against https://docs.x.ai/openapi.json and the official
// video-generation guide:
//   Submit: POST /v1/videos/generations → { request_id }
//   Poll:   GET /v1/videos/{request_id}
//   States: pending → done | failed | expired
//   Result: done.video.url (temporary xAI-hosted URL)
//
// This adapter intentionally supports text-to-video only. Image references,
// video editing, video extension, and reference-to-video stay out of scope.
import { sleep, nowSec, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "../imageProviders/_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const MODEL = "grok-imagine-video-1.5";
const BASE_URL = PROVIDER_MEDIA.xai?.videoConfig?.baseUrl || "https://api.x.ai/v1/videos";
const RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
const RESOLUTIONS = new Set(["480p", "720p", "1080p"]);
const DURATION = { min: 1, max: 15, default: 8 };

function validationError(message) {
  const error = new Error(message);
  error.isValidationError = true;
  return error;
}

function resolveDuration(body) {
  const value = body.duration ?? body.seconds;
  if (value === undefined || value === null || value === "") return DURATION.default;
  const duration = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value)
    : value;
  if (!Number.isInteger(duration) || duration < DURATION.min || duration > DURATION.max) {
    throw validationError(`duration must be an integer ${DURATION.min}-${DURATION.max}`);
  }
  return duration;
}

function resolveRatio(body) {
  const value = body.aspect_ratio;
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !RATIOS.has(value)) {
    throw validationError(`unsupported aspect_ratio '${value}'`);
  }
  return value;
}

function resolveResolution(body) {
  if (body.resolution === undefined || body.resolution === null || body.resolution === "") {
    return undefined;
  }
  if (typeof body.resolution !== "string" || !RESOLUTIONS.has(body.resolution)) {
    throw validationError(`unsupported resolution '${body.resolution}' (480p, 720p, or 1080p)`);
  }
  return body.resolution;
}

function failureMessage(result) {
  return result?.error?.message || result?.error?.code || "xAI video generation failed";
}

export default {
  async: true,
  buildUrl: () => `${BASE_URL}/generations`,
  buildHeaders: (credentials) => {
    const key = credentials?.apiKey || credentials?.accessToken;
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    };
  },
  buildBody: (model, body) => {
    if (model !== MODEL) {
      throw validationError(`xAI video adapter only supports ${MODEL}`);
    }
    if (body.image || body.input_reference || body.reference_images || body.reference_audios) {
      throw validationError("xAI text-to-video does not accept image or reference inputs");
    }
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      throw validationError("Missing required field: prompt");
    }

    const payload = {
      model: MODEL,
      prompt: body.prompt,
      duration: resolveDuration(body),
    };
    const aspectRatio = resolveRatio(body);
    if (aspectRatio !== undefined) payload.aspect_ratio = aspectRatio;
    const resolution = resolveResolution(body);
    if (resolution !== undefined) payload.resolution = resolution;
    return payload;
  },
  async parseResponse(response, { headers }) {
    const submitted = await response.json();
    const requestId = submitted?.request_id;
    if (typeof requestId !== "string" || !requestId) {
      throw new Error("xAI: no request_id returned");
    }

    const pollUrl = `${BASE_URL}/${encodeURIComponent(requestId)}`;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const pollResponse = await fetch(pollUrl, { headers });
      if (pollResponse.status === 404) {
        throw new Error("xAI: video request was not found or expired");
      }
      if (!pollResponse.ok) {
        throw new Error(`xAI video status ${pollResponse.status}`);
      }
      if (pollResponse.status === 202) continue;

      const result = await pollResponse.json();
      if (result?.status === "done") {
        if (typeof result.video?.url !== "string" || !result.video.url) {
          throw new Error("xAI: video completed with no output url");
        }
        return result;
      }
      if (result?.status === "failed" || result?.status === "expired") {
        throw new Error(`xAI: ${result.status}: ${failureMessage(result)}`);
      }
      // pending and unknown states remain bounded by POLL_TIMEOUT_MS.
    }
    throw new Error("xAI polling timeout");
  },
  normalize: (responseBody) => ({
    created: nowSec(),
    data: typeof responseBody?.video?.url === "string" && responseBody.video.url
      ? [{ url: responseBody.video.url }]
      : [],
  }),
};

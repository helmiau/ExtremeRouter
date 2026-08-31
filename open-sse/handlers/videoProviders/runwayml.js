// Runway ML — text-to-video via async submit + /tasks/{id} polling.
//
// Mirrors the proven async pattern in imageProviders/runwayml.js (submit →
// task id → poll → output[]) but for the TEXT-to-video path only. It is a
// distinct adapter from the image one — which serves Text→Image / Image→Video —
// so a video request is never accidentally routed into image_to_video.
//
// Endpoint: the base URL + `text_to_video` segment mirror the in-repo
// `image_to_video` convention (same api.dev.runwayml.com/v1 host and
// X-Runway-Version header). Live credentials were not available in this
// environment; the exact segment name is pending live verification.
import { sleep, nowSec, sizeToAspectRatio, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "../imageProviders/_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const BASE_URL = PROVIDER_MEDIA["runwayml"]?.videoConfig?.baseUrl;

export default {
  async: true,
  // Pure T2V: always the text_to_video endpoint, never image_to_video.
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
    const duration = Number.isInteger(body.duration) && body.duration > 0 ? body.duration : 5;
    return {
      promptText: body.prompt,
      model,
      ratio: sizeToAspectRatio(body.size),
      duration,
      ...(body.image ? { promptImage: body.image } : {}), // optional I2V input, never required
    };
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
      if (!r.ok) throw new Error(`Runway status ${r.status}`);
      const s = await r.json();
      if (s.status === "SUCCEEDED") return s;
      if (s.status === "FAILED" || s.status === "CANCELLED") {
        throw new Error(s.failure || "Runway video generation failed");
      }
      // else QUEUED/PROCESSING → keep polling
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
// Helyx AI — OpenAI-compatible image/video generation adapter.
//   Image: POST /v1/images/generations  (flux-1) → OpenAI image shape
//   Video: POST /v1/videos/generations  (kling-video) → OpenAI-style {data:[{url}]}
import { PROVIDER_MEDIA } from "../../providers/index.js";

const media = () => PROVIDER_MEDIA["helyxai"] || {};

export default {
  buildUrl: (model) => {
    const cfg = model === "kling-video" ? media().videoConfig : media().imageConfig;
    return cfg?.baseUrl;
  },
  buildHeaders: (creds) => {
    const headers = { "Content-Type": "application/json" };
    const key = creds?.apiKey || creds?.accessToken;
    if (key) headers["Authorization"] = `Bearer ${key}`;
    return headers;
  },
  buildBody: (model, body) => {
    const { prompt, n = 1, size = "1024x1024", duration } = body;
    if (model === "kling-video") {
      return { model, prompt, ...(duration ? { duration } : {}) };
    }
    const full = { model, prompt, n, size };
    if (body.response_format) full.response_format = body.response_format;
    return full;
  },
  normalize: (responseBody) => responseBody,
};

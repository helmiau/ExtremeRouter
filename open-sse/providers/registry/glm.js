import { CLAUDE_API_HEADERS } from "../shared.js";

export default {
  id: "glm",
  priority: 140,
  alias: "glm",
  display: {
    name: "GLM Coding",
    icon: "code",
    color: "#2563EB",
    textIcon: "GL",
    website: "https://open.bigmodel.cn",
    notice: {
      apiKeyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.z.ai/api/anthropic/v1/messages",
    format: "claude",
    urlSuffix: "?beta=true",
    headers: { ...CLAUDE_API_HEADERS },
    auth: {
      combined: true,
      header: "x-api-key",
      scheme: "raw",
    },
    usage: {
      url: "https://api.z.ai/api/monitor/usage/quota/limit",
    },
  },
  // Multi-endpoint: pick the transport matching client sourceFormat to skip translation.
  transports: [
    {
      format: "openai",
      // GLM Coding Plan dedicated endpoint. Requires a Coding Plan API key
      // (created at open.bigmodel.cn/usercenter/apikeys).
      baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://api.z.ai/api/anthropic/v1/messages",
      urlSuffix: "?beta=true",
      headers: { ...CLAUDE_API_HEADERS },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  models: [
    // GLM-5.3 (2026-08-14): one upstream id; effort is the reasoning_effort
    // param (low|high|max, default max) on the coding chat/completions endpoint.
    // The -high/-low entries are aliases resolved by GlmExecutor
    // (parseGlmEffortTier → base "glm-5.3" + effort selector); upstreamModelId
    // keeps the base id out of the wire model. Default context not yet published
    // by Z.ai; 1M mirrored from GLM-5.2 (same base model). https://z.ai/blog/glm-5.3
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "glm-5.3-high", name: "GLM 5.3 High", upstreamModelId: "glm-5.3" },
    { id: "glm-5.3-low", name: "GLM 5.3 Low", upstreamModelId: "glm-5.3" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5", name: "GLM 5" },
    { id: "glm-4.7", name: "GLM 4.7" },
    { id: "glm-4.6v", name: "GLM 4.6V (Vision)" },
  ],
  features: {
    usage: true,
    usageApikey: true,
  },
};

// ZCode — Zhipu's coding agent (zcode.z.ai desktop app + CLI), backed by Z.ai.
//
// OAuth: device-style browser flow against zcode.z.ai /oauth/cli/{init,poll} —
// the exact flow the ZCode app performs (provider "zai"). After the user
// approves in the browser, the poll returns the Z.ai OAuth access_token which
// is then exchanged for the account's "zcode-api-key" coding-plan key
// ("<id>.<secret>") via api.z.ai /api/auth/z/login → getCustomerInfo →
// api_keys (+ /copy for the secret part). That key is the credential ZCode
// itself writes into its config and uses for model calls.
//
// Chat: Anthropic-compatible messages endpoint, multi-endpoint fallback in the
// order the ZCode runtime itself resolves hosts (all three are Anthropic SDK
// base URLs in the app — /v1/messages appended):
//   1. zcode-plan (start-plan runtime origin)
//   2. BigModel coding plan (open.bigmodel.cn)
//   3. Z.AI coding plan (api.z.ai)
// The zcode-plan leg may additionally require the app's client-signing
// protocol (X-Client-Sig / X-Client-Pow handshake); ZcodeExecutor therefore
// falls through auth errors (401/403/404) to the next leg (Kiro-style).
import { CLAUDE_API_HEADERS } from "../shared.js";

// Full Anthropic-messages URLs (SDK base + /v1/messages), in fallback order.
const ZCODE_BASE_URLS = [
  "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
  "https://open.bigmodel.cn/api/anthropic/v1/messages",
  "https://api.z.ai/api/anthropic/v1/messages",
];

export default {
  id: "zcode",
  priority: 150,
  alias: "zcode",
  aliases: ["zc"],
  uiAlias: "zc",
  display: {
    name: "ZCode",
    icon: "terminal",
    color: "#4F46E5",
    textIcon: "ZC",
    website: "https://zcode.z.ai",
    notice: {
      signupUrl: "https://zcode.z.ai",
      text: "ZCode is Zhipu's coding agent powered by Z.ai. OAuth logs in with your Z.ai account and derives the coding-plan API key automatically; you can also paste an existing GLM Coding key (id.secret).",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    // Anthropic messages format across all legs (x-api-key raw, like glm's
    // claude transport). The ZCodePlanExecutor walks baseUrls on auth errors.
    baseUrl: ZCODE_BASE_URLS[0],
    baseUrls: ZCODE_BASE_URLS,
    format: "claude",
    thinkingFormat: "openai",
    headers: { ...CLAUDE_API_HEADERS },
    auth: { combined: true, header: "x-api-key", scheme: "raw" },
  },
  models: [
    // Mirror of the ZCode model catalog (Z.AI family). GLM-5.3 effort tiers are
    // aliases resolved by GlmExecutor (base id + reasoning_effort selector).
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "glm-5.3-high", name: "GLM 5.3 High", upstreamModelId: "glm-5.3" },
    { id: "glm-5.3-low", name: "GLM 5.3 Low", upstreamModelId: "glm-5.3" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5.1-highspeed", name: "GLM 5.1 Highspeed" },
    { id: "glm-5", name: "GLM 5" },
    { id: "glm-5-turbo", name: "GLM 5 Turbo" },
    { id: "glm-5v-turbo", name: "GLM 5V Turbo (Vision)" },
    { id: "glm-4.7", name: "GLM 4.7" },
    { id: "glm-4.7-flashx", name: "GLM 4.7 FlashX" },
    { id: "glm-4.7-flash", name: "GLM 4.7 Flash" },
    { id: "glm-4.6", name: "GLM 4.6" },
  ],
  oauth: {
    // Device-style flow endpoints (from the ZCode app bundle). pollToken is a
    // locally generated 32-byte hex string sent as Bearer on both init+poll.
    baseUrl: "https://zcode.z.ai/api/v1",
    provider: "zai",
    // api.z.ai side of the OAuth-token → coding-plan API key exchange chain.
    apiKeyHost: "https://api.z.ai",
    apiKeyName: "zcode-api-key",
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};

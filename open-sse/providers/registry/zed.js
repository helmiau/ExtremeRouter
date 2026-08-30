// Zed Hosted AI — cloud.zed.dev OAuth provider.
//
// Zed Editor users import their cloud credentials (user_id + access_token),
// which the gateway exchanges for a short-lived LLM bearer token (1h lifetime)
// via POST /client/llm_tokens. The executor (open-sse/executors/zed.js, ported
// from 9router) auto-refreshes when it expires.
//
// Chat flow: POST /completions with a CompletionBody envelope:
//   { thread_id, prompt_id, provider, model, provider_request }
// where `provider` is one of "Anthropic" | "Google" | "OpenAi" | "XAi" and
// `provider_request` is the NATIVE request body for that upstream — resolved
// from the LIVE model catalog (GET /models) via shared/zedAuth.js, falling
// back to name inference (claude*/gemini*/grok*/else → openai Responses).
// Zed streams back JSONL lines of { Status: ... } / { Event: ... } wrapping
// the upstream provider's delta events, translated to OpenAI SSE per-upstream
// inside the executor.
//
// LAYOUT NOTE: the static catalog is intentionally empty — passthroughModels
// forwards any client-sent model id, and model metadata comes from the live
// catalog (modelsUrl) instead of a frozen list.

export default {
  id: "zed",
  priority: 56,
  alias: "zed",
  uiAlias: "zed",
  display: {
    name: "Zed Hosted AI",
    icon: "code",
    color: "#1348DC",
    textIcon: "Z",
    website: "https://zed.dev",
    notice: {
      signupUrl: "https://zed.dev",
      text: "Zed Hosted AI provides access to Claude, GPT, and Gemini models via the Zed Editor cloud. Import your Zed credentials (user ID + access token from the Zed keychain) to mint an LLM token automatically.",
    },
  },
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  transport: {
    baseUrl: "https://cloud.zed.dev",
    chatPath: "/completions",
    format: "openai",
    forceStream: true,
    headers: {
      "Content-Type": "application/json",
      "x-zed-client-supports-status-messages": "true",
      "x-zed-client-supports-stream-ended-request-completion-status": "true",
      "x-zed-client-supports-x-ai": "true",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    usage: {
      url: "https://cloud.zed.dev/client/users/me",
    },
    // Live catalog discovery — Zed's hosted model list changes frequently and
    // is fetched per-connection rather than hardcoded.
    modelsUrl: "https://cloud.zed.dev/models",
  },
  // Empty static catalog + passthrough: Zed fronts a rotating set of upstream
  // models (Claude/GPT/Gemini/Grok). Resolved live via modelsUrl; any
  // client-sent model id is forwarded as-is rather than validated.
  models: [],
  passthroughModels: true,
  oauth: {
    apiEndpoint: "https://cloud.zed.dev",
    completionsPath: "/completions",
    modelsPath: "/models",
    llmTokensPath: "/client/llm_tokens",
    usersMePath: "/client/users/me",
    // LLM tokens are short-lived (1h). Refresh 5 minutes before expiry.
    refreshLeadMs: 300000,
  },
  // Plan + edit-prediction quota surfaced on /dashboard/quota via
  // services/usage/zed.js (GET /client/users/me).
  features: {
    usage: true,
    usageApikey: false,
  },
};
export default {
  id: "cline",
  priority: 80,
  alias: "cl",
  uiAlias: "cl",
  display: {
    name: "Cline",
    icon: "smart_toy",
    color: "#5B9BD5",
    textIcon: "CL",
    website: "https://cline.bot",
    notice: {
      signupUrl: "https://cline.bot",
      apiKeyUrl: "https://app.cline.bot/settings#api-keys",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://api.cline.bot/api/v1/chat/completions",
    // Cline's API only implements streaming (streamText). A non-streaming
    // request returns "generateText is not implemented" / an empty body
    // ("empty response content"). Force upstream streaming and let chatCore
    // convert the SSE back to JSON for stream:false clients (model-test
    // button, non-streaming API callers). Mirror of OmniRoute's forceStream.
    forceStream: true,
    headers: {
      "HTTP-Referer": "https://cline.bot",
      "X-Title": "Cline",
      // REQUIRED to reach models gated to "Cline product surfaces"
      // (deepseek-v4-flash/pro return 403 without it). See clineAuth.js.
      "x-client-type": "cline-cli",
    },
    tokenUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      hooks: [
        "clineHeaders",
      ],
    },
    // Quota Tracker — plan usage limits (5h / weekly / monthly) returned as
    // percentUsed. No absolute token/request counts are exposed.
    usage: {
      url: "https://api.cline.bot/api/v1/users/me/plan/usage-limits",
    },
  },
  // Model IDs use the `{vendor}/{model}` format (OpenRouter convention), where the
  // suffix is each vendor's NATIVE id verbatim. Source: https://docs.cline.bot/api/models
  //
  // Anthropic ids therefore use DASHES for the version (`claude-sonnet-4-6`), matching
  // Anthropic's own API — not dots. Sending `claude-sonnet-4.6` is rejected upstream.
  // OpenAI/Google/MiniMax keep their native dots (`gpt-4o`, `gemini-2.5-pro`,
  // `minimax-m2.5`). Do not "normalize" one family to the other.
  // Seed models — single-sourced from https://api.cline.bot/api/v1/ai/cline/recommended-models
  // (verified live 2026-08-07). Suffix is each vendor's native id.
  //
  // Bare-id entries with upstreamModelId allow writing short `cl/<model>` forms
  // (e.g. cl/glm-5.2 or cl/deepseek-v4-flash) while sending vendor-prefixed
  // ids upstream as required by Cline's API.
  models: [
    // --- Recommended / Flagship ---
    { id: "anthropic/claude-opus-5", name: "Claude Opus 5", upstreamModelId: "anthropic/claude-opus-5" },
    { id: "claude-opus-5", name: "Claude Opus 5", upstreamModelId: "anthropic/claude-opus-5" },
    { id: "zai/glm-5.2", name: "GLM 5.2", upstreamModelId: "zai/glm-5.2" },
    { id: "glm-5.2", name: "GLM 5.2", upstreamModelId: "zai/glm-5.2" },
    { id: "x-ai/grok-4.5", name: "Grok 4.5", upstreamModelId: "x-ai/grok-4.5" },
    { id: "grok-4.5", name: "Grok 4.5", upstreamModelId: "x-ai/grok-4.5" },
    { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", upstreamModelId: "openai/gpt-5.6-sol" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", upstreamModelId: "openai/gpt-5.6-sol" },
    { id: "moonshotai/kimi-k3", name: "Kimi K3", upstreamModelId: "moonshotai/kimi-k3" },
    { id: "kimi-k3", name: "Kimi K3", upstreamModelId: "moonshotai/kimi-k3" },

    // --- Free Tier (API key & OAuth) ---
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", upstreamModelId: "deepseek/deepseek-v4-flash" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", upstreamModelId: "deepseek/deepseek-v4-flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", upstreamModelId: "deepseek/deepseek-v4-pro" },
    { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1 (Free)", upstreamModelId: "poolside/laguna-s-2.1:free" },
    { id: "laguna-s-2.1:free", name: "Laguna S 2.1 (Free)", upstreamModelId: "poolside/laguna-s-2.1:free" },
    { id: "stepfun/step-3.7-flash", name: "Step 3.7 Flash", upstreamModelId: "stepfun/step-3.7-flash" },
    { id: "step-3.7-flash", name: "Step 3.7 Flash", upstreamModelId: "stepfun/step-3.7-flash" },

    // --- Legacy / Secondary ---
    { id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7", upstreamModelId: "anthropic/claude-opus-4-7" },
    { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", upstreamModelId: "anthropic/claude-opus-4-6" },
    { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", upstreamModelId: "anthropic/claude-sonnet-4-6" },
    { id: "anthropic/claude-3-7-sonnet", name: "Claude 3.7 Sonnet", upstreamModelId: "anthropic/claude-3-7-sonnet" },
    { id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", upstreamModelId: "openai/gpt-5.3-codex" },
    { id: "openai/gpt-5.4", name: "GPT-5.4", upstreamModelId: "openai/gpt-5.4" },
    { id: "openai/gpt-4o", name: "GPT-4o", upstreamModelId: "openai/gpt-4o" },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", upstreamModelId: "google/gemini-3.1-pro-preview" },
    { id: "google/gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview", upstreamModelId: "google/gemini-3.1-flash-lite-preview" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", upstreamModelId: "google/gemini-2.5-pro" },
    { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", upstreamModelId: "deepseek/deepseek-chat" },
    { id: "minimax/minimax-m2.5", name: "MiniMax M2.5 (Free)", upstreamModelId: "minimax/minimax-m2.5" },
    { id: "kwaipilot/kat-coder-pro", name: "KAT Coder Pro", upstreamModelId: "kwaipilot/kat-coder-pro" },
    { id: "stealth/ox-alpha", name: "0x-Alpha", upstreamModelId: "stealth/ox-alpha" },
  
  ],
  // Cline rotates its free/promo lineup and exposes no public model-catalog
  // endpoint (`/api/v1/models` is auth-gated), so the list above can never be
  // exhaustive. Passthrough lets users reach newly added ids without a registry
  // edit + release.
  passthroughModels: true,
  oauth: {
    appBaseUrl: "https://app.cline.bot",
    apiBaseUrl: "https://api.cline.bot",
    authorizeUrl: "https://api.cline.bot/api/v1/auth/authorize",
    tokenUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
  },
  thinkingConfig: {
    options: ["auto", "on", "off"],
    defaultMode: "auto",
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};

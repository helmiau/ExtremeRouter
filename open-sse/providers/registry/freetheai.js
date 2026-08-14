// FreeTheAi — OpenAI-compatible gateway with a Discord-signup free tier
// (api.freetheai.xyz). Standard chat/completions; DefaultExecutor only.
// Port of the OmniRoute free-gateway batch.
export default {
  id: "freetheai",
  priority: 60,
  alias: "fta",
  uiAlias: "fta",
  display: {
    name: "FreeTheAi",
    icon: "volunteer_activism",
    color: "#F43F5E",
    textIcon: "FT",
    website: "https://freetheai.xyz",
    notice: {
      apiKeyUrl: "https://freetheai.xyz",
      text: "Free OpenAI-compatible gateway — sign up via Discord for an API key. GPT-4o mini, Llama 3.3 70B, DeepSeek Chat.",
    },
  },
  category: "apikey",
  authType: "apikey",
  authHint: "Sign up via the FreeTheAi Discord and copy your API key.",
  hasFree: true,
  transport: {
    baseUrl: "https://api.freetheai.xyz/v1/chat/completions",
    format: "openai",
  },
  models: [
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "llama-3.3-70b-instruct", name: "Llama 3.3 70B" },
    { id: "deepseek-chat", name: "DeepSeek Chat" },
  ],
  passthroughModels: true,
};

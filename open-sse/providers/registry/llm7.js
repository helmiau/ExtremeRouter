// LLM7 — no-signup OpenAI-compatible gateway (api.llm7.io). Free tier:
// ~2 req/s, 20 RPM, 100 req/hr. Port of the OmniRoute free-gateway batch.
export default {
  id: "llm7",
  priority: 60,
  alias: "llm7",
  display: {
    name: "LLM7",
    icon: "bolt",
    color: "#F59E0B",
    textIcon: "L7",
    website: "https://llm7.io",
    notice: {
      apiKeyUrl: "https://llm7.io",
      text: "No-signup free tier (2 req/s, 20 RPM, 100 req/hr). GPT-4o mini, GPT-4.1 nano, DeepSeek R1 and Qwen2.5 Coder via api.llm7.io.",
    },
  },
  category: "apikey",
  authType: "apikey",
  authHint: "Create an API key at llm7.io. Free tier is rate-limited (~2 req/s).",
  hasFree: true,
  transport: {
    baseUrl: "https://api.llm7.io/v1/chat/completions",
    format: "openai",
  },
  models: [
    { id: "gpt-4o-mini-2024-07-18", name: "GPT-4o mini (LLM7)" },
    { id: "gpt-4.1-nano-2025-04-14", name: "GPT-4.1 nano (LLM7)" },
    { id: "deepseek-r1-0528", name: "DeepSeek R1 (LLM7)" },
    { id: "qwen2.5-coder-32b-instruct", name: "Qwen2.5 Coder 32B (LLM7)" },
  ],
};

// Fireworks AI — serverless inference for 200+ open-weight models via an
// OpenAI-compatible API (DeepSeek, GLM, Kimi, Qwen, Llama, ...).
//
// Endpoint: POST https://api.fireworks.ai/inference/v1/chat/completions
// Models:   GET  https://api.fireworks.ai/inference/v1/models
// Auth: Bearer <fireworks-api-key>  (keys at https://fireworks.ai/account/api-keys)
//
// OpenAI-compatible — DefaultExecutor handles chat/streaming/tools/vision.
// Reasoning models (glm-5p2) speak OpenAI `reasoning_effort`; vision models
// (kimi-k2p6) use standard image_url content parts. thinkingFormat:"openai"
// keeps every reasoning model on the OpenAI effort wire format.
export default {
  id: "fireworks",
  priority: 50,
  alias: "fireworks",
  display: {
    name: "Fireworks AI",
    icon: "local_fire_department",
    color: "#7B2EF2",
    textIcon: "FW",
    website: "https://fireworks.ai",
    notice: {
      apiKeyUrl: "https://fireworks.ai/account/api-keys",
      text: "Fireworks hosts 200+ open-weight models (DeepSeek, GLM, Kimi, Qwen, Llama) on fast serverless GPUs. Get a key at fireworks.ai/account/api-keys — new accounts include free credits. OpenAI-compatible — works with any standard client.",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.fireworks.ai/inference/v1/chat/completions",
    validateUrl: "https://api.fireworks.ai/inference/v1/models",
    thinkingFormat: "openai",
  },
  models: [
    { id: "accounts/fireworks/models/deepseek-v3p1", name: "DeepSeek V3.1" },
    { id: "accounts/fireworks/models/glm-5p2", name: "GLM-5.2" },
    { id: "accounts/fireworks/models/kimi-k2p6", name: "Kimi K2.6" },
    { id: "accounts/fireworks/models/kimi-k2-instruct-0905", name: "Kimi K2 Instruct 0905" },
    { id: "accounts/fireworks/models/llama-v3p3-70b-instruct", name: "Llama 3.3 70B" },
    { id: "accounts/fireworks/models/qwen3-235b-a22b", name: "Qwen3 235B" },
    { id: "nomic-ai/nomic-embed-text-v1.5", name: "Nomic Embed Text v1.5", kind: "embedding" },
  ],
  serviceKinds: ["llm", "embedding"],
  embeddingConfig: { baseUrl: "https://api.fireworks.ai/inference/v1/embeddings" },
};

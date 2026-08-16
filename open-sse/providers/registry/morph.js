// Morph — inference platform built for coding agents; OpenAI-compatible.
// Free tier: 250K credits/month.
export default {
  id: "morph",
  priority: 50,
  alias: "morph",
  display: {
    name: "Morph",
    icon: "auto_fix_high",
    color: "#2563EB",
    textIcon: "MP",
    website: "https://www.morphllm.com",
    notice: {
      apiKeyUrl: "https://www.morphllm.com/keys",
      text: "OpenAI-compatible. Hosts open-weight models (Qwen, MiniMax, DeepSeek, GLM) optimized for coding agents. Free tier: 250K credits/month.",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.morphllm.com/v1/chat/completions",
    validateUrl: "https://api.morphllm.com/v1/models",
  },
  models: [
    { id: "morph-v3-large", name: "Morph V3 Large" },
    { id: "morph-v3-fast", name: "Morph V3 Fast" },
    { id: "morph-glm52-744b", name: "GLM-5.2 744B" },
    { id: "morph-qwen35-397b", name: "Qwen 3.5 397B" },
    { id: "morph-qwen36-27b", name: "Qwen 3.6 27B" },
    { id: "morph-minimax3-428b", name: "MiniMax M3" },
    { id: "morph-dsv4flash", name: "DeepSeek V4 Flash" },
  ],
  serviceKinds: ["llm"],
  hasFree: true,
  freeNote: "Free tier: 250K credits/month, $0",
};

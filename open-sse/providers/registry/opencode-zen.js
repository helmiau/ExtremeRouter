// OpenCode Zen — OpenAI-compatible inference host.
// Imported from OmniRoute catalog (2026-08). Base URL verified from models.dev / provider docs.
export default {
  id: "opencode-zen",
  priority: 50,
  alias: "opencode-zen",
  display: {
    name: "OpenCode Zen",
    icon: "opencode",
    color: "#6366f1",
    textIcon: "OP",
    website: "https://opencode.ai/zen",
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://opencode.ai/zen/v1/chat/completions",
    validateUrl: "https://opencode.ai/zen/v1/models",
  },
  models: [
    { id: "gemini-3-pro", name: "Gemini 3 Pro" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "glm-4.6", name: "GLM-4.6" },
    { id: "ling-3.0-flash-free", name: "Ling-3.0-flash Free" },
    { id: "laguna-s-2.1-free", name: "Laguna S 2.1 Free" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free" },
    { id: "x-preview-f-free", name: "x Preview F Free" },
  
  ],
};

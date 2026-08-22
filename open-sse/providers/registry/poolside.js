// Poolside — OpenAI-compatible inference host.
// Imported from OmniRoute catalog (2026-08). Base URL verified from models.dev / provider docs.
export default {
  id: "poolside",
  priority: 50,
  alias: "poolside",
  display: {
    name: "Poolside",
    icon: "memory",
    color: "#111827",
    textIcon: "PS",
    website: "https://poolside.ai",
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://inference.poolside.ai/v1/chat/completions",
    validateUrl: "https://inference.poolside.ai/v1/models",
  },
  models: [
    { id: "poolside/laguna-xs-2.1", name: "Laguna XS 2.1" },
    { id: "poolside/laguna-s-2.1", name: "Laguna S 2.1" },
  ],
  passthroughModels: true,
  thinkingConfig: {
    options: ["auto", "none", "low", "medium", "high", "xhigh"],
    defaultMode: "auto",
  },
  hasFree: true,
  freeNote: "Laguna S 2.1 and XS 2.1 are free during Preview; no public numeric quota is published.",
};

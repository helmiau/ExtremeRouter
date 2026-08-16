// NaraRouter — OpenAI-compatible gateway.
// Imported from OmniRoute catalog (2026-08). Base URL verified from models.dev / provider docs.
export default {
  id: "nara",
  priority: 50,
  alias: "nara",
  display: {
    name: "NaraRouter",
    icon: "hub",
    color: "#EC4899",
    textIcon: "NA",
    website: "https://bynara.id",
      notice: { text: "Get a free API key via NaraRouter's Telegram channel, then paste it here Bearer token.", },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://router.bynara.id/v1/chat/completions",
    validateUrl: "https://router.bynara.id/v1/models",
  },
  models: [
    { id: "tencent-hy3", name: "Tencent Hy3" },
    { id: "mistral-large", name: "Mistral Large" },
    { id: "mistral-medium-3-5", name: "Mistral Medium 3.5" },
  ],
  passthroughModels: true,
  hasFree: true,
  freeNote: "Free tier is a shared 5M tokens/day pool; some models are gated behind credit/plan.",
};

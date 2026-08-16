// SambaNova — OpenAI-compatible inference host.
// Imported from OmniRoute catalog (2026-08). Base URL verified from models.dev / provider docs.
export default {
  id: "sambanova",
  priority: 50,
  alias: "samba",
  display: {
    name: "SambaNova",
    icon: "memory",
    color: "#DC2626",
    textIcon: "SN",
    website: "https://sambanova.ai",
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://api.sambanova.ai/v1/chat/completions",
    validateUrl: "https://api.sambanova.ai/v1/models",
  },
  passthroughModels: true,
  hasFree: true,
  freeNote: "$5 free credits on signup (30-day validity), no credit card required",
};

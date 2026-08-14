// Felo — anonymous free chat/search agent (felo.ai). No API key or session
// cookie required. The FeloWebExecutor opens a search thread and reads the
// SSE-shaped answer stream. Reverse-engineered (may break if Felo changes its
// frontend contract). Port of OmniRoute felo-web.
export default {
  id: "felo-web",
  priority: 60,
  alias: "felo",
  uiAlias: "felo",
  display: {
    name: "Felo (Free)",
    icon: "travel_explore",
    color: "#0EA5E9",
    textIcon: "FE",
    website: "https://felo.ai",
    notice: {
      text: "Free anonymous access to Felo — a chat/search-agent aggregator. No API key or cookie required. Models: felo-chat, felo-search, felo-scholar, felo-social, felo-document.",
    },
  },
  category: "free",
  noAuth: true,
  hasFree: true,
  transport: {
    baseUrl: "https://felo.ai",
    format: "openai",
    noAuth: true,
  },
  models: [
    { id: "felo-chat", name: "Felo Chat", toolCalling: false },
    { id: "felo-search", name: "Felo Search", toolCalling: false },
    { id: "felo-scholar", name: "Felo Scholar", toolCalling: false },
    { id: "felo-social", name: "Felo Social", toolCalling: false },
    { id: "felo-document", name: "Felo Document", toolCalling: false },
  ],
};

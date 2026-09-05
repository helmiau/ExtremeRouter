export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
    noAuth: true,
  },
  models: [
    { id: "x-preview-f-free", name: "x Preview F Free" },
    { id: "laguna-s-2.1-free", name: "Laguna S 2.1 Free" },
    // Muse Spark is a Responses-API model: /zen/v1/chat/completions 500s for it
    // (verified live 2026-08-31); /zen/v1/responses works with the free lane.
    // Model-scoped targetFormat drives both chatCore's request translation and
    // the executor's endpoint selection. Context/output limits come from the
    // dynamic catalog (models.dev: opencode/muse-spark-1.2-contributor-free —
    // 1M context, 131072 output, reasoning) via direct provider-id match.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 (Contributor Free)", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 (Contributor Free)", targetFormat: "openai-responses" },
  ],
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};

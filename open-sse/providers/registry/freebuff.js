// Freebuff (Account / codebuff.com API) — free-tier authToken provider.
//
// Freebuff's CLI/API surface authenticates with a raw `authToken` (from the
// Freebuff CLI at ~/.config/manicode/credentials.json or https://freebuff.llm.pm)
// against https://codebuff.com — NOT an OAuth2 flow. The FreeBuffExecutor
// (open-sse/executors/freebuff.js) bridges the private session/run protocol to
// an OpenAI-compatible interface:
//   1. POST /api/v1/freebuff/session (x-freebuff-model header) → instanceId
//   2. POST /api/v1/agent-runs {action:"START", agentId:"base2-free"} → runId
//   3. POST /api/v1/chat/completions + codebuff_metadata {run_id, cost_mode:"free", ...}
//
// Distinct from freebuff-web (freebuff.com/chat via NextAuth session cookie) —
// this is the account-token surface. Model list is curated from the official
// catalog (2026-08-13); server-side admission is stricter than the client
// picker, so each entry stays only after a successful E2E test.
export default {
  id: "freebuff",
  priority: 66,
  alias: "fb",
  aliases: ["freebuff-api", "freebuff-token"],
  uiAlias: "fb",
  display: {
    name: "Freebuff (Account)",
    icon: "bolt",
    color: "#F97316",
    textIcon: "FB",
    website: "https://freebuff.com",
    notice: {
      signupUrl: "https://freebuff.llm.pm",
      apiKeyUrl: "https://freebuff.llm.pm",
      text: "Connect your Freebuff account with your authToken. Get it from https://freebuff.llm.pm (log in) or the Freebuff CLI at ~/.config/manicode/credentials.json (authToken field).",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://codebuff.com",
    format: "freebuff",
    authType: "token",
  },
  models: [
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (Freebuff)" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (Freebuff)" },
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna (Freebuff)" },
    { id: "minimax/minimax-m3", name: "MiniMax M3 (Freebuff)" },
  ],
  passthroughModels: true,
};

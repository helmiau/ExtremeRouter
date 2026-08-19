// Alibaba Token Plan (ap-southeast-1) — credit-subscription keys on
// token-plan.<region>.maas.aliyuncs.com.
//
// Fourth Alibaba key type. Coding Plan (alicode/alicode-intl) and Model Studio
// (alibaba/alibaba-cn) keys are mutually exclusive with Token Plan keys — each
// surface rejects the others' key formats.
//
// Distinct from `qwen-cloud` (DashScope international), which merged the former
// `qwen-cloud-token-plan` provider in v0.7.7. That merge collapsed the two hosts
// onto dashscope-intl, which rejects Token Plan keys — so token-plan users must
// route here instead. Singapore is the only serving region (eu-central-1
// answers IllegalEndpoint).
//
// OpenAI-compatible transport only: DashScope's Anthropic surface (/apps/anthropic)
// is not authorized for this plan, so only the /compatible-mode/v1 endpoints apply.
export default {
  id: "alitp-intl",
  priority: 165,
  alias: "atp",
  aliases: ["token-plan", "qwen-cloud-token-plan"],
  uiAlias: "atp",
  display: {
    name: "Alibaba Token Plan",
    icon: "cloud",
    color: "#FF6A00",
    textIcon: "ATP",
    website: "https://www.alibabacloud.com/campaign/ai-landing-page-token",
    notice: {
      apiKeyUrl: "https://modelstudio.console.alibabacloud.com/?apiKey=1",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl:
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    format: "openai",
    validateUrl:
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    quirks: { preserveCacheControl: true },
  },
  models: [
    { id: "qwen3.8-max-preview", name: "Qwen3.8 Max Preview", contextWindow: 1000000, maxOutput: 65536 },
    { id: "qwen3.7-max", name: "Qwen3.7 Max", contextWindow: 1000000, maxOutput: 65536 },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus", contextWindow: 1000000, maxOutput: 65536 },
    { id: "qwen3.6-flash", name: "Qwen3.6 Flash", contextWindow: 1000000, maxOutput: 32768 },
    { id: "glm-5.2", name: "GLM 5.2", contextWindow: 1000000, maxOutput: 16384 },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 163840, maxOutput: 32768 },
  ],
  passthroughModels: true,
  modelsFetcher: {
    url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models",
    type: "openai",
  },
};

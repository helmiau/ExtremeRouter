import { platform, arch } from "os";

// === OS/Arch helpers (Stainless fingerprint) ===
export function mapStainlessOs() {
  switch (platform()) {
    case "darwin": return "MacOS";
    case "win32": return "Windows";
    case "linux": return "Linux";
    case "freebsd": return "FreeBSD";
    default: return `Other::${platform()}`;
  }
}

export function mapStainlessArch() {
  switch (arch()) {
    case "x64": return "x64";
    case "arm64": return "arm64";
    case "ia32": return "x86";
    default: return `other::${arch()}`;
  }
}

// Anthropic API version (single source — reused across claude-format providers/executors)
export const ANTHROPIC_API_VERSION = "2023-06-01";

// Shared Claude-compatible API headers (reused across claude-format providers)
export const CLAUDE_API_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14"
};

// Spoofed Claude Code client version — SINGLE SOURCE for both identities:
// the request User-Agent (registry/claude.js + CLAUDE_CLI_SPOOF_HEADERS) and
// the billing-header cc_version (utils/claudeCloaking.js). Bump together, here only.
// 2.1.258: Anthropic gates newly released models (e.g. claude-fable-5-1) to
// CC >= 2.1.251; anything older gets HTTP 400 on every request.
export const CLAUDE_CLI_VERSION = "2.1.258";

// Full Claude CLI fingerprint — required by providers that gate on client identity (e.g. agentrouter)
// Updated to match Claude Code 2.1.258 + Anthropic SDK 0.115.0 (September 2026).
export const CLAUDE_CLI_SPOOF_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28,fine-grained-tool-streaming-2025-05-14",
  "Anthropic-Dangerous-Direct-Browser-Access": "true",
  "User-Agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`,
  "X-App": "cli",
  "X-Stainless-Helper-Method": "stream",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime-Version": process.version,
  "X-Stainless-Package-Version": "0.115.0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Arch": mapStainlessArch(),
  "X-Stainless-Os": mapStainlessOs(),
  "X-Stainless-Timeout": "600"
};

// Shared baseUrls
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1/messages";

// Anthropic beta flags sent to first-party Anthropic and to anthropic-compatible-*
// nodes that front Anthropic (rotating multi-account proxies, corporate gateways).
// Deliberately EXCLUDES the first-party identity flags (claude-code-20250219,
// oauth-2025-04-20) — those are Claude Code's own, stripped for non-Anthropic
// hosts by the executor. Heavy-agent flags are gated to opus/sonnet — cheaper
// models don't need them and gateways may choke on unknown betas.
const ANTHROPIC_BETA_BASE = [
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
];
const ANTHROPIC_BETA_HEAVY_AGENT = ["advanced-tool-use-2025-11-20", "effort-2025-11-24"];

export function selectAnthropicBeta(model = "") {
  const flags = [...ANTHROPIC_BETA_BASE];
  if (/^claude-(opus|sonnet)/.test(model)) flags.push(...ANTHROPIC_BETA_HEAVY_AGENT);
  return flags.join(",");
}

// Default base for dynamic compat providers (openai-compatible-* / anthropic-compatible-*) when user gives no baseUrl
export const OPENAI_COMPAT_BASE = "https://api.openai.com/v1";
export const ANTHROPIC_COMPAT_BASE = "https://api.anthropic.com/v1";

// Env-override helper (Scenario A): read an optional env var, falling back to the
// packaged default. Defaults are intentionally UNCHANGED so existing OAuth refresh
// tokens (bound to the packaged client identity) keep working after upgrade.
// Setting a var lets a self-hoster use their OWN OAuth app — but it changes the
// client identity, so ONLY that instance's own connections must be re-linked.
const fromEnv = (key, fallback) => (typeof process !== "undefined" && process.env?.[key]) || fallback;

// Antigravity OAuth client credentials (public CLI client — shared by registry + src/lib/oauth)
export const ANTIGRAVITY_OAUTH_CLIENT = {
  clientId: fromEnv("ANTIGRAVITY_OAUTH_CLIENT_ID", "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"),
  clientSecret: fromEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", "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")
};

// Gemini (Google) OAuth client credentials (public CLI client — shared by gemini, gemini-cli, src/lib/oauth)
export const GOOGLE_OAUTH_CLIENT = {
  clientId: fromEnv("GEMINI_OAUTH_CLIENT_ID", "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"),
  clientSecret: fromEnv("GEMINI_OAUTH_CLIENT_SECRET", "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")
};

// iFlow OAuth client credentials (public CLI client)
export const IFLOW_OAUTH_CLIENT = {
  clientId: fromEnv("IFLOW_OAUTH_CLIENT_ID", "10009311001"),
  clientSecret: fromEnv("IFLOW_OAUTH_CLIENT_SECRET", "4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW")
};

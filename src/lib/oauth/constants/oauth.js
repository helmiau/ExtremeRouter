/**
 * OAuth Configuration Constants — static data lives in registry, re-exported here for consumers.
 */
import { platform, arch } from "os";
import { ANTIGRAVITY_OAUTH_CLIENT, GOOGLE_OAUTH_CLIENT } from "open-sse/providers/shared.js";
import { PROVIDER_OAUTH, PROVIDERS as REGISTRY_PROVIDERS } from "open-sse/providers/index.js";

/**
 * Get the platform enum value based on the current OS.
 * Matches Antigravity binary's ClientMetadata.Platform enum.
 */
function getOAuthPlatformEnum() {
  const os = platform();
  const architecture = arch();
  if (os === "darwin") return architecture === "arm64" ? 2 : 1;
  if (os === "linux") return architecture === "arm64" ? 4 : 3;
  if (os === "win32") return 5;
  return 0;
}

// Claude OAuth Configuration (Authorization Code Flow with PKCE)
export const CLAUDE_CONFIG = { ...PROVIDER_OAUTH["claude"] };

// Codex (OpenAI) OAuth Configuration (Authorization Code Flow with PKCE)
export const CODEX_CONFIG = { ...PROVIDER_OAUTH["codex"] };

// Gemini (Google) OAuth Configuration (Standard OAuth2)
// clientId/clientSecret from GOOGLE_OAUTH_CLIENT (shared.js) — not stored in registry
export const GEMINI_CONFIG = { ...GOOGLE_OAUTH_CLIENT, ...PROVIDER_OAUTH["gemini-cli"] };

// Qwen OAuth Configuration (Device Code Flow with PKCE)
export const QWEN_CONFIG = { ...PROVIDER_OAUTH["qwen"] };

// Qoder OAuth Configuration (Device Token Flow with PKCE).
// Device tokens are long-lived (~30 days for access, ~360 for refresh).
// The upstream refresh endpoint at center.qoder.sh returns 403 for our
// flow — we accept that and surface it to the user as "re-login" instead
// of attempting to silently rotate.
export const QODER_CONFIG = { ...PROVIDER_OAUTH["qoder"] };

// iFlow OAuth Configuration (Authorization Code)
export const IFLOW_CONFIG = { ...PROVIDER_OAUTH["iflow"] };

// Antigravity OAuth Configuration (Standard OAuth2 with Google)
// clientId/clientSecret from ANTIGRAVITY_OAUTH_CLIENT (shared.js) — not stored in registry
// loadCodeAssistClientMetadata is dynamic (runtime platform detection)
export const ANTIGRAVITY_CONFIG = {
  ...ANTIGRAVITY_OAUTH_CLIENT,
  ...PROVIDER_OAUTH["antigravity"],
  loadCodeAssistClientMetadata: JSON.stringify({ ideType: 9, platform: getOAuthPlatformEnum(), pluginType: 2 }),
};

/**
 * Get client metadata using numeric enum values for API calls.
 * @returns {{ ideType: number, platform: number, pluginType: number }}
 */
export function getOAuthClientMetadata() {
  return { ideType: 9, platform: getOAuthPlatformEnum(), pluginType: 2 };
}

// OpenAI OAuth Configuration (Authorization Code Flow with PKCE)
export const OPENAI_CONFIG = { ...PROVIDER_OAUTH["openai"] };

// GitHub Copilot OAuth Configuration (Device Code Flow)
export const GITHUB_CONFIG = { ...PROVIDER_OAUTH["github"] };

// Kiro OAuth Configuration (multi-method: AWS Builder ID / IDC / Social / Import Token)
export const KIRO_CONFIG = { ...PROVIDER_OAUTH["kiro"] };

// AWS region allowlist pattern — prevents SSRF via region injection into upstream URLs (GHSA-6mwv-4mrm-5p3m)
export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

// Reject any region that is not a valid AWS region before interpolating it into a URL
export function assertValidAwsRegion(region) {
  if (typeof region !== "string" || !AWS_REGION_PATTERN.test(region)) {
    throw new Error("Invalid region");
  }
  return region;
}

// Cursor OAuth Configuration (Import Token from Cursor IDE)
// tokenStoragePaths: user-reference only, not stored in registry
export const CURSOR_CONFIG = {
  ...PROVIDER_OAUTH["cursor"],
  tokenStoragePaths: {
    linux: "~/.config/Cursor/User/globalStorage/state.vscdb",
    macos: "/Users/<user>/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    windows: "%APPDATA%\\Cursor\\User\\globalStorage\\state.vscdb",
  },
};

// Kimi Coding OAuth Configuration (Device Code Flow)
// clientId uses env override — dynamic, not stored in registry
export const KIMI_CODING_CONFIG = {
  ...PROVIDER_OAUTH["kimi-coding"],
  clientId: process.env.KIMI_CODING_OAUTH_CLIENT_ID || REGISTRY_PROVIDERS["kimi-coding"]?.clientId,
};

// Kimi Desktop OAuth Configuration (import token from the desktop app's token store)
// Token storage path is the bridged JSON store the desktop app writes on login.
// The stored access_token JWT doubles as the kimi-auth session against www.kimi.com.
export const KIMI_DESKTOP_CONFIG = {
  ...PROVIDER_OAUTH["kimi-desktop"],
  tokenStoragePaths: {
    linux: "~/.config/kimi-desktop/bridge-store/token-store.json (best-effort)",
    macos: "~/Library/Application Support/kimi-desktop/bridge-store/token-store.json",
    windows: "%APPDATA%\\kimi-desktop\\bridge-store\\token-store.json",
  },
};

// KiloCode OAuth Configuration (Custom Device Auth Flow)
export const KILOCODE_CONFIG = { ...PROVIDER_OAUTH["kilocode"] };

// Cline OAuth Configuration (Local Callback Flow via app.cline.bot)
export const CLINE_CONFIG = { ...PROVIDER_OAUTH["cline"] };

// ClinePass OAuth Configuration (shares Cline's OAuth endpoints)
export const CLINEPASS_CONFIG = { ...PROVIDER_OAUTH["clinepass"] };

// GitLab Duo OAuth Configuration (Authorization Code Flow with PKCE)
export const GITLAB_CONFIG = { ...PROVIDER_OAUTH["gitlab"] };

// CodeBuddy (Tencent) OAuth Configuration (Browser OAuth Polling Flow)
export const CODEBUDDY_CONFIG = { ...PROVIDER_OAUTH["codebuddy-cn"] };

// CodeBuddy intl (codebuddy.ai) + WorkBuddy (workbuddy.ai) — same /v2/plugin
// polling contract on their own hosts.
export const CODEBUDDY_CONFIG_INTL = { ...PROVIDER_OAUTH["codebuddy-intl"] };
export const CODEBUDDY_CONFIG_WORKBUDDY = { ...PROVIDER_OAUTH["workbuddy"] };

// Kimchi OAuth Configuration (Browser token callback flow)
export const KIMCHI_CONFIG = { ...PROVIDER_OAUTH["kimchi"] };

// Freebuff (Account) — authToken from the Freebuff CLI credentials store
// (~/.config/manicode/credentials.json → authToken) or https://freebuff.llm.pm.
// Not a browser OAuth flow: a raw bearer token validated against the
// codebuff.com session endpoint (see providers.js freebuff entry).
export const FREEBUFF_CONFIG = {
  baseUrl: "https://codebuff.com",
  tokenPageUrl: "https://freebuff.llm.pm",
  // Official FALLBACK/LIMITED id (2026-08-13 catalog) — the cheapest session
  // to open for validation and the safe default for step-down.
  defaultModel: "deepseek/deepseek-v4-flash",
  // Per-user premium pool ceiling (6 sessions/day, Pacific day) from the
  // official catalog — surfaced as guidance, enforcement is upstream.
  premiumModelIds: ["deepseek/deepseek-v4-pro", "openai/gpt-5.6-luna", "minimax/minimax-m3"],
};

// Zed Hosted AI — import user_id + access_token from Zed Editor, mint llm_token.
// Not a browser OAuth flow; credentials are imported from the Zed keychain.
export const ZED_CONFIG = {
  ...PROVIDER_OAUTH["zed"],
  tokenStoragePaths: {
    linux: "~/.local/share/zed/ (or libsecret keyring)",
    macos: "macOS Keychain (zed)",
    windows: "Windows Credential Manager",
  },
};

// OAuth timeout (5 minutes)
export const OAUTH_TIMEOUT = 300000;

// Provider list
export const PROVIDERS = {
  CLAUDE: "claude",
  CODEX: "codex",
  GEMINI: "gemini-cli",
  QWEN: "qwen",
  QODER: "qoder",
  IFLOW: "iflow",
  ANTIGRAVITY: "antigravity",
  OPENAI: "openai",
  GITHUB: "github",
  KIRO: "kiro",
  CURSOR: "cursor",
  KIMI_CODING: "kimi-coding",
  KIMI_DESKTOP: "kimi-desktop",
  KILOCODE: "kilocode",
  CLINE: "cline",
  CLINEPASS: "clinepass",
  GITLAB: "gitlab",
  CODEBUDDY: "codebuddy-cn",
  KIMCHI: "kimchi",
  ZED: "zed",
};

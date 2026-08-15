// Provider info badges — small caveat chips shown on the provider detail page
// (and the add-connection modal). Rendered by <ProviderInfoBadges />.
//
// Research basis: audited every webCookie registry + executor in this repo
// (open-sse/providers/registry/*.js, open-sse/executors/*-web.js) and grouped
// the recurring caveats:
//
//   anti-bot  — provider rejects non-browser TLS/JS fingerprints; requests are
//               usually blocked even with valid cookies (warning badge).
//   browser   — completing a chat requires a real browser session (CAPTCHA /
//               challenge token issued to a browser fingerprint).
//   guest     — anonymous/guest sessions are limited by the provider.
//   cookie    — the FULL cookie header (multi-cookie) must be pasted, not a
//               single named cookie value.
//
// Only cookie providers with a real, user-visible caveat are listed. `variant`
// must be one of the Badge component variants (default/primary/success/
// warning/error/info/cyan); `icon` is a Material Symbols name.

export const PROVIDER_INFO_BADGES = {
  // ── Anti-bot: usually blocked without a browser bridge ──────────────────
  "huggingchat": [
    {
      label: "Anti-bot blocked",
      variant: "warning",
      icon: "shield",
      title:
        "HuggingFace sits behind AWS WAF and rejects non-browser requests. A headless-browser bridge is not implemented yet, so this provider usually does not respond.",
    },
  ],
  "chatgpt-web": [
    {
      label: "Anti-bot sensitive",
      variant: "warning",
      icon: "shield",
      title:
        "chatgpt.com runs Sentinel anti-bot (proof-of-work + Turnstile + TLS fingerprint). Requests are usually blocked even with a valid session cookie — prefer the official OpenAI API provider.",
    },
  ],
  "claude-web": [
    {
      label: "Anti-bot sensitive",
      variant: "warning",
      icon: "shield",
      title:
        "claude.ai sits behind Cloudflare bot management and usually blocks server-side requests (TLS fingerprint mismatch, not bad credentials). Prefer the official Claude API provider.",
    },
  ],
  "gemini-web": [
    {
      label: "Anti-bot sensitive",
      variant: "warning",
      icon: "shield",
      title:
        "gemini.google.com rejects programmatic requests that lack a real browser fingerprint. Often fails with 403/empty body even with valid cookies.",
    },
  ],

  // ── Browser required (CAPTCHA / challenge token) ────────────────────────
  "zai-web": [
    {
      label: "Browser required (CAPTCHA)",
      variant: "info",
      icon: "desktop_windows",
      title:
        "chat.z.ai requires an Aliyun CAPTCHA proof bound to a real browser. This provider drives your installed Chrome/Edge — a plain HTTP request always fails (HTTP 500).",
    },
    {
      label: "Guest = GLM-4.7 only",
      variant: "warning",
      icon: "person",
      title:
        "Guest sessions (guest-…@guest.com) are limited by Z.ai to GLM-4.7 — the server rejects GLM-5.x for guests. Sign in at chat.z.ai and re-capture the token.",
    },
  ],
  "felo-web": [
    {
      label: "Needs Turnstile token",
      variant: "info",
      icon: "verified_user",
      title:
        "Felo requires a Cloudflare Turnstile session token (cf_token) for anonymous access. Run one search in a browser, then capture it from sessionStorage (or use the Capture button with a logged-in session).",
    },
  ],

  // ── Account/session limitations ─────────────────────────────────────────
  "copilot-web": [
    {
      label: "Anonymous = limited models",
      variant: "info",
      icon: "person",
      title:
        "Copilot works without login but only exposes a limited model set. Sign in for the full model list.",
    },
  ],
  "lmarena": [
    {
      label: "Guest = limited",
      variant: "info",
      icon: "person",
      title:
        "LMArena guests can run basic comparisons; logging in raises usage limits.",
    },
    {
      label: "Chunked session cookie",
      variant: "info",
      icon: "cookie",
      title:
        "LMArena splits the session across arena-auth-prod-v1.0, .1, … — paste the whole header; the executor recombines the chunks.",
    },
  ],
  "duckduckgo-web": [
    {
      label: "Free tier rate-limited",
      variant: "info",
      icon: "speed",
      title:
        "DuckDuckGo AI Chat is free and anonymous but rate-limits sessions — best for light use.",
    },
  ],
  "blackbox-web": [
    {
      label: "Premium models need plan",
      variant: "info",
      icon: "workspace_premium",
      title:
        "Premium Blackbox models require a paid subscription; free accounts only get the free model set.",
    },
  ],

  // ── Full cookie header required (multi-cookie auth) ─────────────────────
  "qwen-web": [
    {
      label: "Needs full cookie header",
      variant: "info",
      icon: "cookie",
      title:
        "Qwen's baxia WAF requires the FULL cookie jar (cna, ssxmod_itna, token, …) from a logged-in browser session — a single cookie is not enough.",
    },
  ],
  "qwencloud": [
    {
      label: "Needs full cookie header",
      variant: "info",
      icon: "cookie",
      title:
        "QwenCloud needs the full cookie string (must include login_qwencloud_ticket; bx-ua / bx-umidtoken optional).",
    },
  ],
  "doubao-web": [
    {
      label: "Needs full cookie header",
      variant: "info",
      icon: "cookie",
      title: "Doubao authenticates with the full browser cookie jar — paste the whole Cookie header.",
    },
  ],
  "t3-web": [
    {
      label: "Needs full cookie header",
      variant: "info",
      icon: "cookie",
      title: "T3 requires the full cookie string including convex-session-id.",
    },
  ],
  "v0-vercel-web": [
    {
      label: "Needs full cookie header",
      variant: "info",
      icon: "cookie",
      title: "v0 requires the full cookie string (must include user_session and v0-last-scope).",
    },
  ],
  "venice-web": [
    {
      label: "Needs full cookie header",
      variant: "info",
      icon: "cookie",
      title: "Venice authenticates with the full session cookie header from venice.ai.",
    },
  ],
  "zenmux-free": [
    {
      label: "Needs full cookie header",
      variant: "info",
      icon: "cookie",
      title: "ZenMux Free requires the full cookie string (must include ctoken).",
    },
  ],
  "tencent-aistudio-web": [
    {
      label: "Needs full cookie header",
      variant: "info",
      icon: "cookie",
      title: "Tencent AI Studio uses the full session Cookie header from aistudio.tencent.ai.",
    },
  ],
};

// Providers whose badge list we intentionally keep empty — listed for reference
// so the research classification is explicit and auditable.
export const PROVIDER_INFO_BADGE_DECISIONS = {
  "adapta-web": "none — Clerk JWT auto-refresh handled by the executor.",
  "agnes-web": "none — single bearer JWT, executor handles it.",
  "api-airforce": "none — session JWT → API-key exchange handled by the executor.",
  "deepseek-web": "none — proof-of-work challenge solved automatically by the executor.",
  "grok-web": "none — single sso cookie.",
  "kimi-web": "none — single kimi-auth JWT.",
  "muse-spark-web": "none — single ecto_1_sess cookie.",
  "perplexity-web": "none — single session-token cookie.",
  "poe-web": "none — single p-b cookie.",
  "puter": "none — single auth token.",
  "freebuff-web": "none — single NextAuth session cookie.",
  "1min": "none — bearer JWT from dashboard.",
  "inxorastudio-web": "none — bearer JWT (executor pending is tracked separately).",
  "veoaifree-web": "none — no auth required.",
  "pollinations": "none — free, no auth.",
};

<div align="center">

# ExtremeRouter — AI Gateway Control Plane

**A self-hosted AI gateway that routes traffic from your AI coding tools to 304+ providers with format translation, smart fallback, quota tracking, and 20–40% token savings.**

Connect Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw, and any OpenAI/Anthropic-compatible client to one unified endpoint.

**Language:** [English](README.md) · [Bahasa Indonesia](README.id.md) · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/@rsalmn/extremerouter.svg)](https://www.npmjs.com/package/@rsalmn/extremerouter)
[![Downloads](https://img.shields.io/npm/dm/@rsalmn/extremerouter.svg)](https://www.npmjs.com/package/@rsalmn/extremerouter)
[![Docker Pulls](https://img.shields.io/docker/pulls/rsalmn/extremerouter.svg?logo=docker&label=Docker%20pulls)](https://hub.docker.com/r/rsalmn/extremerouter)
[![GHCR](https://img.shields.io/badge/GHCR-rsalmn%2Fextremerouter-blue?logo=github)](https://github.com/rsalmn/extremerouter/pkgs/container/extremerouter)
[![License](https://img.shields.io/npm/l/@rsalmn/extremerouter.svg)](https://github.com/rsalmn/extremerouter/blob/main/LICENSE)

</div>

---

## Table of Contents

- [Highlight Features](#highlight-features)
- [Comparison: 9Router vs OmniRoute vs ExtremeRouter](#comparison)
- [How It Works](#how-it-works)
- [How It Looks](#how-it-looks)
- [Quick Start](#quick-start)
- [Supported CLI Tools](#supported-cli-tools)
- [Supported Providers](#supported-providers)
- [Key Features in Detail](#key-features-in-detail)
- [Frequently Asked Questions](#frequently-asked-questions)
- [API Reference](#api-reference)
- [Contributors](#contributors)
- [Support](#support)
- [Star Chart & Forks](#star-chart--forks)
- [Acknowledgments & References](#acknowledgments--references)
- [License](#license)

---

<a name="highlight-features"></a>

## Highlight Features

| Feature | What It Does | Why It Matters |
|---------|--------------|----------------|
| **304+ providers, one endpoint** | API-key, OAuth, free-tier, and 39 web-cookie providers behind a single `/v1` surface | No more juggling base URLs, keys, and dashboards |
| **Format translation** | OpenAI ↔ Claude ↔ Gemini ↔ Responses ↔ Antigravity ↔ Kiro ↔ Cursor | Any CLI tool talks to any provider |
| **6 combo strategies** | fallback, round-robin, fusion, swarm, cascade, smart-routing | Pick the routing brain that fits the task |
| **Hierarchical Swarm engine** | Gatekeeper → Manager → Workers → Audit → Synthesis with live SSE telemetry | Parallel multi-agent execution for complex tasks |
| **Smart Routing** | Task-aware routing: tool-calling tasks go to tool-capable models, research goes to cookie/free providers | Automatic model selection per task type |
| **Cascade strategy** | Cheap → capable escalation with self-reported confidence gating | Pay for power only when simple models fail |
| **RTK Token Saver** | Compresses `tool_result` content (git diff, grep, ls, tree...) before sending | Saves 20–40% input tokens on every request |
| **Ponytail & Caveman** | YAGNI-first and terse-response prompt injectors | Up to 65% fewer output tokens |
| **Smart 3-tier fallback** | Subscription → cheap → free, automatic | Never stop coding, zero downtime |
| **Real-time quota tracking** | Live token counts and reset countdowns per provider | Maximize every subscription |
| **Multi-account round-robin** | Multiple accounts per provider, auto-failover | Load balancing + redundancy |
| **Auto token refresh** | OAuth tokens refresh before expiry, 401/403 retry path | No manual re-login |
| **Per-key model ACL** | Each API key can carry an `allowedModels` allow-list (403 outside it) | Hand out scoped keys safely |
| **Health monitor + circuit breaker** | Per-provider sliding-window health, CLOSED/OPEN/HALF_OPEN state machine | Auto-skip dead providers, auto-recover |
| **Combo budget & admission control** | Per-combo cost ceilings, per-key concurrency caps | Stay inside spending limits |
| **A/B Lab** | Replay historical requests and compare strategies (fallback vs swarm vs smart-routing) | Pick the cheapest strategy that still answers |
| **Usage analytics** | Tokens, cost estimates, trends, request logs | Understand and optimize spend |
| **Deploy anywhere** | Localhost, VPS, Docker, Cloudflare Workers, tunnels (Cloudflare + Tailscale) | Same setup everywhere |

---

<a name="comparison"></a>

## Comparison: 9Router vs OmniRoute vs ExtremeRouter

All three projects share the same family tree. ExtremeRouter is a fully independent evolution — it keeps the proven 9Router core, borrows the best ideas from OmniRoute, and adds its own architecture, UI, and reliability layer.

| Feature | 9Router | OmniRoute | **ExtremeRouter** |
|---------|---------|-----------|-------------------|
| **Combo strategies** | 4 | 17 | **6** (fallback / round-robin / fusion / swarm / cascade / **smart-routing**) |
| **Smart Routing (task-aware)** | – | – | **Yes** — tool-calling vs research routing per task |
| **Hierarchical Swarm** | – | – | **Yes** — Gatekeeper → Manager → Workers → Audit → Synthesis + live telemetry |
| **Cascade (progressive escalation)** | – | – | **Yes** — cheap → capable with confidence gating |
| **Per-combo thinking overrides** | – | – | **Yes** — role-level (manager=max, worker=medium) |
| **AutoScale swarm workers** | – | – | **Yes** — dynamic worker count from subtask complexity |
| **Combo templates (model-first)** | – | – | **Yes** — resolve across connected providers |
| **Combo budget + admission control** | – | – | **Yes** — call/cost/output ceilings + per-key caps |
| **A/B Lab (strategy simulation)** | – | – | **Yes** — predicted vs reality comparison |
| **Proxy-aware circuit breaker** | – | DB-backed | **Yes** — per `provider:proxyKey` |
| **Health monitoring** | – | – | **Yes** — cached aggregates + `health:degraded` SSE |
| **Structured Output + JSON fence** | – | Yes | **Yes** — `response_format` translation + ```` ```json ```` unwrap |
| **Provider capabilities layer** | – | – | **Yes** — control-role gating for web-cookie providers |
| **Kimchi quota auto-reactivation** | – | – | **Yes** — daily reset sweep |
| **MITM intercept (CLI tools)** | Yes | Yes | **Yes** — SNI + HTTP/2 ALPN + binary EventStream + model alias mapping |
| **Tunnel (Cloudflare + Tailscale)** | Yes | Yes | **Yes** |
| **Format translation** | OpenAI↔Claude↔Gemini | Yes | **Yes** — OpenAI↔Claude↔Gemini↔Responses↔Antigravity |
| **Token savers (RTK/Headroom/Caveman/Ponytail)** | Yes | Yes | **Yes** |
| **Provider count** | 40+ | 231+ | **304** (incl. 39 web-cookie free providers) |

**What ExtremeRouter has that the others don't:**

- Smart Routing — automatically picks the right model pool per task type (tool-calling vs research)
- Hierarchical Swarm engine with live telemetry (gatekeeper verdicts, per-worker lifecycle)
- A/B Lab — replay real request history and simulate strategies before switching
- Cascade strategy — escalate only when confidence is low
- Proxy-aware resilience + TPS optimizations
- 39 web-cookie providers for zero-cost access (Qwen Web, Claude Web, Gemini Web, Conol, Notion AI, HyperAgent, ...)
- Model-first combo templates that resolve to any connected provider

---

<a name="how-it-works"></a>

## How It Works

```
┌─────────────┐
│  Your CLI   │  (Claude Code, Codex, OpenClaw, Cursor, Cline, ...)
│   Tool      │
└──────┬──────┘
       │ http://localhost:20128/v1
       ↓
┌──────────────────────────────────────────────┐
│             ExtremeRouter                    │
│  • RTK Token Saver (compress tool_result)    │
│  • Format translation (OpenAI ↔ Claude)      │
│  • Quota tracking + auto token refresh       │
│  • Combo strategies + smart routing          │
└──────┬───────────────────────────────────────┘
       │
       ├─→ [Tier 1: SUBSCRIPTION] Claude Code, Codex, GitHub Copilot
       │   ↓ quota exhausted
       ├─→ [Tier 2: CHEAP] GLM, MiniMax
       │   ↓ budget limit
       └─→ [Tier 3: FREE] Kiro, OpenCode Free, Vertex ($300 credits)

Result: never stop coding, minimal cost, 20–40% token savings via RTK
```

Every request goes through the same pipeline:

1. **Parse** — the incoming model string is resolved to a single model or a combo.
2. **Translate** — the request body is converted from the client format to the provider's native format.
3. **Execute** — the provider executor calls the upstream API (SSE or JSON), refreshing OAuth tokens on 401/403.
4. **Fallback** — on quota-exhaustion, rate limits, or errors, the next account or next combo member is tried.
5. **Stream & translate back** — the upstream stream is normalized to the client's expected format.
6. **Track** — usage (tokens, cost, latency) is persisted for the dashboard.

---

<a name="how-it-looks"></a>

## How It Looks

A preview of the ExtremeRouter dashboard:

<p align="center">
  <img src="./images/extremerouter.png" width="720" alt="ExtremeRouter Dashboard"/>
  <img src="./images/dashboard-home.png" width="720" alt="Dashboard Home"/>
  <img src="./images/dashboard-usage.png" width="720" alt="Usage Analytics"/>
  <img src="./images/providers-page.png" width="420" alt="Providers Page"/>
  <img src="./images/fusion-combo-ui.png" width="720" alt="Fusion Combo UI"/>
</p>

---

<a name="quick-start"></a>

## Quick Start

**Option 1 — install globally (npm):**

```bash
npm install -g @rsalmn/extremerouter
extremerouter
```

The dashboard opens at `http://localhost:20128` (default first-login password: `123456` — change it).

**Option 2 — run from source:**

```bash
git clone https://github.com/rsalmn/extremerouter.git
cd extremerouter
cp .env.example .env
npm install
npm run dev
```

**Option 3 — Docker:**

```bash
docker run -d \
  --name extremerouter \
  -p 20128:20128 \
  -v "$HOME/.extremerouter:/app/data" \
  -e DATA_DIR=/app/data \
  rsalmn/extremerouter:latest
```

**Connect a provider and start using it:**

1. Open the dashboard → **Providers** → connect a provider (OAuth login, API key, or a browser cookie).
2. Copy your API key from **Endpoint** (or use the auto-provisioned default key).
3. Point your CLI tool at the gateway:

```
Endpoint: http://localhost:20128/v1
API Key:  [your key]
Model:    kr/claude-sonnet-4.5   (or any model / combo name)
```

That's it — your CLI now routes through ExtremeRouter with fallback, quota tracking, and token savings.

See [DOCKER.md](DOCKER.md) for full deployment and environment-variable reference.

---

<a name="supported-cli-tools"></a>

## Supported CLI Tools

ExtremeRouter works with any tool that accepts a custom OpenAI/Anthropic-compatible endpoint. It also ships dedicated integration helpers (settings writers/checkers, MITM intercept) for:

| Tool | Integration |
|------|-------------|
| Claude Code | Anthropic-compatible endpoint + settings writer |
| Codex CLI | OpenAI-compatible endpoint + settings writer |
| OpenClaw | Dedicated settings + model picker |
| Cline | Settings writer + official model catalog |
| Kilo Code | Settings writer |
| Copilot / GitHub | OAuth provider + settings |
| OpenCode | Settings writer + OpenCode Free provider |
| Cursor | OpenAI-compatible endpoint (models auto-detect) |
| Antigravity | MITM intercept + OAuth |
| Droid | Settings writer |
| Cowork | Settings + MCP registry/tools |
| DeepSeek TUI | Settings writer |
| Hermes / JCode | Settings writers |
| Continue / Roo | OpenAI-compatible endpoint |
| Zed | OAuth auto-import |

Any other OpenAI/Anthropic-compatible client works out of the box.

---

<a name="supported-providers"></a>

## Supported Providers

**304 providers** across five categories:

| Category | Count | Examples |
|----------|-------|----------|
| API-key providers | 206 | OpenAI, Anthropic, OpenRouter, GLM, Kimi, MiniMax, DeepSeek, Groq, xAI, Mistral, Fireworks, Cerebras, SiliconFlow, Nebius, Together, Perplexity, NVIDIA, Cohere, Novita, Helyx, TokenHarbor, 180+ more |
| OAuth providers | 25 | Claude Code, Codex, GitHub Copilot, Cursor, Antigravity, Gemini CLI, Kimchi, Kiro, Qwen, Zed, WorkBuddy, CodeBuddy, Kimi Desktop, iFlow |
| Web-cookie providers | 39 | Qwen Web, Claude Web, ChatGPT Web, Gemini Web, DeepSeek Web, Kimi Web, Grok Web, Perplexity Web, Blackbox, T3, DuckDuckGo, Venice, DouBao, v0, Poe, Copilot, Meta AI (Muse), Adapta, VeoAI, Conol, Notion AI, HyperAgent, Hailuo, Gemini Business, Inner.ai, and more |
| Free-tier providers | 19 | Kiro AI (free Claude/GLM/MiniMax), OpenCode Free (no auth), Vertex AI ($300 credits), ZenMux, free API mirrors |
| Free providers | 15 | Community free endpoints, no signup |

**Zero-cost stack (recommended):** Kiro AI + OpenCode Free + Vertex AI — unlimited free usage for daily coding.

> Note: some free tiers changed in 2026 — iFlow and Qwen Code free tiers were discontinued. Kiro / OpenCode Free / Vertex remain the recommended free options.

---

<a name="key-features-in-detail"></a>

## Key Features in Detail

### Combo strategies

A combo is a named list of models with a strategy. Call a combo by its name from any client.

- **fallback** — try members in order; move to the next on quota/rate-limit/error.
- **round-robin** — rotate through members for load balancing.
- **fusion** — send the task to a panel of models and let a judge pick/merge the best answer.
- **swarm** — Hierarchical Swarm: a gatekeeper triages the prompt, a manager plans and splits subtasks, workers execute in parallel, an audit stage reviews, and the manager synthesizes the final answer. Live SSE telemetry on the dashboard Swarm page.
- **cascade** — start cheap, escalate to more capable models only when confidence is low.
- **smart-routing** — task-aware routing (available in combo templates): tool-calling tasks route to tool-capable API models; research-style prompts route to cookie/free providers. Every decision (reason, selected pool, excluded cookies) is recorded in Smart Routing telemetry, persisted to the database, and shown in a dedicated dashboard page with pagination and filters.

### Token savers

- **RTK** — auto-detects and compresses tool outputs (git-diff, grep, ls, tree, dedup-log, smart-truncate) before the request reaches the LLM. Runs before format translation, so it works across all formats. Default ON.
- **Headroom** — optional external `/v1/compress` proxy (fails open if down).
- **Ponytail** — injects a "lazy senior dev" YAGNI-first prompt (Lite / Full / Ultra).
- **Caveman** — injects a terse-response prompt for up to 65% output-token savings.

### Resilience

- **Health monitor** — sliding-window success/failure samples per provider, live SSE feed, dashboard Health page.
- **Circuit breaker** — per-provider CLOSED/OPEN/HALF_OPEN state machine; routing auto-skips open breakers and probes to auto-recover.
- **Account fallback** — multiple accounts per provider, cooldown on transient/rate/auth errors, next account tried automatically.
- **Combo budget & admission control** — per-combo cost/call/output ceilings and per-key concurrency caps.

### Security

- **Per-key model ACL** — each API key can carry `allowedModels`; requests outside the list are rejected with 403 up front.
- **API keys** — HMAC-signed local keys (`API_KEY_SECRET`), optional `REQUIRE_API_KEY` enforcement for internet-exposed deployments.
- **Secrets handling** — tokens never logged in plaintext (masked), provider secrets stored in the local database.
- **Dashboard auth** — cookie session signed with JWT (`JWT_SECRET`), optional `INITIAL_PASSWORD`, secure-cookie flag behind HTTPS proxies.

### Observability

- **Usage analytics** — tokens and estimated cost per provider/model, trends, monthly reports, leaderboards.
- **Request logging** — optional full request/response logs (`ENABLE_REQUEST_LOGS=true`), request-details viewer.
- **Smart Routing telemetry** — persisted routing decisions (reason, pool, excluded cookies) with history, pagination, and filters.
- **A/B Lab** — replay historical requests through different strategies and compare predicted vs actual results, flagging models that fail often in production.

### Media & more

- **Images** — generation via provider-native endpoints (e.g. flux-1, image models).
- **Audio** — STT (assemblyai, gladia, soniox, rev-ai, speechmatics) and TTS (fishaudio and friends) async-batch adapters.
- **Embeddings & search** — OpenAI-compatible embeddings and web-search endpoints.
- **Proxy pools** — deploy routing nodes to Cloudflare Workers, Deno, or Vercel.
- **Tunnels** — Cloudflare Quick Tunnel and Tailscale (enable/disable/status from the dashboard).
- **Cloud sync** — sync providers, combos, keys, and settings across devices.
- **MCP plugin** — mount MCP servers/tools for agents.

---

<a name="frequently-asked-questions"></a>

## Frequently Asked Questions

<details>
<summary><b>Will ExtremeRouter ever charge me anything?</b></summary>

No. ExtremeRouter is free, open-source software that runs on your own machine. It has no billing system and never sends invoices. You only pay providers directly (subscriptions or API fees) when you choose paid ones — ExtremeRouter just routes your traffic.

</details>

<details>
<summary><b>Why does the dashboard show high costs if it's free?</b></summary>

The "cost" numbers are *estimated* costs — what the same usage would cost if you called the paid APIs directly. They are a savings tracker, not a bill. Example: dashboard shows "$290" while you used Kiro (free) — that $290 is what you saved.

</details>

<details>
<summary><b>Are the free providers really unlimited?</b></summary>

Yes for the recommended ones (Kiro AI, OpenCode Free, Vertex $300 credits) — they are genuinely free services offered by those companies. ExtremeRouter just makes them easy to route to, with fallback support.

</details>

<details>
<summary><b>What happens when my subscription quota runs out mid-session?</b></summary>

If you're using a combo, the router automatically falls back to the next member (cheap → free). You never see downtime; your cost stays predictable because you define the ladder.

</details>

<details>
<summary><b>Can I hand out keys to teammates without exposing everything?</b></summary>

Yes. Per-key model ACL lets you mint keys with an `allowedModels` allow-list. Any request outside the list is rejected with 403.

</details>

<details>
<summary><b>Which tools can I use it with?</b></summary>

Anything that accepts a custom OpenAI or Anthropic-compatible base URL: Claude Code, Codex, Cursor, Cline, Continue, Roo, OpenClaw, Kilo Code, OpenCode, Zed, and more. No plugin required — just point the endpoint at `http://localhost:20128/v1`.

</details>

<details>
<summary><b>Do web-cookie providers require anything special?</b></summary>

You paste a browser cookie (or session token) from the site's DevTools. The router handles token refresh, WAF cookies, PoW challenges, and SSE translation per site. Some sites (Claude/ChatGPT/Gemini web) deploy aggressive anti-bot protection and are included best-effort.

</details>

---

<a name="api-reference"></a>

## API Reference

The gateway exposes an OpenAI-compatible surface at `http://localhost:20128/v1`.

### Chat completions

```bash
POST /v1/chat/completions
Authorization: Bearer your-api-key
Content-Type: application/json

{
  "model": "kr/claude-sonnet-4.5",
  "messages": [
    { "role": "user", "content": "Write a function to..." }
  ],
  "stream": true
}
```

### List models

```bash
GET /v1/models
Authorization: Bearer your-api-key
```

Returns all provider models + combos in OpenAI format.

### Anthropic Messages (Claude Code)

```bash
POST /v1/messages
Authorization: Bearer your-api-key
```

Anthropic-format entry point for Claude Code and similar clients.

### OpenAI Responses API

```bash
POST /v1/responses
```

### Gemini-native (v1beta)

```bash
POST /v1beta/models/gemini-2.5-pro:generateContent
```

Gemini-native surface for Google clients (respects per-key model ACL).

### Other endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/embeddings` | Embeddings (OpenAI-compatible) |
| `POST /v1/images/generations` | Image generation |
| `POST /v1/audio/transcriptions` | Speech-to-text |
| `POST /v1/audio/speech` | Text-to-speech |
| `POST /v1/search` | Web search |
| `POST /v1/web/fetch` | Web fetch |
| `POST /v1/messages/count_tokens` | Token counting |

### Model naming

Models are namespaced by provider alias: `kr/claude-sonnet-4.5`, `cc/claude-opus-4-6`, `glm/glm-5.1`, `minimax/MiniMax-M2.7`, `vertex/gemini-3.1-pro-preview`. Combo names can be used directly as the model value.

---

<a name="contributors"></a>

## Contributors

Thanks to all contributors who helped make ExtremeRouter better!

[![Contributors](https://contrib.rocks/image?repo=rsalmn/extremerouter&max=150&columns=15&anon=1&v=20260309)](https://github.com/rsalmn/extremerouter/graphs/contributors)

---

<a name="support"></a>

## Support

- **Issues & bugs**: [github.com/rsalmn/extremerouter/issues](https://github.com/rsalmn/extremerouter/issues)
- **Docker Hub**: [rsalmn/extremerouter](https://hub.docker.com/r/rsalmn/extremerouter)
- **GHCR**: [ghcr.io/rsalmn/extremerouter](https://github.com/rsalmn/extremerouter/pkgs/container/extremerouter)
- **npm**: [@rsalmn/extremerouter](https://www.npmjs.com/package/@rsalmn/extremerouter)

---

<a name="star-chart--forks"></a>

## Star Chart & Forks

[![Star Chart](https://starchart.cc/rsalmn/extremerouter.svg?variant=adaptive)](https://starchart.cc/rsalmn/extremerouter)

Community forks will be listed here. Submit a Pull Request to add yours.

---

<a name="acknowledgments--references"></a>

## Acknowledgments & References

Built on the shoulders of giants:

- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — the original Go implementation that inspired this JavaScript port.
- **[RTK](https://github.com/rtk-ai/rtk)** — Rust token-saver; ExtremeRouter ports its compression pipeline to JS.
- **[Headroom](https://github.com/chopratejas/headroom)** — context compression proxy.
- **[Caveman](https://github.com/JuliusBrussee/caveman)** by **[@JuliusBrussee](https://github.com/JuliusBrussee)** — terse-response prompting.
- **[Ponytail](https://github.com/DietrichGebert/ponytail)** by **[@DietrichGebert](https://github.com/DietrichGebert)** — YAGNI-first code prompting.
- **[OmniRoute](https://github.com/diegosouzapw/omniroute)** — provider registry and web-cookie executor patterns that ExtremeRouter adapts.
- **[9Router](https://github.com/9router/9router)** — the routing core lineage.
- **gemini-web2api / gemini-business2api / g4f** — reverse-engineering references for Gemini and Hailuo web protocols.

---

<a name="license"></a>

## License

MIT License — see [LICENSE](LICENSE) for details.

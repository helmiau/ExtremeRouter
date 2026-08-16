# ExtremeRouter — AI Gateway Control Plane

**A self-hosted AI gateway that routes traffic from your AI coding tools to 304+ providers with format translation, smart fallback, quota tracking, and 20–40% token savings.**

Connect Claude Code, Codex, Cursor, Antigravity, Copilot, Gemini, OpenCode, Cline, OpenClaw, and any OpenAI/Anthropic-compatible client to one unified endpoint: `http://localhost:20128/v1`.

## Quick Start

```bash
docker run -d \
  --name extremerouter \
  -p 20128:20128 \
  -v "$HOME/.extremerouter:/app/data" \
  -e DATA_DIR=/app/data \
  rsalmn/extremerouter:latest
```

Open `http://localhost:20128` — the dashboard is ready (default first-login password: `123456`, change it).

## Highlights

- **304+ providers** — API-key (206), OAuth (25), web-cookie (39), free-tier (19), and free (15) providers behind a single endpoint
- **Format translation** — OpenAI ↔ Claude ↔ Gemini ↔ Responses ↔ Antigravity ↔ Kiro ↔ Cursor
- **6 combo strategies** — fallback, round-robin, fusion, swarm, cascade, smart-routing
- **Smart Routing** — task-aware routing (tool-calling vs research) with persisted telemetry
- **Hierarchical Swarm engine** — gatekeeper, manager, workers, audit, synthesis with live SSE telemetry
- **A/B Lab** — replay request history and compare strategies (predicted vs actual)
- **Token savers** — RTK (20–40% input savings), Headroom, Ponytail, Caveman (up to 65% output savings)
- **Resilience** — health monitor, per-provider circuit breaker, multi-account fallback, combo budget + admission control
- **Security** — per-key model ACL, HMAC-signed API keys, OAuth auto-refresh
- **Observability** — usage analytics, request logs, smart-routing telemetry

## Supported CLI Tools

Claude Code, Codex, Cursor, Antigravity, Copilot, Cline, OpenCode, OpenClaw, Gemini CLI, Droid, Roo, Kilo Code, Qwen, iFlow, Continue, Zed, Aider — and any OpenAI/Anthropic-compatible client. No plugin required.

## Data & Persistence

- Container data lives in `/app/data` — mount a volume to persist (`$HOME/.extremerouter:/app/data`)
- SQLite database, auto backups, settings, providers, keys, combos, usage history

## Links

- **Repository**: https://github.com/rsalmn/extremerouter
- **Issues**: https://github.com/rsalmn/extremerouter/issues
- **npm**: https://www.npmjs.com/package/@rsalmn/extremerouter
- **License**: MIT

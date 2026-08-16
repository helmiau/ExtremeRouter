<div align="center">

# ExtremeRouter — AI Gateway Control Plane

**A self-hosted AI gateway that routes traffic from your AI coding tools to 304+ providers with format translation, smart fallback, quota tracking, and 20–40% token savings.**

Connect Claude Code, Codex, Cursor, Antigravity, Copilot, Gemini, OpenCode, Cline, OpenClaw, and any OpenAI/Anthropic-compatible client to one unified endpoint.

**Language:** [English](README.md) · [Bahasa Indonesia](README.id.md) · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/@rsalmn/extremerouter.svg)](https://www.npmjs.com/package/@rsalmn/extremerouter)
[![Downloads](https://img.shields.io/npm/dm/@rsalmn/extremerouter.svg)](https://www.npmjs.com/package/@rsalmn/extremerouter)
[![License](https://img.shields.io/npm/l/@rsalmn/extremerouter.svg)](https://github.com/rsalmn/extremerouter/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-rsalmn%2Fextremerouter-blue?logo=github)](https://github.com/rsalmn/extremerouter)

</div>

---

## Table of Contents

- [Quick Start](#quick-start)
- [CLI Options](#cli-options)
- [Supported Tools](#supported-tools)
- [Data Location](#data-location)
- [Docker](#docker)
- [Documentation](#documentation)
- [License](#license)

---

## Quick Start

**Install globally:**

```bash
npm install -g @rsalmn/extremerouter
extremerouter
```

The dashboard opens at `http://localhost:20128` (default first-login password: `123456` — change it).

**Run with npx (no install):**

```bash
npx @rsalmn/extremerouter
```

**Connect a provider and start using it:**

1. Dashboard → **Providers** → connect a provider (OAuth login, API key, or browser cookie).
2. Copy your API key from **Endpoint**.
3. Point your CLI tool at the gateway:

```
Endpoint: http://localhost:20128/v1
API Key:  [your key]
Model:    <provider>/<model>   (e.g. kr/claude-sonnet-4.5)
```

---

## CLI Options

```bash
extremerouter                  # Start with default settings
extremerouter -p 8080          # Custom port (default: 20128)
extremerouter -H 0.0.0.0       # Bind to all interfaces
extremerouter -n               # Don't open the browser on start
extremerouter -l ./er.log      # Write logs to a file
extremerouter -t               # Start in system tray mode
extremerouter --skip-update    # Skip the auto-update check
extremerouter -h               # Show help
extremerouter -v               # Show version
```

| Option | Description |
|--------|-------------|
| `-p, --port <port>` | Port to run the server (default: `20128`) |
| `-H, --host <host>` | Host to bind (default: `0.0.0.0` — use `127.0.0.1` for local-only) |
| `-n, --no-browser` | Don't open the browser automatically |
| `-l, --log <file>` | Write request logs to a file |
| `-t, --tray` | Start minimized in the system tray |
| `--skip-update` | Skip the auto-update check |
| `-h, --help` | Show this help message |
| `-v, --version` | Show the installed version |

**Dashboard**: `http://localhost:20128/dashboard`

> **Network note:** the server binds `0.0.0.0` by default, so it is reachable on your LAN. For local-only use, start with `-H 127.0.0.1`.

---

## Supported Tools

Claude Code, Codex, Cursor, Antigravity, Copilot, Cline, OpenCode, OpenClaw, Gemini CLI, Droid, Roo, Kilo Code, Qwen, iFlow, Continue, Zed, Aider — and any OpenAI/Anthropic-compatible client. No plugin required; just point the endpoint at `http://localhost:20128/v1`.

---

## Data Location

- **macOS / Linux**: `~/.extremerouter/`
- **Windows**: `%APPDATA%/extremerouter/`
- **Docker**: `/app/data/` (mount `$HOME/.extremerouter` to persist)

The first launch automatically migrates providers, keys, combos, and settings from older versions. Your previous data is left intact so you can roll back.

---

## Docker

```bash
docker run -d --name extremerouter -p 20128:20128 \
  -v "$HOME/.extremerouter:/app/data" -e DATA_DIR=/app/data \
  rsalmn/extremerouter:latest
```

---

## Documentation

- **Repository**: https://github.com/rsalmn/extremerouter
- **Issues**: https://github.com/rsalmn/extremerouter/issues
- **Docker Hub**: https://hub.docker.com/r/rsalmn/extremerouter

---

## License

MIT License — see [LICENSE](LICENSE) for details.

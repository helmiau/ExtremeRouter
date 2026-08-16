<div align="center">

# ExtremeRouter — AI 网关控制平面

**一个自托管的 AI 网关，通过格式转换、智能回退、配额跟踪和 20–40% 的令牌节省，将您的 AI 编码工具流量路由到 304+ 个提供商。**

将 Claude Code、Codex、Cursor、Antigravity、Copilot、Gemini、OpenCode、Cline、OpenClaw 以及任何兼容 OpenAI/Anthropic 的客户端连接到统一端点。

**语言：** [English](README.md) · [Bahasa Indonesia](README.id.md) · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/@rsalmn/extremerouter.svg)](https://www.npmjs.com/package/@rsalmn/extremerouter)
[![Downloads](https://img.shields.io/npm/dm/@rsalmn/extremerouter.svg)](https://www.npmjs.com/package/@rsalmn/extremerouter)
[![License](https://img.shields.io/npm/l/@rsalmn/extremerouter.svg)](https://github.com/rsalmn/extremerouter/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-rsalmn%2Fextremerouter-blue?logo=github)](https://github.com/rsalmn/extremerouter)

</div>

---

## 目录

- [快速开始](#快速开始)
- [CLI 选项](#cli-选项)
- [支持的工具](#支持的工具)
- [数据位置](#数据位置)
- [Docker](#docker)
- [文档](#文档)
- [许可证](#许可证)

---

## 快速开始

**全局安装：**

```bash
npm install -g @rsalmn/extremerouter
extremerouter
```

仪表盘在 `http://localhost:20128` 打开（首次登录默认密码：`123456`，请尽快修改）。

**使用 npx 运行（无需安装）：**

```bash
npx @rsalmn/extremerouter
```

**连接提供商并开始使用：**

1. 仪表盘 → **Providers** → 连接提供商（OAuth 登录、API 密钥或浏览器 cookie）。
2. 从 **Endpoint** 复制您的 API 密钥。
3. 将您的 CLI 工具指向网关：

```
Endpoint: http://localhost:20128/v1
API Key:  [您的密钥]
Model:    <provider>/<model>   （例如 kr/claude-sonnet-4.5）
```

---

## CLI 选项

```bash
extremerouter                  # 使用默认设置启动
extremerouter -p 8080          # 自定义端口（默认：20128）
extremerouter -H 0.0.0.0       # 绑定所有接口
extremerouter -n               # 启动时不打开浏览器
extremerouter -l ./er.log      # 将日志写入文件
extremerouter -t               # 以系统托盘模式启动
extremerouter --skip-update    # 跳过自动更新检查
extremerouter -h               # 显示帮助
extremerouter -v               # 显示版本
```

| 选项 | 说明 |
|------|------|
| `-p, --port <port>` | 服务器运行端口（默认：`20128`） |
| `-H, --host <host>` | 绑定主机（默认：`0.0.0.0` — 仅本地请用 `127.0.0.1`） |
| `-n, --no-browser` | 不自动打开浏览器 |
| `-l, --log <file>` | 将请求日志写入文件 |
| `-t, --tray` | 最小化启动到系统托盘 |
| `--skip-update` | 跳过自动更新检查 |
| `-h, --help` | 显示此帮助信息 |
| `-v, --version` | 显示已安装版本 |

**仪表盘**：`http://localhost:20128/dashboard`

> **网络提示：** 服务器默认绑定 `0.0.0.0`，因此可在局域网内访问。仅本地使用请以 `-H 127.0.0.1` 启动。

---

## 支持的工具

Claude Code、Codex、Cursor、Antigravity、Copilot、Cline、OpenCode、OpenClaw、Gemini CLI、Droid、Roo、Kilo Code、Qwen、iFlow、Continue、Zed、Aider — 以及任何兼容 OpenAI/Anthropic 的客户端。无需插件，只需将端点指向 `http://localhost:20128/v1`。

---

## 数据位置

- **macOS / Linux**：`~/.extremerouter/`
- **Windows**：`%APPDATA%/extremerouter/`
- **Docker**：`/app/data/`（挂载 `$HOME/.extremerouter` 以持久化）

首次启动会自动从旧版本迁移提供商、密钥、组合和设置。您的旧数据保持原样，可以回滚。

---

## Docker

```bash
docker run -d --name extremerouter -p 20128:20128 \
  -v "$HOME/.extremerouter:/app/data" -e DATA_DIR=/app/data \
  rsalmn/extremerouter:latest
```

---

## 文档

- **仓库**：https://github.com/rsalmn/extremerouter
- **Issues**：https://github.com/rsalmn/extremerouter/issues
- **Docker Hub**：https://hub.docker.com/r/rsalmn/extremerouter

---

## 许可证

MIT 许可证 — 详见 [LICENSE](LICENSE)。

<div align="center">

# ExtremeRouter — AI 网关控制平面

**一个自托管的 AI 网关，通过格式转换、智能回退、配额跟踪和 20–40% 的令牌节省，将您的 AI 编码工具流量路由到 304+ 个提供商。**

将 Claude Code、Cursor、Antigravity、Copilot、Codex、Gemini、OpenCode、Cline、OpenClaw 以及任何兼容 OpenAI/Anthropic 的客户端连接到统一端点。

**语言：** [English](README.md) · [Bahasa Indonesia](README.id.md) · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/@rsalmn/extremerouter.svg)](https://www.npmjs.com/package/@rsalmn/extremerouter)
[![Downloads](https://img.shields.io/npm/dm/@rsalmn/extremerouter.svg)](https://www.npmjs.com/package/@rsalmn/extremerouter)
[![Docker Pulls](https://img.shields.io/docker/pulls/rsalmn/extremerouter.svg?logo=docker&label=Docker%20pulls)](https://hub.docker.com/r/rsalmn/extremerouter)
[![GHCR](https://img.shields.io/badge/GHCR-rsalmn%2Fextremerouter-blue?logo=github)](https://github.com/rsalmn/extremerouter/pkgs/container/extremerouter)
[![License](https://img.shields.io/npm/l/@rsalmn/extremerouter.svg)](https://github.com/rsalmn/extremerouter/blob/main/LICENSE)

</div>

---

## 目录

- [亮点功能](#亮点功能)
- [对比：9Router vs OmniRoute vs ExtremeRouter](#对比)
- [工作原理](#工作原理)
- [界面预览](#界面预览)
- [快速开始](#快速开始)
- [支持的 CLI 工具](#支持的-cli-工具)
- [支持的提供商](#支持的提供商)
- [核心功能详解](#核心功能详解)
- [常见问题](#常见问题)
- [API 参考](#api-参考)
- [贡献者](#贡献者)
- [支持](#支持)
- [星标图与 Fork](#星标图与-fork)
- [致谢与参考](#致谢与参考)
- [许可证](#许可证)

---

<a name="亮点功能"></a>

## 亮点功能

| 功能 | 作用 | 为什么重要 |
|------|------|-----------|
| **304+ 提供商，单一端点** | API 密钥、OAuth、免费层和 39 个 web-cookie 提供商统一在一个 `/v1` 接口之后 | 无需再在多个 base URL、密钥和仪表盘之间切换 |
| **格式转换** | OpenAI ↔ Claude ↔ Gemini ↔ Responses ↔ Antigravity ↔ Kiro ↔ Cursor | 任何 CLI 工具都能对接任何提供商 |
| **6 种组合策略** | fallback、round-robin、fusion、swarm、cascade、smart-routing | 为任务选择最合适的路由方案 |
| **分层 Swarm 引擎** | Gatekeeper → Manager → Workers → Audit → Synthesis，带实时 SSE 遥测 | 面向复杂任务的并行多智能体执行 |
| **智能路由** | 感知任务的路由：工具调用任务走支持工具的模型，研究类任务走 cookie/免费提供商 | 按任务类型自动选择模型池 |
| **Cascade 策略** | 从便宜到强大，带自我报告置信度门控 | 仅在简单模型失败时才为高性能付费 |
| **RTK 令牌节省器** | 发送前压缩 `tool_result` 内容（git diff、grep、ls、tree…） | 每次请求节省 20–40% 输入令牌 |
| **Ponytail 与 Caveman** | 注入 YAGNI 优先和简洁回复的提示词 | 最多减少 65% 输出令牌 |
| **智能三层回退** | 订阅 → 便宜 → 免费，全自动 | 永不停机，零中断 |
| **实时配额跟踪** | 每个提供商的实时令牌数和重置倒计时 | 最大化订阅价值 |
| **多账户轮询** | 每个提供商多账户，自动故障转移 | 负载均衡 + 冗余 |
| **自动令牌刷新** | OAuth 令牌到期前自动刷新，401/403 重试路径 | 无需手动重新登录 |
| **按密钥模型 ACL** | 每个 API 密钥可携带 `allowedModels` 白名单（白名单外返回 403） | 安全地分发受限密钥 |
| **健康监控 + 熔断器** | 每提供商滑动窗口健康度、CLOSED/OPEN/HALF_OPEN 状态机 | 自动跳过故障提供商并自动恢复 |
| **组合预算与准入控制** | 每组合成本上限、每密钥并发上限 | 保持在支出限额内 |
| **A/B 实验室** | 回放历史请求并对比策略（fallback vs swarm vs smart-routing） | 选择仍能作答的最便宜策略 |
| **用量分析** | 令牌、成本估算、趋势、请求日志 | 理解并优化支出 |
| **随处部署** | Localhost、VPS、Docker、Cloudflare Workers、隧道（Cloudflare + Tailscale） | 处处相同的配置 |

---

<a name="对比"></a>

## 对比：9Router vs OmniRoute vs ExtremeRouter

三个项目同属一个家族。ExtremeRouter 是完全独立的演进——保留了久经考验的 9Router 核心，借鉴 OmniRoute 的最佳想法，并加入自己的架构、UI 和可靠性层。

| 功能 | 9Router | OmniRoute | **ExtremeRouter** |
|------|---------|-----------|-------------------|
| **组合策略** | 4 | 17 | **6**（fallback / round-robin / fusion / swarm / cascade / **smart-routing**） |
| **智能路由（感知任务）** | – | – | **有** — 按任务在工具调用与研究之间路由 |
| **分层 Swarm** | – | – | **有** — Gatekeeper → Manager → Workers → Audit → Synthesis + 实时遥测 |
| **Cascade（渐进升级）** | – | – | **有** — 从便宜到强大，带置信度门控 |
| **每组合思考覆盖** | – | – | **有** — 角色级（manager=max，worker=medium） |
| **Swarm worker 自动伸缩** | – | – | **有** — 根据子任务复杂度动态调整 worker 数 |
| **组合模板（模型优先）** | – | – | **有** — 解析到任意已连接提供商 |
| **组合预算 + 准入控制** | – | – | **有** — 调用/成本/输出上限 + 每密钥并发上限 |
| **A/B 实验室（策略模拟）** | – | – | **有** — 预测与实际结果对比 |
| **代理感知熔断器** | – | 基于 DB | **有** — 按 `provider:proxyKey` |
| **健康监控** | – | – | **有** — 缓存聚合 + `health:degraded` SSE |
| **结构化输出 + JSON 围栏** | – | 有 | **有** — `response_format` 转换 + ```` ```json ```` 解包 |
| **提供商能力层** | – | – | **有** — 对 web-cookie 提供商做控制角色门控 |
| **Kimchi 配额自动恢复** | – | – | **有** — 每日重置扫描 |
| **MITM 拦截（CLI 工具）** | 有 | 有 | **有** — SNI + HTTP/2 ALPN + 二进制 EventStream + 模型别名映射 |
| **隧道（Cloudflare + Tailscale）** | 有 | 有 | **有** |
| **格式转换** | OpenAI↔Claude↔Gemini | 有 | **有** — OpenAI↔Claude↔Gemini↔Responses↔Antigravity |
| **令牌节省器（RTK/Headroom/Caveman/Ponytail）** | 有 | 有 | **有** |
| **提供商数量** | 40+ | 231+ | **304**（含 39 个免费 web-cookie 提供商） |

**ExtremeRouter 独有：**

- 智能路由 — 按任务类型（工具调用 vs 研究）自动选择正确的模型池
- 分层 Swarm 引擎，带实时遥测（gatekeeper 裁决、每个 worker 的生命周期）
- A/B 实验室 — 回放真实请求历史，切换前先模拟策略
- Cascade 策略 — 仅在置信度低时升级
- 代理感知韧性 + TPS 优化
- 39 个免费 web-cookie 提供商（Qwen Web、Claude Web、Gemini Web、Conol、Notion AI、HyperAgent…）
- 模型优先的组合模板，可解析到任意已连接提供商

---

<a name="工作原理"></a>

## 工作原理

```
┌─────────────┐
│  您的 CLI   │  (Claude Code, Codex, OpenClaw, Cursor, Cline, ...)
│    工具     │
└──────┬──────┘
       │ http://localhost:20128/v1
       ↓
┌──────────────────────────────────────────────┐
│             ExtremeRouter                    │
│  • RTK 令牌节省器（压缩 tool_result）          │
│  • 格式转换（OpenAI ↔ Claude）                │
│  • 配额跟踪 + 自动令牌刷新                    │
│  • 组合策略 + 智能路由                        │
└──────┬───────────────────────────────────────┘
       │
       ├─→ [第 1 层：订阅] Claude Code, Codex, GitHub Copilot
       │   ↓ 配额耗尽
       ├─→ [第 2 层：便宜] GLM, MiniMax
       │   ↓ 预算上限
       └─→ [第 3 层：免费] Kiro, OpenCode Free, Vertex（$300 额度）

结果：永不停机，成本最小化，通过 RTK 节省 20–40% 令牌
```

每个请求经过相同的流水线：

1. **解析** — 传入的模型字符串解析为单个模型或一个组合。
2. **转换** — 请求体从客户端格式转换为提供商的本地格式。
3. **执行** — 提供商执行器调用上游 API（SSE 或 JSON），在 401/403 时自动刷新 OAuth 令牌。
4. **回退** — 配额耗尽、限流或出错时，尝试下一个账户或下一个组合成员。
5. **流式返回并转换** — 上游流标准化为客户端期望的格式。
6. **跟踪** — 用量（令牌、成本、延迟）持久化到仪表盘。

---

<a name="界面预览"></a>

## 界面预览

ExtremeRouter 仪表盘预览：

<p align="center">
  <img src="./images/extremerouter.png" width="720" alt="ExtremeRouter Dashboard"/>
  <img src="./images/dashboard-home.png" width="720" alt="Dashboard Home"/>
  <img src="./images/dashboard-usage.png" width="720" alt="Usage Analytics"/>
  <img src="./images/providers-page.png" width="420" alt="Providers Page"/>
  <img src="./images/fusion-combo-ui.png" width="720" alt="Fusion Combo UI"/>
</p>

---

<a name="快速开始"></a>

## 快速开始

**方式 1 — 全局安装（npm）：**

```bash
npm install -g @rsalmn/extremerouter
extremerouter
```

仪表盘在 `http://localhost:20128` 打开（首次登录默认密码：`123456`，请尽快修改）。

**方式 2 — 从源码运行：**

```bash
git clone https://github.com/rsalmn/extremerouter.git
cd extremerouter
cp .env.example .env
npm install
npm run dev
```

**方式 3 — Docker：**

```bash
docker run -d \
  --name extremerouter \
  -p 20128:20128 \
  -v "$HOME/.extremerouter:/app/data" \
  -e DATA_DIR=/app/data \
  rsalmn/extremerouter:latest
```

**连接提供商并开始使用：**

1. 打开仪表盘 → **Providers** → 连接提供商（OAuth 登录、API 密钥或浏览器 cookie）。
2. 从 **Endpoint** 复制您的 API 密钥（或使用自动生成的默认密钥）。
3. 将您的 CLI 工具指向网关：

```
Endpoint: http://localhost:20128/v1
API Key:  [您的密钥]
Model:    kr/claude-sonnet-4.5   （或任何模型 / 组合名称）
```

就这样——您的 CLI 现在通过 ExtremeRouter 路由，享受回退、配额跟踪和令牌节省。

完整部署与环境变量参考见 [DOCKER.md](DOCKER.md)。

---

<a name="支持的-cli-工具"></a>

## 支持的 CLI 工具

ExtremeRouter 可与任何接受自定义 OpenAI/Anthropic 兼容端点的工具配合使用。项目还提供专用集成辅助（设置读写器、MITM 拦截），支持：

| 工具 | 集成 |
|------|------|
| Claude Code | Anthropic 兼容端点 + 设置写入器 |
| Codex CLI | OpenAI 兼容端点 + 设置写入器 |
| OpenClaw | 专用设置 + 模型选择器 |
| Cline | 设置写入器 + 官方模型目录 |
| Kilo Code | 设置写入器 |
| Copilot / GitHub | OAuth 提供商 + 设置 |
| OpenCode | 设置写入器 + OpenCode Free 提供商 |
| Cursor | OpenAI 兼容端点（模型自动检测） |
| Antigravity | MITM 拦截 + OAuth |
| Droid | 设置写入器 |
| Cowork | 设置 + MCP 注册表/工具 |
| DeepSeek TUI | 设置写入器 |
| Hermes / JCode | 设置写入器 |
| Continue / Roo | OpenAI 兼容端点 |
| Zed | OAuth 自动导入 |

任何其他 OpenAI/Anthropic 兼容客户端均可开箱即用。

---

<a name="支持的提供商"></a>

## 支持的提供商

**304 个提供商**，分五个类别：

| 类别 | 数量 | 示例 |
|------|------|------|
| API 密钥提供商 | 206 | OpenAI、Anthropic、OpenRouter、GLM、Kimi、MiniMax、DeepSeek、Groq、xAI、Mistral、Fireworks、Cerebras、SiliconFlow、Nebius、Together、Perplexity、NVIDIA、Cohere、Novita、Helyx、TokenHarbor 等 180+ 家 |
| OAuth 提供商 | 25 | Claude Code、Codex、GitHub Copilot、Cursor、Antigravity、Gemini CLI、Kimchi、Kiro、Qwen、Zed、WorkBuddy、CodeBuddy、Kimi Desktop、iFlow |
| Web-cookie 提供商 | 39 | Qwen Web、Claude Web、ChatGPT Web、Gemini Web、DeepSeek Web、Kimi Web、Grok Web、Perplexity Web、Blackbox、T3、DuckDuckGo、Venice、DouBao、v0、Poe、Copilot、Meta AI（Muse）、Adapta、VeoAI、Conol、Notion AI、HyperAgent、Hailuo、Gemini Business、Inner.ai 等 |
| 免费层提供商 | 19 | Kiro AI（免费 Claude/GLM/MiniMax）、OpenCode Free（免认证）、Vertex AI（$300 额度）、ZenMux、免费 API 镜像 |
| 免费提供商 | 15 | 社区免费端点，无需注册 |

**零成本方案（推荐）：** Kiro AI + OpenCode Free + Vertex AI — 日常编码无限免费使用。

> 注意：2026 年部分免费层有变动——iFlow 和 Qwen Code 免费层已停止。Kiro / OpenCode Free / Vertex 仍是推荐的免费选项。

---

<a name="核心功能详解"></a>

## 核心功能详解

### 组合策略

组合是带策略的命名模型列表。可从任何客户端按名称调用。

- **fallback** — 按顺序尝试成员；配额/限流/出错时移到下一个。
- **round-robin** — 成员间轮换以实现负载均衡。
- **fusion** — 将任务发送给一组模型，由裁判选择/合并最佳答案。
- **swarm** — 分层 Swarm：gatekeeper 分流提示词，manager 规划并拆分子任务，workers 并行执行，audit 阶段审查，manager 综合最终答案。仪表盘 Swarm 页面提供实时 SSE 遥测。
- **cascade** — 从便宜开始，仅在置信度低时升级到更强的模型。
- **smart-routing** — 感知任务的路由（在组合模板中可用）：工具调用任务路由到支持工具的 API 模型；研究类提示词路由到 cookie/免费提供商。每个决策（原因、所选池、排除的 cookie）都记录在智能路由遥测中，持久化到数据库，并在专用仪表盘页面中显示，支持分页和过滤。

### 令牌节省器

- **RTK** — 在请求到达 LLM 前自动检测并压缩工具输出（git-diff、grep、ls、tree、dedup-log、smart-truncate）。在格式转换之前运行，适用于所有格式。默认开启。
- **Headroom** — 可选的外部 `/v1/compress` 代理（宕机时 fail-open）。
- **Ponytail** — 注入"懒惰资深开发"YAGNI 优先提示词（Lite / Full / Ultra）。
- **Caveman** — 注入简洁回复提示词，最多节省 65% 输出令牌。

### 可靠性

- **健康监控** — 每个提供商的滑动窗口成功/失败样本、实时 SSE 流、仪表盘 Health 页面。
- **熔断器** — 每提供商 CLOSED/OPEN/HALF_OPEN 状态机；路由自动跳过打开的熔断器并探测自动恢复。
- **账户回退** — 每提供商多账户，瞬时/限流/认证错误冷却，自动尝试下一个账户。
- **组合预算与准入控制** — 每组合成本/调用/输出上限和每密钥并发上限。

### 安全

- **按密钥模型 ACL** — 每个 API 密钥可携带 `allowedModels`；白名单外的请求立即以 403 拒绝。
- **API 密钥** — HMAC 签名的本地密钥（`API_KEY_SECRET`），可选的 `REQUIRE_API_KEY` 强制执行（用于暴露在公网的部署）。
- **机密处理** — 令牌从不以明文记录（打码），提供商机密存储在本地数据库中。
- **仪表盘认证** — 使用 JWT 签名的 cookie 会话（`JWT_SECRET`）、可选的 `INITIAL_PASSWORD`、HTTPS 反向代理后的 secure-cookie 标志。

### 可观测性

- **用量分析** — 每个提供商/模型的令牌和成本估算、趋势、月度报告、排行榜。
- **请求日志** — 可选的完整请求/响应日志（`ENABLE_REQUEST_LOGS=true`）、请求详情查看器。
- **智能路由遥测** — 持久化的路由决策（原因、池、排除的 cookie），带历史记录、分页和过滤。
- **A/B 实验室** — 回放历史请求，用不同策略模拟并对比预测与实际结果，标记在生产中经常失败的模型。

### 媒体与其他

- **图像** — 通过提供商本地端点生成（例如 flux-1、图像模型）。
- **音频** — STT 异步批处理适配器（assemblyai、gladia、soniox、rev-ai、speechmatics）和 TTS（fishaudio 等）。
- **嵌入与搜索** — OpenAI 兼容的嵌入和网络搜索端点。
- **代理池** — 将路由节点部署到 Cloudflare Workers、Deno 或 Vercel。
- **隧道** — Cloudflare Quick Tunnel 和 Tailscale（仪表盘可启用/禁用/查看状态）。
- **云同步** — 跨设备同步提供商、组合、密钥和设置。
- **MCP 插件** — 为智能体挂载 MCP 服务器/工具。

---

<a name="常见问题"></a>

## 常见问题

<details>
<summary><b>ExtremeRouter 会向我收费吗？</b></summary>

不会。ExtremeRouter 是在您自己机器上运行的免费开源软件。它没有计费系统，也从不发送发票。您只在选择付费提供商时直接向提供商付费（订阅或 API 费用）——ExtremeRouter 仅负责路由您的流量。

</details>

<details>
<summary><b>既然是免费的，为什么仪表盘显示很高的成本？</b></summary>

"成本"数字是*估算*——即相同用量直接调用付费 API 的成本。这是节省追踪器，不是账单。例如：仪表盘显示"$290"，而您在使用 Kiro（免费）——这 $290 就是您节省的金额。

</details>

<details>
<summary><b>免费提供商真的无限吗？</b></summary>

推荐的提供商（Kiro AI、OpenCode Free、Vertex $300 额度）是的——它们是这些公司提供的真正免费服务。ExtremeRouter 只是让路由到它们变得容易，并支持回退。

</details>

<details>
<summary><b>会话中途订阅配额用完了怎么办？</b></summary>

如果您使用组合，路由器会自动回退到下一个成员（便宜 → 免费）。您不会看到停机；由于阶梯由您定义，成本保持可预测。

</details>

<details>
<summary><b>可以把密钥分发给同事而不暴露全部内容吗？</b></summary>

可以。按密钥模型 ACL 允许您签发带 `allowedModels` 白名单的密钥。白名单外的任何请求都会以 403 拒绝。

</details>

<details>
<summary><b>可以配合哪些工具使用？</b></summary>

任何接受自定义 OpenAI 或 Anthropic 兼容 base URL 的工具：Claude Code、Codex、Cursor、Cline、Continue、Roo、OpenClaw、Kilo Code、OpenCode、Zed 等。无需插件——只需将端点指向 `http://localhost:20128/v1`。

</details>

<details>
<summary><b>web-cookie 提供商需要特殊准备吗？</b></summary>

您从网站的 DevTools 粘贴浏览器 cookie（或会话令牌）。路由器按站点处理令牌刷新、WAF cookie、PoW 挑战和 SSE 转换。部分站点（Claude/ChatGPT/Gemini Web）部署了激进的防机器人保护，属于尽力而为。

</details>

---

<a name="api-参考"></a>

## API 参考

网关在 `http://localhost:20128/v1` 暴露 OpenAI 兼容接口。

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

### 模型列表

```bash
GET /v1/models
Authorization: Bearer your-api-key
```

以 OpenAI 格式返回所有提供商模型 + 组合。

### Anthropic Messages（Claude Code）

```bash
POST /v1/messages
Authorization: Bearer your-api-key
```

面向 Claude Code 及类似客户端的 Anthropic 格式入口。

### OpenAI Responses API

```bash
POST /v1/responses
```

### Gemini 原生（v1beta）

```bash
POST /v1beta/models/gemini-2.5-pro:generateContent
```

面向 Google 客户端的 Gemini 原生接口（遵守按密钥模型 ACL）。

### 其他端点

| 端点 | 用途 |
|------|------|
| `POST /v1/embeddings` | 嵌入（OpenAI 兼容） |
| `POST /v1/images/generations` | 图像生成 |
| `POST /v1/audio/transcriptions` | 语音转文字 |
| `POST /v1/audio/speech` | 文字转语音 |
| `POST /v1/search` | 网络搜索 |
| `POST /v1/web/fetch` | 网页抓取 |
| `POST /v1/messages/count_tokens` | 令牌计数 |

### 模型命名

模型按提供商别名命名空间：`kr/claude-sonnet-4.5`、`cc/claude-opus-4-6`、`glm/glm-5.1`、`minimax/MiniMax-M2.7`、`vertex/gemini-3.1-pro-preview`。组合名称可直接用作模型值。

---

<a name="贡献者"></a>

## 贡献者

感谢所有帮助 ExtremeRouter 变得更好的贡献者！

[![Contributors](https://contrib.rocks/image?repo=rsalmn/extremerouter&max=150&columns=15&anon=1&v=20260309)](https://github.com/rsalmn/extremerouter/graphs/contributors)

---

<a name="支持"></a>

## 支持

- **问题与缺陷**：[github.com/rsalmn/extremerouter/issues](https://github.com/rsalmn/extremerouter/issues)
- **Docker Hub**：[rsalmn/extremerouter](https://hub.docker.com/r/rsalmn/extremerouter)
- **GHCR**：[ghcr.io/rsalmn/extremerouter](https://github.com/rsalmn/extremerouter/pkgs/container/extremerouter)
- **npm**：[@rsalmn/extremerouter](https://www.npmjs.com/package/@rsalmn/extremerouter)

---

<a name="星标图与-fork"></a>

## 星标图与 Fork

[![Star Chart](https://starchart.cc/rsalmn/extremerouter.svg?variant=adaptive)](https://starchart.cc/rsalmn/extremerouter)

社区 Fork 将在此列出。提交 Pull Request 添加您的 Fork。

---

<a name="致谢与参考"></a>

## 致谢与参考

站在巨人的肩膀上：

- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — 启发此 JavaScript 移植的原始 Go 实现。
- **[RTK](https://github.com/rtk-ai/rtk)** — Rust 令牌节省器；ExtremeRouter 将其压缩管线移植到 JS。
- **[Headroom](https://github.com/chopratejas/headroom)** — 上下文压缩代理。
- **[Caveman](https://github.com/JuliusBrussee/caveman)**，作者 **[@JuliusBrussee](https://github.com/JuliusBrussee)** — 简洁回复提示词。
- **[Ponytail](https://github.com/DietrichGebert/ponytail)**，作者 **[@DietrichGebert](https://github.com/DietrichGebert)** — YAGNI 优先代码提示词。
- **[OmniRoute](https://github.com/diegosouzapw/omniroute)** — ExtremeRouter 借鉴的提供商注册表与 web-cookie 执行器模式。
- **[9Router](https://github.com/9router/9router)** — 路由核心血统。
- **gemini-web2api / gemini-business2api / g4f** — Gemini 与 Hailuo Web 协议的反向工程参考。

---

<a name="许可证"></a>

## 许可证

MIT 许可证 — 详见 [LICENSE](LICENSE)。

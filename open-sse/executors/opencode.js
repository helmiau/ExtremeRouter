import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";

// Models that use /zen/v1/messages (claude format)
const MESSAGES_MODELS = new Set();

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  transformRequest(model, body, stream) {
    // OpenCode is OpenAI-compatible and REJECTS `stream_options` without
    // `stream: true` (400 "stream_options should be set along with stream = true").
    // On non-streaming requests strip any client-sent stream_options so the pair
    // can't go out mismatched (mirrors DefaultExecutor's stream/stream_options
    // handling). The executor never injects stream_options on stream either —
    // opencode accepts plain `stream: true`.
    if (stream === false && body && typeof body === "object" && body.stream_options !== undefined) {
      body = { ...body };
      delete body.stream_options;
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return MESSAGES_MODELS.has(model)
      ? `${base}/zen/v1/messages`
      : `${base}/zen/v1/chat/completions`;
  }

  // Identity-driven upstream headers. The identity object is resolved once per
  // LOGICAL REQUEST in chat.js and carried through execute() — never cached on
  // this singleton executor (concurrent requests must not cross-talk).
  // Downstream opencode headers are preserved; non-opencode clients get no
  // fabricated opencode User-Agent (we are not the opencode CLI) and a unique
  // per-request session when they provide no session identity.
  buildHeaders(credentials, stream = true, model = null, opencodeIdentity = null) {
    const id = opencodeIdentity || {};
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "Accept": stream ? "text/event-stream" : "*/*",
    };
    // x-opencode-client: forward when the client sent one, else the
    // provider-required compatibility default the upstream expects.
    headers["x-opencode-client"] = id.clientId || "desktop";
    // x-opencode-session: client session is preserved; otherwise the
    // request-scoped resolved session (chat.js) — never random-per-request.
    if (id.sessionId) headers["x-opencode-session"] = id.sessionId;
    // x-opencode-request: unique per logical request; stable across retries,
    // fallback and the whole stream because the identity object is reused.
    if (id.requestId) headers["x-opencode-request"] = id.requestId;
    // x-opencode-project: forwarded only when the client supplied one (no
    // arbitrary defaults — the field may carry local metadata).
    if (id.projectId) headers["x-opencode-project"] = id.projectId;
    // User-Agent: preserve a real downstream opencode UA; otherwise omit —
    // never fabricate "opencode" for clients that are not opencode.
    return headers;
  }
}

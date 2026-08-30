import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { getModelTargetFormat } from "../config/providerModels.js";
import { convertResponsesStreamToJson } from "../transformer/streamToJsonConverter.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// Models that use /zen/v1/messages (claude format)
const MESSAGES_MODELS = new Set();

// Responses-API models (registry targetFormat: "openai-responses", e.g.
// muse-spark-1.2-contributor-free): /zen/v1/chat/completions 500s for these —
// they are served exclusively by /zen/v1/responses (verified live 2026-08-31).
// Routing is MODEL-scoped via the registry targetFormat, the same pattern the
// github executor uses; never a hardcoded model set here.
function isResponsesModel(model) {
  return getModelTargetFormat("oc", model) === "openai-responses";
}

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
    // Responses-API models: chatCore has already translated the request to
    // Responses shape (model targetFormat), so the URL must match — a
    // Responses-shaped body on /chat/completions 500s upstream.
    if (isResponsesModel(model)) {
      return `${base}/zen/v1/responses`;
    }
    return MESSAGES_MODELS.has(model)
      ? `${base}/zen/v1/messages`
      : `${base}/zen/v1/chat/completions`;
  }

  async execute(options) {
    const { model } = options;
    if (model && isResponsesModel(model)) {
      return this.executeResponses(options);
    }
    return super.execute(options);
  }

  // Responses-API execution. chatCore translated the request to Responses
  // shape (model targetFormat) before execute() and — for streaming clients —
  // also converts the upstream responses SSE back to the client format via its
  // SSE transform (OPENAI_RESPONSES → source), the same path codex models use.
  // The executor only picks the endpoint and always streams upstream
  // (translator hardcodes stream:true). For non-streaming CLIENTS chatCore's
  // streaming response would never be consumed as JSON, so the executor
  // collects the responses stream itself and maps it to a chat.completion
  // body here.
  async executeResponses({ model, body, stream, credentials, signal, log, proxyOptions = null, opencodeIdentity = null }) {
    const url = `${this.config.baseUrl}/zen/v1/responses`;
    const headers = this.buildHeaders(credentials, true, model, opencodeIdentity);

    // The translator hardcodes stream:true (Responses SSE); strip any
    // client-shaped stream_options that survived translation.
    const transformedBody = { ...body, model, stream: true };
    delete transformedBody.stream_options;

    log?.debug?.("OPENCODE", `Responses route for ${model} (targetFormat:openai-responses)`);

    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal,
    }, proxyOptions);

    if (!response.ok || !response.body) {
      return { response, url, headers, transformedBody };
    }

    if (stream === false) {
      // Non-streaming client: collect the responses SSE into the complete
      // responses JSON, then map to a chat.completion body (same field mapping
      // as the codex forced-SSE path).
      const jsonResponse = await convertResponsesStreamToJson(response.body);
      return {
        response: new Response(JSON.stringify(this.responsesJsonToChatCompletion(jsonResponse, model)), {
          status: response.status,
          statusText: response.statusText,
          headers: { "Content-Type": "application/json", ...response.headers },
        }),
        url,
        headers,
        transformedBody,
      };
    }

    // Streaming client: hand chatCore the raw upstream responses SSE — its
    // transform stream owns the responses→client translation.
    return { response, url, headers, transformedBody };
  }

  // Responses JSON → chat.completion JSON (mirrors the codex forced-SSE field
  // mapping in sseToJsonHandler: last non-empty assistant message, function
  // call items → tool_calls, responses usage → chat usage).
  responsesJsonToChatCompletion(jsonResponse, model) {
    const output = Array.isArray(jsonResponse?.output) ? jsonResponse.output : [];

    let textContent = null;
    for (const item of output) {
      if (item?.type !== "message") continue;
      const text = (item.content || [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("");
      if (text.length > 0) textContent = text; // last non-empty wins
    }

    const toolCalls = output
      .filter((item) => item?.type === "function_call")
      .map((item, i) => ({
        id: item.call_id || item.id || `call_${i}`,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "{}" },
      }));

    const thinking = output
      .filter((item) => item?.type === "reasoning")
      .flatMap((item) => (item.summary || []))
      .map((s) => s?.text)
      .filter(Boolean)
      .join("\n") || null;

    const usage = jsonResponse?.usage || {};
    const chatUsage = usage.input_tokens != null || usage.output_tokens != null
      ? {
          prompt_tokens: usage.input_tokens || 0,
          completion_tokens: usage.output_tokens || 0,
          total_tokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0),
        }
      : undefined;

    return {
      id: jsonResponse?.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: jsonResponse?.created_at || Math.floor(Date.now() / 1000),
      model,
      ...(jsonResponse?.error ? { error: jsonResponse.error } : {}),
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: textContent,
          reasoning_content: thinking,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : (jsonResponse?.status === "incomplete" ? "length" : "stop"),
      }],
      ...(chatUsage ? { usage: chatUsage } : {}),
    };
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

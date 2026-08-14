import { randomUUID } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

/**
 * FeloWebExecutor — anonymous, free access to Felo (felo.ai), a
 * chat/search-agent aggregator. No API key or session cookie required.
 *
 * Flow:
 * 1. POST /api-proxy/main/search/threads — opens a search thread, returns `stream_key`.
 * 2. GET /api/message/v1/stream/{stream_key}?offset=0 — SSE-shaped stream. Each line is
 *    `data:{...}` (no space after the colon). The JSON payload carries a double-encoded
 *    `content` string; parsing that yields `{ data: { type, data } }` where `type` is
 *    `"answer"` (incremental/snapshot text) or `"final_contexts"` (sources, dropped —
 *    no OpenAI-compatible slot for citations here).
 *
 * Reverse-engineered, scrape-style integration — may break without notice if Felo
 * changes its frontend contract. Port of OmniRoute felo-web.
 */

export const FELO_BASE = "https://felo.ai";
export const FELO_THREADS_URL = `${FELO_BASE}/api-proxy/main/search/threads`;

export function feloStreamUrl(streamKey) {
  return `${FELO_BASE}/api/message/v1/stream/${encodeURIComponent(streamKey)}?offset=0`;
}

const FELO_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

export const FELO_HEADERS = {
  Accept: "*/*",
  "Content-Type": "application/json",
  Origin: FELO_BASE,
  Referer: `${FELO_BASE}/search?q=hello`,
  "User-Agent": FELO_USER_AGENT,
};

const FELO_STREAM_REQUEST_HEADERS = {
  Accept: "*/*",
  Origin: FELO_BASE,
  Referer: FELO_HEADERS.Referer,
  "User-Agent": FELO_USER_AGENT,
};

// Mirrors g4f's `Felo.model_aliases` — category drives which search/answer
// pipeline Felo routes the query through.
const FELO_MODEL_CATEGORIES = {
  "felo-chat": "chat",
  "felo-search": "google",
  "felo-scholar": "scholar",
  "felo-social": "social",
  "felo-document": "document",
};

export const FELO_DEFAULT_MODEL = "felo-chat";

export function normalizeFeloModel(model) {
  if (!model) return FELO_DEFAULT_MODEL;
  const clean = String(model).startsWith("felo-web/")
    ? String(model).slice("felo-web/".length)
    : String(model);
  return Object.prototype.hasOwnProperty.call(FELO_MODEL_CATEGORIES, clean)
    ? clean
    : FELO_DEFAULT_MODEL;
}

export function resolveFeloCategory(model) {
  return FELO_MODEL_CATEGORIES[normalizeFeloModel(model)];
}

export function extractFeloLastUserPrompt(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  const content = lastUser.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function buildFeloThreadPayload(model, prompt) {
  const searchUuid = randomUUID();
  return {
    query: prompt,
    search_uuid: searchUuid,
    lang: "",
    agent_lang: "en",
    search_options: { langcode: "en-US" },
    search_video: true,
    query_from: "default",
    category: resolveFeloCategory(model),
    model: "",
    auto_routing: true,
    mode: "concise",
    device_id: randomUUID().replaceAll("-", ""),
    source_message_rid: "",
    documents: [],
    document_action: "",
    slides_source: { type: "ask_question", files: {} },
    slide_template_uid: "",
    selected_resource_ids: [],
    process_id: searchUuid,
    stream_protocol: "message_center_v1",
    enable_task_state: true,
  };
}

function extractFeloAnswerText(contentJson) {
  if (!contentJson || typeof contentJson !== "object") return null;
  const data = contentJson.data;
  if (!data || typeof data !== "object") return null;
  if (data.type !== "answer") return null;
  const inner = data.data;
  if (!inner || typeof inner !== "object") return null;
  const text = inner.text;
  return typeof text === "string" ? text : null;
}

/**
 * Parse a single line of Felo's SSE-shaped stream, diffing against the running
 * snapshot: each `answer` event carries the full text-so-far, and only the new
 * suffix is new content.
 */
export function parseFeloStreamLine(line, previousText) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:{")) {
    return { newText: null, nextPreviousText: previousText };
  }

  let outer;
  try {
    outer = JSON.parse(trimmed.slice(5));
  } catch {
    return { newText: null, nextPreviousText: previousText };
  }

  const content = outer?.content;
  if (typeof content !== "string") {
    return { newText: null, nextPreviousText: previousText };
  }

  let contentJson;
  try {
    contentJson = JSON.parse(content);
  } catch {
    return { newText: null, nextPreviousText: previousText };
  }

  const text = extractFeloAnswerText(contentJson);
  if (text === null) {
    return { newText: null, nextPreviousText: previousText };
  }

  if (text.startsWith(previousText)) {
    const newPart = text.slice(previousText.length);
    return newPart
      ? { newText: newPart, nextPreviousText: text }
      : { newText: null, nextPreviousText: previousText };
  }

  return { newText: text, nextPreviousText: text };
}

/** Replay a full raw stream body through `parseFeloStreamLine`, returning the final text. */
export function accumulateFeloStreamText(rawText) {
  let previousText = "";
  for (const line of rawText.split("\n")) {
    previousText = parseFeloStreamLine(line, previousText).nextPreviousText;
  }
  return previousText;
}

function feloErrorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message, type: "upstream_error" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildFeloStreamTransform() {
  let previousText = "";
  let buffer = "";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseFeloStreamLine(line, previousText);
        previousText = parsed.nextPreviousText;
        if (!parsed.newText) continue;
        const openaiChunk = { choices: [{ delta: { content: parsed.newText }, index: 0 }] };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
      }
    },
    flush(controller) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
}

async function processFeloResponse(response, streaming) {
  if (streaming) {
    if (!response.body) {
      return feloErrorResponse(500, "No response body");
    }
    const transformed = response.body.pipeThrough(buildFeloStreamTransform());
    return new Response(transformed, { headers: { "Content-Type": "text/event-stream" } });
  }

  const rawText = await response.text();
  const fullText = accumulateFeloStreamText(rawText);
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: fullText },
          index: 0,
          finish_reason: "stop",
        },
      ],
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

export class FeloWebExecutor extends BaseExecutor {
  constructor() {
    super("felo-web", { baseUrl: FELO_BASE, format: "openai", noAuth: true });
  }

  async execute({ model, body, stream, signal, log, proxyOptions }) {
    const bodyObj = body || {};
    const messages = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
    const isStreaming = stream !== false;

    if (messages.length === 0) {
      return this.result(feloErrorResponse(400, "No messages provided"), body);
    }
    const prompt = extractFeloLastUserPrompt(messages);
    if (!prompt) {
      return this.result(feloErrorResponse(400, "No user message content found"), body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      const err = new Error("felo-web execute timeout");
      err.name = "TimeoutError";
      controller.abort(err);
    }, 60_000);
    const mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

    try {
      const streamKey = await this.createFeloThread(model, prompt, mergedSignal, proxyOptions);
      if (streamKey instanceof Response) {
        clearTimeout(timeout);
        return this.result(streamKey, body);
      }

      const streamResponse = await proxyAwareFetch(
        feloStreamUrl(streamKey),
        { method: "GET", headers: FELO_STREAM_REQUEST_HEADERS, signal: mergedSignal },
        proxyOptions
      );
      clearTimeout(timeout);

      if (!streamResponse.ok || !streamResponse.body) {
        const status = !streamResponse.ok && streamResponse.status >= 500 ? 502 : streamResponse.status || 502;
        return this.result(feloErrorResponse(status, `Felo stream request failed with HTTP ${streamResponse.status}`), body);
      }

      return this.result(await processFeloResponse(streamResponse, isStreaming), body);
    } catch (error) {
      clearTimeout(timeout);
      log?.error?.("FELO", `execute error: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof DOMException && error.name === "AbortError") {
        return this.result(feloErrorResponse(499, "Request cancelled"), body);
      }
      return this.result(feloErrorResponse(500, error instanceof Error ? error.message : "Unknown error"), body);
    }
  }

  /** Returns the resolved `stream_key`, or an error Response to propagate as-is. */
  async createFeloThread(model, prompt, signal, proxyOptions) {
    const threadResponse = await proxyAwareFetch(
      FELO_THREADS_URL,
      {
        method: "POST",
        headers: FELO_HEADERS,
        body: JSON.stringify(buildFeloThreadPayload(model, prompt)),
        signal,
      },
      proxyOptions
    );

    if (!threadResponse.ok) {
      const status = threadResponse.status >= 500 ? 502 : threadResponse.status;
      return feloErrorResponse(status, `Felo thread creation failed with HTTP ${threadResponse.status}`);
    }

    const threadJson = await threadResponse.json().catch(() => null);
    const streamKey = threadJson?.stream_key;
    if (typeof streamKey !== "string" || !streamKey) {
      return feloErrorResponse(502, "Felo did not return a stream_key");
    }
    return streamKey;
  }

  result(response, body) {
    return { response, url: FELO_THREADS_URL, headers: FELO_HEADERS, transformedBody: body };
  }
}

export default FeloWebExecutor;

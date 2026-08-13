// Pure logic for the Playground — no React, no DOM, no fetch. Extracted so the
// stream callbacks, session persistence, and parameter derivation are unit-
// testable without mounting components (same pattern as swarmReducer.js).

// ── Stream deltas ───────────────────────────────────────────────────────────

/** Append a delta string to a running value (null-safe). */
export function appendDelta(cur, val) {
  return val ? (cur || "") + val : cur;
}

// ── Compare-mode slot keys ───────────────────────────────────────────────────
//
// Compare panels are addressed by a per-slot key instead of the bare model id.
// Previously the context/results map was keyed by modelId, so selecting the
// SAME model in two slots made the second stream overwrite the first's context
// and — worse — the first completion deleted the shared key, so the second
// panel never received deltas or completion and froze at "Waiting…".

/** Build a stable per-slot key ("3::gpt-5.3") that survives duplicate models. */
export function compareSlotKey(index, modelId) {
  return `${index}::${modelId}`;
}

/** Parse a slot key back into { index, modelId }. */
export function parseCompareSlotKey(key) {
  const i = key.indexOf("::");
  if (i < 0) return { index: -1, modelId: key };
  return { index: Number(key.slice(0, i)), modelId: key.slice(i + 2) };
}

// ── Result merging (functional, race-safe for concurrent streams) ────────────

const EMPTY_RESULT = { content: "", reasoning: "", streaming: true, error: null };

/** Seed a compare result placeholder for one slot. */
export function emptyCompareResult() {
  return { ...EMPTY_RESULT };
}

/** Merge a delta into a compare result map under `key`. */
export function mergeCompareDelta(prev, key, parsed) {
  const cur = prev[key] || emptyCompareResult();
  return {
    ...prev,
    [key]: {
      ...cur,
      content: appendDelta(cur.content, parsed.content),
      reasoning: appendDelta(cur.reasoning, parsed.reasoning),
    },
  };
}

/** Finalize a compare result map entry (complete or error). */
export function mergeCompareFinal(prev, key, patch) {
  const cur = prev[key] || { content: "", reasoning: "", streaming: true, error: null };
  return { ...prev, [key]: { ...cur, ...patch } };
}

/** Patch a single message in a messages array (single mode). */
export function patchMessage(messages, id, patch) {
  return messages.map((m) => (m.id !== id ? m : { ...m, ...patch }));
}

// ── Display normalization ────────────────────────────────────────────────────

/**
 * Build the display copy of outgoing messages: drop the system prompt (sent in
 * the request body only) and normalize user content to plain text with the
 * attachments carried in a separate `attachments` field for rendering.
 */
export function displayMessages(baseMessages) {
  return baseMessages
    .filter((m) => m.role !== "system")
    .map((m) =>
      m.role === "user"
        ? { ...m, content: m.displayText ?? m.content, attachments: m.displayAttachments }
        : m
    );
}

// ── Session titles ───────────────────────────────────────────────────────────

const MAX_TITLE_LENGTH = 40;

/** Extract a string title from the first user message — safe for multimodal
 *  content arrays (previously `.content.slice(0, 40)` on an array produced an
 *  array "title" that rendered broken in the history list). */
export function sessionTitle(messages, fallback = "New Chat") {
  const first = messages.find((m) => m.role === "user");
  if (!first) return fallback;
  let text = first.content;
  if (Array.isArray(text)) {
    text = text
      .map((c) => (c && c.type === "text" ? c.text : ""))
      .filter(Boolean)
      .join(" ");
  }
  if (typeof text !== "string") text = "";
  const t = text.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, MAX_TITLE_LENGTH) : fallback;
}

// ── Thinking levels (client mirror of getThinkingLevels fallback) ────────────
//
// The backend (open-sse/providers/thinkingLevels.js) is the authoritative
// source; /api/models now exposes caps.thinkingLevels / thinkingMaxEffort so
// the panel can advertise the exact per-model set instead of a static list.

const LEVELS_EFFORT = ["minimal", "low", "medium", "high"];
const LEVELS_EFFORT_MAX = [...LEVELS_EFFORT, "max"];

/**
 * Valid thinking levels for a model given its capabilities, or null when the
 * model cannot reason. Mirrors getThinkingLevels' fallback ordering.
 * @param {{reasoning?: boolean, thinkingLevels?: string[]|null, thinkingMaxEffort?: boolean}} caps
 * @returns {string[]|null}
 */
export function thinkingLevelsForCaps(caps) {
  if (!caps?.reasoning) return null;
  if (Array.isArray(caps.thinkingLevels) && caps.thinkingLevels.length > 0) {
    return [...caps.thinkingLevels];
  }
  return caps.thinkingMaxEffort ? [...LEVELS_EFFORT_MAX] : [...LEVELS_EFFORT];
}

// ── Parameter clamping ───────────────────────────────────────────────────────

/** Cap the max-tokens input bound by the model's output limit (default 128k). */
export function maxTokensBound(caps) {
  const out = caps?.maxOutput;
  if (typeof out === "number" && Number.isFinite(out) && out > 0) return out;
  return 128000;
}

// ── Persistence ──────────────────────────────────────────────────────────────

export const MAX_STORED_MESSAGES = 60;
export const MAX_SESSIONS = 100;

/**
 * Clone sessions and drop heavy inline image dataUrls so a few image chats
 * can't keep a session over the localStorage limit forever. Keeps the
 * attachment id/name so thumbnails still render (broken-image safe).
 */
export function stripAttachmentPayload(sessions) {
  return sessions.map((s) => ({
    ...s,
    messages: (s.messages || []).map((m) => {
      if (m.role !== "user") return m;
      return {
        ...m,
        displayAttachments: Array.isArray(m.displayAttachments)
          ? m.displayAttachments.map((a) => ({ id: a.id, name: a.name, stripped: true }))
          : undefined,
        content: Array.isArray(m.content)
          ? m.content.map((c) =>
              c && c.type === "image_url"
                ? { type: "image_url", image_url: { url: "" } }
                : c
            )
          : m.content,
      };
    }),
  }));
}

/**
 * Build a persistable session from current playground state. Stores mode,
 * the selected-model list, and the last compare round so compare chats survive
 * a reload (previously compare mode could never be saved at all).
 */
export function buildSession({ id, messages, params, selectedModels, mode, compareResults }) {
  const hasMsgs = messages.length > 0;
  const title = hasMsgs
    ? sessionTitle(messages)
    : mode === "compare"
      ? "Compare"
      : "New Chat";
  return {
    id,
    title,
    messages: messages.slice(-MAX_STORED_MESSAGES),
    model: selectedModels[0] || "",
    models: selectedModels,
    mode,
    // Deep snapshot — the stored session must never share nested objects with
    // the live compareResults map (which mutates as streams progress).
    compareResults:
      mode === "compare" && compareResults && Object.keys(compareResults).length > 0
        ? JSON.parse(JSON.stringify(compareResults))
        : undefined,
    params: { ...params },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Serialize sessions to a JSON string (used by localStorage writes). */
export function serializeSessions(sessions) {
  return JSON.stringify(sessions);
}

/** Parse a stored JSON string back into sessions (null-safe). */
export function parseSessions(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Save sessions to localStorage with a quota fallback.
 * @returns {"saved"|"stripped"|"failed"}
 */
export function saveSessionsToStorage(storage, sessions) {
  try {
    storage.setItem("extremerouter.playground.sessions", serializeSessions(sessions));
    return "saved";
  } catch {
    try {
      storage.setItem(
        "extremerouter.playground.sessions",
        serializeSessions(stripAttachmentPayload(sessions))
      );
      return "stripped";
    } catch {
      return "failed";
    }
  }
}

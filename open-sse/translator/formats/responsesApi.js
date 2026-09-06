import { createHash } from "crypto";
import { ROLE, RESPONSES_ITEM } from "../schema/index.js";

/**
 * Normalize Responses API input to array format.
 * Accepts string or array, returns array of message items.
 * An empty array is treated like an empty string — providers require at least one user
 * message, so we inject a placeholder rather than forwarding an empty messages[].
 * @param {string|Array} input - raw input from Responses API body
 * @returns {Array|null} normalized array or null if invalid
 */
export function normalizeResponsesInput(input) {
  if (typeof input === "string") {
    const text = input.trim() === "" ? "..." : input;
    return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text }] }];
  }
  if (Array.isArray(input)) {
    // Empty input[] would produce messages:[] which all providers reject (#389)
    if (input.length === 0) {
      return [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "..." }] }];
    }
    return input;
  }
  return null;
}

// Strict Responses upstreams reject overlong call_ids with InputValidationError (#393).
export const MAX_RESPONSES_CALL_ID_LEN = 64;

// Same-millisecond fallback ids would collide when a batch of items is
// sanitized in a tight loop — a per-process sequence keeps them unique so
// function_call ↔ function_call_output correlation never breaks (9router 11222eff).
let responsesCallIdSeq = 0;

function hashCallId(id) {
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}

export function clampResponsesCallId(id) {
  if (typeof id !== "string" || !id) {
    return `call_${Date.now()}_${(responsesCallIdSeq += 1)}`.slice(0, MAX_RESPONSES_CALL_ID_LEN);
  }
  if (id.length <= MAX_RESPONSES_CALL_ID_LEN) return id;
  // Blind truncation can collapse two distinct ids sharing a long prefix into
  // the same 64 chars — the backend then can't tell their outputs apart. A
  // deterministic hash suffix preserves distinguishability while staying ≤64,
  // and call side + output side always map identically (same input → same id).
  const suffix = "_" + hashCallId(id);
  return id.slice(0, MAX_RESPONSES_CALL_ID_LEN - suffix.length) + suffix;
}

// Single-stringify: objects → JSON once; valid JSON strings pass through untouched;
// anything else (partial fragments, empty) falls back to "{}" instead of
// double-encoding and tripping upstream InputValidationError.
export function coerceResponsesArguments(value) {
  if (value === undefined || value === null || value === "") return "{}";
  if (typeof value !== "string") {
    try {
      return JSON.stringify(value);
    } catch {
      return "{}";
    }
  }
  try {
    JSON.parse(value);
    return value;
  } catch {
    return "{}";
  }
}

// Strict Responses backends reject {type:"object"} without a properties map —
// fill one in for bare object schemas. Shared single source for BOTH tool
// coercion paths (request translator + executor last-line-of-defense) so they
// can never drift apart.
export function ensureResponsesObjectProperties(params) {
  if (!params || typeof params !== "object") return { type: "object", properties: {} };
  if (params.type === "object" && !params.properties) return { ...params, properties: {} };
  return params;
}

// function_call_output.output must be a string — never null/object.
export function coerceResponsesOutput(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    // Per-element guard: one unstringifiable element (BigInt, circular) must
    // not throw the whole coercion. Raw strings pass through unquoted —
    // JSON.stringify("x") would smuggle quotes into the tool output.
    return value.map((c) => {
      if (typeof c === "string") return c;
      try {
        return c?.text ?? JSON.stringify(c);
      } catch {
        return String(c);
      }
    }).join("");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

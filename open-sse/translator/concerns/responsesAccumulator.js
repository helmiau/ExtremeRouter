/**
 * Shared Responses API Accumulator.
 *
 * Consumed by BOTH the streaming translator
 * (openaiResponsesToOpenAIResponse) and the forced non-stream converter
 * (convertResponsesStreamToJson). Previously these two paths assembled
 * Responses state independently — the streaming translator tracked only one
 * current tool call (a scalar), so parallel/interleaved tool calls could
 * attach argument fragments to the wrong call. This class correlates
 * fragmented and interleaved tool calls by output index, item id, and call id,
 * and reconstructs complete terminal output + usage with exactly-once
 * semantics for completed/failed/incomplete/cancelled/abort/EOF.
 *
 * Correlation strategy:
 *   - Primary key: output_index (present on all response.output_item.* and
 *     delta events). Falls back to item_id when output_index is absent.
 *   - function_call items carry call_id; delta events carry item_id which
 *     resolves to the call via the item map.
 *   - Tool call items stored in Map<output_index, ToolEntry>.
 *   - Message items stored in Map<output_index, MessageEntry>.
 *
 * Terminal status: "completed" | "failed" | "incomplete" | "cancelled" | null.
 */

const FUNCTION_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);

/**
 * @typedef {Object} ToolEntry
 * @property {string} itemId      - Responses item id (e.g. "fc_abc")
 * @property {string} callId      - Upstream call_id
 * @property {string} name        - Function/tool name
 * @property {string} argsBuffer  - Accumulated argument fragments
 * @property {boolean} done       - response.output_item.done received
 * @property {boolean} emitted    - Already emitted to client (exactly-once)
 */

/**
 * @typedef {Object} MessageEntry
 * @property {string} itemId
 * @property {string} textBuffer
 * @property {boolean} done
 * @property {object} item        - Raw item snapshot (for output reconstruction)
 */

export class ResponsesAccumulator {
  constructor() {
    /** @type {Map<number|string, ToolEntry>} keyed by output_index (number) or item_id (string) */
    this._tools = new Map();
    /** @type {Map<number|string, MessageEntry>} keyed by output_index or item_id */
    this._messages = new Map();
    /** Ordered list of output keys (output_index values) in arrival order */
    this._order = [];
    /** itemId → output_index (for delta correlation when only item_id is present) */
    this._itemIdToIndex = new Map();
    /** Alias maps for alias-safe tool reconstruction (9router approach) */
    this._toolsByItemId = new Map();
    this._toolsByCallId = new Map();
    /** itemId → tool emit tracking (exactly-once) */
    this._emitted = new Set();
    /** Terminal status */
    this._status = null;
    /** Usage object from response.completed */
    this._usage = null;
    /** Response id from response.created */
    this._responseId = null;
    /** Created timestamp */
    this._created = null;
    /** Whether any tool call was registered */
    this._hasTools = false;
    /** Error object from failed/error events */
    this._error = null;
    /** Model name (passed via factory for output reconstruction) */
    this._model = null;
    /** Incomplete details (for LENGTH finish_reason mapping) */
    this._incompleteDetails = null;
    /** Whether the accumulator has been finalized (exactly-once) */
    this._finalized = false;
  }

  /**
   * Feed any parsed Responses SSE event. Mutates internal state.
   * @param {string} eventType - e.g. "response.output_item.added"
   * @param {object} data - parsed JSON payload
   */
  ingest(eventType, data) {
    if (!eventType || !data) return;

    switch (eventType) {
      case "response.created": {
        this._responseId = data.response?.id || this._responseId;
        this._created = data.response?.created_at || this._created;
        break;
      }

      case "response.output_item.added": {
        const item = data.item;
        if (!item) break;
        const key = data.output_index ?? item.id ?? this._order.length;
        this._registerKey(key);
        this._itemIdToIndex.set(item.id, key);

        if (FUNCTION_CALL_TYPES.has(item.type)) {
          this._hasTools = true;
          // Alias-safe: check if this item was already registered under a
          // different alias (item_id or call_id) — if so, remap rather than
          // create a duplicate. This handles providers that send output_item.
          // added with one id and deltas with another.
          const existingByItemId = item.id ? this._toolsByItemId.get(item.id) : null;
          const existingByCallId = item.call_id ? this._toolsByCallId.get(item.call_id) : null;
          const existing = existingByItemId || existingByCallId;

          if (existing) {
            // Remap: update this key to point to the existing tool entry.
            this._tools.set(key, existing);
            if (item.id) this._toolsByItemId.set(item.id, existing);
            if (item.call_id) this._toolsByCallId.set(item.call_id, existing);
            // Fill in any fields we didn't have yet.
            if (!existing.name && item.name) existing.name = item.name;
            if (!existing.callId && item.call_id) existing.callId = item.call_id;
            if (!existing.itemId && item.id) existing.itemId = item.id;
          } else if (!this._tools.has(key)) {
            const entry = {
              itemId: item.id || "",
              callId: item.call_id || "",
              name: item.name || "",
              argsBuffer: "",
              // True once at least one arguments delta arrived for this call.
              // Lets consumers distinguish "streamed via deltas" from
              // "only a terminal snapshot" so they never re-emit the full
              // buffer after the deltas (which duplicates the arguments).
              argsStreamed: false,
              done: false,
              emitted: false,
            };
            this._tools.set(key, entry);
            if (item.id) this._toolsByItemId.set(item.id, entry);
            if (item.call_id) this._toolsByCallId.set(item.call_id, entry);
          }
        } else if (item.type === "message") {
          if (!this._messages.has(key)) {
            this._messages.set(key, {
              itemId: item.id || "",
              textBuffer: "",
              done: false,
              item: { ...item, content: [] },
            });
          }
        }
        break;
      }

      case "response.output_text.delta": {
        // Append to the last-known message (or a virtual message at the end).
        const delta = data.delta || "";
        if (delta) {
          const key = data.output_index ?? data.item_id ?? this._lastMessageKey();
          this._registerKey(key);
          let msg = this._messages.get(key);
          if (!msg) {
            msg = { itemId: data.item_id || "", textBuffer: "", done: false, item: { type: "message", content: [], role: "assistant" } };
            this._messages.set(key, msg);
          }
          msg.textBuffer += delta;
        }
        break;
      }

      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta": {
        const delta = data.delta || "";
        if (!delta) break;
        const key = this._resolveToolKey(data);
        const tool = this._tools.get(key);
        if (tool) {
          tool.argsBuffer += delta;
          tool.argsStreamed = true;
        }
        break;
      }

      case "response.output_item.done": {
        const item = data.item;
        if (!item) break;
        const key = data.output_index ?? this._itemIdToIndex.get(item.id) ?? item.id;
        if (FUNCTION_CALL_TYPES.has(item.type)) {
          // Alias-safe lookup: try key, then item_id, then call_id.
          const tool = this._tools.get(key)
            || (item.id ? this._toolsByItemId.get(item.id) : null)
            || (item.call_id ? this._toolsByCallId.get(item.call_id) : null);
          if (tool) {
            tool.done = true;
            // preferComplete: if output_item.done carries the full arguments,
            // use whichever is more complete (the snapshot or the accumulated
            // buffer). This guards against corrupt fragmentation where deltas
            // and snapshot disagree — we pick the one that's a valid prefix
            // superset rather than blindly preferring one source.
            if (item.arguments) {
              const snapshot = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments);
              tool.argsBuffer = preferComplete(tool.argsBuffer, snapshot);
            }
            if (!tool.name && item.name) tool.name = item.name;
            if (!tool.callId && item.call_id) tool.callId = item.call_id;
            if (!tool.itemId && item.id) tool.itemId = item.id;
            // Register alias maps for this item in case deltas come later.
            if (item.id) this._toolsByItemId.set(item.id, tool);
            if (item.call_id) this._toolsByCallId.set(item.call_id, tool);
          }
        } else if (item.type === "message") {
          const msg = this._messages.get(key);
          if (msg) {
            msg.done = true;
            msg.item = item;
          }
        }
        break;
      }

      case "response.completed":
      case "response.done": {
        this._status = "completed";
        const u = data.response?.usage;
        if (u && typeof u === "object") {
          const inputTokens = u.input_tokens || u.prompt_tokens || 0;
          const outputTokens = u.output_tokens || u.completion_tokens || 0;
          const cachedTokens = u.input_tokens_details?.cached_tokens || u.cache_read_input_tokens || 0;
          this._usage = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: u.total_tokens || inputTokens + outputTokens,
            cached_tokens: cachedTokens,
          };
        }
        // If response.completed carries a full output array, ingest it (covers
        // providers that send only the terminal event with no deltas).
        const output = data.response?.output;
        if (Array.isArray(output)) {
          for (let i = 0; i < output.length; i++) {
            this._ingestFullItem(i, output[i]);
          }
        }
        break;
      }

      case "response.failed":
      case "error": {
        this._status = "failed";
        this._error = data.error || data.response?.error || null;
        break;
      }

      case "response.incomplete": {
        this._status = "incomplete";
        this._incompleteDetails = data.response?.incomplete_details || null;
        // Capture usage from incomplete events too (some providers send it).
        const iu = data.response?.usage;
        if (iu && !this._usage) {
          const inputTokens = iu.input_tokens || iu.prompt_tokens || 0;
          const outputTokens = iu.output_tokens || iu.completion_tokens || 0;
          this._usage = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: iu.total_tokens || inputTokens + outputTokens,
            cached_tokens: iu.input_tokens_details?.cached_tokens || iu.cache_read_input_tokens || 0,
          };
        }
        break;
      }

      case "response.cancelled": {
        this._status = "cancelled";
        break;
      }

      default:
        // Ignore unrecognized events (reasoning_summary_text.delta, etc.)
        break;
    }
  }

  /**
   * Ingest a complete item from a response.output array (terminal-only providers).
   */
  _ingestFullItem(index, item) {
    if (!item || typeof item !== "object") return;
    this._registerKey(index);
    this._itemIdToIndex.set(item.id, index);
    if (FUNCTION_CALL_TYPES.has(item.type)) {
      this._hasTools = true;
      // Only overwrite if no existing entry (streamed deltas take precedence).
      // If deltas already populated argsBuffer, keep that — don't clobber with
      // the terminal snapshot which may be less complete.
      const existing = this._tools.get(index);
      if (!existing) {
        // Fix #8: avoid emitting '""' (JSON.stringify of empty string fallback)
        // when arguments is absent. Use "" directly.
        const args = typeof item.arguments === "string"
          ? item.arguments
          : (item.arguments != null ? JSON.stringify(item.arguments) : "");
        this._tools.set(index, {
          itemId: item.id || "",
          callId: item.call_id || "",
          name: item.name || "",
          argsBuffer: args,
          argsStreamed: false,
          done: true,
          emitted: false,
        });
        if (item.id) this._toolsByItemId.set(item.id, this._tools.get(index));
        if (item.call_id) this._toolsByCallId.set(item.call_id, this._tools.get(index));
      } else {
        // Already streamed — just mark done + fill missing fields.
        existing.done = true;
        if (!existing.name && item.name) existing.name = item.name;
        if (!existing.callId && item.call_id) existing.callId = item.call_id;
        if (!existing.itemId && item.id) existing.itemId = item.id;
        // Reconcile arguments the same way output_item.done does: if the
        // terminal snapshot is more complete than the accumulated deltas,
        // prefer it (mirrors preferComplete semantics).
        if (item.arguments != null) {
          const snapshot = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments);
          existing.argsBuffer = preferComplete(existing.argsBuffer, snapshot);
        }
      }
    } else if (item.type === "message") {
      this._messages.set(index, {
        itemId: item.id || "",
        textBuffer: "",
        done: true,
        item,
      });
    }
  }

  /** Resolve a tool key from delta event data (item_id → output_index, or direct). */
  _resolveToolKey(data) {
    if (data.output_index !== undefined) return data.output_index;
    if (data.item_id) {
      const idx = this._itemIdToIndex.get(data.item_id);
      if (idx !== undefined) return idx;
      return data.item_id;
    }
    // Fallback: last registered tool key.
    const keys = [...this._tools.keys()];
    return keys.length > 0 ? keys[keys.length - 1] : 0;
  }

  /** Track output_index arrival order for output reconstruction. */
  _registerKey(key) {
    if (!this._order.includes(key)) this._order.push(key);
  }

  /** Get the key of the last message (or undefined). */
  _lastMessageKey() {
    const keys = [...this._messages.keys()];
    return keys.length > 0 ? keys[keys.length - 1] : 0;
  }

  // ── Public getters ──────────────────────────────────────────────────────

  /** @returns {"completed"|"failed"|"incomplete"|"cancelled"|null} */
  get status() { return this._status; }

  /** @returns {{input_tokens:number,output_tokens:number,total_tokens:number,cached_tokens:number}|null} */
  get usage() { return this._usage; }

  get responseId() { return this._responseId; }
  get created() { return this._created; }
  get error() { return this._error || null; }
  get hasTools() { return this._hasTools; }

  /**
   * Ordered output array (messages + function_calls), reconstructed from items.
   * Gaps in numeric indices are filled with empty message placeholders.
   *
   * M2 FIX: dedup by itemId/callId so alias-registered tools (same entry under
   * multiple keys via output_index + item_id) are emitted exactly once.
   * M3 FIX: iterate ALL keys (numeric + string) in arrival order, not just
   * numeric. Previously string-keyed items were dropped when any numeric key
   * existed — common for streams where text deltas omit output_index.
   *
   * @returns {object[]}
   */
  get output() {
    if (this._order.length === 0) return [];
    const out = [];
    const seenToolIds = new Set(); // M2: dedup by itemId

    // M3 FIX: iterate ALL keys in arrival order. For numeric keys, gap-fill
    // missing indices. For string keys (item_id fallback), emit directly.
    const numericKeys = this._order.filter((k) => typeof k === "number");
    const stringKeys = this._order.filter((k) => typeof k === "string");

    // Numeric keys: iterate 0..max for gap-tolerant ordering.
    if (numericKeys.length > 0) {
      const maxIdx = Math.max(...numericKeys);
      const usedNumericKeys = new Set(numericKeys);
      for (let i = 0; i <= maxIdx; i++) {
        if (!usedNumericKeys.has(i)) {
          // Gap — fill with empty message placeholder.
          out.push({ type: "message", content: [], role: "assistant" });
          continue;
        }
        const tool = this._tools.get(i);
        if (tool) {
          const dedupKey = tool.itemId || tool.callId || `idx-${i}`;
          if (!seenToolIds.has(dedupKey)) {
            seenToolIds.add(dedupKey);
            out.push(this._buildToolOutput(tool));
          }
          continue;
        }
        const msg = this._messages.get(i);
        if (msg) {
          out.push(this._buildMessageOutput(msg));
          continue;
        }
      }
    }

    // String keys: append in arrival order (not gap-filled).
    for (const key of stringKeys) {
      const tool = this._tools.get(key);
      if (tool) {
        const dedupKey = tool.itemId || tool.callId || `key-${key}`;
        if (!seenToolIds.has(dedupKey)) {
          seenToolIds.add(dedupKey);
          out.push(this._buildToolOutput(tool));
        }
        continue;
      }
      const msg = this._messages.get(key);
      if (msg) {
        out.push(this._buildMessageOutput(msg));
      }
    }

    return out;
  }

  _buildToolOutput(tool) {
    return {
      type: "function_call",
      id: tool.itemId,
      call_id: tool.callId,
      name: tool.name,
      arguments: tool.argsBuffer,
    };
  }

  _buildMessageOutput(msg) {
    if (msg.done && msg.item) {
      // Use the full item if we captured it on output_item.done.
      return msg.item;
    }
    return {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: msg.textBuffer }],
    };
  }

  // ── Streaming helpers ───────────────────────────────────────────────────

  /**
   * Get the OpenAI tool_call index for a given item_id or output_index.
   * The index is the position of this tool in arrival order (0-based).
   *
   * Fix #9: deduplicate _order by resolved tool entry. Previously the same
   * tool registered under multiple keys (output_index + item_id) could
   * return different indexes depending on which alias was passed.
   * Now we resolve to the actual ToolEntry first, then find its FIRST
   * occurrence in _order.
   *
   * @param {string|number} itemIdOrIndex
   * @returns {number}
   */
  toolCallIndexFor(itemIdOrIndex) {
    // Resolve to the actual ToolEntry object.
    const tool = this.getTool(itemIdOrIndex);
    if (!tool) return 0; // No tool found — default to index 0.

    // Find the FIRST key in _order that maps to this tool entry.
    const seen = new Set();
    let toolIndex = 0;
    for (const key of this._order) {
      const entry = this._tools.get(key);
      if (!entry || seen.has(entry)) continue; // Skip aliases of already-counted tools.
      seen.add(entry);
      if (entry === tool) return toolIndex;
      toolIndex++;
    }
    return toolIndex;
  }

  /**
   * Get a tool entry by item_id or output_index.
   * @param {string|number} itemIdOrIndex
   * @returns {ToolEntry|undefined}
   */
  getTool(itemIdOrIndex) {
    const key = this._resolveToolKey({ item_id: typeof itemIdOrIndex === "string" ? itemIdOrIndex : undefined, output_index: typeof itemIdOrIndex === "number" ? itemIdOrIndex : undefined });
    return this._tools.get(key);
  }

  /** Mark a tool call as emitted (exactly-once guard). */
  markToolCallEmitted(itemId) { this._emitted.add(itemId); }

  /** Has this tool call already been emitted? */
  isToolCallEmitted(itemId) { return this._emitted.has(itemId); }

  /** @returns {object|null} incomplete_details (for LENGTH finish_reason) */
  get incompleteDetails() { return this._incompleteDetails; }

  /** @returns {boolean} whether finalize() was called */
  get finalized() { return this._finalized; }

  /**
   * Complete Responses API response object — single source of truth for both
   * the streaming flush and the forced non-stream converter. Includes id,
   * status, output, usage, error, and incomplete_details when present.
   * @returns {object}
   */
  get response() {
    const status = this._status || "completed";
    return {
      id: this._responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      object: "response",
      created_at: this._created || Math.floor(Date.now() / 1000),
      status,
      output: this.output,
      ...(this._usage ? { usage: this._usage } : {}),
      ...(this._error ? { error: this._error } : {}),
      ...(this._incompleteDetails ? { incomplete_details: this._incompleteDetails } : {}),
    };
  }

  /**
   * Finalize the accumulator: mark as finalized and optionally inject an error
   * (used by abort/stream-disconnect paths). Returns the accumulator for
   * chaining. Exactly-once: subsequent calls are no-ops.
   * @param {{error?: object, status?: string}} [opts]
   * @returns {ResponsesAccumulator}
   */
  finalize(opts = {}) {
    if (this._finalized) return this;
    this._finalized = true;
    if (opts.error && !this._error) {
      this._error = opts.error;
      if (!this._status) this._status = "failed";
    }
    if (opts.status && !this._status) this._status = opts.status;
    return this;
  }
}

// ── Functional factory API (mirrors 9router createResponsesAccumulator) ────
// These allow per-request instantiation at the handler level and sharing
// across streaming + forced non-stream + abort paths.

/**
 * Create a per-request ResponsesAccumulator instance.
 * @param {{model?: string}} [opts]
 * @returns {ResponsesAccumulator}
 */
export function createResponsesAccumulator(opts = {}) {
  const acc = new ResponsesAccumulator();
  if (opts.model) acc._model = opts.model;
  return acc;
}

/**
 * Finalize an accumulator and return its terminal response object.
 * Used by the forced non-stream converter + abort handler.
 * @param {ResponsesAccumulator} acc
 * @param {{error?: object, status?: string}} [opts]
 * @returns {{response: object, accumulator: ResponsesAccumulator}}
 */
export function finalizeResponsesAccumulator(acc, opts = {}) {
  acc.finalize(opts);
  return { response: acc.response, accumulator: acc };
}

/**
 * Prefer the more complete string between two candidates. Used when both
 * streamed deltas and a terminal snapshot exist for the same field — picks
 * whichever is a valid prefix superset rather than blindly preferring one.
 * Port of 9router preferComplete().
 *
 * @param {string} current
 * @param {string} incoming
 * @returns {string}
 */
function preferComplete(current, incoming) {
  if (typeof incoming !== "string" || incoming === "") return current || "";
  if (!current) return incoming;
  // If incoming starts with current, it's a superset → use incoming.
  if (incoming.startsWith(current)) return incoming;
  // If current starts with incoming, current is more complete → keep it.
  if (current.startsWith(incoming)) return current;
  // Neither is a prefix of the other (fragmentation corruption) → prefer
  // incoming as the authoritative terminal snapshot.
  return incoming;
}

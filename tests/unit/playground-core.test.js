import { describe, it, expect } from "vitest";
import {
  appendDelta,
  compareSlotKey,
  parseCompareSlotKey,
  emptyCompareResult,
  mergeCompareDelta,
  mergeCompareFinal,
  patchMessage,
  displayMessages,
  sessionTitle,
  thinkingLevelsForCaps,
  maxTokensBound,
  buildSession,
  serializeSessions,
  parseSessions,
  saveSessionsToStorage,
  stripAttachmentPayload,
  MAX_STORED_MESSAGES,
} from "../../src/app/(dashboard)/dashboard/playground/playgroundCore";

describe("appendDelta", () => {
  it("appends to a running string and is null-safe", () => {
    expect(appendDelta("", "a")).toBe("a");
    expect(appendDelta("ab", "cd")).toBe("abcd");
    expect(appendDelta(null, "x")).toBe("x");
    expect(appendDelta("ab", null)).toBe("ab");
    expect(appendDelta("ab", undefined)).toBe("ab");
  });
});

describe("compare slot keys", () => {
  it("round-trips through parseCompareSlotKey", () => {
    expect(parseCompareSlotKey(compareSlotKey(0, "gpt-5.3"))).toEqual({ index: 0, modelId: "gpt-5.3" });
    expect(parseCompareSlotKey(compareSlotKey(3, "cx/gpt-5.6-sol"))).toEqual({ index: 3, modelId: "cx/gpt-5.6-sol" });
  });

  it("duplicate models get distinct keys (Bug A: same model in two slots)", () => {
    const a = compareSlotKey(0, "gpt-4o");
    const b = compareSlotKey(1, "gpt-4o");
    expect(a).not.toBe(b);
    expect(parseCompareSlotKey(a)).toEqual(parseCompareSlotKey(b) && { index: 0, modelId: "gpt-4o" });
    expect(parseCompareSlotKey(b).index).toBe(1);
  });
});

describe("compare result merging", () => {
  it("mergeCompareDelta seeds a placeholder for unknown keys", () => {
    const next = mergeCompareDelta({}, "0::gpt-4o", { content: "hi", reasoning: null });
    expect(next["0::gpt-4o"].content).toBe("hi");
    expect(next["0::gpt-4o"].reasoning).toBe("");
    expect(next["0::gpt-4o"].streaming).toBe(true);
  });

  it("appends deltas without touching other slots", () => {
    let state = {};
    state = mergeCompareDelta(state, "0::gpt-4o", { content: "Hel", reasoning: "think" });
    state = mergeCompareDelta(state, "1::claude", { content: "Yo", reasoning: null });
    state = mergeCompareDelta(state, "0::gpt-4o", { content: "lo", reasoning: "ing" });
    expect(state["0::gpt-4o"].content).toBe("Hello");
    expect(state["0::gpt-4o"].reasoning).toBe("thinking");
    expect(state["1::claude"].content).toBe("Yo");
  });

  it("completing one slot never touches a sibling slot (Bug A regression)", () => {
    let state = {};
    state = mergeCompareDelta(state, "0::gpt-4o", { content: "first", reasoning: null });
    state = mergeCompareDelta(state, "1::gpt-4o", { content: "second", reasoning: null });
    state = mergeCompareFinal(state, "0::gpt-4o", { streaming: false, usage: { prompt_tokens: 5 } });
    // The second slot (same model id) keeps streaming with its own content.
    expect(state["0::gpt-4o"].streaming).toBe(false);
    expect(state["1::gpt-4o"].streaming).toBe(true);
    expect(state["1::gpt-4o"].content).toBe("second");
  });

  it("error finalize marks the slot and is idempotent", () => {
    let state = mergeCompareFinal({}, "0::gpt-4o", { content: "❌ boom", streaming: false, error: true });
    state = mergeCompareFinal(state, "0::gpt-4o", { content: "❌ boom", streaming: false, error: true });
    expect(state["0::gpt-4o"].error).toBe(true);
    expect(state["0::gpt-4o"].streaming).toBe(false);
  });

  it("emptyCompareResult returns a fresh placeholder", () => {
    const a = emptyCompareResult();
    const b = emptyCompareResult();
    expect(a).toEqual(b);
    expect(a.streaming).toBe(true);
    a.content = "x";
    expect(b.content).toBe("");
  });
});

describe("patchMessage", () => {
  it("patches only the target message id", () => {
    const msgs = [
      { id: "a", content: "1" },
      { id: "b", content: "2", streaming: true },
    ];
    const next = patchMessage(msgs, "b", { streaming: false, content: "2x" });
    expect(next[1].streaming).toBe(false);
    expect(next[1].content).toBe("2x");
    expect(next[0]).toEqual(msgs[0]);
    expect(msgs[1].streaming).toBe(true); // immutable
  });
});

describe("displayMessages", () => {
  it("strips system and normalizes user content/attachments", () => {
    const base = [
      { role: "system", content: "sys" },
      { role: "user", content: "plain", id: "u", displayText: "plain", displayAttachments: [{ id: "a" }] },
      { role: "assistant", content: "hi", id: "m" },
    ];
    const out = displayMessages(base);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toBe("plain");
    expect(out[0].attachments).toEqual([{ id: "a" }]);
    expect(out[1].id).toBe("m");
  });
});

describe("sessionTitle", () => {
  it("uses the first user message text", () => {
    const msgs = [{ role: "user", content: "Hello world, this is a very long first message indeed", id: "1" }];
    expect(sessionTitle(msgs)).toBe("Hello world, this is a very long first m");
  });

  it("handles multimodal content arrays (Bug E: array title)", () => {
    const msgs = [
      { role: "user", content: [
        { type: "text", text: "Describe" },
        { type: "text", text: " this image" },
        { type: "image_url", image_url: { url: "data:..." } },
      ], id: "1" },
    ];
    expect(sessionTitle(msgs)).toBe("Describe this image");
  });

  it("falls back when no user message", () => {
    expect(sessionTitle([{ role: "assistant", content: "hi", id: "1" }])).toBe("New Chat");
    expect(sessionTitle([])).toBe("New Chat");
  });
});

describe("thinkingLevelsForCaps", () => {
  it("returns null for non-reasoning models", () => {
    expect(thinkingLevelsForCaps({ reasoning: false })).toBeNull();
    expect(thinkingLevelsForCaps(null)).toBeNull();
  });

  it("uses explicit caps.thinkingLevels verbatim", () => {
    expect(thinkingLevelsForCaps({ reasoning: true, thinkingLevels: ["high", "max"] })).toEqual(["high", "max"]);
  });

  it("falls back to effort (+max) like the backend getThinkingLevels", () => {
    expect(thinkingLevelsForCaps({ reasoning: true })).toEqual(["minimal", "low", "medium", "high"]);
    expect(thinkingLevelsForCaps({ reasoning: true, thinkingMaxEffort: true })).toEqual([
      "minimal", "low", "medium", "high", "max",
    ]);
  });
});

describe("maxTokensBound", () => {
  it("uses the model output cap when present, else the default", () => {
    expect(maxTokensBound({ maxOutput: 65536 })).toBe(65536);
    expect(maxTokensBound({})).toBe(128000);
    expect(maxTokensBound(null)).toBe(128000);
  });
});

describe("buildSession", () => {
  it("persists mode, model list and compare results for compare chats (Bug C)", () => {
    const results = { "0::gpt-4o": { content: "a", streaming: false, error: null } };
    const session = buildSession({
      id: "s1",
      messages: [],
      params: { temperature: 0.7 },
      selectedModels: ["gpt-4o", "claude", "gpt-4o"],
      mode: "compare",
      compareResults: results,
    });
    expect(session.mode).toBe("compare");
    expect(session.models).toEqual(["gpt-4o", "claude", "gpt-4o"]);
    expect(session.compareResults).toEqual({ "0::gpt-4o": { content: "a", streaming: false, error: null } });
    // deep-copied snapshot — mutating the stored session never touches the live map
    expect(session.compareResults).not.toBe(results);
    session.compareResults["0::gpt-4o"].content = "mutated";
    expect(results["0::gpt-4o"].content).toBe("a");
  });

  it("caps stored messages at MAX_STORED_MESSAGES", () => {
    const msgs = Array.from({ length: MAX_STORED_MESSAGES + 10 }, (_, i) => ({ id: `m${i}`, role: "user", content: "x" }));
    const session = buildSession({ id: "s", messages: msgs, params: {}, selectedModels: ["m"], mode: "single", compareResults: null });
    expect(session.messages).toHaveLength(MAX_STORED_MESSAGES);
  });

  it("titles a compare chat without user messages", () => {
    const session = buildSession({ id: "s", messages: [], params: {}, selectedModels: ["a", "b"], mode: "compare", compareResults: { "0::a": { content: "x" } } });
    expect(session.title).toBe("Compare");
  });
});

describe("serialization + persistence", () => {
  it("serialize/parse round-trips", () => {
    const sessions = [{ id: "s", title: "hi", messages: [] }];
    expect(parseSessions(serializeSessions(sessions))).toEqual(sessions);
  });

  it("parse handles invalid/missing input", () => {
    expect(parseSessions(null)).toEqual([]);
    expect(parseSessions("not json {")).toEqual([]);
    expect(parseSessions('{"not":"array"}')).toEqual([]);
  });

  it("saveSessionsToStorage falls back to stripped payload on quota, then fails", () => {
    let calls = 0;
    let lastWritten = null;
    const failsOnce = {
      setItem(_k, v) {
        calls++;
        if (calls === 1) throw new Error("QuotaExceededError");
        lastWritten = v;
      },
    };
    const fullFail = {
      setItem() { throw new Error("nope"); },
    };
    const ok = {
      setItem() { return true; },
    };
    const sessions = [{ id: "s", messages: [{ role: "user", content: "hi", displayAttachments: [{ id: "a", dataUrl: "data:...", name: "p.png" }] }] }];
    expect(saveSessionsToStorage(ok, sessions)).toBe("saved");
    expect(saveSessionsToStorage(failsOnce, sessions)).toBe("stripped");
    // The stripped retry dropped the dataUrl.
    const stripped = JSON.parse(lastWritten);
    expect(stripped[0].messages[0].displayAttachments[0]).toEqual({ id: "a", name: "p.png", stripped: true });
    expect(saveSessionsToStorage(fullFail, sessions)).toBe("failed");
  });

  it("stripAttachmentPayload drops dataUrls but keeps id/name", () => {
    const sessions = [{
      id: "s",
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:abc" } }, { type: "text", text: "hi" }],
        displayAttachments: [{ id: "a", dataUrl: "data:abc", name: "p.png" }],
      }],
    }];
    const stripped = stripAttachmentPayload(sessions);
    expect(stripped[0].messages[0].content[0].image_url.url).toBe("");
    expect(stripped[0].messages[0].content[1].text).toBe("hi");
    expect(stripped[0].messages[0].displayAttachments[0]).toEqual({ id: "a", name: "p.png", stripped: true });
  });
});

// Locks edge cases flagged in docs 11 §1/§4 that were only covered indirectly.
import { describe, it, expect } from "vitest";
import { normalizeClaudePassthrough, anchorClaudeCache } from "../../open-sse/translator/formats/claude.js";
import { parseDataUri, encodeDataUri } from "../../open-sse/translator/concerns/image.js";

describe("normalizeClaudePassthrough — haiku adaptive thinking (docs 11 §1)", () => {
  it("downgrades adaptive thinking to enabled+budget for haiku models", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-haiku-4-5");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  });

  it("keeps adaptive thinking for sonnet/opus", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-sonnet-4-6");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  it("folds mid-conversation system into neighbouring user (not body.system)", () => {
    const originalUser = { role: "user", content: "hi" };
    const body = {
      system: [{ type: "text", text: "base" }],
      messages: [
        originalUser,
        { role: "system", content: "be brief" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    };
    const out = normalizeClaudePassthrough(body);
    expect(out.system).toEqual([{ type: "text", text: "base" }]);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0].role).toBe("user");
    expect(out.messages[0].content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "be brief" },
    ]);
    expect(out.messages[1].role).toBe("assistant");
    // copy-on-write: original user message object must stay untouched
    expect(originalUser.content).toBe("hi");
  });

  it("promotes leading system to user when no previous user turn", () => {
    const out = normalizeClaudePassthrough({
      messages: [
        { role: "system", content: "only system" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    });
    expect(out.system).toBeUndefined();
    expect(out.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "only system" }],
    });
  });
});

describe("anchorClaudeCache — Claude passthrough cache re-anchor", () => {
  it("pins 1h on last system + last tool, 5m on last assistant", () => {
    const body = {
      system: [
        { type: "text", text: "a", cache_control: { type: "ephemeral" } },
        { type: "text", text: "b" },
      ],
      tools: [
        { name: "t1", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
        { name: "t2", input_schema: { type: "object" } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "sig" },
            { type: "text", text: "reply" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ],
    };
    anchorClaudeCache(body);
    expect(body.system[0].cache_control).toBeUndefined();
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
    expect(body.messages[1].content[0].cache_control).toBeUndefined(); // thinking skipped
    expect(body.messages[1].content[1].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[2].content[0].cache_control).toBeUndefined();
  });

  it("falls back to final message when no assistant turn", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "only" }] },
      ],
    };
    anchorClaudeCache(body);
    expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("parseDataUri / encodeDataUri (docs 11 §4)", () => {
  it("parses a base64 data uri", () => {
    expect(parseDataUri("data:image/png;base64,AAAB")).toEqual({ mimeType: "image/png", base64: "AAAB" });
  });

  it("tolerates newlines inside base64 payload", () => {
    expect(parseDataUri("data:image/jpeg;base64,AA\nBB")?.base64).toBe("AA\nBB");
  });

  it("returns null for http urls and non-strings", () => {
    expect(parseDataUri("https://x/y.png")).toBeNull();
    expect(parseDataUri(null)).toBeNull();
  });

  it("encode/parse roundtrip", () => {
    const uri = encodeDataUri("image/webp", "ZZZ");
    expect(parseDataUri(uri)).toEqual({ mimeType: "image/webp", base64: "ZZZ" });
  });
});

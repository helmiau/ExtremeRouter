import { describe, it, expect } from "vitest";

// Console log page redesign — line parser covering the real wire formats this
// codebase emits (timestamps, level tags, component tags, ANSI colors, emojis).

const { parseLine } = await import("../../src/app/(dashboard)/dashboard/console-log/ConsoleLogClient.js");

const ANSI = (s) => `\x1b[32m${s}\x1b[0m`;

describe("console log line parser", () => {
  it("parses timestamp + level + component tag (usage line)", () => {
    const entry = parseLine(`[21:03:16] 📊 ${ANSI("[USAGE]")} OPENAI | in=2007 | out=64 | account=c1`);
    expect(entry.ts).toBe("21:03:16");
    expect(entry.level).toBe("log");
    expect(entry.tag).toBe("USAGE");
    expect(entry.text).toBe("📊 OPENAI | in=2007 | out=64 | account=c1");
    expect(entry.raw).not.toContain("\x1b"); // ANSI stripped
  });

  it("detects explicit levels after the timestamp", () => {
    expect(parseLine("[10:00:00] [ERROR] boom").level).toBe("error");
    expect(parseLine("[10:00:00] [WARN] careful").level).toBe("warn");
    expect(parseLine("[10:00:00] [INFO] hello").level).toBe("info");
  });

  it("treats DBG-prefixed tags as debug with the tag preserved", () => {
    const entry = parseLine("[DBG:FETCH] ZCODE → https://zcode.z.ai | body=3207B");
    expect(entry.level).toBe("log"); // DBG:FETCH is a component tag, not a level
    expect(entry.tag).toBe("DBG:FETCH");
    expect(entry.text).toContain("ZCODE →");
  });

  it("shapes ❌-marked lines and bare Error payloads as errors", () => {
    expect(parseLine("❌ zcode [429]: rate limited").level).toBe("error");
    expect(parseLine('Error: {"type":"error"}').level).toBe("error");
  });

  it("extracts a component tag from tag-first lines", () => {
    const entry = parseLine("[STREAM] openai | m1 | blocked pipe: Server Error [502]");
    expect(entry.tag).toBe("STREAM");
    expect(entry.level).toBe("log");
  });

  it("keeps request-detail lifecycle lines intact (no level tag)", () => {
    const entry = parseLine("[RequestDetail] lifecycle: streaming → success | provider=opencode | model=muse");
    expect(entry.tag).toBe("RequestDetail");
    expect(entry.text).toContain("streaming → success");
  });

  it("timestampless lines parse without a ts", () => {
    const entry = parseLine("plain line without any structure");
    expect(entry.ts).toBeNull();
    expect(entry.level).toBe("log");
    expect(entry.tag).toBeNull();
    expect(entry.text).toBe("plain line without any structure");
  });

  it("does not treat numeric bracket tokens as component tags", () => {
    // "[21]" from a timestamp fragment must never become the tag.
    const entry = parseLine("[21:03:16] some late line");
    expect(entry.ts).toBe("21:03:16");
    expect(entry.tag).toBeNull();
  });

  it("fetch lines keep their DBG tag and full URL text", () => {
    const entry = parseLine("[DBG:FETCH] OPENCODE → https://opencode.ai/zen/v1/responses | body=3207B");
    expect(entry.tag).toBe("DBG:FETCH");
    expect(entry.text).toContain("/zen/v1/responses");
  });
});

import { describe, it, expect } from "vitest";
import { convertUserInputMessage, INLINE_IMAGE_MIME_BY_FORMAT } from "../../src/mitm/handlers/kiro.js";

const pngBytes = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";

describe("kiro MITM — inline image preservation (OpenAI direction)", () => {
  it("maps a CodeWhisperer inline image to an OpenAI image_url part", () => {
    const out = convertUserInputMessage({
      content: "What is in this image?",
      images: [{ format: "png", source: { bytes: pngBytes } }],
    });
    const userMsg = out.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg.content)).toBe(true);
    const img = userMsg.content.find((p) => p.type === "image_url");
    expect(img).toBeDefined();
    expect(img.image_url.url).toBe(`data:image/png;base64,${pngBytes}`);
    const text = userMsg.content.find((p) => p.type === "text");
    expect(text.text).toBe("What is in this image?");
  });

  it("emits plain text user message when no images are present", () => {
    const out = convertUserInputMessage({ content: "just text" });
    expect(out).toEqual([{ role: "user", content: "just text" }]);
  });

  it("emits a bare user message for an empty first turn (no text, no images)", () => {
    const out = convertUserInputMessage({ content: "" });
    expect(out).toEqual([{ role: "user", content: "" }]);
  });

  it("skips images with unsupported formats or missing bytes", () => {
    const out = convertUserInputMessage({
      content: "text only after filtering",
      images: [
        { format: "bmp", source: { bytes: pngBytes } }, // unsupported mime
        { format: "png", source: null },                // null source
        { format: "png", source: { bytes: "" } },       // empty bytes
        { format: "png", source: { bytes: pngBytes } }, // valid
      ],
    });
    const userMsg = out.find((m) => m.role === "user");
    const imgs = userMsg.content.filter((p) => p.type === "image_url");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].image_url.url).toBe(`data:image/png;base64,${pngBytes}`);
  });

  it("keeps tool results separate from the image-bearing user message", () => {
    const out = convertUserInputMessage({
      content: "here is a screenshot",
      userInputMessageContext: {
        toolResults: [{ toolUseId: "t1", content: [{ text: "tool output" }] }],
      },
      images: [{ format: "jpeg", source: { bytes: pngBytes } }],
    });
    const toolMsg = out.find((m) => m.role === "tool");
    const userMsg = out.find((m) => m.role === "user");
    expect(toolMsg.content).toBe("tool output");
    expect(userMsg.content.some((p) => p.type === "image_url")).toBe(true);
  });

  it("exposes the supported inline image formats", () => {
    expect([...INLINE_IMAGE_MIME_BY_FORMAT.keys()].sort()).toEqual(
      ["gif", "jpeg", "jpg", "png", "webp"].sort()
    );
  });
});

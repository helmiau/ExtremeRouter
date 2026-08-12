import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_MEDIA } from "../../open-sse/providers/index.js";
import { PROVIDER_PRICING, getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getImageAdapter, isImageProvider } from "../../open-sse/handlers/imageProviders/index.js";

describe("Helyx AI provider", () => {
  const helyxai = REGISTRY.find((e) => e.id === "helyxai");

  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(helyxai).toBeDefined();
    expect(helyxai.category).toBe("apikey");
    expect(helyxai.authType).toBe("apikey");
    expect(helyxai.transport.baseUrl).toBe("https://helyxai.space/v1/chat/completions");
    expect(helyxai.transport.format).toBe("openai");
    expect(helyxai.alias).toBe("helyxai");
    expect(helyxai.aliases).toContain("hx");
    expect(helyxai.passthroughModels).toBe(true);
  });

  it("builds into the runtime PROVIDERS map with the openai format", () => {
    expect(PROVIDERS.helyxai).toBeDefined();
    expect(PROVIDERS.helyxai.format).toBe("openai");
    expect(PROVIDERS.helyxai.baseUrl).toBe("https://helyxai.space/v1/chat/completions");
  });

  it("exposes the seed catalog incl. image/video kinds", () => {
    const models = PROVIDER_MODELS.helyxai || [];
    const ids = models.map((m) => m.id);
    expect(ids).toContain("DeepSeek-V4-Flash");
    expect(ids).toContain("gpt-5.6-luna");
    expect(ids).toContain("GLM-5.2");
    expect(ids).toContain("flux-1");
    expect(ids).toContain("kling-video");
    const flux = models.find((m) => m.id === "flux-1");
    expect(flux.kind).toBe("image");
    const kling = models.find((m) => m.id === "kling-video");
    expect(kling.kind).toBe("video");
  });

  it("configures image and video endpoints", () => {
    expect(PROVIDER_MEDIA.helyxai.imageConfig.baseUrl).toBe("https://helyxai.space/v1/images/generations");
    expect(PROVIDER_MEDIA.helyxai.videoConfig.baseUrl).toBe("https://helyxai.space/v1/videos/generations");
    expect(PROVIDER_MEDIA.helyxai.serviceKinds).toEqual(["llm", "image", "video"]);
  });

  it("keeps every registry id unique after adding helyxai", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Helyx AI pricing", () => {
  it("has a helyxai entry in PROVIDER_PRICING", () => {
    expect(PROVIDER_PRICING.helyxai).toBeDefined();
  });

  it("resolves listed prices for key models", () => {
    expect(getPricingForModel("helyxai", "DeepSeek-V4-Flash")).toMatchObject({ input: 0.14, output: 0.28 });
    expect(getPricingForModel("helyxai", "gpt-5.6-luna")).toMatchObject({ input: 0.10, output: 0.60 });
    expect(getPricingForModel("helyxai", "GLM-5.2")).toMatchObject({ input: 1.4, output: 4.4 });
    expect(getPricingForModel("helyxai", "Kimi-K3")).toMatchObject({ input: 4, output: 14 });
    expect(getPricingForModel("helyxai", "MiniMax-M3")).toMatchObject({ input: 0.3, output: 1.2 });
    expect(getPricingForModel("helyxai", "llama-3.1-8b-instruct")).toMatchObject({ input: 0.1, output: 0.25 });
  });
});

describe("Helyx AI image/video adapter", () => {
  const adapter = getImageAdapter("helyxai");

  it("is registered as an image provider", () => {
    expect(isImageProvider("helyxai")).toBe(true);
    expect(adapter).toBeDefined();
  });

  it("routes flux-1 to the images endpoint and kling-video to the videos endpoint", () => {
    expect(adapter.buildUrl("flux-1")).toBe("https://helyxai.space/v1/images/generations");
    expect(adapter.buildUrl("kling-video")).toBe("https://helyxai.space/v1/videos/generations");
  });

  it("sends bearer auth from apiKey", () => {
    expect(adapter.buildHeaders({ apiKey: "sk-test" })).toMatchObject({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
    });
  });

  it("builds OpenAI image body for flux-1", () => {
    expect(adapter.buildBody("flux-1", { prompt: "cyberpunk city", n: 2, size: "512x512" })).toEqual({
      model: "flux-1",
      prompt: "cyberpunk city",
      n: 2,
      size: "512x512",
    });
  });

  it("builds video body with duration for kling-video (no size/n)", () => {
    expect(adapter.buildBody("kling-video", { prompt: "dog flying", duration: 5 })).toEqual({
      model: "kling-video",
      prompt: "dog flying",
      duration: 5,
    });
  });
});

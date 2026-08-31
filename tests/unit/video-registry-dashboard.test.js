/**
 * Registry + dashboard wiring tests for Text-to-Video (Runway, verified contract).
 *
 * Verifies model-level capability granularity: `gen4.5` is the T2V video model
 * while I2V models (gen4_turbo / gen3a_turbo / gen4_image*) are image-pipeline
 * models and never T2V-eligible; the video kind + route exist; Runway advertises
 * the video service and appears in getProvidersByKind("video").
 */
import { describe, it, expect } from "vitest";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";
import { getModelType } from "open-sse/config/providerModels.js";

describe("Text-to-Video registry + dashboard wiring (Runway gen4.5)", () => {
  it("declares the video kind mapped to POST /v1/video/generations", () => {
    const video = MEDIA_PROVIDER_KINDS.find((k) => k.id === "video");
    expect(video).toBeDefined();
    expect(video.label).toBe("Video");
    expect(video.endpoint).toEqual({ method: "POST", path: "/v1/video/generations" });
  });

  it("Runway advertises the video service and carries a videoConfig", () => {
    expect(AI_PROVIDERS.runwayml.serviceKinds).toContain("video");
    expect(AI_PROVIDERS.runwayml.videoConfig?.baseUrl).toContain("runwayml.com");
  });

  it("Runway appears in getProvidersByKind('video')", () => {
    const ids = getProvidersByKind("video").map((p) => p.id);
    expect(ids).toContain("runwayml");
    // Image-only providers must NOT leak into the video list.
    expect(ids).not.toContain("black-forest-labs");
  });

  it("only gen4.5 is classified as a T2V (kind=video) model", () => {
    expect(getModelType("runwayml", "gen4.5")).toBe("video");
    // I2V / image models are kind=image and therefore never T2V-eligible.
    expect(getModelType("runwayml", "gen4_turbo")).toBe("image");
    expect(getModelType("runwayml", "gen3a_turbo")).toBe("image");
    expect(getModelType("runwayml", "gen4_image")).toBe("image");
    expect(getModelType("runwayml", "gen4_image_turbo")).toBe("image");
    // The provider still supports both services.
    expect(AI_PROVIDERS.runwayml.serviceKinds.sort()).toEqual(["image", "video"]);
  });
});
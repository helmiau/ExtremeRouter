/**
 * Registry + dashboard wiring tests for Text-to-Video.
 *
 * Verifies model-level capability granularity: the `video` kind + `/v1/video/generations`
 * route exist, Runway advertises the video service, its video models are `kind: video`
 * while image models stay image-only, and `getProvidersByKind("video")` surfaces Runway.
 */
import { describe, it, expect } from "vitest";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";
import { getModelType } from "open-sse/config/providerModels.js";

describe("Text-to-Video registry + dashboard wiring", () => {
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

  it("video models are kind=video and image models stay image-only (model-level gate)", () => {
    expect(getModelType("runwayml", "gen4_turbo")).toBe("video");
    expect(getModelType("runwayml", "gen3a_turbo")).toBe("video");
    expect(getModelType("runwayml", "gen4_image")).toBe("image");
    expect(AI_PROVIDERS.runwayml.serviceKinds).toContain("image");
  });
});
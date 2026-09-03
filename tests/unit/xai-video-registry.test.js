import { describe, it, expect } from "vitest";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";
import { getModelType } from "open-sse/config/providerModels.js";
import { getVideoAdapter } from "open-sse/handlers/videoProviders/index.js";

const MODEL = "grok-imagine-video-1.5";

describe("xAI video registry and dashboard metadata", () => {
  it("declares only Grok Imagine Video 1.5 as the xAI video model", () => {
    expect(getModelType("xai", MODEL)).toBe("video");
    expect(getModelType("xai", "grok-4.6")).not.toBe("video");
    expect(getModelType("xai", "grok-imagine-image-2.0")).not.toBe("video");
  });

  it("advertises xAI under video with the verified endpoint metadata", () => {
    expect(AI_PROVIDERS.xai.serviceKinds).toContain("video");
    expect(AI_PROVIDERS.xai.videoConfig).toMatchObject({
      baseUrl: "https://api.x.ai/v1/videos",
      bodyFields: expect.arrayContaining(["model", "prompt", "duration", "aspect_ratio", "resolution"]),
    });
    expect(getProvidersByKind("video").map((provider) => provider.id)).toContain("xai");
  });

  it("registers the xAI adapter without changing the existing provider auth model", () => {
    expect(getVideoAdapter("xai")).toBeTruthy();
    expect(AI_PROVIDERS.xai.authModes).toEqual(["oauth", "apikey"]);
  });
});

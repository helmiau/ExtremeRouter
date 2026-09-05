import { describe, it, expect } from "vitest";
import { isMuseSparkModel } from "../../open-sse/providers/models/helpers.js";

describe("isMuseSparkModel", () => {
  it("matches the registered opencode free Muse Spark variants", () => {
    expect(isMuseSparkModel("muse-spark-1.2-contributor-free")).toBe(true);
    expect(isMuseSparkModel("muse-spark-1.3-contributor-free")).toBe(true);
    expect(isMuseSparkModel("muse-spark-1.1-contributor-free")).toBe(true);
  });

  it("matches vendor-prefixed ids and trailing tier presets", () => {
    expect(isMuseSparkModel("oc/muse-spark-1.3-contributor-free")).toBe(true);
    expect(isMuseSparkModel("muse-spark-1.2-contributor-free(high)")).toBe(true);
  });

  it("rejects non-Muse-Spark ids and empty input", () => {
    // isMuseSparkModel is provider-agnostic: it matches the whole family including
    // the meta-ai web-bridge (-web) — the EXECUTOR scopes it to opencode only.
    expect(isMuseSparkModel("laguna-s-2.1-free")).toBe(false);
    expect(isMuseSparkModel("gpt-5")).toBe(false);
    expect(isMuseSparkModel(null)).toBe(false);
    expect(isMuseSparkModel("")).toBe(false);
  });

  it("matches the web-bridge variant (provider scoping is the executor's job)", () => {
    expect(isMuseSparkModel("muse-spark-web")).toBe(true);
  });
});

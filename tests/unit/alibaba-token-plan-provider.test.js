import { describe, it, expect } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { getProviderIconPath } from "../../src/shared/utils/providerIcon.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));

describe("Alibaba Token Plan (alitp-intl)", () => {
  const entry = REGISTRY.find((e) => e.id === "alitp-intl");

  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(PROVIDERS["alitp-intl"]).toBeDefined();
    expect(PROVIDERS["alitp-intl"].format).toBe("openai");
  });

  it("targets Singapore Token Plan host in compatible mode", () => {
    // eu-central-1 answers IllegalEndpoint; plan is Singapore-only.
    expect(PROVIDERS["alitp-intl"].baseUrl).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
  });

  it("uses a distinct Token Plan host from Coding Plan / Model Studio / Qwen Cloud", () => {
    // alibaba + qwen-cloud intentionally share dashscope-intl (same product surface).
    // Token Plan must NOT share a host with any of them — keys are mutually exclusive.
    const tokenHost = new URL(PROVIDERS["alitp-intl"].baseUrl).host;
    expect(tokenHost).toBe("token-plan.ap-southeast-1.maas.aliyuncs.com");

    for (const id of ["alicode", "alicode-intl", "alibaba", "alibaba-cn", "qwen-cloud"]) {
      expect(new URL(PROVIDERS[id].baseUrl).host).not.toBe(tokenHost);
    }
  });

  it("exposes models the plan actually serves", () => {
    const ids = (PROVIDER_MODELS["atp"] || PROVIDER_MODELS["alitp-intl"] || []).map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "qwen3.8-max-preview",
        "qwen3.7-max",
        "qwen3.7-plus",
        "qwen3.6-flash",
        "glm-5.2",
        "deepseek-v4-pro",
      ]),
    );
  });

  it("routes legacy qwen-cloud-token-plan alias to alitp-intl (not qwen-cloud)", () => {
    expect(resolveProviderAlias("qwen-cloud-token-plan")).toBe("alitp-intl");
    expect(resolveProviderAlias("token-plan")).toBe("alitp-intl");
    expect(resolveProviderAlias("atp")).toBe("alitp-intl");
    // DashScope intl stays on its own id.
    expect(resolveProviderAlias("qwen-cloud")).toBe("qwen-cloud");
    expect(resolveProviderAlias("qwc")).toBe("qwen-cloud");
  });

  it("keeps registry ids unique after adding the provider", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ships a brand icon under public/providers", () => {
    const icon = getProviderIconPath("alitp-intl");
    expect(icon).toBe("/providers/alitp-intl.svg");
    expect(fs.existsSync(path.join(PUBLIC_DIR, icon.slice(1)))).toBe(true);
  });
});

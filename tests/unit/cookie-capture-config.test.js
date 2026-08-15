import { describe, it, expect } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { COOKIE_CAPTURE } from "../../src/shared/constants/cookieCapture.js";

const registryById = Object.fromEntries(REGISTRY.map((p) => [p.id, p]));

describe("COOKIE_CAPTURE metadata", () => {
  it("every entry is a registered webCookie provider", () => {
    for (const id of Object.keys(COOKIE_CAPTURE)) {
      const entry = registryById[id];
      expect(entry, `${id} should exist in registry`).toBeDefined();
      expect(entry.category === "webCookie" || entry.authType === "cookie", `${id} should be cookie-based`).toBe(true);
    }
  });

  it("every entry has a label, domains and at least one extraction method", () => {
    for (const [id, cfg] of Object.entries(COOKIE_CAPTURE)) {
      expect(cfg.label, `${id} label`).toBeTruthy();
      expect(Array.isArray(cfg.domains) && cfg.domains.length > 0, `${id} domains`).toBe(true);
      const hasExtraction =
        (cfg.cookies?.length > 0) || cfg.fullCookieHeader || (cfg.localStorage?.length > 0) || cfg.authorization;
      expect(hasExtraction, `${id} extraction method`).toBe(true);
    }
  });

  it("felo-web stays on its own dedicated capture (not in the generic map)", () => {
    expect(COOKIE_CAPTURE["felo-web"]).toBeUndefined();
  });
});

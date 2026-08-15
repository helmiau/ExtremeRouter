// Validates the provider info-badge metadata (deep-research classification of
// webCookie caveats) against the registry: badge entries must reference valid
// Badge variants/icons, and every webCookie provider must be classified (badge
// or documented "no badge" decision).

import { describe, it, expect } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import {
  PROVIDER_INFO_BADGES,
  PROVIDER_INFO_BADGE_DECISIONS,
} from "../../src/shared/constants/providerInfoBadges.js";

const VALID_VARIANTS = ["default", "primary", "success", "warning", "error", "info", "cyan"];
const VALID_ICON_PATTERN = /^[a-z0-9_]+$/; // material-symbols name

const webCookieIds = REGISTRY.filter((p) => p.category === "webCookie").map((p) => p.id);

describe("PROVIDER_INFO_BADGES metadata", () => {
  it("only references real webCookie providers", () => {
    const unknown = Object.keys(PROVIDER_INFO_BADGES).filter((id) => !webCookieIds.includes(id));
    expect(unknown).toEqual([]);
  });

  it("every badge entry has a label, a valid variant, an icon name and a tooltip", () => {
    const problems = [];
    for (const [providerId, badges] of Object.entries(PROVIDER_INFO_BADGES)) {
      if (!Array.isArray(badges) || badges.length === 0) {
        problems.push(`${providerId}: not a non-empty array`);
        continue;
      }
      for (const badge of badges) {
        if (typeof badge.label !== "string" || !badge.label.trim()) {
          problems.push(`${providerId}: missing label`);
        }
        if (!VALID_VARIANTS.includes(badge.variant)) {
          problems.push(`${providerId}: invalid variant "${badge.variant}"`);
        }
        if (typeof badge.icon !== "string" || !VALID_ICON_PATTERN.test(badge.icon)) {
          problems.push(`${providerId}: invalid icon "${badge.icon}"`);
        }
        if (typeof badge.title !== "string" || !badge.title.trim()) {
          problems.push(`${providerId}: missing title`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("classifies every webCookie provider (badge or documented decision)", () => {
    const classified = new Set([
      ...Object.keys(PROVIDER_INFO_BADGES),
      ...Object.keys(PROVIDER_INFO_BADGE_DECISIONS),
    ]);
    const unclassified = webCookieIds.filter((id) => !classified.has(id));
    expect(unclassified).toEqual([]);
  });
});

// Pure-helper tests for the zai-web browser transport. Browser-driving code
// itself is covered by the live E2E verification; these lock in the guest
// detection and name mapping logic.

import { describe, it, expect } from "vitest";
import {
  isZaiGuestToken,
  zaiGuestHint,
  browserModelName,
  tokenPoolKey,
} from "../../open-sse/services/zaiBrowserTransport.js";

const GUEST_TOKEN = `e30.${Buffer.from(
  JSON.stringify({ id: "u-1", email: "guest-1786799164504@guest.com" })
).toString("base64url")}.sig`;

const REAL_TOKEN = `e30.${Buffer.from(
  JSON.stringify({ id: "u-1", email: "someone@example.com" })
).toString("base64url")}.sig`;

describe("isZaiGuestToken", () => {
  it("detects guest sessions by email suffix", () => {
    expect(isZaiGuestToken(GUEST_TOKEN)).toBe(true);
  });

  it("detects guest sessions by role claim", () => {
    const roleToken = `e30.${Buffer.from(JSON.stringify({ id: "u-1", role: "guest" })).toString("base64url")}.sig`;
    expect(isZaiGuestToken(roleToken)).toBe(true);
  });

  it("does not flag real accounts or junk input", () => {
    expect(isZaiGuestToken(REAL_TOKEN)).toBe(false);
    expect(isZaiGuestToken("not-a-jwt")).toBe(false);
    expect(isZaiGuestToken("")).toBe(false);
  });
});

describe("zaiGuestHint", () => {
  it("tells guests to sign in and re-capture the token", () => {
    expect(zaiGuestHint(GUEST_TOKEN)).toMatch(/guest session/);
    expect(zaiGuestHint(GUEST_TOKEN)).toMatch(/GLM-4.7/);
  });

  it("gives a generic sign-in hint for real accounts", () => {
    expect(zaiGuestHint(REAL_TOKEN)).toMatch(/Sign in/);
    expect(zaiGuestHint(REAL_TOKEN)).not.toMatch(/guest session/);
  });
});

describe("browserModelName", () => {
  it("maps API ids to picker display names", () => {
    expect(browserModelName("glm-5.2")).toBe("GLM-5.2");
    expect(browserModelName("zw/glm-5.2")).toBe("GLM-5.2");
    expect(browserModelName("glm-5v-turbo")).toBe("GLM-5V-Turbo");
    expect(browserModelName("glm-5.1")).toBe("glm-5.1");
  });
});

describe("tokenPoolKey", () => {
  it("is a stable, bounded hash per token", () => {
    expect(tokenPoolKey("token-a")).toBe(tokenPoolKey("token-a"));
    expect(tokenPoolKey("token-a")).not.toBe(tokenPoolKey("token-b"));
    expect(tokenPoolKey("token-a").length).toBe(24);
  });
});

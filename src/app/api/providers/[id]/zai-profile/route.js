import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { extractZaiToken } from "open-sse/executors/zai-web.js";

const ZAI_SETTINGS_URL = "https://chat.z.ai/api/v1/users/user/settings";
const FETCH_TIMEOUT_MS = 8000;

// Decode the z.ai JWT payload (id + email ride in the token itself — same
// claims the signed completion URL uses). Never verifies the signature; the
// live settings check below is what proves the session is still valid.
function decodeZaiJwt(token) {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) || {};
  } catch {
    return {};
  }
}

// GET /api/providers/[id]/zai-profile
//
// Badge info for the connected Z.ai web session, following the same pattern as
// felo-profile / freebuff-profile: derive identity from the token + do a live
// session check against the authenticated settings endpoint (the same one the
// validate route uses). Guests (guest-…@guest.com) are surfaced so the badge
// can warn that chat.z.ai only allows GLM-4.7 for them.
export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const token = extractZaiToken(connection.apiKey || "");
    if (!token) {
      return NextResponse.json(
        {
          error: "no_token",
          message:
            'No Z.ai token found — copy the "token" value from chat.z.ai Local Storage (DevTools → Application → Local Storage → chat.z.ai).',
        },
        { status: 400 },
      );
    }

    const claims = decodeZaiJwt(token);
    const email = typeof claims.email === "string" ? claims.email : "";
    const isGuest = claims.role === "guest" || /@guest\.com$/i.test(email);

    // Live session check — 401/403 means the stored token no longer authenticates.
    let sessionOk = true;
    let name = "";
    let image = "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Z.ai profile fetch timed out")), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(ZAI_SETTINGS_URL, {
        method: "GET",
        headers: {
          Accept: "application/json, text/plain, */*",
          Authorization: `Bearer ${token}`,
          Origin: "https://chat.z.ai",
          Referer: "https://chat.z.ai/",
        },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        sessionOk = false;
      } else if (res.ok) {
        const json = await res.json().catch(() => ({}));
        const user = json?.data?.user || json?.user || json?.data || {};
        if (typeof user.name === "string" && user.name.trim()) name = user.name.trim();
        if (typeof user.avatar === "string" && user.avatar) image = user.avatar;
        if (!image && typeof user.picture === "string" && user.picture) image = user.picture;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!sessionOk) {
      return NextResponse.json(
        {
          error: "session_expired",
          message:
            "Z.ai session invalid or expired — sign in at chat.z.ai and re-capture the token from Local Storage (DevTools → Application → Local Storage → chat.z.ai).",
        },
        { status: 401 },
      );
    }

    return NextResponse.json({
      name: name || (email ? email.split("@")[0] : "Z.ai user"),
      email,
      image,
      isGuest,
      id: typeof claims.id === "string" ? claims.id : "",
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      return NextResponse.json({ error: "Z.ai profile fetch timed out" }, { status: 504 });
    }
    return NextResponse.json({ error: err?.message || "Failed to fetch profile" }, { status: 500 });
  }
}

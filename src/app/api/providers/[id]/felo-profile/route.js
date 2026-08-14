import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { parseFeloCredential, FELO_USER_INFO_URL } from "open-sse/executors/felo-web.js";

const FETCH_TIMEOUT_MS = 8000;

// GET /api/providers/[id]/felo-profile
//
// Fetches the Felo user profile (name, email, avatar, uid) by calling
// /api-proxy/ext/user/info. The endpoint authenticates the ACCOUNT via the
// session credentials (felo-user-token cookie or `authorization: Bearer 6h_...`
// header) — the Turnstile cf_token alone is NOT accepted (it only gates thread
// creation). So the badge appears once the user pastes full credentials:
// cf_token (chat) + cookie/bearer (account identity).
export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const { cfToken, bearer, cookie } = parseFeloCredential(connection.apiKey || "");

    // Account identity comes from the session cookie/bearer, not cf_token.
    if (!bearer && !cookie) {
      return NextResponse.json(
        {
          error: "session_required",
          message:
            "Profile needs your Felo session cookie/bearer — paste the full Cookie header (DevTools → Network → any request) or the `authorization` Bearer token. `cf_token` alone is not enough.",
        },
        { status: 400 },
      );
    }

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      Accept: "application/json",
    };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (cookie) headers.Cookie = cookie;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Felo profile fetch timed out")), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(FELO_USER_INFO_URL, { method: "GET", headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 401 || res.status === 403) {
      return NextResponse.json(
        {
          error: "session_expired",
          message: "Felo session expired — re-copy the full Cookie header / Bearer token from felo.ai DevTools.",
        },
        { status: 401 },
      );
    }
    if (!res.ok) {
      return NextResponse.json({ error: `Felo returned ${res.status}` }, { status: res.status });
    }

    const json = await res.json();
    const d = json?.data;
    if (!d) {
      return NextResponse.json({ error: "No user data" }, { status: 401 });
    }

    return NextResponse.json({
      name: d.name || d.email?.split("@")[0] || `User ${d.uid}`,
      email: d.email || "",
      image: d.picture || "",
      uid: d.uid || "",
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      return NextResponse.json({ error: "Felo profile fetch timed out" }, { status: 504 });
    }
    return NextResponse.json({ error: err?.message || "Failed to fetch profile" }, { status: 500 });
  }
}

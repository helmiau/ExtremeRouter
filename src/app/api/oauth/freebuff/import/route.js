import { NextResponse } from "next/server";
import os from "os";
import path from "path";
import fs from "fs";
import { exchangeTokens } from "@/lib/oauth/providers";
import { createProviderConnection } from "@/models";

/**
 * Freebuff (Account) import — authToken from the Freebuff CLI credentials file.
 *
 * The Freebuff CLI stores its session at:
 *   Windows:  %USERPROFILE%\.config\manicode\credentials.json
 *   Linux/OS: ~/.config/manicode/credentials.json
 * with the token under the `authToken` key. The same token is shown after
 * login at https://freebuff.llm.pm.
 */

function credentialsPath() {
  return path.join(os.homedir(), ".config", "manicode", "credentials.json");
}

function readAuthToken() {
  try {
    const raw = fs.readFileSync(credentialsPath(), "utf8");
    const data = JSON.parse(raw);
    const token = typeof data?.authToken === "string" ? data.authToken.trim() : "";
    if (!token) return { tokenFound: false, error: "credentials.json exists but has no authToken field" };
    return { tokenFound: true, token };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { tokenFound: false, error: "Freebuff CLI credentials not found. Install the CLI (npm i -g freebuff), log in once, or copy your token from freebuff.llm.pm." };
    }
    return { tokenFound: false, error: `Failed to read Freebuff CLI credentials: ${err.message}` };
  }
}

/**
 * GET /api/oauth/freebuff/import
 * Auto-detect the Freebuff authToken from the CLI credentials file.
 */
export async function GET() {
  return NextResponse.json({
    provider: "freebuff",
    method: "import_token",
    credentialsPath: credentialsPath(),
    ...readAuthToken(),
  });
}

/**
 * POST /api/oauth/freebuff/import
 * Validate an authToken against the codebuff.com session endpoint and persist
 * the connection.
 *
 * Request body: { authToken: string }
 */
export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid or empty request body" }, { status: 400 });
    }
    const token = String(body?.authToken || "").trim();
    if (!token) {
      return NextResponse.json({ error: "authToken is required" }, { status: 400 });
    }

    // Validate via the same session check the paste flow uses, then map to
    // connection fields (accessToken, expiresIn, providerSpecificData, …).
    const mapped = await exchangeTokens("freebuff", token);

    const connection = await createProviderConnection({
      provider: "freebuff",
      authType: "oauth",
      ...mapped,
      expiresAt: mapped.expiresIn
        ? new Date(Date.now() + mapped.expiresIn * 1000).toISOString()
        : null,
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    console.log("Freebuff import error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

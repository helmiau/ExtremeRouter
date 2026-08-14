"use server";

import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import {
  checkBinaryInstalled,
  readJsonTolerant,
  writeJsonFile,
  mkdirp,
  ensureSuffix,
  settingsError,
} from "@/lib/cliTools";

const getDataDir = () => path.join(os.homedir(), ".local", "share", "kilo");
const getAuthPath = () => path.join(getDataDir(), "auth.json");
const getVscodeSettingsPath = () => path.join(os.homedir(), ".config", "Code", "User", "settings.json");

const checkInstalled = () =>
  checkBinaryInstalled({ binary: "kilo", configPaths: [getAuthPath()] });

const readJson = (filePath) => readJsonTolerant(filePath);

const hasExtremeRouterConfig = (auth) => {
  if (!auth) return false;
  const entry = auth["openai-compatible"] || auth["@rsalmn/extremerouter"];
  if (!entry) return false;
  const baseUrl = entry.baseUrl || entry.baseURL || "";
  return baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("@rsalmn/extremerouter");
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Kilo Code CLI is not installed" });
    }
    const auth = await readJson(getAuthPath());
    return NextResponse.json({
      installed: true,
      settings: { auth: auth ? Object.keys(auth) : [] },
      hasExtremeRouter: hasExtremeRouterConfig(auth),
      authPath: getAuthPath(),
    });
  } catch (error) {
    return settingsError("Error checking kilo settings", error, "Failed to check kilo settings");
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !apiKey || !model) {
      return NextResponse.json({ error: "baseUrl, apiKey and model are required" }, { status: 400 });
    }

    await mkdirp(getDataDir());

    const normalizedBaseUrl = ensureSuffix(baseUrl, "/v1");

    const auth = (await readJson(getAuthPath())) || {};
    auth["openai-compatible"] = {
      type: "api-key",
      apiKey,
      baseUrl: normalizedBaseUrl,
      model,
    };
    await writeJsonFile(getAuthPath(), auth);

    // Best-effort: update VS Code extension settings
    try {
      const vscode = (await readJson(getVscodeSettingsPath())) || {};
      vscode["kilocode.customProvider"] = { name: "ExtremeRouter", baseURL: normalizedBaseUrl, apiKey };
      vscode["kilocode.defaultModel"] = model;
      await writeJsonFile(getVscodeSettingsPath(), vscode);
    } catch { /* VS Code settings not writable */ }

    return NextResponse.json({ success: true, message: "Kilo Code settings applied successfully!", authPath: getAuthPath() });
  } catch (error) {
    return settingsError("Error updating kilo settings", error, "Failed to update kilo settings");
  }
}

export async function DELETE() {
  try {
    const auth = await readJson(getAuthPath());
    if (!auth) {
      return NextResponse.json({ success: true, message: "No settings file to reset" });
    }
    delete auth["openai-compatible"];
    delete auth["@rsalmn/extremerouter"];
    await writeJsonFile(getAuthPath(), auth);

    try {
      const vscode = await readJson(getVscodeSettingsPath());
      if (vscode) {
        delete vscode["kilocode.customProvider"];
        delete vscode["kilocode.defaultModel"];
        await writeJsonFile(getVscodeSettingsPath(), vscode);
      }
    } catch { /* ignore */ }

    return NextResponse.json({ success: true, message: "ExtremeRouter settings removed from Kilo Code" });
  } catch (error) {
    return settingsError("Error resetting kilo settings", error, "Failed to reset kilo settings");
  }
}

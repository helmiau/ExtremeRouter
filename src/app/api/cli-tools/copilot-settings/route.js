"use server";

import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import {
  readJsonTolerant,
  readTextFile,
  writeJsonFile,
  mkdirp,
  settingsError,
} from "@/lib/cliTools";

// Resolve chatLanguageModels.json path per OS
const getConfigPath = () => {
  const home = os.homedir();
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(process.env.APPDATA || home, "Code", "User", "chatLanguageModels.json");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "chatLanguageModels.json");
  }
  return path.join(home, ".config", "Code", "User", "chatLanguageModels.json");
};

const readConfig = () => readJsonTolerant(getConfigPath());

const hasExtremeRouterConfig = (config) => {
  if (!Array.isArray(config)) return false;
  return config.some((entry) => entry.name === "ExtremeRouter");
};

const getExtremeRouterEntry = (config) => {
  if (!Array.isArray(config)) return null;
  return config.find((entry) => entry.name === "ExtremeRouter") || null;
};

// GET - Read current copilot config
export async function GET() {
  try {
    const config = await readConfig();
    const entry = getExtremeRouterEntry(config);

    return NextResponse.json({
      installed: true,
      config,
      hasExtremeRouter: hasExtremeRouterConfig(config),
      configPath: getConfigPath(),
      currentModel: entry?.models?.[0]?.id || null,
      currentUrl: entry?.models?.[0]?.url || null,
    });
  } catch (error) {
    return settingsError("Error checking copilot settings", error, "Failed to check copilot settings");
  }
}

// POST - Apply ExtremeRouter config to chatLanguageModels.json
export async function POST(request) {
  try {
    const { baseUrl, apiKey, models } = await request.json();

    if (!baseUrl || !models?.length) {
      return NextResponse.json({ error: "baseUrl and models are required" }, { status: 400 });
    }

    const configPath = getConfigPath();
    await mkdirp(path.dirname(configPath));

    // Read existing config array
    let config = [];
    const existing = await readJsonTolerant(configPath);
    if (Array.isArray(existing)) config = existing;

    const endpointUrl = `${baseUrl}/chat/completions#models.ai.azure.com`;
    const keyToUse = apiKey || "sk_extremerouter";

    const newEntry = {
      name: "ExtremeRouter",
      vendor: "azure",
      apiKey: keyToUse,
      models: models.map((id) => ({
        id,
        name: id,
        url: endpointUrl,
        toolCalling: true,
        vision: false,
        maxInputTokens: 128000,
        maxOutputTokens: 16000,
      })),
    };

    // Replace existing ExtremeRouter entry or append
    const idx = config.findIndex((e) => e.name === "ExtremeRouter");
    if (idx >= 0) {
      config[idx] = newEntry;
    } else {
      config.push(newEntry);
    }

    await writeJsonFile(configPath, config);

    return NextResponse.json({
      success: true,
      message: "Copilot settings applied! Reload VS Code to take effect.",
      configPath,
    });
  } catch (error) {
    return settingsError("Error updating copilot settings", error, "Failed to update copilot settings");
  }
}

// DELETE - Remove ExtremeRouter entry from chatLanguageModels.json
export async function DELETE() {
  try {
    const configPath = getConfigPath();

    // Distinguish "no file" (clean reset message) from other read errors.
    if ((await readTextFile(configPath, null)) === null) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    let config = [];
    const existing = await readJsonTolerant(configPath);
    if (Array.isArray(existing)) config = existing;

    config = config.filter((e) => e.name !== "ExtremeRouter");
    await writeJsonFile(configPath, config);

    return NextResponse.json({
      success: true,
      message: "ExtremeRouter removed from Copilot config",
    });
  } catch (error) {
    return settingsError("Error resetting copilot settings", error, "Failed to reset copilot settings");
  }
}

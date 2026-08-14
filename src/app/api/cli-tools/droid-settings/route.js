"use server";

import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import {
  checkBinaryInstalled,
  readJsonTolerant,
  readTextFile,
  writeJsonFile,
  mkdirp,
  ensureSuffix,
  settingsError,
} from "@/lib/cliTools";

const getDroidDir = () => path.join(os.homedir(), ".factory");
const getDroidSettingsPath = () => path.join(getDroidDir(), "settings.json");

// Check if droid CLI is installed (via which/where or config file exists)
const checkDroidInstalled = () =>
  checkBinaryInstalled({ binary: "droid", configPaths: [getDroidSettingsPath()] });

// Read current settings.json (tolerates JSONC)
const readSettings = () => readJsonTolerant(getDroidSettingsPath());

// Check if settings has ExtremeRouter customModels
const hasExtremeRouterConfig = (settings) => {
  if (!settings || !settings.customModels) return false;
  return settings.customModels.some(m => m.id?.startsWith("custom:ExtremeRouter"));
};

// GET - Check droid CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkDroidInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Factory Droid CLI is not installed",
      });
    }

    const settings = await readSettings();

    return NextResponse.json({
      installed: true,
      settings,
      hasExtremeRouter: hasExtremeRouterConfig(settings),
      settingsPath: getDroidSettingsPath(),
    });
  } catch (error) {
    return settingsError("Error checking droid settings", error, "Failed to check droid settings");
  }
}

// POST - Update ExtremeRouter customModels (merge with existing settings)
// Accepts either `model` (string, legacy single-model) or `models` (array of strings, multi-model)
// Also accepts `activeModel` to set which model is active/primary
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, activeModel } = await request.json();

    // Accept either `models` (array) or `model` (string, legacy)
    const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);

    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const droidDir = getDroidDir();
    const settingsPath = getDroidSettingsPath();

    // Ensure directory exists
    await mkdirp(droidDir);

    // Read existing settings or create new (tolerates JSONC)
    const settings = (await readSettings()) || {};

    // Ensure customModels array exists
    if (!settings.customModels) {
      settings.customModels = [];
    }

    // Remove all existing ExtremeRouter configs
    settings.customModels = settings.customModels.filter(m => !m.id?.startsWith("custom:ExtremeRouter"));

    // Normalize baseUrl to ensure /v1 suffix
    const normalizedBaseUrl = ensureSuffix(baseUrl, "/v1");
    const keyToUse = apiKey || "your_api_key";

    // Determine active model: prefer explicit activeModel, else first of modelsArray
    // If activeModel is explicitly empty string, no model will be set as default
    let defaultIndex = 0;
    if (typeof activeModel === "string") {
      if (activeModel === "") {
        defaultIndex = -1; // signal: don't set a default
      } else {
        const idx = modelsArray.indexOf(activeModel);
        defaultIndex = idx >= 0 ? idx : 0;
      }
    }

    // Add entries for all requested models
    // The first one (index 0) will be the default if defaultIndex >= 0
    for (let i = 0; i < modelsArray.length; i++) {
      const m = modelsArray[i];
      if (!m || typeof m !== "string") continue;
      settings.customModels.push({
        model: m,
        id: `custom:ExtremeRouter-${i}`,
        index: i,
        baseUrl: normalizedBaseUrl,
        apiKey: keyToUse,
        displayName: m,
        maxOutputTokens: 131072,
        noImageSupport: false,
        provider: "openai",
      });
    }

    // Set default model if applicable
    if (defaultIndex >= 0 && settings.customModels[defaultIndex]) {
      // Reorder so the default comes first
      const [defaultEntry] = settings.customModels.splice(defaultIndex, 1);
      settings.customModels.unshift({ ...defaultEntry, index: 0 });
      // Re-index the rest
      settings.customModels.forEach((m, i) => { m.index = i; });
    }

    // Write settings
    await writeJsonFile(settingsPath, settings);

    return NextResponse.json({
      success: true,
      message: "Factory Droid settings applied successfully!",
      settingsPath,
    });
  } catch (error) {
    return settingsError("Error updating droid settings", error, "Failed to update droid settings");
  }
}

// DELETE - Remove ExtremeRouter customModels only (keep other settings)
export async function DELETE() {
  try {
    const settingsPath = getDroidSettingsPath();

    // Distinguish "no file" (clean reset message) from other read errors.
    if ((await readTextFile(settingsPath, null)) === null) {
      return NextResponse.json({
        success: true,
        message: "No settings file to reset",
      });
    }

    // Read existing settings (tolerates JSONC)
    const settings = (await readSettings()) || {};

    // Remove ExtremeRouter customModels
    if (settings.customModels) {
      settings.customModels = settings.customModels.filter(m => !m.id?.startsWith("custom:ExtremeRouter"));

      // Remove customModels array if empty
      if (settings.customModels.length === 0) {
        delete settings.customModels;
      }
    }

    // Write updated settings
    await writeJsonFile(settingsPath, settings);

    return NextResponse.json({
      success: true,
      message: "ExtremeRouter settings removed successfully",
    });
  } catch (error) {
    return settingsError("Error resetting droid settings", error, "Failed to reset droid settings");
  }
}

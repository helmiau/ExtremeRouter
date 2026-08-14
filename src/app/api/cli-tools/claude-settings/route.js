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

// Get claude settings path based on OS
const getClaudeSettingsPath = () => path.join(os.homedir(), ".claude", "settings.json");

// Check if claude CLI is installed (via which/where or config file exists)
const checkClaudeInstalled = () =>
  checkBinaryInstalled({ binary: "claude", configPaths: [getClaudeSettingsPath()] });

// Read current settings (tolerates JSONC trailing commas/comments)
const readSettings = () => readJsonTolerant(getClaudeSettingsPath());

// GET - Check claude CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkClaudeInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Claude CLI is not installed",
      });
    }

    const settings = await readSettings();
    const hasExtremeRouter = !!(settings?.env?.ANTHROPIC_BASE_URL);

    return NextResponse.json({
      installed: true,
      settings: settings,
      hasExtremeRouter: hasExtremeRouter,
      settingsPath: getClaudeSettingsPath(),
    });
  } catch (error) {
    return settingsError("Error checking claude settings", error, "Failed to check claude settings");
  }
}

// POST - Backup old fields and write new settings
export async function POST(request) {
  try {
    const { env } = await request.json();

    if (!env || typeof env !== "object") {
      return NextResponse.json(
        { error: "Invalid env object" },
        { status: 400 }
      );
    }

    const settingsPath = getClaudeSettingsPath();
    const claudeDir = path.dirname(settingsPath);

    // Ensure .claude directory exists
    await mkdirp(claudeDir);

    // Read current settings (tolerates JSONC trailing commas/comments)
    const currentSettings = (await readSettings()) || {};

    // Normalize ANTHROPIC_BASE_URL to ensure /v1 suffix
    if (env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = ensureSuffix(env.ANTHROPIC_BASE_URL, "/v1");
    }

    // Merge new env with existing settings
    const newSettings = {
      ...currentSettings,
      hasCompletedOnboarding: true,
      env: {
        ...(currentSettings.env || {}),
        ...env,
      },
    };

    // Write new settings
    await writeJsonFile(settingsPath, newSettings);

    return NextResponse.json({
      success: true,
      message: "Settings updated successfully",
    });
  } catch (error) {
    return settingsError("Error updating claude settings", error, "Failed to update claude settings");
  }
}

// Fields to remove when resetting
const RESET_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "API_TIMEOUT_MS",
];

// DELETE - Reset settings (remove env fields)
export async function DELETE() {
  try {
    const settingsPath = getClaudeSettingsPath();

    // Read current settings (tolerates JSONC trailing commas/comments)
    if ((await readTextFile(settingsPath, null)) === null) {
      return NextResponse.json({
        success: true,
        message: "No settings file to reset",
      });
    }
    const currentSettings = (await readSettings()) || {};

    // Remove specified env fields
    if (currentSettings.env) {
      RESET_ENV_KEYS.forEach((key) => {
        delete currentSettings.env[key];
      });

      // Clean up empty env object
      if (Object.keys(currentSettings.env).length === 0) {
        delete currentSettings.env;
      }
    }

    // Write updated settings
    await writeJsonFile(settingsPath, currentSettings);

    return NextResponse.json({
      success: true,
      message: "Settings reset successfully",
    });
  } catch (error) {
    return settingsError("Error resetting claude settings", error, "Failed to reset claude settings");
  }
}

"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parseTOML, stringifyTOML } from "confbox";
import {
  checkBinaryInstalled,
  readJsonTolerant,
  ensureSuffix,
  settingsError,
} from "@/lib/cliTools";

const getCodexDir = () => path.join(os.homedir(), ".codex");
const getCodexConfigPath = () => path.join(getCodexDir(), "config.toml");
const getCodexAuthPath = () => path.join(getCodexDir(), "auth.json");

// The provider id written into config.toml — detection and reset must agree on it.
const EXTREMEROUTER_PROVIDER = "@rsalmn/extremerouter";
// Older builds wrote the bare id; accept it for detection/reset compatibility.
const LEGACY_PROVIDER = "extremerouter";

// Flatten confbox-parsed TOML into a writable object, preserving nested tables
const parsedToWritable = (obj) => obj ?? {};

// Set a nested key from a flat dotted path, creating intermediate objects as needed
const setNestedSection = (obj, dottedKey, value) => {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
};

// Delete a nested key from a flat dotted path
const deleteNestedSection = (obj, dottedKey) => {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = cur?.[keys[i]];
    if (cur == null) return;
  }
  delete cur[keys[keys.length - 1]];
};

// Check if codex CLI is installed (via which/where or config file exists)
const checkCodexInstalled = () =>
  checkBinaryInstalled({ binary: "codex", configPaths: [getCodexConfigPath()] });

// Read current config.toml
const readConfig = async () => {
  try {
    return await fs.readFile(getCodexConfigPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

// Check if config has ExtremeRouter settings.
// Parses the TOML (instead of string matching) so detection agrees with what
// POST writes: model_provider = "@rsalmn/extremerouter" plus the
// [model_providers.extremerouter] section. Accepts the legacy bare id too.
const hasExtremeRouterConfig = (config) => {
  if (!config) return false;
  try {
    const parsed = parseTOML(config);
    if (parsed.model_provider === EXTREMEROUTER_PROVIDER || parsed.model_provider === LEGACY_PROVIDER) return true;
    return !!parsed.model_providers?.[LEGACY_PROVIDER];
  } catch {
    return false;
  }
};

// GET - Check codex CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkCodexInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Codex CLI is not installed",
      });
    }

    const config = await readConfig();

    return NextResponse.json({
      installed: true,
      config,
      hasExtremeRouter: hasExtremeRouterConfig(config),
      configPath: getCodexConfigPath(),
    });
  } catch (error) {
    return settingsError("Error checking codex settings", error, "Failed to check codex settings");
  }
}

// POST - Update ExtremeRouter settings (merge with existing config)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, subagentModel } = await request.json();

    if (!baseUrl || !apiKey || !model) {
      return NextResponse.json({ error: "baseUrl, apiKey and model are required" }, { status: 400 });
    }

    const codexDir = getCodexDir();
    const configPath = getCodexConfigPath();

    // Ensure directory exists
    await fs.mkdir(codexDir, { recursive: true });

    // Read and parse existing config
    let parsed = {};
    try {
      const existingConfig = await fs.readFile(configPath, "utf-8");
      parsed = parsedToWritable(parseTOML(existingConfig));
    } catch { /* No existing config */ }

    // Update only ExtremeRouter related fields (api_key goes to auth.json, not config.toml)
    parsed.model = model;
    parsed.model_provider = EXTREMEROUTER_PROVIDER;

    // Update or create extremerouter provider section (no api_key - Codex reads from auth.json)
    // Ensure /v1 suffix is added only once
    const normalizedBaseUrl = ensureSuffix(baseUrl, "/v1");
    setNestedSection(parsed, `model_providers.${LEGACY_PROVIDER}`, {
      name: "ExtremeRouter",
      base_url: normalizedBaseUrl,
      wire_api: "responses",
    });

    // Add subagent configuration
    const effectiveSubagentModel = subagentModel || model;
    setNestedSection(parsed, "agents.subagent", {
      model: effectiveSubagentModel,
    });

    // Write merged config
    const configContent = stringifyTOML(parsed);
    await fs.writeFile(configPath, configContent);

    // Update auth.json with OPENAI_API_KEY (Codex reads this first)
    const authPath = getCodexAuthPath();
    let authData = {};
    try {
      const existingAuth = await fs.readFile(authPath, "utf-8");
      authData = JSON.parse(existingAuth);
    } catch { /* No existing auth */ }

    // Force apikey mode (keep existing tokens untouched for ChatGPT login reuse)
    authData.OPENAI_API_KEY = apiKey;
    authData.auth_mode = "apikey";
    await fs.writeFile(authPath, JSON.stringify(authData, null, 2));

    return NextResponse.json({
      success: true,
      message: "Codex settings applied successfully!",
      configPath,
    });
  } catch (error) {
    return settingsError("Error updating codex settings", error, "Failed to update codex settings");
  }
}

// DELETE - Remove ExtremeRouter settings only (keep other settings)
export async function DELETE() {
  try {
    const configPath = getCodexConfigPath();

    // Read and parse existing config
    let parsed = {};
    try {
      const existingConfig = await fs.readFile(configPath, "utf-8");
      parsed = parsedToWritable(parseTOML(existingConfig));
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({
          success: true,
          message: "No config file to reset",
        });
      }
      throw error;
    }

    // Remove ExtremeRouter related root fields only if they point to extremerouter
    if (parsed.model_provider === EXTREMEROUTER_PROVIDER || parsed.model_provider === LEGACY_PROVIDER) {
      delete parsed.model;
      delete parsed.model_provider;
    }

    // Remove extremerouter provider section
    deleteNestedSection(parsed, `model_providers.${LEGACY_PROVIDER}`);

    // Remove subagent configuration
    deleteNestedSection(parsed, "agents.subagent");

    // Write updated config
    const configContent = stringifyTOML(parsed);
    await fs.writeFile(configPath, configContent);

    // Remove OPENAI_API_KEY from auth.json
    const authPath = getCodexAuthPath();
    try {
      const existingAuth = await fs.readFile(authPath, "utf-8");
      const authData = JSON.parse(existingAuth);
      delete authData.OPENAI_API_KEY;
      delete authData.auth_mode;

      // Write back or delete if empty
      if (Object.keys(authData).length === 0) {
        await fs.unlink(authPath);
      } else {
        await fs.writeFile(authPath, JSON.stringify(authData, null, 2));
      }
    } catch { /* No auth file */ }

    return NextResponse.json({
      success: true,
      message: "ExtremeRouter settings removed successfully",
    });
  } catch (error) {
    return settingsError("Error resetting codex settings", error, "Failed to reset codex settings");
  }
}

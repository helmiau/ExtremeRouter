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

const getConfigDir = () => path.join(os.homedir(), ".config", "opencode");
const getConfigPath = () => path.join(getConfigDir(), "opencode.json");

// Check if opencode CLI is installed (via which/where or config file exists)
const checkOpenCodeInstalled = () =>
  checkBinaryInstalled({ binary: "opencode", configPaths: [getConfigPath()] });

// Read current config (tolerates JSONC comments/trailing commas; treats
// missing or unparseable files as "no config").
const readConfig = () => readJsonTolerant(getConfigPath());

const hasExtremeRouterConfig = (config) => {
  if (!config?.provider) return false;
  return !!config.provider["@rsalmn/extremerouter"];
};

// GET - Check opencode CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenCodeInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "OpenCode CLI is not installed",
      });
    }

    const config = await readConfig();
    const providerConfig = config?.provider?.["@rsalmn/extremerouter"];
    const modelMap = providerConfig?.models || {};

    return NextResponse.json({
      installed: true,
      config,
      hasExtremeRouter: hasExtremeRouterConfig(config),
      configPath: getConfigPath(),
        opencode: {
          models: Object.keys(modelMap),
          activeModel: config?.model?.startsWith("extremerouter/") ? config.model.replace(/^extremerouter\//, "") : null,
          baseURL: providerConfig?.options?.baseURL || null,
        },
    });
  } catch (error) {
    return settingsError("Error checking opencode settings", error, "Failed to check opencode settings");
  }
}

// POST - Apply ExtremeRouter as openai-compatible provider (multi-model support)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, activeModel, subagentModel } = await request.json();

    // Accept either `model` (string, legacy) or `models` (array of strings)
    const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);

    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const configDir = getConfigDir();
    const configPath = getConfigPath();

    await mkdirp(configDir);

    // Read existing config or start fresh (tolerates JSONC)
    const config = (await readConfig()) || {};

    const normalizedBaseUrl = ensureSuffix(baseUrl, "/v1");
    const keyToUse = apiKey || "sk_extremerouter";
    const effectiveSubagentModel = subagentModel || modelsArray[0];

    // Ensure provider object
    if (!config.provider) config.provider = {};

    // Preserve any existing extremerouter provider entry and its models
    const existingProvider = config.provider["@rsalmn/extremerouter"] || { npm: "@ai-sdk/openai-compatible", options: {}, models: {} };

    // Merge options (overwrite baseURL/apiKey)
    existingProvider.options = {
      ...existingProvider.options,
      baseURL: normalizedBaseUrl,
      apiKey: keyToUse,
    };

    // Ensure models map exists
    existingProvider.models = existingProvider.models || {};

    // Add or update entries for all requested models
    for (const m of modelsArray) {
      if (!m || typeof m !== "string") continue;
      existingProvider.models[m] = { name: m, modalities: { input: ["text", "image"], output: ["text"] } };
    }

    // Save merged provider back
    config.provider["@rsalmn/extremerouter"] = existingProvider;

    // Set the active model: prefer explicit activeModel, else first of modelsArray
    // If activeModel is explicitly empty string, clear the model
    if (activeModel === "") {
      config.model = "";
    } else {
      const finalActive = activeModel || modelsArray[0];
      if (finalActive) {
        config.model = `extremerouter/${finalActive}`;
      }
    }

    // Add subagent configuration
    if (!config.agent) config.agent = {};
    config.agent.explorer = {
      description: "Fast explorer subagent for codebase exploration",
      mode: "subagent",
      model: `extremerouter/${effectiveSubagentModel}`,
    };

    await writeJsonFile(configPath, config);

    return NextResponse.json({
      success: true,
      message: "OpenCode settings applied successfully!",
      configPath,
    });
  } catch (error) {
    return settingsError("Error applying opencode settings", error, "Failed to apply settings");
  }
}

// PATCH - Update specific settings (e.g., clear active model)
export async function PATCH(request) {
  try {
    const { clearActiveModel } = await request.json();
    const configPath = getConfigPath();

    // Distinguish "no file" (clean message) from other read errors.
    if ((await readTextFile(configPath, null)) === null) {
      return NextResponse.json({ success: true, message: "No config file found" });
    }

    const config = (await readConfig()) || {};

    if (clearActiveModel === true) {
      // Clear active model but keep models in the list
      if (config.model?.startsWith("extremerouter/")) {
        config.model = "";
      }
    }

    await writeJsonFile(configPath, config);

    return NextResponse.json({
      success: true,
      message: "Settings updated",
    });
  } catch (error) {
    return settingsError("Error patching opencode settings", error, "Failed to patch settings");
  }
}

// DELETE - Remove ExtremeRouter provider or specific models from config
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");
    const configPath = getConfigPath();

    // Distinguish "no file" (clean reset message) from other read errors.
    if ((await readTextFile(configPath, null)) === null) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    const config = (await readConfig()) || {};

    // If specific model provided, remove just that model
    if (modelToRemove && config.provider?.["@rsalmn/extremerouter"]?.models) {
      delete config.provider["@rsalmn/extremerouter"].models[modelToRemove];

      // If no models left, remove the provider
      if (Object.keys(config.provider["@rsalmn/extremerouter"].models).length === 0) {
        delete config.provider["@rsalmn/extremerouter"];
        if (config.model?.startsWith("extremerouter/")) delete config.model;
      } else if (config.model === `extremerouter/${modelToRemove}`) {
        // If removed model was active, switch to first remaining model
        const remainingModels = Object.keys(config.provider["@rsalmn/extremerouter"].models);
        config.model = `extremerouter/${remainingModels[0]}`;
      }
    } else {
      // No specific model - remove entire extremerouter provider
      if (config.provider) delete config.provider["@rsalmn/extremerouter"];
      if (config.model?.startsWith("extremerouter/")) delete config.model;
    }

    // Remove subagent configuration
    if (config.agent?.explorer?.model?.startsWith("extremerouter/")) {
      delete config.agent.explorer;
      // Clean up empty agent object
      if (Object.keys(config.agent).length === 0) delete config.agent;
    }

    await writeJsonFile(configPath, config);

    return NextResponse.json({
      success: true,
      message: modelToRemove ? `Model "${modelToRemove}" removed` : "ExtremeRouter settings removed from OpenCode",
    });
  } catch (error) {
    return settingsError("Error resetting opencode settings", error, "Failed to reset opencode settings");
  }
}

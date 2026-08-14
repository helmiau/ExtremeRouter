"use server";

import { NextResponse } from "next/server";
import path from "path";
import {
  checkBinaryInstalled,
  readJsonTolerant,
  readTextFile,
  writeJsonFile,
  mkdirp,
  ensureSuffix,
  settingsError,
} from "@/lib/cliTools";

// OpenClaw 2026.5.x writes agents[].model as either a plain string
// (legacy) or as an object `{ primary, fallbacks }`. Normalize to the
// string id so downstream consumers can call `.startsWith()` safely.
const resolveAgentModel = (m) => {
  if (typeof m === "string") return m;
  if (m && typeof m === "object") return m.primary ?? "";
  return "";
};

const getOpenClawDir = () => path.join(os.homedir(), ".openclaw");
const getOpenClawSettingsPath = () => path.join(getOpenClawDir(), "openclaw.json");

// Check if openclaw CLI is installed (via which/where or config file exists)
const checkOpenClawInstalled = () =>
  checkBinaryInstalled({ binary: "openclaw", configPaths: [getOpenClawSettingsPath()] });

// Read current settings.json (tolerates JSONC)
const readSettings = () => readJsonTolerant(getOpenClawSettingsPath());

// Check if settings has ExtremeRouter config
const hasExtremeRouterConfig = (settings) => {
  if (!settings || !settings.models || !settings.models.providers) return false;
  return !!settings.models.providers["@rsalmn/extremerouter"];
};

// Read per-agent models.json and return current model id (without "extremerouter/" prefix)
const readAgentModel = async (agentDir) => {
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const content = await readTextFile(modelsPath, null);
    if (content === null) return null;
    const data = JSON.parse(content);
    const models = data?.providers?.["@rsalmn/extremerouter"]?.models;
    return models?.[0]?.id || null;
  } catch {
    return null;
  }
};

// GET - Check openclaw CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenClawInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Open Claw CLI is not installed",
      });
    }

    const settings = await readSettings();

    // Enrich agents list with current per-agent model from models.json.
    // Coerce agent.model to its string id when OpenClaw stores it as
    // `{ primary, fallbacks }` so downstream `.startsWith()` calls work.
    const agentList = settings?.agents?.list || [];
    const enrichedAgents = await Promise.all(
      agentList.map(async (agent) => {
        const agentModel = agent.agentDir ? await readAgentModel(agent.agentDir) : null;
        return { ...agent, model: resolveAgentModel(agent.model), currentModel: agentModel };
      })
    );

    return NextResponse.json({
      installed: true,
      settings,
      agents: enrichedAgents,
      hasExtremeRouter: hasExtremeRouterConfig(settings),
      settingsPath: getOpenClawSettingsPath(),
    });
  } catch (error) {
    return settingsError("Error checking openclaw settings", error, "Failed to check openclaw settings");
  }
}

// Write per-agent models.json
const writeAgentModels = async (agentDir, model, baseUrl, apiKey) => {
  await mkdirp(agentDir);
  const modelsPath = path.join(agentDir, "models.json");
  const existing = (await readJsonTolerant(modelsPath)) || {};

  if (!existing.providers) existing.providers = {};
  existing.providers["@rsalmn/extremerouter"] = {
    baseUrl,
    apiKey: apiKey || "your_api_key",
    api: "openai-completions",
    models: [{ id: model, name: model.split("/").pop() || model }],
  };
  await writeJsonFile(modelsPath, existing);
};

// POST - Update ExtremeRouter settings (merge with existing settings)
export async function POST(request) {
  try {
    // agentModels: { [agentId]: modelId } for per-agent override
    const { baseUrl, apiKey, model, agentModels = {} } = await request.json();

    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const openclawDir = getOpenClawDir();
    const settingsPath = getOpenClawSettingsPath();

    await mkdirp(openclawDir);

    const settings = (await readSettings()) || {};

    if (!settings.agents) settings.agents = {};
    if (!settings.agents.defaults) settings.agents.defaults = {};
    if (!settings.agents.defaults.model) settings.agents.defaults.model = {};
    if (!settings.agents.defaults.models) settings.agents.defaults.models = {};
    if (!settings.models) settings.models = {};
    if (!settings.models.providers) settings.models.providers = {};

    const normalizedBaseUrl = ensureSuffix(baseUrl, "/v1");
    const fullModelId = `extremerouter/${model}`;

    // Remove all old extremerouter/* entries from agents.defaults.models
    Object.keys(settings.agents.defaults.models)
      .filter((k) => k.startsWith("extremerouter/"))
      .forEach((k) => { delete settings.agents.defaults.models[k]; });

    // Update default model
    settings.agents.defaults.model.primary = fullModelId;

    // Collect all unique models (default + per-agent)
    const allModelIds = new Set([model]);
    Object.values(agentModels).forEach((m) => { if (m) allModelIds.add(m); });

    // Add fresh extremerouter models to allowlist
    allModelIds.forEach((m) => {
      settings.agents.defaults.models[`extremerouter/${m}`] = {};
    });

    // Remove old extremerouter model from each agent in agents.list. The
    // model field may be a plain string or `{ primary, fallbacks }`.
    if (settings.agents.list) {
      settings.agents.list = settings.agents.list.map((agent) => {
        if (resolveAgentModel(agent.model).startsWith("extremerouter/")) {
          const { model: _, ...rest } = agent;
          return rest;
        }
        return agent;
      });
    }

    // Update models.providers.extremerouter with all models
    settings.models.providers["@rsalmn/extremerouter"] = {
      baseUrl: normalizedBaseUrl,
      apiKey: apiKey || "your_api_key",
      api: "openai-completions",
      models: [...allModelIds].map((m) => ({ id: m, name: m.split("/").pop() || m })),
    };

    // Set per-agent model in agents.list and write models.json
    if (settings.agents.list) {
      settings.agents.list = settings.agents.list.map((agent) => {
        const agentModel = agentModels[agent.id];
        if (agentModel) return { ...agent, model: `extremerouter/${agentModel}` };
        return agent;
      });

      // Write per-agent models.json for agents with agentDir
      await Promise.all(
        settings.agents.list.map(async (agent) => {
          if (!agent.agentDir) return;
          const agentModel = agentModels[agent.id];
          const modelToWrite = agentModel || model; // fallback to default
          await writeAgentModels(agent.agentDir, modelToWrite, normalizedBaseUrl, apiKey);
        })
      );
    }

    await writeJsonFile(settingsPath, settings);

    return NextResponse.json({
      success: true,
      message: "Open Claw settings applied successfully!",
      settingsPath,
    });
  } catch (error) {
    return settingsError("Error updating openclaw settings", error, "Failed to update openclaw settings");
  }
}

// DELETE - Remove ExtremeRouter settings only (keep other settings)
export async function DELETE() {
  try {
    const settingsPath = getOpenClawSettingsPath();

    // Distinguish "no file" (clean reset message) from other read errors.
    if ((await readTextFile(settingsPath, null)) === null) {
      return NextResponse.json({
        success: true,
        message: "No settings file to reset",
      });
    }

    const settings = (await readSettings()) || {};

    // Remove ExtremeRouter from models.providers
    if (settings.models && settings.models.providers) {
      delete settings.models.providers["@rsalmn/extremerouter"];

      // Remove providers object if empty
      if (Object.keys(settings.models.providers).length === 0) {
        delete settings.models.providers;
      }
    }

    // Remove extremerouter models from agents.defaults.models allowlist
    if (settings.agents?.defaults?.models) {
      const keysToRemove = Object.keys(settings.agents.defaults.models).filter((k) => k.startsWith("extremerouter/"));
      for (const key of keysToRemove) {
        delete settings.agents.defaults.models[key];
      }
      if (Object.keys(settings.agents.defaults.models).length === 0) {
        delete settings.agents.defaults.models;
      }
    }

    // Reset agents.defaults.model.primary if it uses extremerouter
    if (settings.agents?.defaults?.model?.primary?.startsWith("extremerouter/")) {
      delete settings.agents.defaults.model.primary;
    }

    // Write updated settings
    await writeJsonFile(settingsPath, settings);

    return NextResponse.json({
      success: true,
      message: "ExtremeRouter settings removed successfully",
    });
  } catch (error) {
    return settingsError("Error resetting openclaw settings", error, "Failed to reset openclaw settings");
  }
}

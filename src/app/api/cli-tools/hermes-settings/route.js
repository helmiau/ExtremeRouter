"use server";

import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import {
  checkBinaryInstalled,
  readTextFile,
  writeTextFile,
  mkdirp,
  ensureSuffix,
  upsertEnvLine,
  settingsError,
} from "@/lib/cliTools";

const PROVIDER_NAME = "@rsalmn/extremerouter";
const API_KEY_ENV = "OPENAI_API_KEY";

const getHermesDir = () => path.join(os.homedir(), ".hermes");
const getHermesConfigPath = () => path.join(getHermesDir(), "config.yaml");
const getHermesEnvPath = () => path.join(getHermesDir(), ".env");

// Match top-level "model:" block (until next non-indented, non-empty line)
const MODEL_BLOCK_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;

const buildModelBlock = (model, baseUrl) =>
  `model:\n  default: "${model}"\n  provider: "custom"\n  base_url: "${baseUrl}"\n`;

// Parse current model block back to fields (best-effort, simple key:value)
const parseModelBlock = (yaml) => {
  const match = yaml.match(MODEL_BLOCK_RE);
  if (!match) return null;
  const body = match[1] || "";
  const get = (key) => {
    const m = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\r\n]+)["']?`, "m"));
    return m ? m[1].trim() : null;
  };
  return {
    default: get("default"),
    provider: get("provider"),
    base_url: get("base_url"),
  };
};

const upsertModelBlock = (yaml, newBlock) => {
  if (MODEL_BLOCK_RE.test(yaml)) return yaml.replace(MODEL_BLOCK_RE, newBlock);
  return yaml.length > 0 ? `${newBlock}\n${yaml}` : newBlock;
};

const removeModelBlock = (yaml) => yaml.replace(MODEL_BLOCK_RE, "").replace(/^\n+/, "");

const checkHermesInstalled = () =>
  checkBinaryInstalled({ binary: "hermes", configPaths: [getHermesConfigPath()] });

const readConfigYaml = () => readTextFile(getHermesConfigPath(), "");
const readEnvFile = () => readTextFile(getHermesEnvPath(), "");

// Detect extremerouter by base_url containing localhost/127.0.0.1 or matching tunnel URL
const hasExtremeRouterConfig = (modelCfg) => {
  if (!modelCfg?.base_url) return false;
  return modelCfg.provider === "custom" && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(modelCfg.base_url);
};

export async function GET() {
  try {
    const installed = await checkHermesInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Hermes Agent is not installed" });
    }
    const yaml = await readConfigYaml();
    const model = parseModelBlock(yaml);
    return NextResponse.json({
      installed: true,
      settings: { model },
      hasExtremeRouter: hasExtremeRouterConfig(model),
      configPath: getHermesConfigPath(),
    });
  } catch (error) {
    return settingsError("Error checking hermes settings", error, "Failed to check hermes settings");
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    await mkdirp(getHermesDir());

    const normalizedBaseUrl = ensureSuffix(baseUrl, "/v1");

    // Update config.yaml — replace/insert model: block, keep everything else
    const existingYaml = await readConfigYaml();
    const newYaml = upsertModelBlock(existingYaml, buildModelBlock(model, normalizedBaseUrl));
    await writeTextFile(getHermesConfigPath(), newYaml);

    // Update .env — upsert OPENAI_API_KEY only when caller provides one
    if (apiKey) {
      const existingEnv = await readEnvFile();
      const newEnv = upsertEnvLine(existingEnv, API_KEY_ENV, apiKey);
      await writeTextFile(getHermesEnvPath(), newEnv);
    }

    return NextResponse.json({
      success: true,
      message: "Hermes settings applied successfully!",
      configPath: getHermesConfigPath(),
    });
  } catch (error) {
    return settingsError("Error updating hermes settings", error, "Failed to update hermes settings");
  }
}

export async function DELETE() {
  try {
    const configPath = getHermesConfigPath();
    const yaml = await readTextFile(configPath, null);
    if (yaml === null) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }
    const newYaml = removeModelBlock(yaml);
    await writeTextFile(configPath, newYaml);
    return NextResponse.json({ success: true, message: `${PROVIDER_NAME} model block removed` });
  } catch (error) {
    return settingsError("Error resetting hermes settings", error, "Failed to reset hermes settings");
  }
}

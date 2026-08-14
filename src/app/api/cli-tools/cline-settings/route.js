"use server";

import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import {
  checkBinaryInstalled,
  readJsonTolerant,
  writeJsonFile,
  mkdirp,
  stripSuffix,
  settingsError,
} from "@/lib/cliTools";

const getDataDir = () => path.join(os.homedir(), ".cline", "data");
const getGlobalStatePath = () => path.join(getDataDir(), "globalState.json");
const getSecretsPath = () => path.join(getDataDir(), "secrets.json");

const checkInstalled = () =>
  checkBinaryInstalled({ binary: "cline", configPaths: [getGlobalStatePath()] });

const readJson = (filePath) => readJsonTolerant(filePath);

const hasExtremeRouterConfig = (globalState) => {
  if (!globalState) return false;
  const isOpenAi =
    globalState.actModeApiProvider === "openai" || globalState.planModeApiProvider === "openai";
  const baseUrl = globalState.openAiBaseUrl || "";
  return isOpenAi && (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("@rsalmn/extremerouter"));
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Cline CLI is not installed" });
    }
    const globalState = await readJson(getGlobalStatePath());
    return NextResponse.json({
      installed: true,
      settings: {
        actModeApiProvider: globalState?.actModeApiProvider,
        planModeApiProvider: globalState?.planModeApiProvider,
        openAiBaseUrl: globalState?.openAiBaseUrl,
        openAiModelId: globalState?.openAiModelId,
      },
      hasExtremeRouter: hasExtremeRouterConfig(globalState),
      globalStatePath: getGlobalStatePath(),
    });
  } catch (error) {
    return settingsError("Error checking cline settings", error, "Failed to check cline settings");
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !apiKey || !model) {
      return NextResponse.json({ error: "baseUrl, apiKey and model are required" }, { status: 400 });
    }

    await mkdirp(getDataDir());

    // Cline expects base WITHOUT /v1
    const normalizedBaseUrl = stripSuffix(baseUrl, "/v1");

    const globalState = (await readJson(getGlobalStatePath())) || {};
    globalState.actModeApiProvider = "openai";
    globalState.planModeApiProvider = "openai";
    globalState.openAiBaseUrl = normalizedBaseUrl;
    globalState.openAiModelId = model;
    globalState.planModeOpenAiModelId = model;
    await writeJsonFile(getGlobalStatePath(), globalState);

    const secrets = (await readJson(getSecretsPath())) || {};
    secrets.openAiApiKey = apiKey;
    await writeJsonFile(getSecretsPath(), secrets);

    return NextResponse.json({ success: true, message: "Cline settings applied successfully!", globalStatePath: getGlobalStatePath() });
  } catch (error) {
    return settingsError("Error updating cline settings", error, "Failed to update cline settings");
  }
}

export async function DELETE() {
  try {
    const globalState = await readJson(getGlobalStatePath());
    if (!globalState) {
      return NextResponse.json({ success: true, message: "No settings file to reset" });
    }

    if (globalState.actModeApiProvider === "openai") {
      delete globalState.openAiBaseUrl;
      delete globalState.openAiModelId;
      delete globalState.planModeOpenAiModelId;
      globalState.actModeApiProvider = "cline";
      globalState.planModeApiProvider = "cline";
    }
    await writeJsonFile(getGlobalStatePath(), globalState);

    const secrets = (await readJson(getSecretsPath())) || {};
    delete secrets.openAiApiKey;
    await writeJsonFile(getSecretsPath(), secrets);

    return NextResponse.json({ success: true, message: "ExtremeRouter settings removed from Cline" });
  } catch (error) {
    return settingsError("Error resetting cline settings", error, "Failed to reset cline settings");
  }
}

"use server";

import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import {
  checkBinaryInstalled,
  readTextFile,
  writeTextFile,
  mkdirp,
  parseSimpleToml,
  settingsError,
} from "@/lib/cliTools";

const PROVIDER_NAME = "@rsalmn/extremerouter";

const getDeepSeekDir = () => path.join(os.homedir(), ".deepseek");
const getDeepSeekConfigPath = () => path.join(getDeepSeekDir(), "config.toml");

// Build TOML config for ExtremeRouter (openai provider mode)
const buildExtremeRouterConfig = (baseUrl, apiKey, model) => {
    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    return `provider = "openai"

[providers.openai]
base_url = "${normalizedBaseUrl}"
api_key = "${apiKey}"
model = "${model}"
`;
};

// Default DeepSeek config (reset state)
const DEFAULT_CONFIG = `provider = "deepseek"
`;

const checkDeepSeekInstalled = () =>
    checkBinaryInstalled({ binary: "deepseek", configPaths: [getDeepSeekConfigPath()] });

const readConfigToml = () => readTextFile(getDeepSeekConfigPath(), "");

// Detect ExtremeRouter by checking if provider is "openai" and base_url points to localhost/127.0.0.1
const hasExtremeRouterConfig = (config) => {
    if (!config) return false;
    const provider = config.provider;
    if (provider !== "openai") return false;
    const openaiSection = config["providers.openai"];
    if (!openaiSection?.base_url) return false;
    return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(openaiSection.base_url);
};

export async function GET() {
    try {
        const installed = await checkDeepSeekInstalled();
        if (!installed) {
            return NextResponse.json({ installed: false, settings: null, message: "DeepSeek TUI is not installed" });
        }
        const toml = await readConfigToml();
        const config = parseSimpleToml(toml);
        return NextResponse.json({
            installed: true,
            settings: config,
            hasExtremeRouter: hasExtremeRouterConfig(config),
            configPath: getDeepSeekConfigPath(),
        });
    } catch (error) {
        return settingsError("Error checking deepseek-tui settings", error, "Failed to check deepseek-tui settings");
    }
}

export async function POST(request) {
    try {
        const { baseUrl, apiKey, model } = await request.json();
        if (!baseUrl || !model) {
            return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
        }

        await mkdirp(getDeepSeekDir());

        const newConfig = buildExtremeRouterConfig(baseUrl, apiKey || "sk_extremerouter", model);
        await writeTextFile(getDeepSeekConfigPath(), newConfig);

        return NextResponse.json({
            success: true,
            message: "DeepSeek TUI settings applied successfully!",
            configPath: getDeepSeekConfigPath(),
        });
    } catch (error) {
        return settingsError("Error updating deepseek-tui settings", error, "Failed to update deepseek-tui settings");
    }
}

export async function DELETE() {
    try {
        const configPath = getDeepSeekConfigPath();
        if ((await readTextFile(configPath, null)) === null) {
            return NextResponse.json({ success: true, message: "No config file to reset" });
        }

        await writeTextFile(configPath, DEFAULT_CONFIG);
        return NextResponse.json({ success: true, message: `${PROVIDER_NAME} config reset to DeepSeek defaults` });
    } catch (error) {
        return settingsError("Error resetting deepseek-tui settings", error, "Failed to reset deepseek-tui settings");
    }
}

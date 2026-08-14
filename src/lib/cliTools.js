// Shared helpers for the cli-tools/*-settings API routes.
//
// Every tool route previously re-implemented the same low-level pieces:
//   - `which`/`where` install checks with %APPDATA%\npm PATH injection,
//   - JSONC-tolerant config reads (trailing commas, // and /* */ comments),
//   - pretty JSON writes with mkdir -p,
//   - plain-text / .env line editing,
//   - the `/v1` base-URL normalization,
//   - the standardized catch → console.log + 500 JSON response.
//
// Keep tool-specific merge/reset semantics in each route; share only the
// primitives above so a bugfix or behavior change lands in one place.

import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { NextResponse } from "next/server";

export const execAsync = promisify(exec);

export const isWindows = () => os.platform() === "win32";

/**
 * Check whether a CLI binary is installed (via `which`/`where`), falling back
 * to any of the given config paths existing (covers npm-global installs where
 * the shim is present but PATH is odd, and config-file-only tools).
 *
 * On Windows, %APPDATA%\npm is injected into PATH so npm-global CLIs are found.
 *
 * @param {{ binary: string, configPaths?: string[] }} opts
 * @returns {Promise<boolean>}
 */
export async function checkBinaryInstalled({ binary, configPaths = [] }) {
  const command = isWindows() ? `where ${binary}` : `which ${binary}`;
  const env = isWindows()
    ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
    : process.env;
  try {
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    for (const p of configPaths) {
      try {
        await fs.access(p);
        return true;
      } catch { /* try next */ }
    }
    return false;
  }
}

/**
 * Read a text file, returning `fallback` (default "") only when the file is
 * missing. Other errors (permissions, etc.) propagate so callers can surface
 * them instead of silently swallowing real failures.
 */
export async function readTextFile(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

/**
 * Parse JSON that may contain `//` or `/* *​/` comments and trailing commas
 * (JSONC). String-safe: comment markers inside quoted strings are left alone.
 * Throws on genuinely unparseable input — wrap with readJsonTolerant for the
 * "treat as no config" semantics the settings routes expect.
 */
export function parseJsonTolerant(content) {
  let stripped = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (escaped) {
      stripped += ch;
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      stripped += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stripped += ch;
      continue;
    }
    if (ch === "/" && content[i + 1] === "/") {
      while (i < content.length && content[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && content[i + 1] === "*") {
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i++;
      continue;
    }
    stripped += ch;
  }
  return JSON.parse(stripped.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Read + parse a JSON file tolerating JSONC. Returns null when the file is
 * missing or unparseable — callers treat null as "no config" rather than
 * failing the request.
 */
export async function readJsonTolerant(filePath) {
  try {
    return parseJsonTolerant(await fs.readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** mkdir -p a directory. */
export const mkdirp = (dir) => fs.mkdir(dir, { recursive: true });

/** mkdir -p the parent, then pretty-write JSON. */
export async function writeJsonFile(filePath, data) {
  await mkdirp(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

/** mkdir -p the parent, then write raw text. */
export async function writeTextFile(filePath, content) {
  await mkdirp(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf-8");
}

/** Append `suffix` (e.g. "/v1") unless already present. */
export function ensureSuffix(value, suffix) {
  return value.endsWith(suffix) ? value : `${value}${suffix}`;
}

/** Strip a trailing `suffix` (e.g. "/v1") if present. */
export function stripSuffix(value, suffix) {
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

/**
 * Standardized catch handler for settings routes: logs via console.log (so the
 * dashboard console-log buffer still captures it) and returns a 500 JSON body.
 */
export function settingsError(logPrefix, error, userMessage) {
  console.log(logPrefix, error);
  return NextResponse.json({ error: userMessage }, { status: 500 });
}

/**
 * Minimal TOML subset parser: `key = "value"` / `key = value` and single-level
 * `[section]` headers (nested headers become dotted keys, e.g. "providers.openai").
 * Used by the DeepSeek TUI route, which only needs this shape.
 */
export function parseSimpleToml(content) {
  const result = {};
  let currentSection = result;

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Section header: [section] or [section.subsection]
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const sectionName = sectionMatch[1];
      if (!result[sectionName]) result[sectionName] = {};
      currentSection = result[sectionName];
      continue;
    }

    // Key = "value" or key = value
    const keyValueMatch = trimmed.match(/^(\w+)\s*=\s*"([^"]*)"$/);
    if (keyValueMatch) {
      currentSection[keyValueMatch[1]] = keyValueMatch[2];
      continue;
    }

    // Key = value (unquoted)
    const unquotedMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (unquotedMatch) {
      currentSection[unquotedMatch[1]] = unquotedMatch[2].trim();
    }
  }

  return result;
}

/** Upsert a single `KEY=value` line in a .env-style text blob. */
export function upsertEnvLine(envText, key, value) {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(envText)) return envText.replace(re, line);
  return envText.length > 0 && !envText.endsWith("\n")
    ? `${envText}\n${line}\n`
    : `${envText}${line}\n`;
}

/** Remove a single `KEY=...` line from a .env-style text blob. */
export function removeEnvLine(envText, key) {
  const re = new RegExp(`^${key}=.*\\r?\\n?`, "m");
  return envText.replace(re, "");
}

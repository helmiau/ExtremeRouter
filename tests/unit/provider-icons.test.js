import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getProviderIconPath, SVG_ICON_IDS } from "../../src/shared/utils/providerIcon.js";

const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));

function iconFileExists(iconPath) {
  if (!iconPath || !iconPath.startsWith("/")) return false;
  return fs.existsSync(path.join(PUBLIC_DIR, iconPath.slice(1)));
}

describe("provider icon assets", () => {
  it("every registry provider resolves to an existing icon file", () => {
    const missing = [];
    for (const p of REGISTRY) {
      const icon = getProviderIconPath(p.id);
      if (!iconFileExists(icon)) missing.push(`${p.id} → ${icon}`);
    }
    expect(missing).toEqual([]);
  });

  it("every id listed in SVG_ICON_IDS has a matching .svg asset", () => {
    const missing = [];
    for (const id of SVG_ICON_IDS) {
      const file = path.join(PUBLIC_DIR, "providers", `${id}.svg`);
      if (!fs.existsSync(file)) missing.push(id);
    }
    expect(missing).toEqual([]);
  });

  it("the previously-broken free batch providers now resolve", () => {
    const ids = [
      "freebuff", "aihorde", "bazaarlink", "dgrid", "dahl",
      "g4f-groq", "g4f-gemini", "g4f-ollama", "g4f-nvidia", "g4f-pollinations",
      "hackclub", "llm7", "mimocode", "tencent-aistudio-web", "theoldllm",
      "uncloseai", "meta-ai",
    ];
    for (const id of ids) {
      expect(iconFileExists(getProviderIconPath(id)), `${id}`).toBe(true);
    }
  });
});

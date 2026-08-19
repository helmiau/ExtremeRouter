// Migration registry — append new entries when schema changes.
// Each migration: { version: number, name: string, up(db): void }
// Versions MUST be unique and monotonically increasing.
import m001 from "./001-initial.js";
import m002 from "./002-rename-qwen-token-plan.js";
import m003 from "./003-qwen-cloud-authtype-fix.js";
import m004 from "./004-combo-production-config.js";
import m005 from "./005-add-combo-context-length.js";
import m006 from "./006-hash-usage-api-keys.js";

export const MIGRATIONS = [m001, m002, m003, m004, m005, m006].sort((a, b) => a.version - b.version);

export function latestVersion() {
  return MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
}

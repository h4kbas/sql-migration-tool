import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_FOLDERS = ["models", "controllers", "seeds"];

export function resolveProjectRoot(rootOption) {
  return path.resolve(rootOption ?? process.cwd());
}

export function loadConfig(projectRoot) {
  const configPath = path.join(projectRoot, "migration.config.json");
  if (!existsSync(configPath)) {
    return { folders: DEFAULT_FOLDERS };
  }

  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  return {
    folders: Array.isArray(raw.folders) && raw.folders.length > 0
      ? raw.folders
      : DEFAULT_FOLDERS,
    folderSuborders:
      raw.folderSuborders && typeof raw.folderSuborders === "object"
        ? raw.folderSuborders
        : {},
  };
}

export function loadEnv(projectRoot) {
  const envPath = path.join(projectRoot, ".env");
  if (!existsSync(envPath)) {
    throw new Error("Missing .env file. Copy .env.example to .env first.");
  }

  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    env[key] = value;
  }

  if (!env.POSTGRES_USER || !env.POSTGRES_DB) {
    throw new Error(".env must define POSTGRES_USER and POSTGRES_DB");
  }

  return env;
}

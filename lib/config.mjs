import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_FOLDERS = ["models", "controllers", "seeds"];
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertIdent(value, label) {
  if (!IDENT_RE.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function normalizeSchemaRoles(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((role) => String(role).trim())
    .filter(Boolean)
    .map((role) => {
      assertIdent(role, "schema role");
      return role;
    });
}

export function resolveProjectRoot(rootOption) {
  return path.resolve(rootOption ?? process.cwd());
}

function resolveDatabase(raw, env) {
  const database = raw.database && typeof raw.database === "object" ? raw.database : {};

  const user = database.user ?? env?.POSTGRES_USER;
  const name = database.database ?? database.name ?? env?.POSTGRES_DB;

  if (!user || !name) {
    throw new Error("Database user and database name are required in database config or .env");
  }

  return {
    host: database.host ?? env?.POSTGRES_HOST ?? "127.0.0.1",
    port: Number(database.port ?? env?.POSTGRES_PORT ?? 5432),
    user,
    password: database.password ?? env?.POSTGRES_PASSWORD ?? "",
    database: name,
  };
}

export function loadConfig(projectRoot, env = null) {
  const configPath = path.join(projectRoot, "migration.config.json");
  const raw = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {};

  const schema = typeof raw.schema === "string" && raw.schema.trim()
    ? raw.schema.trim()
    : "public";
  const migrationTable = typeof raw.migrationTable === "string" && raw.migrationTable.trim()
    ? raw.migrationTable.trim()
    : "migration";

  assertIdent(schema, "schema");
  assertIdent(migrationTable, "migrationTable");

  const config = {
    folders: Array.isArray(raw.folders) && raw.folders.length > 0
      ? raw.folders
      : DEFAULT_FOLDERS,
    folderSuborders:
      raw.folderSuborders && typeof raw.folderSuborders === "object"
        ? raw.folderSuborders
        : {},
    schema,
    migrationTable,
    migrationQualified: `${schema}.${migrationTable}`,
    schemaRoles: normalizeSchemaRoles(raw.schemaRoles),
    postgrestReload: raw.postgrestReload === true,
    exportDir:
      typeof raw.exportDir === "string" && raw.exportDir.trim()
        ? raw.exportDir.trim()
        : "migrations",
  };

  config.database = resolveDatabase(raw, env);
  return config;
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

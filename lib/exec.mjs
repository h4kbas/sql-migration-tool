import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS api.migration (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`.trim();

const SCHEMA_BOOTSTRAP_SQL = `
DROP SCHEMA IF EXISTS api CASCADE;
CREATE SCHEMA api;
GRANT USAGE ON SCHEMA api TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA api
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA api
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA api
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
`.trim();

export function runPsql(projectRoot, env, sql, label) {
  if (!sql.trim()) {
    console.log(`Skipping empty ${label} SQL.`);
    return;
  }

  console.log(`Running ${label}...`);
  const result = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      env.POSTGRES_USER,
      "-d",
      env.POSTGRES_DB,
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ],
    {
      cwd: projectRoot,
      input: sql,
      encoding: "utf8",
    },
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.status !== 0) {
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error(`${label} failed`);
  }
}

export function ensureMigrationTable(projectRoot, env) {
  runPsql(projectRoot, env, MIGRATION_TABLE_SQL, "migration table bootstrap");
}

export function runInitBootstrap(projectRoot, env, dropSchema) {
  if (dropSchema) {
    runPsql(projectRoot, env, SCHEMA_BOOTSTRAP_SQL, "schema bootstrap");
    return;
  }

  runPsql(
    projectRoot,
    env,
    `
CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA api
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA api
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA api
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
`.trim(),
    "schema ensure",
  );
}

export function fetchAppliedMigrations(projectRoot, env) {
  ensureMigrationTable(projectRoot, env);

  const result = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      env.POSTGRES_USER,
      "-d",
      env.POSTGRES_DB,
      "-t",
      "-A",
      "-c",
      "SELECT name FROM api.migration ORDER BY applied_at ASC, name ASC;",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error("Failed to read applied migrations");
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function fetchAppliedMigrationsDesc(projectRoot, env) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      env.POSTGRES_USER,
      "-d",
      env.POSTGRES_DB,
      "-t",
      "-A",
      "-c",
      "SELECT name FROM api.migration ORDER BY applied_at DESC, name DESC;",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error("Failed to read applied migrations");
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function reloadPostgrest(projectRoot, env) {
  runPsql(
    projectRoot,
    env,
    "NOTIFY pgrst, 'reload schema';",
    "postgrest reload",
  );
}

export function maybeSaveCompiledSql(projectRoot, mode, sql, save) {
  if (!save || !sql.trim()) return;

  const dir = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const filePath = path.join(dir, `${stamp}_${mode}.sql`);
  writeFileSync(filePath, `${sql}\n`, "utf8");
  console.log(`Saved compiled SQL to ${path.relative(projectRoot, filePath)}`);
}

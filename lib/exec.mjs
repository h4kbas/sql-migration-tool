import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { logDone, logSqlStats, logStep } from "./log.mjs";

export function buildMigrationTableSql(migrationQualified) {
  return `
CREATE TABLE IF NOT EXISTS ${migrationQualified} (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`.trim();
}

function buildSchemaRoleSql(schema, schemaRoles) {
  if (schemaRoles.length === 0) return "";

  const roles = schemaRoles.join(", ");
  return `
GRANT USAGE ON SCHEMA ${schema} TO ${roles};
ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roles};
ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
  GRANT USAGE, SELECT ON SEQUENCES TO ${roles};
ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
  GRANT EXECUTE ON FUNCTIONS TO ${roles};
`.trim();
}

export function buildSchemaBootstrapSql(config, dropSchema) {
  const { schema, schemaRoles } = config;
  const parts = [];

  if (dropSchema) {
    parts.push(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
    parts.push(`CREATE SCHEMA ${schema};`);
  } else {
    parts.push(`CREATE SCHEMA IF NOT EXISTS ${schema};`);
  }

  const roleSql = buildSchemaRoleSql(schema, schemaRoles);
  if (roleSql) {
    parts.push(roleSql);
  }

  return parts.join("\n");
}

function psqlProcessEnv(database) {
  return {
    ...process.env,
    PGHOST: database.host,
    PGPORT: String(database.port),
    PGUSER: database.user,
    PGDATABASE: database.database,
    ...(database.password ? { PGPASSWORD: database.password } : {}),
  };
}

function runPsqlCommand(projectRoot, config, extraArgs, options = {}) {
  return spawnSync(
    "psql",
    extraArgs,
    {
      cwd: projectRoot,
      env: psqlProcessEnv(config.database),
      ...options,
    },
  );
}

export function runPsql(projectRoot, config, sql, label) {
  if (!sql.trim()) {
    console.log(`Skipping empty ${label} SQL.`);
    return;
  }

  const { database } = config;
  const target = `psql://${database.host}:${database.port}/${database.database}`;

  logSqlStats(`Executing ${label}`, sql);
  logStep(`Running ${label} via ${target}...`);

  const startedAt = Date.now();
  const result = runPsqlCommand(
    projectRoot,
    config,
    ["-v", "ON_ERROR_STOP=1", "-f", "-"],
    {
      input: sql,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );

  if (result.status !== 0) {
    throw new Error(`${label} failed`);
  }

  logDone(label, startedAt);
}

export function ensureMigrationTable(projectRoot, config) {
  runPsql(
    projectRoot,
    config,
    buildMigrationTableSql(config.migrationQualified),
    "migration table bootstrap",
  );
}

export function runInitBootstrap(projectRoot, config, dropSchema) {
  runPsql(
    projectRoot,
    config,
    buildSchemaBootstrapSql(config, dropSchema),
    dropSchema ? "schema bootstrap" : "schema ensure",
  );
}

export function fetchAppliedMigrations(projectRoot, config, options = {}) {
  const { ensureTable = true } = options;
  if (ensureTable) {
    ensureMigrationTable(projectRoot, config);
  }

  logStep(`Reading applied migrations from ${config.migrationQualified}...`);

  const result = runPsqlCommand(
    projectRoot,
    config,
    [
      "-t",
      "-A",
      "-c",
      `SELECT name FROM ${config.migrationQualified} ORDER BY applied_at ASC, name ASC;`,
    ],
    {
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error("Failed to read applied migrations");
  }

  const applied = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  console.log(`Applied migrations: ${applied.length}`);
  return applied;
}

export function fetchAppliedMigrationsSafe(projectRoot, config) {
  try {
    return fetchAppliedMigrations(projectRoot, config, { ensureTable: false });
  } catch {
    return [];
  }
}

export function fetchAppliedMigrationsDesc(projectRoot, config) {
  const result = runPsqlCommand(
    projectRoot,
    config,
    [
      "-t",
      "-A",
      "-c",
      `SELECT name FROM ${config.migrationQualified} ORDER BY applied_at DESC, name DESC;`,
    ],
    {
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

export function reloadSchemaCache(projectRoot, config) {
  if (!config.postgrestReload) return;

  logStep("Reloading PostgREST schema cache...");
  runPsql(
    projectRoot,
    config,
    "NOTIFY pgrst, 'reload schema';",
    "postgrest reload",
  );
}

export function saveCompiledSql(projectRoot, config, mode, sql, options = {}) {
  const { output = null, required = false } = options;
  if (!sql.trim()) {
    if (required) {
      throw new Error(`Nothing to export for ${mode}`);
    }
    return null;
  }

  const filePath = output
    ? path.resolve(projectRoot, output)
    : path.join(
      projectRoot,
      config.exportDir,
      `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}_${mode}.sql`,
    );

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${sql}\n`, "utf8");
  return filePath;
}

export function maybeSaveCompiledSql(projectRoot, config, mode, sql, save) {
  if (!save) return null;
  const filePath = saveCompiledSql(projectRoot, config, mode, sql, { required: true });
  console.log(`Saved compiled SQL to ${path.relative(projectRoot, filePath)}`);
  return filePath;
}

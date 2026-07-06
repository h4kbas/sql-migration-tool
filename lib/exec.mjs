import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function buildMigrationTableSql(migrationQualified) {
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

function buildSchemaBootstrapSql(config, dropSchema) {
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

function dockerPsqlArgs(config, env, extraArgs = []) {
  return [
    "compose",
    "exec",
    "-T",
    config.dockerService,
    "psql",
    "-U",
    env.POSTGRES_USER,
    "-d",
    env.POSTGRES_DB,
    ...extraArgs,
  ];
}

export function runPsql(projectRoot, config, env, sql, label) {
  if (!sql.trim()) {
    console.log(`Skipping empty ${label} SQL.`);
    return;
  }

  console.log(`Running ${label}...`);
  const result = spawnSync(
    "docker",
    dockerPsqlArgs(config, env, ["-v", "ON_ERROR_STOP=1", "-f", "-"]),
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

export function ensureMigrationTable(projectRoot, config, env) {
  runPsql(
    projectRoot,
    config,
    env,
    buildMigrationTableSql(config.migrationQualified),
    "migration table bootstrap",
  );
}

export function runInitBootstrap(projectRoot, config, env, dropSchema) {
  runPsql(
    projectRoot,
    config,
    env,
    buildSchemaBootstrapSql(config, dropSchema),
    dropSchema ? "schema bootstrap" : "schema ensure",
  );
}

export function fetchAppliedMigrations(projectRoot, config, env) {
  ensureMigrationTable(projectRoot, config, env);

  const result = spawnSync(
    "docker",
    dockerPsqlArgs(config, env, [
      "-t",
      "-A",
      "-c",
      `SELECT name FROM ${config.migrationQualified} ORDER BY applied_at ASC, name ASC;`,
    ]),
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

export function fetchAppliedMigrationsDesc(projectRoot, config, env) {
  const result = spawnSync(
    "docker",
    dockerPsqlArgs(config, env, [
      "-t",
      "-A",
      "-c",
      `SELECT name FROM ${config.migrationQualified} ORDER BY applied_at DESC, name DESC;`,
    ]),
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

export function reloadSchemaCache(projectRoot, config, env) {
  if (!config.postgrestReload) return;

  runPsql(
    projectRoot,
    config,
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

#!/usr/bin/env node

import { loadConfig, loadEnv, resolveProjectRoot } from "./lib/config.mjs";
import { discoverSqlFiles, topLevelFolder } from "./lib/discover.mjs";
import { inferBlocksFromFolder, parseSqlFile } from "./lib/parser.mjs";
import {
  compileInit,
  compileMigrateDown,
  compileMigrateUp,
  compileSeed,
} from "./lib/compiler.mjs";
import {
  ensureMigrationTable,
  fetchAppliedMigrations,
  fetchAppliedMigrationsDesc,
  maybeSaveCompiledSql,
  reloadSchemaCache,
  runInitBootstrap,
  runPsql,
} from "./lib/exec.mjs";

const MODES = new Set(["init", "seed", "migrate:up", "migrate:down"]);

function printUsage() {
  console.log(`Usage:
  sql-migrate <init|seed|migrate:up|migrate:down> [options]

Options:
  --root <path>          project root (default: cwd)
  --drop                 init only: drop and recreate configured schema first
  --save                 write compiled SQL into migrations/
  --folders a,b,c        override migration.config.json folder order
  --name <migration>     migrate:down only: rollback one migration

Directives:
  Freestanding SQL (above any // @...) runs on every command.

  // @model               init only, baseline schema below until next //
  // @seed                seed command only
  // @migration <name>    migrate:up only
  // @migration:down <name>
  // @defer <migration>   waits for applied migration (seed / migrate:up)
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();

  if (!command || command === "--help" || command === "-h") {
    return { help: true };
  }

  if (!MODES.has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const options = {
    command,
    root: null,
    drop: false,
    save: false,
    folders: null,
    name: null,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--root") {
      options.root = args.shift() ?? null;
      if (!options.root) throw new Error("--root requires a path");
      continue;
    }
    if (arg === "--drop") {
      options.drop = true;
      continue;
    }
    if (arg === "--save") {
      options.save = true;
      continue;
    }
    if (arg === "--folders") {
      const value = args.shift();
      if (!value) throw new Error("--folders requires a comma-separated list");
      options.folders = value.split(",").map((item) => item.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--name") {
      options.name = args.shift() ?? null;
      if (!options.name) throw new Error("--name requires a migration name");
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function loadParsedFiles(projectRoot, folders, folderSuborders = {}) {
  const files = discoverSqlFiles(projectRoot, folders, folderSuborders);

  return files.map((filePath) => {
    const folder = topLevelFolder(projectRoot, filePath, folders);
    const parsed = parseSqlFile(filePath);
    return inferBlocksFromFolder(folder, parsed);
  });
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printUsage();
    process.exit(1);
  }

  if (options.help) {
    printUsage();
    process.exit(0);
  }

  const projectRoot = resolveProjectRoot(options.root);
  const config = loadConfig(projectRoot);
  const folders = options.folders ?? config.folders;
  const env = loadEnv(projectRoot);
  const parsedFiles = loadParsedFiles(projectRoot, folders, config.folderSuborders);

  if (options.command === "init") {
    runInitBootstrap(projectRoot, config, env, options.drop);
    const sql = compileInit(parsedFiles);
    maybeSaveCompiledSql(projectRoot, "init", sql, options.save);
    runPsql(projectRoot, config, env, sql, "init");
    reloadSchemaCache(projectRoot, config, env);
    console.log("Init complete.");
    return;
  }

  if (options.command === "seed") {
    ensureMigrationTable(projectRoot, config, env);
    const applied = fetchAppliedMigrations(projectRoot, config, env);
    const sql = compileSeed(parsedFiles, applied, config);
    maybeSaveCompiledSql(projectRoot, "seed", sql, options.save);
    runPsql(projectRoot, config, env, sql, "seed");
    reloadSchemaCache(projectRoot, config, env);
    console.log("Seed complete.");
    return;
  }

  if (options.command === "migrate:up") {
    const applied = fetchAppliedMigrations(projectRoot, config, env);
    const appliedNames = new Set(applied);
    const sql = compileMigrateUp(parsedFiles, appliedNames, config);
    maybeSaveCompiledSql(projectRoot, "migrate_up", sql, options.save);
    runPsql(projectRoot, config, env, sql, "migrate:up");
    reloadSchemaCache(projectRoot, config, env);
    console.log("migrate:up complete.");
    return;
  }

  if (options.command === "migrate:down") {
    const appliedDesc = fetchAppliedMigrationsDesc(projectRoot, config, env);
    const targetNames = options.name
      ? [options.name]
      : appliedDesc.slice(0, 1);

    if (targetNames.length === 0) {
      console.log("No applied migrations to roll back.");
      return;
    }

    const notApplied = targetNames.filter((name) => !appliedDesc.includes(name));
    if (notApplied.length > 0) {
      throw new Error(`Migration not applied: ${notApplied.join(", ")}`);
    }

    const sql = compileMigrateDown(parsedFiles, targetNames, config);
    maybeSaveCompiledSql(projectRoot, "migrate_down", sql, options.save);
    runPsql(projectRoot, config, env, sql, "migrate:down");
    reloadSchemaCache(projectRoot, config, env);
    console.log("migrate:down complete.");
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

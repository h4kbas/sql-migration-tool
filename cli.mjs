#!/usr/bin/env node

import path from "node:path";
import {
  applyRunnerOverride,
  loadConfig,
  loadEnv,
  resolveProjectRoot,
} from "./lib/config.mjs";
import { discoverSqlFiles, topLevelFolder } from "./lib/discover.mjs";
import { inferBlocksFromFolder, parseSqlFile } from "./lib/parser.mjs";
import {
  compileInit,
  compileMigrateDown,
  compileMigrateUp,
  compileSeed,
} from "./lib/compiler.mjs";
import {
  buildMigrationTableSql,
  buildSchemaBootstrapSql,
  ensureMigrationTable,
  fetchAppliedMigrations,
  fetchAppliedMigrationsDesc,
  reloadSchemaCache,
  runInitBootstrap,
  runPsql,
  saveCompiledSql,
} from "./lib/exec.mjs";
import { logDatabaseTarget, logSqlStats, logStep } from "./lib/log.mjs";

const RUN_MODES = new Set(["init", "seed", "migrate:up", "migrate:down"]);

function printUsage() {
  console.log(`Usage:
  sql-migrate <init|seed|migrate:up|migrate:down|export> [options]
  sql-migrate export <init|seed|migrate:up|migrate:down> [options]

Options:
  --root <path>          project root (default: cwd)
  --drop                 init only: drop and recreate configured schema first
  --save                 write compiled SQL into exportDir and still run
  --export-only          write compiled SQL and skip database execution
  --output <path>        export/save file path (relative to project root)
  --runner <psql|docker> override database.runner from migration.config.json
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
  let command = args.shift();

  if (!command || command === "--help" || command === "-h") {
    return { help: true };
  }

  let exportOnly = false;
  if (command === "export") {
    exportOnly = true;
    command = args.shift();
  }

  if (!command || !RUN_MODES.has(command)) {
    throw new Error(`Unknown command: ${command ?? "(missing)"}`);
  }

  const options = {
    command,
    exportOnly,
    root: null,
    drop: false,
    save: false,
    output: null,
    runner: null,
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
    if (arg === "--export-only") {
      options.exportOnly = true;
      continue;
    }
    if (arg === "--output") {
      options.output = args.shift() ?? null;
      if (!options.output) throw new Error("--output requires a path");
      continue;
    }
    if (arg === "--runner") {
      options.runner = args.shift() ?? null;
      if (!options.runner) throw new Error("--runner requires psql or docker");
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
  logStep(`Discovering SQL files in ${folders.join(", ")}...`);
  const files = discoverSqlFiles(projectRoot, folders, folderSuborders);
  console.log(`Found ${files.length} SQL files`);

  return files.map((filePath, index) => {
    if (index === 0 || (index + 1) % 10 === 0 || index + 1 === files.length) {
      console.log(`Parsing ${index + 1}/${files.length}...`);
    }

    const folder = topLevelFolder(projectRoot, filePath, folders);
    const parsed = parseSqlFile(filePath);
    return inferBlocksFromFolder(folder, parsed);
  });
}

function joinSql(parts) {
  return parts.filter((part) => part?.trim()).join("\n\n").trim();
}

function writeSql(projectRoot, config, mode, sql, options) {
  const shouldWrite = options.exportOnly || options.save || !!options.output;
  if (!shouldWrite) return null;

  const filePath = saveCompiledSql(projectRoot, config, mode, sql, {
    output: options.output,
    required: options.exportOnly,
  });

  if (options.exportOnly) {
    logSqlStats("Exported SQL", sql);
    console.log(`Exported SQL to ${path.relative(projectRoot, filePath)}`);
    console.log("Skipped database execution.");
    return filePath;
  }

  console.log(`Saved compiled SQL to ${path.relative(projectRoot, filePath)}`);
  return filePath;
}

function loadRuntimeConfig(projectRoot, options) {
  const needsEnv = !(options.exportOnly && options.command === "init");
  const env = needsEnv ? loadEnv(projectRoot) : null;
  const config = applyRunnerOverride(loadConfig(projectRoot, env), options.runner);
  return { config, env };
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
  const { config } = loadRuntimeConfig(projectRoot, options);
  const folders = options.folders ?? config.folders;
  const modeLabel = options.exportOnly ? `export ${options.command}` : options.command;

  console.log(`sql-migrate ${modeLabel}`);
  console.log(`Project: ${projectRoot}`);
  if (!options.exportOnly || options.command !== "init") {
    logDatabaseTarget(config);
  }

  const parsedFiles = loadParsedFiles(projectRoot, folders, config.folderSuborders);

  if (options.command === "init") {
    logStep("Compiling init SQL...");
    const compiled = compileInit(parsedFiles);
    logSqlStats("Compiled init SQL", compiled);

    const exportSql = joinSql([
      buildSchemaBootstrapSql(config, options.drop),
      compiled,
    ]);

    writeSql(projectRoot, config, "init", exportSql, options);
    if (options.exportOnly) return;

    runInitBootstrap(projectRoot, config, options.drop);
    writeSql(projectRoot, config, "init", compiled, {
      ...options,
      exportOnly: false,
      save: options.save && !options.output,
      output: options.output,
    });
    runPsql(projectRoot, config, compiled, "init");
    reloadSchemaCache(projectRoot, config);
    console.log("Init complete.");
    return;
  }

  if (options.command === "seed") {
    const applied = fetchAppliedMigrations(projectRoot, config, {
      ensureTable: !options.exportOnly,
    });

    logStep("Compiling seed SQL...");
    const compiled = compileSeed(parsedFiles, applied, config);
    logSqlStats("Compiled seed SQL", compiled);

    const exportSql = joinSql([
      buildMigrationTableSql(config.migrationQualified),
      compiled,
    ]);

    writeSql(projectRoot, config, "seed", exportSql, options);
    if (options.exportOnly) return;

    ensureMigrationTable(projectRoot, config);
    const appliedLive = fetchAppliedMigrations(projectRoot, config);
    const seedSql = compileSeed(parsedFiles, appliedLive, config);
    writeSql(projectRoot, config, "seed", seedSql, {
      ...options,
      exportOnly: false,
      save: options.save && !options.output,
      output: options.output,
    });
    runPsql(projectRoot, config, seedSql, "seed");
    reloadSchemaCache(projectRoot, config);
    console.log("Seed complete.");
    return;
  }

  if (options.command === "migrate:up") {
    const applied = fetchAppliedMigrations(projectRoot, config, {
      ensureTable: !options.exportOnly,
    });

    logStep("Compiling migrate:up SQL...");
    const compiled = compileMigrateUp(parsedFiles, new Set(applied), config);
    logSqlStats("Compiled migrate:up SQL", compiled);

    writeSql(projectRoot, config, "migrate_up", compiled, options);
    if (options.exportOnly) return;

    const appliedLive = fetchAppliedMigrations(projectRoot, config);
    const migrateSql = compileMigrateUp(parsedFiles, new Set(appliedLive), config);
    writeSql(projectRoot, config, "migrate_up", migrateSql, {
      ...options,
      exportOnly: false,
      save: options.save && !options.output,
      output: options.output,
    });
    runPsql(projectRoot, config, migrateSql, "migrate:up");
    reloadSchemaCache(projectRoot, config);
    console.log("migrate:up complete.");
    return;
  }

  const appliedDesc = options.exportOnly
    ? (options.name ? [options.name] : [])
    : fetchAppliedMigrationsDesc(projectRoot, config);
  const targetNames = options.name
    ? [options.name]
    : appliedDesc.slice(0, 1);

  if (targetNames.length === 0) {
    console.log("No applied migrations to roll back.");
    return;
  }

  if (!options.exportOnly) {
    const notApplied = targetNames.filter((name) => !appliedDesc.includes(name));
    if (notApplied.length > 0) {
      throw new Error(`Migration not applied: ${notApplied.join(", ")}`);
    }
  }

  logStep("Compiling migrate:down SQL...");
  const compiled = compileMigrateDown(parsedFiles, targetNames, config);
  logSqlStats("Compiled migrate:down SQL", compiled);
  console.log(`Rolling back: ${targetNames.join(", ")}`);

  writeSql(projectRoot, config, "migrate_down", compiled, options);
  if (options.exportOnly) return;

  runPsql(projectRoot, config, compiled, "migrate:down");
  reloadSchemaCache(projectRoot, config);
  console.log("migrate:down complete.");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

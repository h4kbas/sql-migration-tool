function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function appendChunk(parts, label, sql) {
  const trimmed = sql.trim();
  if (!trimmed) return;
  parts.push(`-- >>> ${label}\n${trimmed}\n`);
}

const BLOCK_KINDS_BY_MODE = {
  init: new Set(["model"]),
  seed: new Set(["seed"]),
  "migrate:up": new Set(["migration_up"]),
};

function pushDeferUnit(units, block, parsed, index) {
  if ((block.dependsOn ?? []).length === 0) {
    throw new Error(`Missing migration target for // @defer in ${parsed.filePath}`);
  }

  units.push({
    id: `${parsed.filePath}:defer:${index}`,
    type: "defer",
    name: block.name ?? null,
    dependsOnAll: block.dependsOn ?? [],
    sql: block.sql,
    filePath: parsed.filePath,
    order: index,
  });
}

function collectUnits(parsedFiles, mode, includeFreestanding, { includeDefer = false } = {}) {
  const units = [];
  let index = 0;

  for (const parsed of parsedFiles) {
    if (includeFreestanding && parsed.freestandingSql) {
      units.push({
        id: `${parsed.filePath}:freestanding`,
        type: "freestanding",
        sql: parsed.freestandingSql,
        filePath: parsed.filePath,
        order: index++,
      });
    }

    const allowedKinds = BLOCK_KINDS_BY_MODE[mode];
    for (const block of parsed.blocks) {
      if (block.kind === "defer") {
        if (!includeDefer) continue;
        pushDeferUnit(units, block, parsed, index++);
        continue;
      }

      if (!allowedKinds?.has(block.kind)) continue;

      if (block.kind === "migration_up" && !block.name) {
        throw new Error(`Missing name for // @migration in ${parsed.filePath}`);
      }

      units.push({
        id: `${parsed.filePath}:${index}`,
        type: block.kind,
        name: block.name ?? null,
        dependsOnAll: block.dependsOn ?? [],
        sql: block.sql,
        filePath: parsed.filePath,
        order: index++,
      });
    }
  }

  return units;
}

function dependenciesMet(applied, dependsOnAll) {
  return (dependsOnAll ?? []).every((dep) => applied.has(dep));
}

function resolveUnits(units, appliedNames) {
  const applied = new Set(appliedNames);
  const emitted = new Set();
  const output = [];
  let pending = [...units];

  while (pending.length > 0) {
    let progress = false;
    const next = [];

    for (const unit of pending) {
      if (emitted.has(unit.id)) {
        continue;
      }

      if (unit.type === "freestanding" || unit.type === "seed") {
        output.push(unit);
        emitted.add(unit.id);
        progress = true;
        continue;
      }

      if (unit.type === "defer") {
        if (!dependenciesMet(applied, unit.dependsOnAll)) {
          emitted.add(unit.id);
          progress = true;
          continue;
        }

        output.push(unit);
        emitted.add(unit.id);
        progress = true;
        continue;
      }

      if (unit.type === "migration_up") {
        if (!dependenciesMet(applied, unit.dependsOnAll)) {
          next.push(unit);
          continue;
        }

        if (applied.has(unit.name)) {
          emitted.add(unit.id);
          progress = true;
          continue;
        }

        output.push(unit);
        output.push({
          id: `${unit.id}:insert`,
          type: "migration_insert",
          name: unit.name,
        });
        applied.add(unit.name);
        emitted.add(unit.id);
        progress = true;
      }
    }

    if (!progress) {
      const waiting = next.map((unit) => {
        const deps = (unit.dependsOnAll ?? []).filter((dep) => !applied.has(dep));
        return `${deps.join(",")} -> ${unit.type} ${unit.name ?? unit.filePath}`;
      });
      throw new Error(`Unresolved // @defer migration dependencies: ${waiting.join(" | ")}`);
    }

    pending = next;
  }

  return output;
}

function renderResolvedUnits(resolved, migrationQualified) {
  const parts = [];

  for (const unit of resolved) {
    if (unit.type === "migration_insert") {
      parts.push(`INSERT INTO ${migrationQualified} (name) VALUES (${sqlLiteral(unit.name)});\n`);
      continue;
    }

    const label = unit.type === "defer"
      ? `defer ${(unit.dependsOnAll ?? []).join(",")} ${unit.filePath}`
      : `${unit.type} ${unit.name ?? unit.filePath}`;

    appendChunk(parts, label, unit.sql);
  }

  return parts.join("\n").trim();
}

function appendDeferredSql(parts, parsedFiles, appliedNames, migrationQualified) {
  const units = collectUnits(parsedFiles, "init", false, { includeDefer: true });
  const resolved = resolveUnits(units, appliedNames);
  const deferSql = renderResolvedUnits(resolved, migrationQualified);
  if (deferSql) {
    parts.push(deferSql);
  }
}

export function compileInit(parsedFiles, appliedNames = [], toolConfig = {}) {
  const migrationQualified = toolConfig.migrationQualified ?? "public.migration";
  const parts = [];

  for (const parsed of parsedFiles) {
    for (const block of parsed.blocks) {
      if (block.kind !== "model") continue;
      appendChunk(parts, `model ${parsed.filePath}`, block.sql);
    }

    appendChunk(parts, `freestanding ${parsed.filePath}`, parsed.freestandingSql);
  }

  appendDeferredSql(parts, parsedFiles, appliedNames, migrationQualified);

  return parts.join("\n").trim();
}

export function compileSeed(parsedFiles, appliedNames = [], toolConfig = {}) {
  const migrationQualified = toolConfig.migrationQualified ?? "public.migration";
  const parts = [];

  for (const parsed of parsedFiles) {
    appendChunk(parts, `freestanding ${parsed.filePath}`, parsed.freestandingSql);
  }

  const units = collectUnits(parsedFiles, "seed", false, { includeDefer: true });
  const resolved = resolveUnits(units, appliedNames);
  const seedSql = renderResolvedUnits(resolved, migrationQualified);
  if (seedSql) {
    parts.push(seedSql);
  }

  return parts.join("\n").trim();
}

export function compileMigrateUp(parsedFiles, appliedNames, toolConfig = {}) {
  const migrationQualified = toolConfig.migrationQualified ?? "public.migration";
  const units = collectUnits(parsedFiles, "migrate:up", true, { includeDefer: true });
  const resolved = resolveUnits(units, [...appliedNames]);
  return renderResolvedUnits(resolved, migrationQualified);
}

export function compileMigrateDown(parsedFiles, appliedNamesOrderedDesc, toolConfig = {}, appliedNames = []) {
  const migrationQualified = toolConfig.migrationQualified ?? "public.migration";
  const downByName = new Map();

  for (const parsed of parsedFiles) {
    for (const block of parsed.blocks) {
      if (block.kind !== "migration_down") continue;
      if (!block.name) {
        throw new Error(`Missing migration:down name in ${parsed.filePath}`);
      }
      downByName.set(block.name, block.sql);
    }
  }

  const parts = [];

  for (const parsed of parsedFiles) {
    appendChunk(parts, `freestanding ${parsed.filePath}`, parsed.freestandingSql);
  }

  appendDeferredSql(parts, parsedFiles, appliedNames, migrationQualified);

  for (const name of appliedNamesOrderedDesc) {
    const sql = downByName.get(name);
    if (!sql) continue;

    appendChunk(parts, `migration:down ${name}`, sql);
    parts.push(`DELETE FROM ${migrationQualified} WHERE name = ${sqlLiteral(name)};\n`);
  }

  return parts.join("\n").trim();
}

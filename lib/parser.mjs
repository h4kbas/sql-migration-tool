import { readFileSync } from "node:fs";

const DIRECTIVE_RE = /^\s*\/\/\s*@([^\s]+)(?:\s+(.*))?\s*$/;

function parseDirective(line) {
  const match = line.match(DIRECTIVE_RE);
  if (!match) return null;

  const token = match[1];
  const arg = match[2]?.trim() || null;

  if (token === "model") {
    return { kind: "model", name: arg };
  }
  if (token === "seed") {
    return { kind: "seed", name: arg };
  }
  if (token === "migration") {
    return { kind: "migration_up", name: arg };
  }
  if (token === "migration:down") {
    return { kind: "migration_down", name: arg };
  }
  if (token === "defer") {
    return { kind: "defer", name: arg };
  }

  return { kind: "other", token };
}

function pushBlock(blocks, block) {
  if (!block) return;
  const sql = block.lines.join("\n").trim();
  if (!sql) return;
  blocks.push({ ...block, sql });
}

export function parseSqlFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  const freestanding = [];
  const blocks = [];
  let current = null;
  let pendingDefers = [];

  for (const line of lines) {
    const directive = parseDirective(line);
    if (directive) {
      if (directive.kind === "other") {
        pushBlock(blocks, current);
        current = null;
        continue;
      }

      if (directive.kind === "defer") {
        if (!directive.name) {
          throw new Error(`Missing name for // @defer in ${filePath}`);
        }

        if (current?.kind === "defer" && current.lines.length > 0) {
          pushBlock(blocks, current);
          current = null;
        } else if (current?.kind && current.kind !== "defer") {
          pushBlock(blocks, current);
          current = null;
        }

        if (current?.kind === "defer") {
          current.dependsOn.push(directive.name);
        } else {
          pendingDefers.push(directive.name);
        }
        continue;
      }

      pushBlock(blocks, current);
      current = {
        kind: directive.kind,
        name: directive.name ?? null,
        dependsOn: [...pendingDefers],
        lines: [],
      };
      pendingDefers = [];
      continue;
    }

    if (current?.kind === "defer" || pendingDefers.length > 0) {
      if (!current || current.kind !== "defer") {
        current = {
          kind: "defer",
          name: null,
          dependsOn: [...pendingDefers],
          lines: [],
        };
        pendingDefers = [];
      }
      current.lines.push(line);
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else {
      freestanding.push(line);
    }
  }

  pushBlock(blocks, current);

  const freestandingSql = freestanding.join("\n").trim();

  return {
    filePath,
    freestandingSql,
    blocks,
    hasDirectives: blocks.length > 0,
  };
}

export function inferBlocksFromFolder(folder, parsed) {
  if (parsed.hasDirectives || parsed.blocks.length > 0) {
    return parsed;
  }

  const sql = [parsed.freestandingSql].filter(Boolean).join("\n").trim();
  if (!sql) {
    return parsed;
  }

  if (folder === "seeds") {
    return {
      ...parsed,
      freestandingSql: "",
      blocks: [{ kind: "seed", name: null, dependsOn: [], sql }],
      hasDirectives: true,
    };
  }

  return parsed;
}

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const INCLUDE_RE = /^\s*\/\/\s*@include\s+(\S+)\s*$/;

function resolveIncludePath(spec, fromFile, projectRoot) {
  if (spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec)) {
    const resolved = path.isAbsolute(spec) ? spec : path.resolve(path.dirname(fromFile), spec);
    if (!existsSync(resolved)) {
      throw new Error(`Include not found: ${spec} (resolved ${resolved})`);
    }
    return resolved;
  }

  const slash = spec.indexOf("/");
  if (slash <= 0) {
    throw new Error(`Invalid include path: ${spec}`);
  }

  const pkg = spec.slice(0, slash);
  const rel = spec.slice(slash + 1);
  let dir = projectRoot;

  while (true) {
    const candidate = path.join(dir, "node_modules", pkg, "sql", rel);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  throw new Error(`Include not found: ${spec} (searched from ${projectRoot})`);
}

export function expandIncludes(filePath, projectRoot, stack = []) {
  const normalized = path.resolve(filePath);
  if (stack.includes(normalized)) {
    throw new Error(`Circular include: ${normalized}`);
  }

  const nextStack = [...stack, normalized];
  const out = [];

  for (const line of readFileSync(normalized, "utf8").split(/\r?\n/)) {
    const match = line.match(INCLUDE_RE);
    if (match) {
      const includedPath = resolveIncludePath(match[1], normalized, projectRoot);
      out.push(expandIncludes(includedPath, projectRoot, nextStack));
      continue;
    }
    out.push(line);
  }

  return out.join("\n");
}

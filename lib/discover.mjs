import { readdirSync, statSync } from "node:fs";
import path from "node:path";

function walkSqlFiles(dir, bucket) {
  for (const entry of readdirSync(dir).sort()) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkSqlFiles(fullPath, bucket);
      continue;
    }
    if (entry.endsWith(".sql")) {
      bucket.push(fullPath);
    }
  }
}

function collectFolderFiles(rootDir, folder, suborders) {
  const baseDir = path.join(rootDir, folder);
  const files = [];

  try {
    statSync(baseDir);
  } catch {
    return files;
  }

  const orderedSubfolders = suborders?.[folder];
  if (orderedSubfolders?.length) {
    for (const subfolder of orderedSubfolders) {
      const dir = path.join(baseDir, subfolder);
      try {
        statSync(dir);
      } catch {
        continue;
      }
      const bucket = [];
      walkSqlFiles(dir, bucket);
      files.push(...bucket);
    }

    for (const entry of readdirSync(baseDir).sort()) {
      const fullPath = path.join(baseDir, entry);
      if (!statSync(fullPath).isDirectory()) {
        if (entry.endsWith(".sql")) {
          files.push(fullPath);
        }
        continue;
      }
      if (orderedSubfolders.includes(entry)) continue;
      const bucket = [];
      walkSqlFiles(fullPath, bucket);
      files.push(...bucket);
    }

    return files;
  }

  const bucket = [];
  walkSqlFiles(baseDir, bucket);
  return bucket;
}

export function discoverSqlFiles(rootDir, folders, suborders = {}) {
  const files = [];

  for (const folder of folders) {
    files.push(...collectFolderFiles(rootDir, folder, suborders));
  }

  return files;
}

export function topLevelFolder(rootDir, filePath, folders) {
  const relative = path.relative(rootDir, filePath);
  const first = relative.split(path.sep)[0];
  if (folders.includes(first)) {
    return first;
  }
  return null;
}

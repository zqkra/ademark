// One folder hash for TASKS.md SHA256 files and the manifest.
// Algorithm: walk the folder, skip .DS_Store, .git and node_modules, collect relative POSIX paths of
// regular files, sort them with the default JS sort (UTF-16 code units), then for each file hash the
// path, a NUL, the file bytes and a NUL again.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIPPED_NAMES = new Set([".DS_Store", ".git", "node_modules"]);

export function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (SKIPPED_NAMES.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return files.sort();
}

export function hashFolder(dir: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(dir)) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// Clean config snapshot and restore for ~/.claude, ~/.codex and ~/.agents (RUNBOOK.md 4.12, METHODOLOGY.md 5).
// Dry run by default; applying is only allowed for the dedicated `ademark` macOS user.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir, userInfo } from "node:os";

export const INCLUDED_PATHS = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/CLAUDE.md",
  ".claude/skills",
  ".claude/plugins",
  ".claude/hooks",
  ".claude/agents",
  ".claude/commands",
  ".codex/config.toml",
  ".codex/AGENTS.md",
  ".codex/hooks.json",
  ".codex/prompts",
  ".agents",
] as const;

export const EXCLUDED_PATHS = [
  ".claude/projects",
  ".claude/todos",
  ".claude/statsig",
  ".claude/.credentials.json",
  ".codex/sessions",
  ".codex/auth.json",
  ".codex/log",
] as const;

export type SnapshotOp =
  | { action: "mkdir"; target: string }
  | { action: "copy"; source: string; target: string }
  | { action: "remove"; target: string };

export interface SnapshotOptions {
  apply?: boolean;
}

export type DiffStatus = "added" | "removed" | "changed";

export interface DiffEntry {
  status: DiffStatus;
  path: string;
}

const APPLY_USER = "ademark";

function isInside(path: string, base: string): boolean {
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  return path === base || path.startsWith(prefix);
}

// A fake home under the OS temp folder is not the owner's config, so tests may apply there.
function isTemporaryHome(home: string): boolean {
  try {
    const real = realpathSync(resolve(home));
    return [realpathSync(tmpdir()), realpathSync("/private/tmp")].some((base) => isInside(real, base));
  } catch {
    return false;
  }
}

function assertApplyAllowed(home: string, options: SnapshotOptions): void {
  if (!options.apply) return;
  const username = userInfo().username;
  if (username === APPLY_USER || isTemporaryHome(home)) return;
  throw new Error(
    `refusing to apply: snapshot restore rewrites ~/.claude, ~/.codex and ~/.agents, ` +
      `which is only allowed as the dedicated "${APPLY_USER}" user (current user: "${username}") ` +
      `or inside a temporary test home. Drop --apply for a dry run.`,
  );
}

function isExcluded(relativePath: string): boolean {
  return (EXCLUDED_PATHS as readonly string[]).some(
    (excluded) => relativePath === excluded || relativePath.startsWith(`${excluded}/`),
  );
}

function hashPath(path: string): string {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    const hash = createHash("sha256");
    for (const child of readdirSync(path).sort()) {
      const childPath = join(path, child);
      const childRel = relative(path, childPath);
      if (isExcluded(childRel)) continue;
      hash.update(childRel);
      hash.update("\0");
      hash.update(hashPath(childPath));
      hash.update("\0");
    }
    return hash.digest("hex");
  }
  if (stat.isSymbolicLink()) return `link:${readFileSync(path, "utf8")}`;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function planCopy(source: string, target: string): SnapshotOp[] {
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    const ops: SnapshotOp[] = [{ action: "mkdir", target }];
    for (const child of readdirSync(source).sort()) {
      const childRel = relative(source, join(source, child));
      if (isExcluded(childRel)) continue;
      ops.push(...planCopy(join(source, child), join(target, child)));
    }
    return ops;
  }
  return [{ action: "copy", source, target }];
}

function applyOps(ops: readonly SnapshotOp[]): void {
  for (const op of ops) {
    if (op.action === "mkdir") mkdirSync(op.target, { recursive: true });
    else if (op.action === "copy") {
      mkdirSync(dirname(op.target), { recursive: true });
      cpSync(op.source, op.target, { recursive: true, force: true });
    } else {
      rmSync(op.target, { recursive: true, force: true });
    }
  }
}

function includedHomePaths(home: string): Array<{ rel: string; homePath: string }> {
  return INCLUDED_PATHS.map((rel) => ({ rel, homePath: join(home, rel) }));
}

export function save(snapshotDir: string, home: string = homedir(), options: SnapshotOptions = {}): SnapshotOp[] {
  assertApplyAllowed(home, options);
  const root = resolve(snapshotDir);
  const ops: SnapshotOp[] = [{ action: "mkdir", target: root }];
  for (const { rel, homePath } of includedHomePaths(home)) {
    if (!existsSync(homePath)) continue;
    ops.push(...planCopy(homePath, join(root, rel)));
  }
  if (options.apply) applyOps(ops);
  return ops;
}

export function restore(snapshotDir: string, home: string = homedir(), options: SnapshotOptions = {}): SnapshotOp[] {
  assertApplyAllowed(home, options);
  const root = resolve(snapshotDir);
  if (!existsSync(root)) throw new Error(`restore: snapshot folder does not exist: ${root}`);
  const ops: SnapshotOp[] = [];
  for (const { rel, homePath } of includedHomePaths(home)) {
    const snapPath = join(root, rel);
    const homeExists = existsSync(homePath);
    const snapExists = existsSync(snapPath);
    if (snapExists) {
      if (homeExists) ops.push({ action: "remove", target: homePath });
      ops.push(...planCopy(snapPath, homePath));
    } else if (homeExists) {
      ops.push({ action: "remove", target: homePath });
    }
  }
  if (options.apply) applyOps(ops);
  return ops;
}

function collectHashes(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const child of readdirSync(dir).sort()) {
      const childRel = prefix ? `${prefix}/${child}` : child;
      if (isExcluded(childRel)) continue;
      const path = join(dir, child);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path, childRel);
      else out.set(childRel, hashPath(path));
    }
  };
  for (const rel of INCLUDED_PATHS) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    if (lstatSync(path).isDirectory()) walk(path, rel);
    else out.set(rel, hashPath(path));
  }
  return out;
}

export function diff(snapshotDir: string, home: string = homedir()): DiffEntry[] {
  const root = resolve(snapshotDir);
  if (!existsSync(root)) throw new Error(`diff: snapshot folder does not exist: ${root}`);
  const snap = collectHashes(root);
  const live = collectHashes(home);
  const entries: DiffEntry[] = [];
  for (const [path, hash] of live) {
    const other = snap.get(path);
    if (other === undefined) entries.push({ status: "added", path });
    else if (other !== hash) entries.push({ status: "changed", path });
  }
  for (const path of snap.keys()) {
    if (!live.has(path)) entries.push({ status: "removed", path });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}


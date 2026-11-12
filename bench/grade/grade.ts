import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TZ_GROUP,
  isDirectory,
  isGroupId,
  parseTap,
} from "./groups.ts";
import type { GradeGroup, GradeResult, TaskSpec } from "../core/contracts.ts";
import { privateRoot, repoRoot, tasksRoot } from "../core/paths.ts";
import { generateHandoffCodes, loadTaskDir } from "../core/tasks.ts";

export const GROUP_TIMEOUT_MS = 120_000;
export const VALIDATION_SEED = "ademark-validation";
// Per user on macOS: the pilot left a /tmp root owned by the ademark user, so grading failed for anyone else.
export const GRADE_ROOT = join(tmpdir(), "ademark-grade");

export interface NodeInfo {
  path: string;
  version: string;
}

export interface DiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
}

export interface DiffStats {
  base: string;
  empty: boolean;
  added: number;
  modified: number;
  deleted: number;
  files: DiffEntry[];
}

export interface GroupRun {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

export interface GradeOutput extends GradeResult {
  node: NodeInfo;
  diff: DiffStats;
  tests_modified: boolean;
  changed_tests: string[];
  base: string;
  workdir: string;
  output: Record<string, GroupRun>;
}

const IGNORED_NAMES = new Set([".git", "node_modules", ".DS_Store", "test-hidden"]);

function findOnPath(command: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, command);
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // an unreadable path entry is not the binary
      }
    }
  }
  return null;
}

export function nodeEnv(node: NodeInfo): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(node.path)}:/usr/bin:/bin`,
    HOME: process.env.HOME ?? homedir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: "en_US.UTF-8",
    TZ: "UTC",
  };
}

export function resolveNodeBinary(): NodeInfo {
  const requested = process.env.ADEMARK_NODE?.trim();
  let candidate: string | null;
  if (requested !== undefined && requested !== "") {
    candidate = requested.includes("/") ? resolve(requested) : findOnPath(requested);
  } else {
    candidate = findOnPath("node");
  }
  if (candidate === null || !existsSync(candidate)) {
    throw new Error(
      requested !== undefined && requested !== ""
        ? `ADEMARK_NODE not found: ${requested}`
        : "node not found on PATH",
    );
  }

  const absolute = resolve(candidate);
  const checked = spawnSync(absolute, ["--version"], {
    encoding: "utf8",
    env: nodeEnv({ path: absolute, version: "" }),
    timeout: 10_000,
  });
  const version = checked.stdout?.trim() ?? "";
  if (checked.status !== 0 || version === "") {
    throw new Error(`could not read the version of ${absolute}: ${checked.stderr ?? ""}`);
  }
  return { path: absolute, version };
}

function treeFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(relative(root, full).split("\\").join("/"));
    }
  };
  walk(root);
  return files.sort();
}

function sameBytes(left: string, right: string): boolean {
  return readFileSync(left).equals(readFileSync(right));
}

export function diffTrees(baseDir: string, workDir: string): DiffStats {
  const baseFiles = new Set(treeFiles(baseDir));
  const workFiles = new Set(treeFiles(workDir));
  const files: DiffEntry[] = [];

  for (const file of [...baseFiles].sort()) {
    if (!workFiles.has(file)) files.push({ path: file, status: "deleted" });
    else if (!sameBytes(join(baseDir, file), join(workDir, file))) {
      files.push({ path: file, status: "modified" });
    }
  }
  for (const file of [...workFiles].sort()) {
    if (!baseFiles.has(file)) files.push({ path: file, status: "added" });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const added = files.filter((entry) => entry.status === "added").length;
  const modified = files.filter((entry) => entry.status === "modified").length;
  const deleted = files.filter((entry) => entry.status === "deleted").length;
  return {
    base: baseDir,
    empty: added + modified + deleted === 0,
    added,
    modified,
    deleted,
    files,
  };
}

export function changedVisibleTests(baseDir: string, workDir: string): string[] {
  const baseTest = join(baseDir, "test");
  if (!isDirectory(baseTest)) return [];
  const changed: string[] = [];
  for (const relativePath of treeFiles(baseTest)) {
    const workPath = join(workDir, "test", relativePath);
    const basePath = join(baseTest, relativePath);
    if (!existsSync(workPath) || !sameBytes(basePath, workPath)) changed.push(relativePath);
  }
  return changed;
}

export function analyzeWorktree(baseDir: string, workDir: string) {
  const diff = diffTrees(baseDir, workDir);
  const changedTests = changedVisibleTests(baseDir, workDir);
  return { diff, testsModified: changedTests.length > 0, changedTests };
}

export function copyTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function extractGitRef(ref: string): string {
  const directory = mkdtempSync(join(tmpdir(), "ademark-base-"));
  const archive = spawnSync("git", ["archive", ref, "arena"], {
    cwd: repoRoot,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (archive.status !== 0) {
    throw new Error(`git archive ${ref} failed: ${archive.stderr.toString()}`);
  }
  const tarball = join(directory, "arena.tar");
  writeFileSync(tarball, archive.stdout);
  const extracted = spawnSync("tar", ["-xf", tarball, "-C", directory], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (extracted.status !== 0) {
    throw new Error(`tar failed for base ${ref}: ${extracted.stderr.toString()}`);
  }
  return join(directory, "arena");
}

export function resolveBase(baseArg: string | undefined): string {
  if (!baseArg) return extractGitRef("HEAD");
  const candidate = resolve(baseArg);
  if (isDirectory(candidate)) return candidate;
  return extractGitRef(baseArg);
}

// A bare flag takes no value and parses as "true"; every other option still needs one.
const FLAG_NAMES = new Set(["write-hashes", "all"]);

export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const equals = token.indexOf("=");
    if (equals !== -1) {
      args[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const name = token.slice(2);
    if (FLAG_NAMES.has(name)) {
      args[name] = "true";
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    args[name] = value;
    index += 1;
  }
  return args;
}

export function handoffCodesFromEnv(): string | null {
  if (process.env.ADEMARK_HANDOFF_CODES) return process.env.ADEMARK_HANDOFF_CODES;
  const seed = process.env.ADEMARK_HANDOFF_SEED;
  return seed ? JSON.stringify(generateHandoffCodes(seed)) : null;
}

function groupTestFiles(workdir: string, group: string): string[] {
  const directory = join(workdir, "test-hidden", group);
  if (!isDirectory(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => `test-hidden/${group}/${name}`);
}

function failedGroups(
  task: TaskSpec,
  reason: string,
  missingHandoffCodes = false,
): GradeGroup[] {
  return task.grade_groups.map((id) => ({
    id,
    passed: 0,
    total: 1,
    failed: [id === "C1-handoff" && missingHandoffCodes ? "missing handoff codes" : reason],
  }));
}

export function runGroup(
  workdir: string,
  group: string,
  files: string[],
  codes: string | null,
  node: NodeInfo,
): { result: GradeGroup; run: GroupRun } {
  const env = nodeEnv(node);
  if (codes !== null) env.ADEMARK_HANDOFF_CODES = codes;
  let args: string[];
  if (group === TZ_GROUP) {
    args = ["--test", "--test-reporter=tap", join(repoRoot, "bench", "grade", "run-tz.ts")];
    env.ADEMARK_TZ_FILES = files.join("\n");
  } else {
    args = ["--test", "--test-reporter=tap", ...files];
  }

  const started = Date.now();
  const spawned = spawnSync(node.path, args, {
    cwd: workdir,
    env,
    encoding: "utf8",
    timeout: GROUP_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 128 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const timedOut =
    (spawned.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
    spawned.signal === "SIGKILL";
  const stdout = spawned.stdout ?? "";
  const stderr = spawned.stderr ?? "";
  const combined = `${stdout}${stderr}`;
  const summary = parseTap(stdout.trim() === "" ? combined : stdout);
  const failed = [...summary.failed];
  if (timedOut) failed.push(`timed out after ${GROUP_TIMEOUT_MS / 1000}s`);
  if (!timedOut && spawned.status !== 0 && failed.length === 0) {
    failed.push(`node --test exited with ${spawned.status ?? "no status"}`);
  }
  if (spawned.error && !timedOut) failed.push(spawned.error.message);
  if (summary.total === 0 && failed.length === 0) failed.push("no tests ran");

  return {
    result: {
      id: group,
      passed: failed.length === 0 ? summary.passed : Math.min(summary.passed, summary.total),
      total: summary.total,
      failed,
    },
    run: {
      command: [node.path, ...args].join(" "),
      exitCode: spawned.status,
      timedOut,
      durationMs,
      output: combined,
    },
  };
}

export interface GradeTaskOptions {
  taskId: string;
  worktree: string;
  base?: string;
  out: string;
  taskDir?: string;
  hiddenTests?: string;
  node?: NodeInfo;
}

export function gradeTask(options: GradeTaskOptions): GradeOutput {
  const node = options.node ?? resolveNodeBinary();
  const taskDir = options.taskDir ?? join(tasksRoot(), options.taskId);
  const task = loadTaskDir(taskDir, options.taskId);
  if (task.id !== options.taskId) {
    throw new Error(`task.toml id ${task.id} does not match ${options.taskId}`);
  }
  const base = resolveBase(options.base);
  const root = GRADE_ROOT;
  mkdirSync(root, { recursive: true });
  const workdir = join(root, randomUUID());
  mkdirSync(workdir, { recursive: true });
  copyTree(resolve(options.worktree), workdir);

  const { diff, testsModified, changedTests } = analyzeWorktree(base, workdir);
  const codes = handoffCodesFromEnv();
  const missingHandoffCodes = task.grade_groups.includes("C1-handoff") && codes === null;
  const reasons: string[] = [];
  if (diff.empty) reasons.push("empty diff");
  if (testsModified) reasons.push("tests modified");
  if (missingHandoffCodes) reasons.push("missing handoff codes");

  const hiddenTests = options.hiddenTests ?? join(privateRoot(), "tasks", options.taskId, "tests");
  if (!isDirectory(hiddenTests)) {
    const invalid: GradeOutput = {
      task: options.taskId,
      groups: failedGroups(task, "missing hidden tests", missingHandoffCodes),
      valid: false,
      reasons: ["missing hidden tests", ...(missingHandoffCodes ? ["missing handoff codes"] : [])],
      node,
      diff,
      tests_modified: testsModified,
      changed_tests: changedTests,
      base,
      workdir,
      output: {},
    };
    writeResult(options.out, invalid);
    return invalid;
  }

  if (diff.empty) {
    const empty: GradeOutput = {
      task: options.taskId,
      groups: failedGroups(task, "empty diff", missingHandoffCodes),
      valid: !missingHandoffCodes,
      reasons,
      node,
      diff,
      tests_modified: testsModified,
      changed_tests: changedTests,
      base,
      workdir,
      output: {},
    };
    writeResult(options.out, empty);
    return empty;
  }

  rmSync(join(workdir, "test"), { recursive: true, force: true });
  copyTree(join(base, "test"), join(workdir, "test"));
  copyTree(hiddenTests, join(workdir, "test-hidden"));

  const groups: GradeGroup[] = [];
  const output: Record<string, GroupRun> = {};
  let valid = !missingHandoffCodes;

  for (const group of task.grade_groups) {
    if (!isGroupId(group)) {
      valid = false;
      reasons.push(`unknown group ${group}`);
      groups.push({ id: group, passed: 0, total: 1, failed: [`unknown group ${group}`] });
      continue;
    }
    if (group === "C1-handoff" && missingHandoffCodes) {
      groups.push({ id: group, passed: 0, total: 1, failed: ["missing handoff codes"] });
      continue;
    }
    const files = groupTestFiles(workdir, group);
    if (files.length === 0) {
      valid = false;
      reasons.push(`missing hidden tests for ${group}`);
      groups.push({ id: group, passed: 0, total: 1, failed: ["missing hidden tests"] });
      continue;
    }
    const { result, run } = runGroup(workdir, group, files, codes, node);
    groups.push(result);
    output[group] = run;
  }

  const grade: GradeOutput = {
    task: options.taskId,
    groups,
    valid,
    reasons,
    node,
    diff,
    tests_modified: testsModified,
    changed_tests: changedTests,
    base,
    workdir,
    output,
  };
  writeResult(options.out, grade);
  return grade;
}

function writeResult(out: string, result: GradeOutput): void {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}

function usage(): string {
  return "usage: bun bench/grade/grade.ts --task <id> --worktree <path> --out <file> [--base <path-or-ref>]";
}

function fallbackNode(): NodeInfo {
  try {
    return resolveNodeBinary();
  } catch {
    return { path: process.env.ADEMARK_NODE ?? "node", version: "" };
  }
}

function main(argv: string[]): void {
  let out = "";
  let taskId = "";
  try {
    const args = parseArgs(argv);
    taskId = args.task ?? "";
    const worktree = args.worktree ?? "";
    out = args.out ?? "";
    if (!taskId || !worktree || !out) throw new Error(usage());
    const result = gradeTask({ taskId, worktree, out, base: args.base });
    const failed = result.groups.filter((group) => group.failed.length > 0);
    console.log(
      `${result.task}: ${result.groups.length - failed.length}/${result.groups.length} groups passed` +
        (result.valid ? "" : " (invalid)") +
        (result.reasons.length > 0 ? ` [${result.reasons.join(", ")}]` : ""),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`grade failed: ${message}`);
    if (out) {
      const invalid: GradeOutput = {
        task: taskId,
        groups: [],
        valid: false,
        reasons: [message],
        node: fallbackNode(),
        diff: { base: "", empty: false, added: 0, modified: 0, deleted: 0, files: [] },
        tests_modified: false,
        changed_tests: [],
        base: "",
        workdir: "",
        output: {},
      };
      writeResult(out, invalid);
    }
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

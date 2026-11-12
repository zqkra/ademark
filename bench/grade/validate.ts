import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GROUP_TIMEOUT_MS,
  VALIDATION_SEED,
  copyTree,
  parseArgs,
  resolveBase,
  resolveNodeBinary,
} from "./grade.ts";
import type { GradeOutput, NodeInfo } from "./grade.ts";
import type { TaskSpec } from "../core/contracts.ts";
import { hashFolder } from "../core/hash.ts";
import { privateRoot, repoRoot } from "../core/paths.ts";
import { loadTask } from "../core/tasks.ts";
import { discoverTaskIds, isDirectory } from "./groups.ts";

interface Candidate {
  label: string;
  directory: string;
  kind: "pristine" | "solution" | "mutant" | "touched";
}

interface Row {
  task: string;
  candidate: string;
  groups: string;
  flags: string;
  expected: string;
  ok: boolean;
  problems: string[];
}

function groupPassed(group: { passed: number; total: number; failed: string[] }): boolean {
  return group.total > 0 && group.passed === group.total && group.failed.length === 0;
}

function candidateDirectories(taskId: string, touched: string): Candidate[] {
  const root = join(privateRoot(), "tasks", taskId);
  const candidates: Candidate[] = [
    { label: "pristine", directory: join(repoRoot, "arena"), kind: "pristine" },
    { label: "solution-a", directory: join(root, "solution-a"), kind: "solution" },
    { label: "solution-b", directory: join(root, "solution-b"), kind: "solution" },
    { label: "mutant/touched", directory: touched, kind: "touched" },
  ];
  const mutants = join(root, "mutants");
  if (isDirectory(mutants)) {
    for (const name of readdirSync(mutants).sort()) {
      const directory = join(mutants, name);
      if (isDirectory(directory)) candidates.push({ label: `mutant/${name}`, directory, kind: "mutant" });
    }
  }
  return candidates.filter((candidate) => existsSync(candidate.directory));
}

function runGrade(taskId: string, worktree: string, out: string, node: NodeInfo): GradeOutput {
  const gradeScript = join(repoRoot, "bench", "grade", "grade.ts");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ADEMARK_NODE: node.path,
    ADEMARK_HANDOFF_SEED: VALIDATION_SEED,
  };
  delete env.ADEMARK_HANDOFF_CODES;
  const spawned = spawnSync(
    process.execPath,
    [
      gradeScript,
      "--task",
      taskId,
      "--worktree",
      worktree,
      "--base",
      join(repoRoot, "arena"),
      "--out",
      out,
    ],
    { encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env },
  );
  if (spawned.status !== 0) {
    throw new Error(
      `grade ${taskId} ${worktree} failed: ${spawned.stdout ?? ""}${spawned.stderr ?? ""}`,
    );
  }
  return JSON.parse(readFileSync(out, "utf8")) as GradeOutput;
}

function checkGroupList(toml: TaskSpec, result: GradeOutput): string[] {
  const expected = toml.grade_groups;
  const actual = result.groups.map((group) => group.id);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    return [`groups differ: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  return [];
}

function checkDurations(result: GradeOutput): string[] {
  const problems: string[] = [];
  for (const [group, run] of Object.entries(result.output)) {
    if (run.durationMs > GROUP_TIMEOUT_MS) {
      problems.push(`${group} took ${run.durationMs} ms`);
    }
  }
  return problems;
}

function evaluate(toml: TaskSpec, candidate: Candidate, result: GradeOutput): Row {
  const problems = [...checkGroupList(toml, result), ...checkDurations(result)];
  const flags = result.reasons.length > 0 ? result.reasons.join(", ") : "-";
  const passedGroups = result.groups.filter(groupPassed).length;
  const groups = `${passedGroups}/${result.groups.length}`;
  const allPassed = passedGroups === result.groups.length && result.groups.length > 0;
  const anyFailed = result.groups.some((group) => !groupPassed(group));
  let expected = "";
  let ok = true;

  if (!result.valid) {
    ok = false;
    problems.push("grader returned valid=false");
  }

  if (candidate.kind === "pristine") {
    expected = "fail every group (empty diff)";
    const flagged = result.reasons.includes("empty diff");
    if (!flagged || !anyFailed) ok = false;
    if (!flagged) problems.push("pristine was not flagged empty diff");
    if (!anyFailed) problems.push("pristine passed a group");
  } else if (candidate.kind === "solution") {
    expected = "pass every group";
    if (!allPassed) {
      ok = false;
      problems.push(`solution did not pass every group (${groups})`);
    }
    if (result.reasons.length > 0) {
      ok = false;
      problems.push(`solution has flags: ${flags}`);
    }
  } else if (candidate.kind === "touched") {
    expected = "no empty diff; every group fails";
    if (result.reasons.includes("empty diff")) {
      ok = false;
      problems.push("touched was flagged empty diff");
    }
    if (!anyFailed) {
      ok = false;
      problems.push("touched passed a group");
    }
  } else {
    expected = "fail a group or be flagged";
    const flagged = result.reasons.includes("empty diff") || result.reasons.includes("tests modified");
    if (!flagged && !anyFailed) {
      ok = false;
      problems.push("mutant passed every group and was not flagged");
    }
  }

  return {
    task: toml.id,
    candidate: candidate.label,
    groups,
    flags,
    expected,
    ok,
    problems,
  };
}

function hashLines(path: string): Array<{ hash: string; label: string }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const match = /^([0-9a-f]{64})  (\S+)$/.exec(line);
      if (!match) throw new Error(`bad SHA256 line in ${path}: ${line}`);
      return { hash: match[1]!, label: match[2]! };
    });
}

function writeHashFile(path: string, entries: Array<{ hash: string; label: string }>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => `${entry.hash}  ${entry.label}`).join("\n")}\n`);
}

function checkHashes(taskId: string, write: boolean): string[] {
  const problems: string[] = [];
  const repoTask = join(repoRoot, "tasks", taskId);
  const privateTask = join(privateRoot(), "tasks", taskId);
  const expectedEntries = [
    { label: "tests", folder: join(privateTask, "tests"), file: join(repoTask, "tests", "SHA256") },
    { label: "solution-a", folder: join(privateTask, "solution-a"), file: join(repoTask, "solution", "SHA256") },
    { label: "solution-b", folder: join(privateTask, "solution-b"), file: join(repoTask, "solution", "SHA256") },
  ].filter((entry) => isDirectory(entry.folder));

  const solutionEntries: Array<{ hash: string; label: string }> = [];
  for (const entry of expectedEntries) {
    const hash = hashFolder(entry.folder);
    if (entry.label === "tests") {
      if (write) writeHashFile(entry.file, [{ hash, label: "tests" }]);
      else {
        const lines = hashLines(entry.file);
        if (lines.length !== 1 || lines[0]!.label !== "tests" || lines[0]!.hash !== hash) {
          problems.push(`tests/SHA256 is missing or stale`);
        }
      }
    } else {
      solutionEntries.push({ hash, label: entry.label });
    }
  }

  const solutionFile = join(repoTask, "solution", "SHA256");
  if (write && solutionEntries.length > 0) writeHashFile(solutionFile, solutionEntries);
  if (!write && solutionEntries.length > 0) {
    const lines = hashLines(solutionFile);
    for (const expected of solutionEntries) {
      const found = lines.find((line) => line.label === expected.label);
      if (!found || found.hash !== expected.hash) {
        problems.push(`solution/SHA256 is missing or stale for ${expected.label}`);
      }
    }
  }
  return problems;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function printTable(rows: Row[]): void {
  const columns = ["task", "candidate", "groups", "flags", "expected", "result"];
  const widths = columns.map((column, index) => {
    const values = rows.map((row) =>
      index === 0 ? row.task : index === 1 ? row.candidate : index === 2 ? row.groups : index === 3 ? row.flags : index === 4 ? row.expected : row.ok ? "ok" : "FAIL",
    );
    return Math.max(column.length, ...values.map((value) => value.length));
  });

  const line = (values: string[]) =>
    values.map((value, index) => pad(value, widths[index]!)).join("  ");
  console.log(line(columns));
  console.log(line(widths.map((width) => "-".repeat(width))));
  for (const row of rows) {
    console.log(
      line([
        row.task,
        row.candidate,
        row.groups,
        row.flags,
        row.expected,
        row.ok ? "ok" : "FAIL",
      ]),
    );
  }
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const write = args["write-hashes"] === "true";
  const onlyTask = typeof args.task === "string" ? args.task : null;
  const node = resolveNodeBinary();
  console.log(`node ${node.path} ${node.version}`);
  const tasks = discoverTaskIds().filter((taskId) => {
    if (onlyTask !== null && taskId !== onlyTask) return false;
    return isDirectory(join(privateRoot(), "tasks", taskId, "tests"));
  });
  if (tasks.length === 0) {
    console.error("no tasks with private hidden tests found");
    process.exitCode = 1;
    return;
  }

  const artifacts = mkdtempSync(join(tmpdir(), "ademark-validate-"));
  const touched = join(artifacts, "touched");
  copyTree(resolveBase(undefined), touched);
  appendFileSync(join(touched, "src", "server.ts"), "// touched\n");
  const rows: Row[] = [];
  const allProblems: string[] = [];

  for (const taskId of tasks) {
    const toml = loadTask(taskId);
    const problems = checkHashes(taskId, write);
    for (const problem of problems) allProblems.push(`${taskId}: ${problem}`);

    for (const candidate of candidateDirectories(taskId, touched)) {
      const out = join(artifacts, `${taskId}-${candidate.label.replaceAll("/", "_")}.json`);
      const result = runGrade(taskId, candidate.directory, out, node);
      const row = evaluate(toml, candidate, result);
      rows.push(row);
      for (const problem of row.problems) allProblems.push(`${taskId} ${candidate.label}: ${problem}`);
    }
  }

  printTable(rows);
  if (allProblems.length > 0) {
    console.log("");
    for (const problem of allProblems) console.log(`FAIL: ${problem}`);
    console.log(`\nartifacts: ${artifacts}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nall expected results hold; artifacts: ${artifacts}`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

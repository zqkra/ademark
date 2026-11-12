import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPrompts } from "./check-prompts.ts";
import { analyzeWorktree, gradeTask, handoffCodesFromEnv, parseArgs, resolveNodeBinary, runGroup } from "./grade.ts";
import { parseTap } from "./groups.ts";
import { repoRoot } from "../core/paths.ts";
import { generateHandoffCodes, loadTask } from "../core/tasks.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ademark-unit-"));
}

function fill(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = join(root, relative);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const relative of ["AGENTS.md", "src/a.ts", "test/x.test.ts"]) {
    mkdirSync(join(target, relative, ".."), { recursive: true });
    copyFileSync(join(source, relative), join(target, relative));
    mkdirSync(join(target, "test"), { recursive: true });
  }
}

function copyDirectory(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

describe("argument parsing", () => {
  test("reads value options and flags without values", () => {
    expect(parseArgs(["--task", "C1", "--worktree", "/tmp/w", "--out", "/tmp/o.json"])).toEqual({
      task: "C1",
      worktree: "/tmp/w",
      out: "/tmp/o.json",
    });
    expect(parseArgs(["--write-hashes"])).toEqual({ "write-hashes": "true" });
    expect(parseArgs(["--all"])).toEqual({ all: "true" });
    expect(parseArgs(["--write-hashes", "--all"])).toEqual({ "write-hashes": "true", all: "true" });
    expect(parseArgs(["--base=v1"])).toEqual({ base: "v1" });
    expect(parseArgs(["--write-hashes=true"])).toEqual({ "write-hashes": "true" });
  });

  test("still refuses a value flag without a value", () => {
    expect(() => parseArgs(["--task"])).toThrow(/missing value for --task/);
    expect(() => parseArgs(["--task", "--all"])).toThrow(/missing value for --task/);
    expect(() => parseArgs(["--unknown"])).toThrow(/missing value for --unknown/);
    expect(() => parseArgs(["nope"])).toThrow(/unexpected argument: nope/);
  });
});

describe("TAP parsing", () => {
  test("counts passed and failed test points", () => {
    const output = [
      "TAP version 13",
      "ok 1 - first",
      "not ok 2 - second",
      "  ---",
      "  error: nope",
      "  ...",
      "1..2",
      "# tests 2",
      "# pass 1",
      "# fail 1",
    ].join("\n");
    const parsed = parseTap(output);
    expect(parsed.total).toBe(2);
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toEqual(["second"]);
  });

  test("counts skipped tests apart", () => {
    const parsed = parseTap("ok 1 - later # SKIP\n1..1\n");
    expect(parsed.total).toBe(1);
    expect(parsed.passed).toBe(0);
    expect(parsed.skipped).toBe(1);
    expect(parsed.failed).toEqual([]);
  });

  test("handles two file plans in one stream", () => {
    const parsed = parseTap("ok 1 - a\n1..1\nok 1 - b\n1..1\n");
    expect(parsed.total).toBe(2);
    expect(parsed.passed).toBe(2);
  });

  test("ignores nested subtest lines", () => {
    const parsed = parseTap("    ok 1 - nested\nnot ok 1 - outer\n1..1\n");
    expect(parsed.total).toBe(1);
    expect(parsed.failed).toEqual(["outer"]);
  });
});

describe("handoff codes", () => {
  test("the validation seed produces the published vectors", () => {
    expect(generateHandoffCodes("ademark-validation")).toEqual({
      W1: "ADM-W1-ZAKIR2",
      W2: "ADM-W2-MTBMUN",
      W3: "ADM-W3-CB3PHC",
      W4: "ADM-W4-SOFZXV",
    });
  });

  test("handoffCodesFromEnv prefers explicit codes and renders the seed otherwise", () => {
    const previousCodes = process.env.ADEMARK_HANDOFF_CODES;
    const previousSeed = process.env.ADEMARK_HANDOFF_SEED;
    try {
      delete process.env.ADEMARK_HANDOFF_CODES;
      delete process.env.ADEMARK_HANDOFF_SEED;
      expect(handoffCodesFromEnv()).toBeNull();

      process.env.ADEMARK_HANDOFF_SEED = "ademark-validation";
      expect(handoffCodesFromEnv()).toBe(JSON.stringify(generateHandoffCodes("ademark-validation")));

      process.env.ADEMARK_HANDOFF_CODES = "explicit";
      expect(handoffCodesFromEnv()).toBe("explicit");
    } finally {
      if (previousCodes === undefined) delete process.env.ADEMARK_HANDOFF_CODES;
      else process.env.ADEMARK_HANDOFF_CODES = previousCodes;
      if (previousSeed === undefined) delete process.env.ADEMARK_HANDOFF_SEED;
      else process.env.ADEMARK_HANDOFF_SEED = previousSeed;
    }
  });
});

describe("task loading", () => {
  test("C1 has the full group list and the chat lock probe", () => {
    const task = loadTask("C1-orchestrated-build");
    expect(task.id).toBe("C1-orchestrated-build");
    expect(task.version).toBe("1.0.0");
    expect(task.time_cap_s).toBe(2700);
    expect(task.chat_lock_probe).toBe(true);
    expect(task.grade_groups).toEqual([
      "W1-limiter",
      "W1-api",
      "W2-dates",
      "W3-cursor",
      "W4-create",
      "W4-idempotency",
      "Integration",
      "C1-handoff",
    ]);
  });

  test("C1-solo uses the same groups without the C3 probe", () => {
    const task = loadTask("C1-solo");
    expect(task.time_cap_s).toBe(2700);
    expect(task.chat_lock_probe).toBe(false);
    expect(task.grade_groups.length).toBe(8);
  });

  test("C2 has three timed follow-ups", () => {
    const task = loadTask("C2-message-delivery");
    expect(task.time_cap_s).toBe(900);
    expect(task.chat_lock_probe).toBe(true);
    expect(task.grade_groups).toEqual(["W1-limiter", "W1-api", "C2-F1", "C2-F2", "C2-F3"]);
    expect(task.followups.map(({ id, at_s, file }) => ({ id, at_s, file }))).toEqual([
      { id: "C2-F1", at_s: 30, file: "followups/F1.md" },
      { id: "C2-F2", at_s: 90, file: "followups/F2.md" },
      { id: "C2-F3", at_s: 150, file: "followups/F3.md" },
    ]);
    expect(task.followup_policy).toEqual({
      refused_retry_every_s: 1,
      refused_give_up_s: 10,
    });
  });

  test("the fault tasks carry their fault and recovery", () => {
    const killed = loadTask("C4-agent-killed");
    expect(killed.faults).toEqual([{ kind: "kill-agent", at_s: 90, duration_s: null }]);
    expect(killed.recovery).toEqual({ wait_s: 60, message: "continue" });
    expect(killed.grade_groups).toEqual(["W3-cursor"]);
    expect(killed.time_cap_s).toBe(900);

    const cut = loadTask("C5-network-cut");
    expect(cut.faults).toEqual([{ kind: "cut-network", at_s: 90, duration_s: 30 }]);

    const restart = loadTask("C6-app-restart");
    expect(restart.faults).toEqual([{ kind: "restart-app", at_s: 90, duration_s: null }]);
  });

  test("B1 repeats three times and B3 defaults to one", () => {
    const b1 = loadTask("B1-hello");
    expect(b1.time_cap_s).toBe(120);
    expect(b1.repeats).toBe(3);
    expect(b1.grade_groups).toEqual([]);

    const b3 = loadTask("B3-real-prompt");
    expect(b3.time_cap_s).toBe(300);
    expect(b3.repeats).toBe(1);
  });

  test("the fault prompts are byte-identical", () => {
    const prompts = ["C4-agent-killed", "C5-network-cut", "C6-app-restart"].map((task) =>
      readFileSync(join(repoRoot, "tasks", task, "prompt.md"), "utf8"),
    );
    expect(prompts[0]).toBe(prompts[1]!);
    expect(prompts[1]).toBe(prompts[2]!);
  });
});

describe("worktree analysis", () => {
  test("an identical tree is an empty diff", () => {
    const root = tempDir();
    try {
      const base = join(root, "base");
      const work = join(root, "work");
      fill(base, {
        "AGENTS.md": "rules\n",
        "src/a.ts": "export const a = 1;\n",
        "test/x.test.ts": "test\n",
      });
      copyTree(base, work);
      const analysis = analyzeWorktree(base, work);
      expect(analysis.diff.empty).toBe(true);
      expect(analysis.testsModified).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a changed source file makes the diff non-empty", () => {
    const root = tempDir();
    try {
      const base = join(root, "base");
      const work = join(root, "work");
      fill(base, {
        "AGENTS.md": "rules\n",
        "src/a.ts": "export const a = 1;\n",
        "test/x.test.ts": "test\n",
      });
      copyTree(base, work);
      writeFileSync(join(work, "src/a.ts"), "export const a = 2;\n");
      const analysis = analyzeWorktree(base, work);
      expect(analysis.diff.empty).toBe(false);
      expect(analysis.diff.modified).toBe(1);
      expect(analysis.testsModified).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a changed visible test is flagged and a new one is not", () => {
    const root = tempDir();
    try {
      const base = join(root, "base");
      const work = join(root, "work");
      fill(base, {
        "AGENTS.md": "rules\n",
        "src/a.ts": "export const a = 1;\n",
        "test/x.test.ts": "test\n",
      });
      copyTree(base, work);
      writeFileSync(join(work, "test/x.test.ts"), "changed\n");
      writeFileSync(join(work, "test/new.test.ts"), "new\n");
      const analysis = analyzeWorktree(base, work);
      expect(analysis.testsModified).toBe(true);
      expect(analysis.changedTests).toEqual(["x.test.ts"]);
      expect(analysis.diff.added).toBe(1);
      expect(analysis.diff.modified).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a deleted visible test is flagged", () => {
    const root = tempDir();
    try {
      const base = join(root, "base");
      const work = join(root, "work");
      fill(base, {
        "AGENTS.md": "rules\n",
        "src/a.ts": "export const a = 1;\n",
        "test/x.test.ts": "test\n",
      });
      copyTree(base, work);
      rmSync(join(work, "test/x.test.ts"));
      const analysis = analyzeWorktree(base, work);
      expect(analysis.testsModified).toBe(true);
      expect(analysis.changedTests).toEqual(["x.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prompt files", () => {
  test("every prompt and follow-up matches TASKS.md as bytes", () => {
    const checks = checkPrompts(repoRoot);
    expect(checks.length).toBe(11);
    expect(checks.filter((check) => !check.ok)).toEqual([]);
  });
});

describe("grading environment", () => {
  test("resolves one absolute node binary and its version", () => {
    const node = resolveNodeBinary();
    expect(node.path.startsWith("/")).toBe(true);
    expect(node.version).toMatch(/^v\d+\./);
  });

  test("graded code sees only the minimal environment", () => {
    const root = tempDir();
    const previousNodeOptions = process.env.NODE_OPTIONS;
    const previousLeak = process.env.ADEMARK_LEAK;
    try {
      writeFileSync(
        join(root, "env.test.ts"),
        [
          'import test from "node:test";',
          'import assert from "node:assert/strict";',
          'test("minimal environment", () => {',
          '  console.log("LEAK=" + String(process.env.ADEMARK_LEAK));',
          '  console.log("NODE_OPTIONS=" + String(process.env.NODE_OPTIONS));',
          "  assert.equal(process.env.ADEMARK_LEAK, undefined);",
          "  assert.equal(process.env.NODE_OPTIONS, undefined);",
          "});",
          "",
        ].join("\n"),
      );
      process.env.NODE_OPTIONS = "--require=/nonexistent";
      process.env.ADEMARK_LEAK = "1";

      const node = resolveNodeBinary();
      const { result, run } = runGroup(root, "Environment", ["env.test.ts"], "{}", node);
      expect(result.failed).toEqual([]);
      expect(result.passed).toBe(1);
      expect(result.total).toBe(1);
      expect(run.output).toContain("LEAK=undefined");
      expect(run.output).toContain("NODE_OPTIONS=undefined");
      expect(run.command.startsWith(node.path)).toBe(true);
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
      if (previousLeak === undefined) delete process.env.ADEMARK_LEAK;
      else process.env.ADEMARK_LEAK = previousLeak;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing handoff codes make the result invalid and skip the group", () => {
    const root = tempDir();
    const previousCodes = process.env.ADEMARK_HANDOFF_CODES;
    const previousSeed = process.env.ADEMARK_HANDOFF_SEED;
    try {
      const base = join(root, "base");
      fill(base, {
        "AGENTS.md": "rules\n",
        "src/server.ts": "export const x = 1;\n",
        "test/x.test.ts": "test\n",
      });
      const work = join(root, "work");
      copyDirectory(base, work);
      appendFileSync(join(work, "src/server.ts"), "// touched\n");

      const taskDir = join(root, "task");
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "prompt.md"), "prompt\n");
      writeFileSync(
        join(taskDir, "task.toml"),
        [
          'id = "Missing"',
          'test_id = "C1"',
          'version = "1.0.0"',
          'model = "claude"',
          "time_cap_s = 60",
          'grade_groups = ["C1-handoff"]',
          "",
        ].join("\n"),
      );

      const hidden = join(root, "hidden");
      mkdirSync(join(hidden, "C1-handoff"), { recursive: true });
      writeFileSync(
        join(hidden, "C1-handoff", "handoff.test.ts"),
        'throw new Error("this group must not run");\n',
      );

      delete process.env.ADEMARK_HANDOFF_CODES;
      delete process.env.ADEMARK_HANDOFF_SEED;
      const out = join(root, "out.json");
      const result = gradeTask({
        taskId: "Missing",
        worktree: work,
        base,
        out,
        taskDir,
        hiddenTests: hidden,
      });

      expect(result.valid).toBe(false);
      expect(result.reasons).toContain("missing handoff codes");
      expect(result.output["C1-handoff"]).toBeUndefined();
      expect(result.groups.find((group) => group.id === "C1-handoff")?.failed).toContain(
        "missing handoff codes",
      );
      expect(result.node.path.startsWith("/")).toBe(true);
    } finally {
      if (previousCodes === undefined) delete process.env.ADEMARK_HANDOFF_CODES;
      else process.env.ADEMARK_HANDOFF_CODES = previousCodes;
      if (previousSeed === undefined) delete process.env.ADEMARK_HANDOFF_SEED;
      else process.env.ADEMARK_HANDOFF_SEED = previousSeed;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

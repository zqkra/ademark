import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedPaths } from "../night/repair.ts";
import { realRepairDeps } from "../night/repair-real.ts";

// Real git in a scratch repo. `cleanUp` is left out on purpose: it stops processes of the account that runs it.
let root: string;

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return result.stdout.toString();
}

function write(path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ademark-repair-git-"));
  git("init", "-q");
  write("bench/adapters/profiles/orca.json", "{}\n");
  write("bench/core/gates.ts", "// gates\n");
  git("add", ".");
  git("commit", "-qm", "start");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("realRepairDeps with real git", () => {
  test("changedPaths sees committed, modified and untracked files", () => {
    const deps = realRepairDeps(() => {}, root);
    const before = deps.head();
    write("bench/adapters/profiles/orca.json", '{"a":1}\n');
    git("commit", "-qam", "agent commit");
    write("bench/core/gates.ts", "// changed\n");
    write("bench/new-file.ts", "// new\n");
    expect(deps.changedPaths(before).sort()).toEqual([
      "bench/adapters/profiles/orca.json",
      "bench/core/gates.ts",
      "bench/new-file.ts",
    ]);
  });

  test("a committed rename shows both ends, so a forbidden file cannot move into an allowed path", () => {
    const deps = realRepairDeps(() => {}, root);
    const before = deps.head();
    git("mv", "bench/core/gates.ts", "bench/adapters/orca.ts");
    git("commit", "-qm", "rename");
    expect(deps.changedPaths(before).sort()).toEqual(["bench/adapters/orca.ts", "bench/core/gates.ts"]);
  });

  test("commit stages a deleted allowed file", () => {
    const deps = realRepairDeps(() => {}, root);
    rmSync(join(root, "bench/adapters/profiles/orca.json"));
    deps.commit(allowedPaths("orca"), "remove");
    expect(deps.dirty()).toEqual([]);
  });

  test("a git failure throws", () => {
    const deps = realRepairDeps(() => {}, root);
    expect(() => deps.changedPaths("not-a-commit")).toThrow("git diff failed");
  });

  test("revert also removes untracked files outside bench", () => {
    const deps = realRepairDeps(() => {}, root);
    const before = deps.head();
    write("stray.txt", "x\n");
    deps.revert(before);
    expect(existsSync(join(root, "stray.txt"))).toBe(false);
  });

  test("revert removes commits, edits and new files", () => {
    const deps = realRepairDeps(() => {}, root);
    const before = deps.head();
    write("bench/core/gates.ts", "// tampered\n");
    git("commit", "-qam", "tamper");
    write("bench/core/gates.ts", "// tampered again\n");
    write("bench/new-file.ts", "// new\n");
    deps.revert(before);
    expect(deps.head()).toBe(before);
    expect(readFileSync(join(root, "bench/core/gates.ts"), "utf8")).toBe("// gates\n");
    expect(existsSync(join(root, "bench/new-file.ts"))).toBe(false);
    expect(deps.changedPaths(before)).toEqual([]);
  });

  test("commit takes only the allowed paths and writeDiff records the change", () => {
    const deps = realRepairDeps(() => {}, root);
    const before = deps.head();
    write("bench/adapters/profiles/orca.json", '{"fixed":true}\n');
    write("bench/core/gates.ts", "// left out\n");
    deps.commit(allowedPaths("orca"), "repair(orca)");
    expect(deps.head()).not.toBe(before);
    expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe("bench/adapters/profiles/orca.json");
    const patch = join(root, "diff.patch");
    deps.writeDiff(before, patch);
    expect(readFileSync(patch, "utf8")).toContain('+{"fixed":true}');
  });

  test("commit with nothing to commit keeps HEAD", () => {
    const deps = realRepairDeps(() => {}, root);
    const before = deps.head();
    deps.commit(allowedPaths("orca"), "nothing");
    expect(deps.head()).toBe(before);
  });
});

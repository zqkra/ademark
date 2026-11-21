import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// arena-project.mjs keeps the one "arena" project of a bb-app host on the worktree the block opened.
// The fake CLI in fixtures/arena-project-cli.mjs answers project list|update|hide|reorder|show from a
// JSON state file, so the helper runs for real without touching Cloudroom or bb.
const HELPER = join(import.meta.dir, "..", "adapters", "arena-project.mjs");
const FAKE_CLI = join(import.meta.dir, "fixtures", "arena-project-cli.mjs");

const dirs: string[] = [];

function stateFile(projects: unknown[]): { path: string; read: () => { projects: Record<string, unknown>[] } } {
  const dir = mkdtempSync(join(tmpdir(), "arena-project-"));
  dirs.push(dir);
  const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify({ projects }));
  return { path, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

function run(mode: string, extra: string[] = [], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, HELPER, mode, FAKE_CLI, ...extra], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
}

function arena(id: string, path: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "standard", name: "arena", sources: [{ type: "local_path", path, isDefault: true }], ...extra };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("arena-project free", () => {
  test("renames every arena to prior-<id> and hides it when asked", () => {
    const state = stateFile([
      arena("proj_a", "/tmp/arena/one"),
      { id: "proj_b", kind: "standard", name: "other", sources: [] },
      arena("proj_c", "/tmp/arena/two"),
    ]);
    const result = run("free", ["hide"], { ARENA_PROJECT_FAKE_STATE: state.path });
    expect(result.exitCode).toBe(0);
    const projects = state.read().projects;
    expect(projects.map((project) => project.name)).toEqual(["prior-proj_a", "other", "prior-proj_c"]);
    expect(projects[0]!.hidden).toBe(true);
    expect(projects[1]!.hidden).toBeUndefined();
    expect(projects[2]!.hidden).toBe(true);
    expect(result.stdout.toString()).toContain("renamed arena proj_a to prior-proj_a");
  });

  test("without hide the renamed projects stay visible", () => {
    const state = stateFile([arena("proj_a", "/tmp/arena/one")]);
    const result = run("free", [], { ARENA_PROJECT_FAKE_STATE: state.path });
    expect(result.exitCode).toBe(0);
    const project = state.read().projects[0]!;
    expect(project.name).toBe("prior-proj_a");
    expect(project.hidden).toBeUndefined();
  });
});

describe("arena-project front", () => {
  test("moves arena before the first project when it is not first", () => {
    const state = stateFile([
      { id: "proj_old", kind: "standard", name: "prior-proj_x", sources: [] },
      arena("proj_new", "/tmp/arena/two"),
      { id: "proj_other", kind: "standard", name: "other", sources: [] },
    ]);
    const result = run("front", [], { ARENA_PROJECT_FAKE_STATE: state.path });
    expect(result.exitCode).toBe(0);
    expect(state.read().projects.map((project) => project.id)).toEqual(["proj_new", "proj_old", "proj_other"]);
  });

  test("does nothing when arena is already first", () => {
    const state = stateFile([
      arena("proj_new", "/tmp/arena/two"),
      { id: "proj_old", kind: "standard", name: "prior-proj_x", sources: [] },
    ]);
    const result = run("front", [], { ARENA_PROJECT_FAKE_STATE: state.path });
    expect(result.exitCode).toBe(0);
    expect(state.read().projects.map((project) => project.id)).toEqual(["proj_new", "proj_old"]);
    expect(result.stdout.toString()).toContain("already first");
  });
});

describe("arena-project verify", () => {
  test("passes when exactly one arena sources the worktree", () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-worktree-"));
    dirs.push(dir);
    const state = stateFile([arena("proj_a", dir)]);
    const result = run("verify", [dir], { ARENA_PROJECT_FAKE_STATE: state.path });
    expect(result.exitCode).toBe(0);
  });

  test("fails when two projects are named arena", () => {
    const state = stateFile([arena("proj_a", "/tmp/arena/one"), arena("proj_b", "/tmp/arena/two")]);
    const result = run("verify", ["/tmp/arena/two"], { ARENA_PROJECT_FAKE_STATE: state.path });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("expected exactly one project named arena, found 2");
  });

  test("fails when the arena sources another path", () => {
    const state = stateFile([arena("proj_a", "/tmp/arena/one")]);
    const result = run("verify", ["/tmp/arena/two"], { ARENA_PROJECT_FAKE_STATE: state.path });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("sources /tmp/arena/one, not /tmp/arena/two");
  });

  test("fails when no project is named arena", () => {
    const state = stateFile([{ id: "proj_a", kind: "standard", name: "other", sources: [] }]);
    const result = run("verify", ["/tmp/arena/two"], { ARENA_PROJECT_FAKE_STATE: state.path });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("found 0");
  });

  test("matches the worktree through a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-worktree-"));
    dirs.push(dir);
    const link = join(dir, "link");
    Bun.spawnSync(["ln", "-s", dir, link]);
    const state = stateFile([arena("proj_a", dir)]);
    const result = run("verify", [link], { ARENA_PROJECT_FAKE_STATE: state.path });
    expect(result.exitCode).toBe(0);
  });
});

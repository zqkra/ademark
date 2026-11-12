import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { diff, EXCLUDED_PATHS, INCLUDED_PATHS, restore, save } from "../core/snapshot.ts";

// Tests never touch the real home: every call gets a temporary fake home and snapshot folder.
let root: string;
let home: string;
let snap: string;

function write(rel: string, text: string): void {
  const path = join(home, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function read(rel: string): string | null {
  const path = join(home, rel);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function seedHome(): void {
  write(".claude/settings.json", '{"model":"opus"}');
  write(".claude/CLAUDE.md", "global rules");
  write(".claude/skills/my-skill/SKILL.md", "skill body");
  write(".claude/agents/reviewer.md", "agent body");
  write(".codex/config.toml", 'model = "gpt"');
  write(".codex/prompts/fix.md", "prompt body");
  write(".agents/skills/demo/SKILL.md", "agents skill");
  // Excluded paths must never enter a snapshot and must never be restored over.
  write(".claude/projects/p1/session.jsonl", "secret project log");
  write(".claude/.credentials.json", "credentials");
  write(".codex/sessions/2026/10/19/rollout.jsonl", "session log");
  write(".codex/auth.json", "auth");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ademark-snapshot-"));
  home = join(root, "home");
  snap = join(root, "snapshots", "clean");
  mkdirSync(home, { recursive: true });
  seedHome();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("save", () => {
  test("dry run plans copies and changes nothing", () => {
    const ops = save(snap, home);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.some((op) => op.action === "copy" && op.target.endsWith("settings.json"))).toBe(true);
    expect(existsSync(snap)).toBe(false);
  });

  test("apply writes the included paths and skips excluded ones", () => {
    save(snap, home, { apply: true });
    expect(readFileSync(join(snap, ".claude/settings.json"), "utf8")).toBe('{"model":"opus"}');
    expect(existsSync(join(snap, ".agents/skills/demo/SKILL.md"))).toBe(true);
    expect(existsSync(join(snap, ".claude/projects"))).toBe(false);
    expect(existsSync(join(snap, ".claude/.credentials.json"))).toBe(false);
    expect(existsSync(join(snap, ".codex/sessions"))).toBe(false);
    expect(existsSync(join(snap, ".codex/auth.json"))).toBe(false);
  });

  test("skips paths the home does not have", () => {
    rmSync(join(home, ".codex/config.toml"));
    save(snap, home, { apply: true });
    expect(existsSync(join(snap, ".codex/config.toml"))).toBe(false);
    expect(existsSync(join(snap, ".claude/settings.json"))).toBe(true);
  });
});

describe("restore", () => {
  test("round trip brings back the saved state", () => {
    save(snap, home, { apply: true });
    write(".claude/settings.json", '{"model":"dirty"}');
    write(".claude/skills/extra/SKILL.md", "extra skill");
    restore(snap, home, { apply: true });
    expect(read(".claude/settings.json")).toBe('{"model":"opus"}');
    expect(existsSync(join(home, ".claude/skills/extra"))).toBe(false);
  });

  test("restore never touches excluded paths", () => {
    save(snap, home, { apply: true });
    restore(snap, home, { apply: true });
    expect(read(".claude/projects/p1/session.jsonl")).toBe("secret project log");
    expect(read(".claude/.credentials.json")).toBe("credentials");
    expect(read(".codex/auth.json")).toBe("auth");
    expect(read(".codex/sessions/2026/10/19/rollout.jsonl")).toBe("session log");
  });

  test("dry run plans operations and changes nothing", () => {
    save(snap, home, { apply: true });
    write(".claude/settings.json", "dirty");
    const ops = restore(snap, home);
    expect(ops.length).toBeGreaterThan(0);
    expect(read(".claude/settings.json")).toBe("dirty");
  });

  test("throws when the snapshot folder is missing", () => {
    expect(() => restore(join(root, "nope"), home)).toThrow(/does not exist/);
  });
});

describe("diff", () => {
  test("reports nothing for an unchanged home", () => {
    save(snap, home, { apply: true });
    expect(diff(snap, home)).toEqual([]);
  });

  test("reports added, changed and removed files", () => {
    save(snap, home, { apply: true });
    write(".claude/settings.json", '{"model":"changed"}');
    write(".claude/commands/new.md", "new command");
    rmSync(join(home, ".codex/prompts/fix.md"));

    const entries = diff(snap, home);
    expect(entries).toContainEqual({ status: "changed", path: ".claude/settings.json" });
    expect(entries).toContainEqual({ status: "added", path: ".claude/commands/new.md" });
    expect(entries).toContainEqual({ status: "removed", path: ".codex/prompts/fix.md" });
  });

  test("ignores excluded paths", () => {
    save(snap, home, { apply: true });
    write(".claude/projects/p1/other.jsonl", "new secret");
    write(".codex/sessions/2026/10/20/rollout.jsonl", "another");
    expect(diff(snap, home)).toEqual([]);
  });

  test("throws when the snapshot folder is missing", () => {
    expect(() => diff(join(root, "nope"), home)).toThrow(/does not exist/);
  });
});

describe("apply permission", () => {
  const canApply = userInfo().username === "ademark";

  test("apply works in a temporary fake home", () => {
    save(snap, home, { apply: true });
    expect(readFileSync(join(snap, ".claude/settings.json"), "utf8")).toBe('{"model":"opus"}');
  });

  test(`apply to the real home is ${canApply ? "allowed for" : "refused for"} user ${userInfo().username}`, () => {
    if (canApply) return;
    expect(() => save(snap, homedir(), { apply: true })).toThrow(/only allowed as the dedicated "ademark" user/);
    expect(() => restore(snap, homedir(), { apply: true })).toThrow(/only allowed as the dedicated "ademark" user/);
    expect(existsSync(snap)).toBe(false);
  });
});

describe("path lists", () => {
  test("no included path sits inside an excluded path", () => {
    for (const included of INCLUDED_PATHS) {
      for (const excluded of EXCLUDED_PATHS) {
        const same = (included as string) === (excluded as string);
        expect(same || included.startsWith(`${excluded}/`)).toBe(false);
      }
    }
  });

  test("the include list has the paths from the ticket", () => {
    expect(INCLUDED_PATHS).toContain(".claude/settings.json");
    expect(INCLUDED_PATHS).toContain(".claude/skills");
    expect(INCLUDED_PATHS).toContain(".codex/config.toml");
    expect(INCLUDED_PATHS).toContain(".agents");
  });
});

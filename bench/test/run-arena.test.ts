import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareArena } from "../run/arena.ts";

let root: string;
let previousArena: string | undefined;
let previousHome: string | undefined;

function gitOutput(dir: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ademark-arena-test-"));
  previousArena = process.env.ADEMARK_ARENA;
  previousHome = process.env.HOME;
  process.env.ADEMARK_ARENA = join(root, "arena");
});

afterEach(() => {
  if (previousArena === undefined) delete process.env.ADEMARK_ARENA;
  else process.env.ADEMARK_ARENA = previousArena;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe("prepareArena", () => {
  test("ignores the machine's git config and commits the same tree", async () => {
    const hostileHome = join(root, "hostile-home");
    const cleanHome = join(root, "clean-home");
    mkdirSync(hostileHome);
    mkdirSync(cleanHome);
    writeFileSync(
      join(hostileHome, ".gitconfig"),
      ["[commit]", "\tgpgsign = true", "[core]", "\tautocrlf = true", "[init]", "\tdefaultBranch = trunk", ""].join("\n"),
    );

    process.env.HOME = hostileHome;
    const hostile = await prepareArena({ dest: join(root, "arena", "hostile"), ref: "HEAD" });
    process.env.HOME = cleanHome;
    const clean = await prepareArena({ dest: join(root, "arena", "clean"), ref: "HEAD" });

    expect(gitOutput(hostile, ["rev-parse", "HEAD"])).toBe(gitOutput(clean, ["rev-parse", "HEAD"]));
    expect(gitOutput(hostile, ["branch", "--show-current"])).toBe("main");
    expect(gitOutput(hostile, ["status", "--porcelain"])).toBe("");
    expect(gitOutput(hostile, ["log", "-1", "--pretty=%an <%ae> %cI"])).toBe(
      "ademark <ademark@localhost> 2026-10-19T00:00:00Z",
    );
  }, 60000);

  test("refuses a destination outside the arena root", async () => {
    await expect(prepareArena({ dest: join(root, "outside"), ref: "HEAD" })).rejects.toThrow(/refusing to replace/);
  });
});

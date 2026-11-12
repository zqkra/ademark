// Arena preparation (RUNBOOK.md §7.1 step 8, TESTS.md §4) and the run-wide arena paths.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { repoRoot } from "../core/paths.ts";

export const ARENA_TAG = "arena-v1";

// Fixed identity and date: the same tree must commit to the same hash on every machine.
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "ademark",
  GIT_AUTHOR_EMAIL: "ademark@localhost",
  GIT_AUTHOR_DATE: "2026-10-19T00:00:00Z",
  GIT_COMMITTER_NAME: "ademark",
  GIT_COMMITTER_EMAIL: "ademark@localhost",
  GIT_COMMITTER_DATE: "2026-10-19T00:00:00Z",
};

// Never read the machine's git config: a signature, line endings or init templates would change the hash.
const GIT_CONFIG_ARGS = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.hooksPath=/dev/null",
];
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function gitEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, ...GIT_ENV, ...extra };
}

function gitArgv(argv: string[]): string[] {
  return ["git", ...GIT_CONFIG_ARGS, ...argv];
}

export function homeDir(): string {
  return process.env.ADEMARK_HOME ?? homedir();
}

export function arenaRoot(): string {
  return process.env.ADEMARK_ARENA ?? join(homeDir(), "arena");
}

export function contaminationDir(): string {
  return resolve(arenaRoot(), "_contamination");
}

export function arenaRef(): string {
  const tag = Bun.spawnSync(gitArgv(["rev-parse", "-q", "--verify", `refs/tags/${ARENA_TAG}`]), {
    cwd: repoRoot,
    env: gitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const ref = tag.exitCode === 0 ? ARENA_TAG : "HEAD";
  console.log(`arena ref: ${ref}`);
  return ref;
}

function isInside(path: string, base: string): boolean {
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  return path === base || path.startsWith(prefix);
}

function runGit(argv: string[], cwd: string, env: Record<string, string> = {}): void {
  const result = Bun.spawnSync(gitArgv(argv), {
    cwd,
    env: gitEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${argv.join(" ")} failed in ${cwd}: ${result.stderr.toString().trim().slice(0, 500)}`);
  }
}

// `git archive <ref> arena | tar -x`, moved to dest, then one deterministic commit on main.
export async function prepareArena(o: { dest: string; ref: string }): Promise<string> {
  const dest = resolve(o.dest);
  const root = resolve(arenaRoot());
  if (dest === root || !isInside(dest, root)) {
    throw new Error(`prepareArena: refusing to replace ${dest}: it must be inside ${root}`);
  }

  const temp = mkdtempSync(join(tmpdir(), "ademark-arena-"));
  try {
    const archivePath = join(temp, "arena.tar");
    const archive = Bun.spawnSync(gitArgv(["archive", o.ref, "arena"]), {
      cwd: repoRoot,
      env: gitEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (archive.exitCode !== 0) {
      throw new Error(`git archive ${o.ref} arena failed: ${archive.stderr.toString().trim().slice(0, 500)}`);
    }
    writeFileSync(archivePath, archive.stdout);
    const extracted = Bun.spawnSync(["tar", "-xf", archivePath, "-C", temp], { stdout: "pipe", stderr: "pipe" });
    if (extracted.exitCode !== 0) {
      throw new Error(`tar -xf ${archivePath} failed: ${extracted.stderr.toString().trim().slice(0, 500)}`);
    }
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(temp, "arena"), dest, { recursive: true });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  runGit(["init", "--template=", "-b", "main"], dest, GIT_IDENTITY);
  runGit(["add", "-A"], dest, GIT_IDENTITY);
  runGit(["commit", "-m", ARENA_TAG], dest, GIT_IDENTITY);
  return dest;
}

// The real side of self-repair: git, the agent process, and the child `ademark run` that loads the repaired profile.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { orphanAgents } from "../adapters/macos.ts";
import { getAdapter } from "../adapters/registry.ts";
import type { ResultRow } from "../core/contracts.ts";
import { repoRoot } from "../core/paths.ts";
import { HARNESS_ENV } from "../ops/machine.ts";
import { blocksFor, MODEL_PINS, rowAdeFor } from "../run/models.ts";
import { blockMarker, legacyMarker, supersedeBlock } from "../run/retry.ts";
import type { AgentExit, RepairDeps } from "./repair.ts";

const QUIT_WAIT_MS = 10_000;
const QUIET_WAIT_MS = 180_000;
const REMEASURE_TIMEOUT_MS = 150 * 60_000;
const KILL_GRACE_MS = 10_000;
const STOP_GRACE_MS = 5_000;
const COMMIT_IDENTITY = ["-c", "user.name=ademark", "-c", "user.email=ademark@localhost"];
const REPAIR_AGENT_PATTERN = "dangerously-skip-permissions --output-format stream-json";

// 2026-11-09: Control made its last call at 02:20:59 and then did nothing for 6 hours, and a sync call with no limit
// (pgrep, ps) is a suspect: it freezes the panel's thread with it. Every sync call here has a limit, and a call that
// reaches it is a failure of that call, logged, never a crash.
const SYNC_TIMEOUT_MS = 120_000;

let childLog: (line: string) => void = (line) => console.error(line);

/** Control sends these lines to its log file: the exit code or signal of each child, and each sync call cut at its limit. */
export function setChildLog(write: (line: string) => void): void {
  childLog = write;
}

export function run(args: readonly string[], cwd: string = repoRoot, timeoutMs: number = SYNC_TIMEOUT_MS): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  if (result.exitedDueToTimeout === true) {
    childLog(`${args.slice(0, 3).join(" ")}: no answer in ${Math.round(timeoutMs / 1000)} s, ended; this call failed`);
    return { code: 124, stdout: "", stderr: `timed out after ${timeoutMs} ms` };
  }
  return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Only this account: another logged-in user's process is neither ours to stop nor part of the repair.
function pids(flag: "-f" | "-x", pattern: string): number[] {
  const uid = String(process.getuid?.() ?? "");
  const own = new Set([process.pid, process.ppid]);
  return run(["pgrep", "-u", uid, flag, pattern]).stdout.split("\n").map(Number).filter((pid) => pid > 0 && !own.has(pid));
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // It already exited.
  }
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// The harness runs inside Ghostty, so the control's own app is never quit here: its reset handles it.
function adePatterns(ade: string): string[] {
  if (ade === "bare-cli") return [];
  return getAdapter(ade).processes().bundlePaths.map((path) => `${escapeRegex(path)}/Contents/`);
}

// An agent can start a child in its own process group, so stopping the agent's group is not enough: a detached
// `calibrate gate` would keep driving the app during the next block.
function leftovers(ade: string): number[] {
  return [
    ...pids("-x", "agent-desktop"),
    ...pids("-x", "ademark-native"),
    ...pids("-f", escapeRegex(REPAIR_AGENT_PATTERN)),
    ...pids("-f", "bench/cli\\.ts"),
    ...orphanAgents(run(["ps", "-axo", "pid=,ppid=,uid=,comm="]).stdout, process.getuid?.() ?? -1),
    ...adePatterns(ade).flatMap((pattern) => pids("-f", pattern)),
  ];
}

async function stopAll(find: () => number[]): Promise<number[]> {
  const found = find();
  if (found.length === 0) return [];
  for (const pid of found) signal(pid, "SIGTERM");
  await delay(3_000);
  // A large app can take more than a second to leave the process table after SIGKILL; one look after 1 s stopped
  // whole nights for a process that was already dying. Keep killing and looking for up to 15 s.
  for (let waited = 0; waited < 15_000; waited += 1_000) {
    const alive = find();
    if (alive.length === 0) return [];
    for (const pid of alive) signal(pid, "SIGKILL");
    await delay(1_000);
  }
  return find();
}

function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

// A helper in the group can outlive its leader, so nothing moves on until the group is really gone.
async function drainGroup(group: number): Promise<void> {
  signal(-group, "SIGTERM");
  for (let waited = 0; waited < 2_000 && groupAlive(group); waited += 100) await delay(100);
  signal(-group, "SIGKILL");
  for (let waited = 0; waited < 5_000 && groupAlive(group); waited += 100) await delay(100);
}

const activeGroups = new Set<number>();

/** The process groups of the children that run now, for Control's heartbeat. */
export function activeChildGroups(): number[] {
  return [...activeGroups];
}

/** Control's Stop button: ends every child group that runs now. */
export function stopChildren(): void {
  const groups = [...activeGroups];
  for (const group of groups) signal(-group, "SIGTERM");
  // A child that ignores TERM must not hold the machine in measuring state until its own time limit.
  setTimeout(() => {
    for (const group of groups) signal(-group, "SIGKILL");
  }, STOP_GRACE_MS);
}

/**
 * One hash over the native helper and the snapshots: a run keeps the files it started with. LC_ALL=C: `sort` orders
 * by the locale, so the same files gave b00bbff under en_US.UTF-8 (Ghostty) and 5df4640 under C (launchd, sudo) on
 * 2026-11-10. A Control that the watchdog restarts could then refuse its own run as "changed".
 */
export function measuringInputsOf(root: string): string {
  return run(["sh", "-c", "find bench/native/bin snapshots -type f -print0 2>/dev/null | LC_ALL=C sort -z | LC_ALL=C xargs -0 shasum | shasum"], root).stdout.trim();
}

/** Runs a child in its own group and ends the whole group, also at the limit. Resolves with 124 on timeout. */
export function supervised(argv: readonly string[], timeoutMs: number, cwd: string = repoRoot, stdoutPath?: string): Promise<number> {
  const stdout = stdoutPath === undefined ? "inherit" : openSync(stdoutPath, "w");
  const child = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, stdio: ["ignore", stdout, "inherit"] });
  if (child.pid !== undefined) activeGroups.add(child.pid);
  const killGroup = (name: NodeJS.Signals): void => {
    if (child.pid !== undefined) signal(-child.pid, name);
  };
  const onExit = (): void => killGroup("SIGKILL");
  process.on("exit", onExit);
  return new Promise((done) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    const finish = async (code: number | null): Promise<void> => {
      clearTimeout(timer);
      if (child.pid !== undefined) {
        await drainGroup(child.pid);
        activeGroups.delete(child.pid);
      }
      process.off("exit", onExit);
      if (typeof stdout === "number") closeSync(stdout);
      done(timedOut ? 124 : (code ?? 1));
    };
    child.once("exit", (code, signalName) => {
      childLog(`child ${argv.slice(0, 5).join(" ")} (group ${child.pid}) ended: ${timedOut ? "time limit, " : ""}code ${code ?? "none"}, signal ${signalName ?? "none"}`);
      void finish(code);
    });
    child.once("error", (error) => {
      childLog(`child ${argv.slice(0, 5).join(" ")} did not start: ${error.message}`);
      void finish(1);
    });
  });
}

export function runAgent(o: { prompt: string; logPath: string; timeoutMs: number; bin?: string }): Promise<AgentExit> {
  mkdirSync(dirname(o.logPath), { recursive: true });
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of HARNESS_ENV) delete env[name];
  const log = openSync(o.logPath, "a");
  const pin = MODEL_PINS.claude;
  const child = spawn(
    o.bin ?? join(homedir(), ".local/bin/claude"),
    ["-p", o.prompt, "--model", pin.model!, "--effort", pin.effort!, "--dangerously-skip-permissions",
      "--output-format", "stream-json", "--verbose"],
    { cwd: repoRoot, env, detached: true, stdio: ["ignore", log, log] },
  );
  if (child.pid !== undefined) activeGroups.add(child.pid);
  // The agent leads its own process group, so one signal reaches everything it started in that group.
  const killGroup = (name: NodeJS.Signals): void => {
    if (child.pid !== undefined) signal(-child.pid, name);
  };
  const onExit = (): void => killGroup("SIGKILL");
  process.on("exit", onExit);
  return new Promise((done) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5_000);
    }, o.timeoutMs);
    const finish = async (exit: AgentExit): Promise<void> => {
      clearTimeout(timer);
      if (child.pid !== undefined) {
        await drainGroup(child.pid);
        activeGroups.delete(child.pid);
      }
      process.off("exit", onExit);
      closeSync(log);
      done(exit);
    };
    child.once("exit", (code) => {
      if (timedOut) void finish({ ok: false, note: `time limit of ${Math.round(o.timeoutMs / 60_000)} minutes` });
      else void finish({ ok: code === 0, note: code === 0 ? "" : `the agent exited with code ${code}` });
    });
    child.once("error", (error) => void finish({ ok: false, note: `the agent did not start: ${error.message}` }));
  });
}

// `-z` keeps every path exact. With `--no-renames` a rename shows both ends, so moving a forbidden file into an allowed
// path cannot hide the forbidden side.
function statusPaths(text: string): string[] {
  return text.split("\0").filter((entry) => entry.length > 3).map((entry) => entry.slice(3));
}

export function realRepairDeps(out: (line: string) => void, root: string = repoRoot): RepairDeps {
  const git = (...args: string[]): string => {
    const result = run(["git", ...args], root);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    return result.stdout;
  };
  const dirty = (): string[] => statusPaths(git("status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"));
  return {
    now: () => Date.now(),
    out,
    head: () => git("rev-parse", "HEAD").trim(),
    dirty,
    changedPaths: (before) => {
      const committed = git("diff", "--name-only", "--no-renames", "-z", before, "HEAD").split("\0");
      return [...new Set([...committed, ...dirty()].filter((path) => path.length > 0))];
    },
    measuringInputs: () => measuringInputsOf(root),
    validate: () => {
      const result = run(["bun", "bench/cli.ts", "adapter", "list"], root);
      return result.code === 0 ? null : (result.stderr.trim().split("\n").at(-1) ?? `exit ${result.code}`);
    },
    revert: (before) => {
      git("reset", "--hard", before);
      // A repair starts from a clean tree, so every untracked file here came from the agent.
      git("clean", "-fd");
    },
    commit: (paths, message) => {
      const present = paths.filter((path) => existsSync(join(root, path)) || git("ls-files", "--", path).length > 0);
      if (present.length === 0) return;
      git("add", "-A", "--", ...present);
      if (git("diff", "--cached", "--name-only").trim().length === 0) return;
      git(...COMMIT_IDENTITY, "commit", "-m", message);
    },
    writeDiff: (before, path) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, git("diff", before, "HEAD"));
    },
    quitAde: async (ade) => {
      if (ade === "bare-cli") return;
      run(["osascript", "-e", `quit app "${getAdapter(ade).calibration.appName}"`]);
      await delay(QUIT_WAIT_MS);
      await stopAll(() => adePatterns(ade).flatMap((pattern) => pids("-f", pattern)));
    },
    clearHarnessEnv: () => {
      for (const name of HARNESS_ENV) run(["launchctl", "unsetenv", name]);
    },
    runAgent,
    cleanUp: async (ade) => (await stopAll(() => leftovers(ade))).map(String),
    // A child, because this wait blocks its thread and Control's panel lives on this one.
    waitQuiet: async () => {
      await supervised(["bun", "bench/cli.ts", "settle", "--minutes", String(QUIET_WAIT_MS / 60_000)], QUIET_WAIT_MS + 60_000, root);
    },
    supersede: ({ runDir, ade, tracks, agents, attempt }) => {
      const adapter = getAdapter(ade);
      for (const track of tracks) {
        for (const options of blocksFor(adapter, track)) {
          if (agents !== undefined && !agents.includes(options.agent)) continue;
          const rowAde = rowAdeFor(adapter, options.agent);
          supersedeBlock(runDir, rowAde, track, options.agent, attempt);
          rmSync(blockMarker(runDir, rowAde, track, options.agent), { force: true });
          rmSync(legacyMarker(runDir, rowAde, track), { force: true });
        }
      }
    },
    remeasure: async ({ ade, runId, seed, tracks, agents }) => {
      const args = ["bun", "bench/cli.ts", "run", "--ade", ade, "--tracks", tracks.join(","), "--run-id", runId, "--seed", seed, "--resume"];
      if (agents !== undefined) args.push("--agent", agents.join(","));
      return (await supervised(args, REMEASURE_TIMEOUT_MS, root)) === 0;
    },
    readRows: (runDir) => {
      const path = join(runDir, "rows.jsonl");
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as ResultRow);
    },
  };
}

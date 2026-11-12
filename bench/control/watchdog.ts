// ADEMARK-36: the watchdog of ADEMark Control. On 2026-11-09 Control stopped at 02:20 and the night lost 6 hours: its
// 75 minute step limit never fired, so Control was dead or its thread was frozen. A LaunchAgent runs one pass every
// 60 s in the `ademark` session. It needs no screen permission: it only reads files and sends signals, and it starts
// Control again through the launcher, because the screen permissions belong to Ghostty.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot } from "../core/paths.ts";
import { appendLine, controlFiles, readHeartbeat, writeAtomic, type ControlFiles, type Heartbeat } from "./files.ts";
import { sessionNow, type Screen } from "./session.ts";

export const HEARTBEAT_LIMIT_MS = 5 * 60_000;
export const STEP_GRACE_MS = 5 * 60_000;
export const MAX_RESTARTS = 5;
const TERM_GRACE_MS = 10_000;

export interface WatchdogState {
  run_id: string;
  restarts: number;
  gave_up: boolean;
}

export interface WatchdogDeps {
  now(): number;
  heartbeat(): Heartbeat | null;
  /** The id of the open run, or null. */
  openRun(): string | null;
  /** Only a clear "off" holds a restart back: a reader that cannot tell must not leave a dead Control dead. */
  screen(): Promise<Screen>;
  /** The pid still runs `bench/cli.ts control`: a pid can be reused after a crash. */
  isControl(pid: number): Promise<boolean>;
  alive(target: number): boolean;
  signal(target: number, name: "SIGTERM" | "SIGKILL"): void;
  sleep(ms: number): Promise<void>;
  /** Starts Control with `--continue` through the launcher. */
  launch(beat: Heartbeat): Promise<void>;
  log(line: string): void;
  readState(): WatchdogState | null;
  writeState(state: WatchdogState): void;
  heartbeatLimitMs?: number;
}

// TERM first, then KILL what is left. A stopped process (kill -STOP) never handles TERM, and KILL still ends it.
async function end(deps: WatchdogDeps, targets: readonly number[]): Promise<void> {
  const live = targets.filter((target) => deps.alive(target));
  for (const target of live) deps.signal(target, "SIGTERM");
  for (let waited = 0; waited < TERM_GRACE_MS && live.some((target) => deps.alive(target)); waited += 500) await deps.sleep(500);
  for (const target of live) if (deps.alive(target)) deps.signal(target, "SIGKILL");
}

/** One pass. Returns what it did, also written to watchdog.log when it acts. */
export async function watchdogPass(deps: WatchdogDeps): Promise<string> {
  const runId = deps.openRun();
  if (runId === null) return "no open run";
  const beat = deps.heartbeat();
  if (beat === null) return "no heartbeat";
  if (beat.intent !== "running") return "intent stopped";
  if ((await deps.screen()) === "off") return "this account is not on screen";
  const now = deps.now();
  const age = now - Date.parse(beat.written_at);
  const limit = deps.heartbeatLimitMs ?? HEARTBEAT_LIMIT_MS;
  if (!(age > limit)) {
    if (beat.step_started_at === null || beat.step_limit_ms === null || beat.child_group === null) return "healthy";
    const stepAge = now - Date.parse(beat.step_started_at);
    if (!(stepAge > beat.step_limit_ms + STEP_GRACE_MS)) return "healthy";
    deps.log(`${beat.ade} ${beat.step} runs ${Math.round(stepAge / 60_000)} min, past its limit of ${Math.round(beat.step_limit_ms / 60_000)} min plus 5: ending child group ${beat.child_group}`);
    await end(deps, [-beat.child_group]);
    return "ended an overdue step";
  }
  const state = deps.readState();
  const mine: WatchdogState = state !== null && state.run_id === runId ? state : { run_id: runId, restarts: 0, gave_up: false };
  if (mine.restarts >= MAX_RESTARTS) {
    if (!mine.gave_up) {
      deps.log(`heartbeat ${Math.round(age / 1000)} s old, but ${runId} was restarted ${mine.restarts} times: no more restarts, a person must look`);
      deps.writeState({ ...mine, gave_up: true });
    }
    return "gave up";
  }
  deps.log(`heartbeat ${Math.round(age / 1000)} s old (limit ${Math.round(limit / 1000)} s) while ${runId} should run, state ${beat.state}, ${beat.ade ?? "no app"} ${beat.step ?? ""}: restart ${mine.restarts + 1} of ${MAX_RESTARTS}`);
  const targets: number[] = [];
  if (await deps.isControl(beat.pid)) targets.push(beat.pid);
  else deps.log(`pid ${beat.pid} is no Control any more`);
  if (beat.child_group !== null) targets.push(-beat.child_group);
  await end(deps, targets);
  deps.writeState({ ...mine, restarts: mine.restarts + 1 });
  await deps.launch(beat);
  deps.log(`started Control again with --continue`);
  return "restarted";
}

async function output(argv: string[], timeoutMs: number): Promise<{ code: number; text: string }> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
    const text = await new Response(proc.stdout).text();
    return { code: await proc.exited, text };
  } catch (error) {
    return { code: 127, text: String(error) };
  }
}

function openRunIn(database: string): string | null {
  if (!existsSync(database)) return null;
  const db = new Database(database, { readonly: true });
  try {
    const run = db.query<{ id: string; ended_at: string | null }, []>("SELECT id, ended_at FROM runs ORDER BY started_at DESC, rowid DESC LIMIT 1").get();
    return run !== null && run.ended_at === null ? run.id : null;
  } finally {
    db.close();
  }
}

export const LAUNCHER = join(repoRoot, "bench", "control", "launcher", "run");

export function realWatchdogDeps(dry: boolean, files: ControlFiles = controlFiles(dry)): WatchdogDeps {
  return {
    now: () => Date.now(),
    heartbeat: () => readHeartbeat(files.heartbeat),
    openRun: () => openRunIn(files.database),
    screen: async () => (await sessionNow()).screen,
    isControl: async (pid) => {
      const ps = await output(["/bin/ps", "-o", "command=", "-p", String(pid)], 10_000);
      return ps.code === 0 && /bench\/cli\.ts control/.test(ps.text);
    },
    alive: (target) => {
      try {
        process.kill(target, 0);
        return true;
      } catch {
        return false;
      }
    },
    signal: (target, name) => {
      try {
        process.kill(target, name);
      } catch {
        // It already exited.
      }
    },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    launch: async (beat) => {
      const args = ["--continue", "--port", String(beat.port), ...(dry ? ["--dry-run", "--no-open"] : [])];
      const result = await output(["/bin/zsh", LAUNCHER, ...args], 60_000);
      if (result.code !== 0) appendLine(files.watchdogLog, `launcher exited with ${result.code}`);
    },
    log: (line) => {
      console.log(line);
      appendLine(files.watchdogLog, line);
    },
    readState: () => {
      try {
        return JSON.parse(readFileSync(files.watchdogState, "utf8")) as WatchdogState;
      } catch {
        return null;
      }
    },
    writeState: (state) => writeAtomic(files.watchdogState, `${JSON.stringify(state)}\n`),
  };
}

// The LaunchAgent.
export const WATCHDOG_LABEL = "dev.ademark.watchdog";
const LAUNCH_PATH = "$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function plistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${WATCHDOG_LABEL}.plist`);
}

const xml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Every 60 s one pass, with the PATH the launcher gives Control. Aqua: it lives in the logged-in session. */
export function watchdogPlist(repo: string, logPath: string): string {
  const command = `export PATH="${LAUNCH_PATH}"; cd '${repo.replace(/'/g, "'\\''")}' && exec bun bench/cli.ts watchdog --once`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCHDOG_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xml(command)}</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

const domain = (): string => `gui/${process.getuid?.() ?? 501}`;

export async function watchdogLoaded(): Promise<boolean> {
  return (await output(["/bin/launchctl", "print", `${domain()}/${WATCHDOG_LABEL}`], 10_000)).code === 0;
}

/** Safe to repeat: with the same file already loaded it changes nothing. */
export async function watchdogInstall(repo: string = repoRoot, home: string = homedir()): Promise<string> {
  if (userInfo().username !== "ademark") throw new Error('the watchdog is installed only in the "ademark" account');
  const path = plistPath(home);
  const text = watchdogPlist(repo, join(dirname(controlFiles(false).watchdogLog), "watchdog-launchd.log"));
  const same = existsSync(path) && readFileSync(path, "utf8") === text;
  if (same && (await watchdogLoaded())) return "already loaded";
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(path, text);
  await output(["/bin/launchctl", "bootout", `${domain()}/${WATCHDOG_LABEL}`], 10_000);
  const loaded = await output(["/bin/launchctl", "bootstrap", domain(), path], 10_000);
  if (loaded.code !== 0) throw new Error(`launchctl bootstrap exited with ${loaded.code}`);
  return "loaded";
}

export async function watchdogUninstall(home: string = homedir()): Promise<string> {
  await output(["/bin/launchctl", "bootout", `${domain()}/${WATCHDOG_LABEL}`], 10_000);
  const path = plistPath(home);
  rmSync(path, { force: true });
  return "removed";
}


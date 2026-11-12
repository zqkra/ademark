// macOS side effects shared by every adapter (ADES.md 1.1). Dry run logs the plan; a real run needs the `ademark` user.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AdapterContext, NativeProc } from "../core/contracts.ts";
import {
  keys,
  nativeBinary,
  ocr as nativeOcr,
  procs,
  screenshot as nativeScreenshot,
  watch,
  window as nativeWindow,
  type KeysOptions,
  type OcrOptions,
  type ScreenshotOptions,
  type WatchOptions,
  type WindowOptions,
} from "../core/native.ts";
import { planMessage } from "./support.ts";
import { withoutAgentSession } from "../core/env.ts";

export const ADEMARK_USER = "ademark";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Every system command, native helper and clock goes through the runner, so a test can prove nothing ran.
export interface MacosRunner {
  username(): string;
  uid(): number;
  now(): number;
  run(argv: string[], input?: Uint8Array): RunResult;
  procs(): Promise<NativeProc[]>;
  keys(options: KeysOptions): Promise<unknown>;
  window(options: WindowOptions): Promise<unknown>;
  watch(options: WatchOptions): Promise<{ seen_ns: number | null; timed_out: boolean }>;
  screenshot(options: ScreenshotOptions): Promise<unknown>;
  ocr(options: OcrOptions): Promise<{ lines: string[] }>;
  sleep(ms: number): Promise<void>;
}

export const defaultMacosRunner: MacosRunner = {
  username: () => userInfo().username,
  uid: () => (typeof process.getuid === "function" ? process.getuid() : 501),
  now: () => Date.now(),
  run(argv, input) {
    const result = Bun.spawnSync(argv, {
      stdin: input ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: withoutAgentSession(),
    });
    return {
      code: result.exitCode ?? 1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  },
  procs: () => procs(),
  keys: (options) => keys(options),
  window: (options) => nativeWindow(options),
  watch: (options) => watch(options),
  screenshot: (options) => nativeScreenshot(options),
  ocr: (options) => nativeOcr(options),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

let runner: MacosRunner = defaultMacosRunner;

export function setMacosRunner(next: MacosRunner): void {
  runner = next;
}

export function resetMacosRunner(): void {
  runner = defaultMacosRunner;
}

function assertAdemarkUser(): void {
  const username = runner.username();
  if (username === ADEMARK_USER) return;
  throw new Error(
    `refusing macOS side effect: only the dedicated "${ADEMARK_USER}" user may change system state ` +
      `(current user: "${username}")`,
  );
}

// Every adapter method starts here: dry run returns false, real mode refuses anyone but the `ademark` user.
export function isRealRun(ctx: AdapterContext): boolean {
  if (ctx.dryRun) return false;
  assertAdemarkUser();
  return true;
}

function plan(ctx: AdapterContext, action: string, args: readonly string[] = []): boolean {
  if (!ctx.dryRun) return false;
  ctx.log(planMessage(action, args));
  return true;
}

function run(argv: string[], input?: Uint8Array): RunResult {
  const result = runner.run(argv, input);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(`${argv.join(" ")} failed (exit ${result.code}): ${detail}`);
  }
  return result;
}

function listArg(values: readonly (string | number)[]): string {
  return values.length === 0 ? "-" : values.join(",");
}

export function setenv(ctx: AdapterContext, name: string, value: string): void {
  if (plan(ctx, "setenv", [`${name}=${value}`])) return;
  assertAdemarkUser();
  run(["launchctl", "setenv", name, value]);
}

export function unsetenv(ctx: AdapterContext, name: string): void {
  if (plan(ctx, "unsetenv", [name])) return;
  assertAdemarkUser();
  run(["launchctl", "unsetenv", name]);
}

export function openBundle(ctx: AdapterContext, bundleId: string): void {
  if (plan(ctx, "openBundle", [bundleId])) return;
  assertAdemarkUser();
  run(["open", "-b", bundleId]);
}

// Pilot 2026-10-20: Zeron (GPUI) quits but answers the quit Apple event with "User canceled. (-128)". Callers wait for
// the processes to go and kill what is left, so that answer is logged rather than thrown.
export function quitApp(ctx: AdapterContext, appName: string): void {
  if (plan(ctx, "quitApp", [appName])) return;
  assertAdemarkUser();
  // An app that asks to confirm its quit (Synara, Emdash) never answers the event; AppleScript would wait 2 minutes.
  const result = runner.run(["osascript", "-e", "with timeout of 5 seconds", "-e", `quit app "${appName}"`, "-e", "end timeout"]);
  if (result.code === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim() || "no output";
  // -128: the app cancelled the event. -1712: it did not answer in time (pilot 2026-10-20, Zeron during A1). -1743: macOS
  // has no Automation answer for this app yet. In each case the caller waits for the processes and kills what is left.
  const code = ["(-128)", "(-1712)", "(-1743)"].find((value) => detail.includes(value));
  if (code === undefined) throw new Error(`osascript quit app "${appName}" failed (exit ${result.code}): ${detail}`);
  ctx.log(`quitApp: ${appName} answered the quit event with ${code.slice(1, -1)}; waiting for its processes instead`);
  // No Automation answer: the event never arrived, so the app gets a plain TERM, which also lets it close by itself.
  if (code === "(-1743)") runner.run(["pkill", "-TERM", "-x", appName]);
}

const BOOTOUT_NOT_LOADED = new Set([3, 113]);

// `ps -axo pid=,ppid=,uid=,comm=` lines. An agent CLI whose parent died belongs to no app any more. Night of 2026-11-05:
// a `claude` that Orca started outlived Orca and ran during the blocks after it. A repair agent has `night` as its parent
// and a person's session has a shell, so neither one matches.
export function orphanAgents(psOutput: string, uid: number): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const [, pid, ppid, owner, command] = match;
    if (ppid === "1" && Number(owner) === uid && /\/claude\/versions\/|(^|\/)(claude|codex)$/.test(command!)) pids.push(Number(pid));
  }
  return pids;
}

// `ps -axo pid=,uid=,comm=` lines. The main executable lives in Contents/MacOS; helpers and background ghosts do not, and
// A9 counts those on purpose.
export function mainAppProcesses(psOutput: string, bundlePaths: readonly string[], uid: number): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match === null || Number(match[2]) !== uid) continue;
    if (bundlePaths.some((bundle) => match[3]!.startsWith(`${bundle}/Contents/MacOS/`))) pids.push(Number(match[1]));
  }
  return pids;
}

// Cloudroom's preview LaunchAgent runs the app's own binary, so it stays after a normal quit and is not the app.
export function launchAgentPids(listOutput: string, labels: readonly string[]): number[] {
  const pids: number[] = [];
  for (const line of listOutput.split("\n")) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (label !== undefined && labels.includes(label) && Number(pid) > 0) pids.push(Number(pid));
  }
  return pids;
}

export function mainAppPids(bundlePaths: readonly string[], launchAgents: readonly string[] = []): number[] {
  const agents = launchAgents.length === 0 ? [] : launchAgentPids(run(["launchctl", "list"]).stdout, launchAgents);
  const pids = mainAppProcesses(run(["ps", "-axo", "pid=,uid=,comm="]).stdout, bundlePaths, runner.uid());
  return pids.filter((pid) => !agents.includes(pid));
}

export function orphanAgentPids(ctx: AdapterContext): number[] {
  if (ctx.dryRun) return [];
  return orphanAgents(run(["ps", "-axo", "pid=,ppid=,uid=,comm="]).stdout, runner.uid());
}

export function bootout(ctx: AdapterContext, label: string): void {
  const target = `gui/${runner.uid()}/${label}`;
  if (plan(ctx, "bootout", [target])) return;
  assertAdemarkUser();
  const result = runner.run(["launchctl", "bootout", target]);
  if (result.code === 0 || BOOTOUT_NOT_LOADED.has(result.code)) return;
  const detail = result.stderr.trim() || result.stdout.trim() || "no output";
  throw new Error(`launchctl bootout ${target} failed (exit ${result.code}): ${detail}`);
}

async function alivePids(wanted: ReadonlySet<number>): Promise<number[]> {
  const all = await runner.procs();
  return all.filter((proc) => wanted.has(proc.pid)).map((proc) => proc.pid);
}

export async function waitGone(ctx: AdapterContext, pids: readonly number[], timeoutMs: number): Promise<number[]> {
  if (plan(ctx, "waitGone", [`pids=${listArg(pids)}`, `timeoutMs=${timeoutMs}`])) return [];
  assertAdemarkUser();
  const wanted = new Set(pids);
  if (wanted.size === 0) return [];
  const startedAt = runner.now();
  let alive = await alivePids(wanted);
  while (alive.length > 0 && runner.now() - startedAt < timeoutMs) {
    await runner.sleep(200);
    alive = await alivePids(wanted);
  }
  return alive;
}

// Untimed setup: wait until `text` shows in `region` of the app's window (OCR, no keys posted). A list ends the wait at
// the first of its texts read (native `watch --texts`). `optional`: a text not read returns false and keeps no evidence,
// for a step that only acts when something is on screen; a failed native call still throws.
export async function waitForText(
  ctx: AdapterContext,
  pid: number,
  region: { x: number; y: number; w: number; h: number },
  text: string | readonly string[],
  timeoutS: number,
  options: { optional?: boolean } = {},
): Promise<boolean> {
  const label = typeof text === "string" ? `text=${text}` : `texts=${text.join("|")}`;
  if (plan(ctx, "waitForText", [`pid=${pid}`, label])) return true;
  assertAdemarkUser();
  const frames = join(tmpdir(), `ademark-wait-${process.pid}-${runner.now()}.json`);
  const seen = await runner.watch({ pid, text, region, triggers: [], timeoutS, frames });
  if (!seen.timed_out && seen.seen_ns !== null) {
    rmSync(frames, { force: true });
    return true;
  }
  if (options.optional === true) {
    rmSync(frames, { force: true });
    return false;
  }
  const names = typeof text === "string" ? [text] : text;
  const quoted = names.map((name) => `"${name}"`).join(" or ");
  throw new Error(`${quoted} did not show within ${timeoutS} s (${await keepWaitEvidence(ctx, pid, names[0] ?? "", frames)})`);
}

// 2026-11-08: Cloudroom's "One-click" wait failed twice and the frames were deleted, so nobody could say what the screen
// showed. A failed wait keeps its OCR frames and one window screenshot under <runDir>/waits/.
async function keepWaitEvidence(ctx: AdapterContext, pid: number, text: string, frames: string): Promise<string> {
  if (ctx.runDir === "") return `frames kept at ${frames}, no run folder`;
  const dir = join(ctx.runDir, "waits");
  const stem = `${utcStamp(runner.now())}-${text.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "text"}`;
  const keptFrames = join(dir, `${stem}-frames.json`);
  const shot = join(dir, `${stem}.png`);
  const parts: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    try {
      renameSync(frames, keptFrames);
    } catch {
      cpSync(frames, keptFrames);
      rmSync(frames, { force: true });
    }
    parts.push(`frames ${keptFrames}`);
  } catch (error) {
    parts.push(`frames kept at ${frames} (${error instanceof Error ? error.message : String(error)})`);
  }
  try {
    await runner.screenshot({ pid, out: shot });
    parts.push(`screenshot ${shot}`);
  } catch (error) {
    parts.push(`no screenshot: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parts.join(", ");
}

// Untimed setup: one screenshot of the app's window and its OCR lines. The screenshot stays under <runDir>/checks/ as
// the receipt of what was decided from it. A dry run plans it and reads nothing (null).
export async function windowText(ctx: AdapterContext, pid: number, label: string): Promise<string[] | null> {
  if (plan(ctx, "windowText", [`pid=${pid}`, `label=${label}`])) return null;
  assertAdemarkUser();
  const dir = ctx.runDir === "" ? tmpdir() : join(ctx.runDir, "checks");
  mkdirSync(dir, { recursive: true });
  const shot = join(dir, `${utcStamp(runner.now())}-${label}.png`);
  await runner.screenshot({ pid, out: shot });
  return (await runner.ocr({ image: shot })).lines;
}

// Untimed setup that drives an app's UI waits for it between steps; a dry run only logs the wait.
export async function pause(ctx: AdapterContext, ms: number): Promise<void> {
  if (plan(ctx, "pause", [`ms=${ms}`])) return;
  await runner.sleep(ms);
}

export function killPids(ctx: AdapterContext, pids: readonly number[]): void {
  if (plan(ctx, "killPids", [`pids=${listArg(pids)}`])) return;
  assertAdemarkUser();
  for (const pid of pids) {
    // A process that exited between the listing and the kill is what the kill wanted (2026-11-08: Zeron's A1 stopped
    // on "kill: 31394: No such process"). Any other failure still stops.
    const result = runner.run(["kill", "-9", String(pid)]);
    if (result.code !== 0 && !/no such process/i.test(`${result.stderr} ${result.stdout}`)) {
      throw new Error(`kill -9 ${pid} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim() || "no output"}`);
    }
  }
}

export function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, "-");
}

function expandHome(dir: string, home: string): string {
  if (dir === "~") return home;
  if (dir.startsWith("~/")) return join(home, dir.slice(2));
  return dir;
}

// Never deletes: every data folder ends up under ~/ademark-aside/<adapter>/<UTC timestamp>/.
export function moveAside(ctx: AdapterContext, adapterId: string, dirs: readonly string[]): void {
  const root = join(ctx.home, "ademark-aside", adapterId, utcStamp(runner.now()));
  for (const dir of dirs) {
    const source = expandHome(dir, ctx.home);
    const target = join(root, basename(source));
    if (plan(ctx, "moveAside", [`${dir} -> ${target}`])) continue;
    assertAdemarkUser();
    if (!existsSync(source)) {
      ctx.log(`moveAside: ${dir} is not there, nothing to move`);
      continue;
    }
    mkdirSync(root, { recursive: true });
    try {
      renameSync(source, target);
    } catch {
      cpSync(source, target, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  }
}

// RUNBOOK.md 4.3 step 4: a seed is an ADE's data, signed in and with no threads, saved once by
// ~/ademark-private/ops/save-seed.sh under seeds/<adapter>/home/<path relative to home>. It holds tokens, so it lives
// in the private folder, never in the repo. Restoring it after moveAside keeps the login (ADES.md 1 rule 12).
export const SEEDS_DIR = "~/ademark-private/seeds";

export function restoreSeed(ctx: AdapterContext, adapterId: string, paths: readonly string[]): void {
  const root = join(expandHome(SEEDS_DIR, ctx.home), adapterId, "home");
  for (const rel of paths) {
    const source = join(root, rel);
    const target = expandHome(`~/${rel}`, ctx.home);
    if (plan(ctx, "restoreSeed", [`${source} -> ${target}`])) continue;
    assertAdemarkUser();
    if (!existsSync(source)) throw new Error(`seed for ${adapterId} has no ${rel}: run save-seed.sh first`);
    if (existsSync(target)) throw new Error(`restoreSeed: ${target} exists; move it aside first`);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
}

// Pilot 2026-10-20: Claude Code asks "Accessing workspace ... trust this folder" in every new folder, and every arena is
// a new git repo; trust on ~/arena does not carry over, because the project is the repo root. Claude Code saves the
// answer as projects[<folder>].hasTrustDialogAccepted in ~/.claude.json; setting it before launch keeps the untimed
// answer out of the timed start, as a user who had opened the folder before.
export function trustClaudeFolder(ctx: AdapterContext, folder: string): void {
  const config = join(ctx.home, ".claude.json");
  if (plan(ctx, "trustClaudeFolder", [folder])) return;
  assertAdemarkUser();
  const data = existsSync(config) ? (JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>) : {};
  const projects = (data.projects ?? {}) as Record<string, Record<string, unknown>>;
  if (projects[folder]?.hasTrustDialogAccepted === true) return;
  projects[folder] = { ...projects[folder], hasTrustDialogAccepted: true };
  data.projects = projects;
  const temp = `${config}.ademark-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, config);
}

// Sets top-level keys in an app's JSON settings file, keeping the rest. The app must be closed.
export function setJsonKeys(ctx: AdapterContext, path: string, values: Record<string, unknown>): void {
  const target = expandHome(path, ctx.home);
  if (plan(ctx, "setJsonKeys", [target, JSON.stringify(values)])) return;
  assertAdemarkUser();
  const data = existsSync(target) ? (JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>) : {};
  if (Object.entries(values).every(([key, value]) => data[key] === value)) return;
  Object.assign(data, values);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.ademark-${process.pid}`;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  renameSync(temp, target);
}

/**
 * Sets one nested value in an app's JSON settings file, keeping the rest. The app must be closed. The file and every
 * key of the path must exist: a vendor that renames the setting must stop the block, never leave it off without a word
 * (2026-11-11, the switch of an ADE's orchestration before a Track C block).
 */
export function setJsonPath(ctx: AdapterContext, path: string, keys: readonly string[], value: unknown): void {
  const target = expandHome(path, ctx.home);
  if (plan(ctx, "setJsonPath", [target, keys.join("."), JSON.stringify(value)])) return;
  assertAdemarkUser();
  const where = `${keys.join(".")} in ${target}`;
  if (keys.length === 0) throw new Error(`setJsonPath: no key for ${target}`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(`${target} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let node = data as Record<string, unknown> | null;
  for (const key of keys.slice(0, -1)) {
    const next = node?.[key];
    if (next === null || typeof next !== "object" || Array.isArray(next)) throw new Error(`no ${where}`);
    node = next as Record<string, unknown>;
  }
  const last = keys.at(-1)!;
  if (node === null || typeof node !== "object" || Array.isArray(node) || !(last in node)) throw new Error(`no ${where}`);
  if (node[last] === value) return;
  node[last] = value;
  const temp = `${target}.ademark-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: statSync(target).mode & 0o777 });
  renameSync(temp, target);
  ctx.log(`set ${where} = ${JSON.stringify(value)}`);
}

export function writeTextFile(ctx: AdapterContext, path: string, text: string): void {
  const target = expandHome(path, ctx.home);
  if (plan(ctx, "writeFile", [target, text])) return;
  assertAdemarkUser();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

export function runTool(ctx: AdapterContext, argv: string[]): string {
  if (plan(ctx, "run", argv)) return "";
  assertAdemarkUser();
  return run(argv.map((arg) => expandHome(arg, ctx.home))).stdout;
}

export const FIRST_LAUNCH_DIR = "/tmp/ademark-first-launch";
const FIRST_LAUNCH_REAL_ROOT = "/private/tmp";
const FIRST_LAUNCH_NAME_PREFIX = "ademark-";

// The copy is deleted and recreated, so only a folder that resolves inside /private/tmp and carries our prefix may
// be used as its root; anything else is a bug in the caller, never something to remove.
function firstLaunchRoot(root: string): string {
  const real = existsSync(root) ? realpathSync(root) : join(realpathSync(dirname(root)), basename(root));
  if (!real.startsWith(`${FIRST_LAUNCH_REAL_ROOT}/`) || !basename(real).startsWith(FIRST_LAUNCH_NAME_PREFIX)) {
    throw new Error(
      `refusing first-launch root ${root}: it must resolve to ${FIRST_LAUNCH_REAL_ROOT}/${FIRST_LAUNCH_NAME_PREFIX}*`,
    );
  }
  return real;
}

// A1 first-launch tier: a fresh quarantined copy of the app so Gatekeeper and XProtect run (TESTS.md A1).
export function copyQuarantined(ctx: AdapterContext, appPath: string, root: string = FIRST_LAUNCH_DIR): string {
  const safeRoot = firstLaunchRoot(root);
  const destination = join(safeRoot, basename(appPath));
  if (plan(ctx, "ditto", [appPath, destination])) {
    plan(ctx, "xattr", ["-w", "com.apple.quarantine", "0083;<timestamp>;Safari;", destination]);
    return destination;
  }
  assertAdemarkUser();
  rmSync(safeRoot, { recursive: true, force: true });
  mkdirSync(safeRoot, { recursive: true });
  run(["ditto", appPath, destination]);
  run(["xattr", "-w", "com.apple.quarantine", `0083;${Math.floor(runner.now() / 1000)};Safari;`, destination]);
  return destination;
}

const GATEKEEPER_DIALOG_SCRIPT = `tell application "System Events"
  if exists process "CoreServicesUIAgent" then
    tell process "CoreServicesUIAgent"
      if (count of windows) > 0 then
        click button "Cancel" of window 1
        return "dismissed"
      end if
    end tell
  end if
end tell
return "none"`;

// After the A1 first-launch tier. Pilot 2026-10-20: Gatekeeper's "downloaded from the Internet" dialog for the Zeron
// copy stayed up, took the front from every later run, and the copy (started from an App Translocation path that no
// bundle hint matches) stayed alive. Cancels the dialog, kills the copy, and returns true when a dialog was there.
export async function cleanupFirstLaunch(ctx: AdapterContext, copy: string): Promise<boolean> {
  if (plan(ctx, "cleanupFirstLaunch", [copy])) return false;
  assertAdemarkUser();
  // No Automation answer reads as no dialog: macOS may never ask, and a real Gatekeeper dialog fails the block anyway.
  const dialog = runner.run(["osascript", "-e", GATEKEEPER_DIALOG_SCRIPT]).stdout.trim() === "dismissed";
  const inside = `/${basename(copy)}/Contents/`;
  const copies = (await runner.procs()).filter(
    (proc) => proc.path.includes(inside) && (proc.path.includes("/AppTranslocation/") || proc.path.startsWith(FIRST_LAUNCH_REAL_ROOT)),
  );
  killPids(ctx, copies.map((proc) => proc.pid));
  return dialog;
}

// Keys only reach the frontmost app, and the native helper refuses to post otherwise. Pilot 2026-10-20: a message typed
// to the agent's Terminal during a run took the front and stopped the block at "not_frontmost". Untimed adapter steps
// bring the ADE back to the front once and retry; timed triggers never do this (the echo timer skips and fails the run).
async function postKeys(ctx: AdapterContext, options: KeysOptions): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await runner.keys(options);
      return;
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("not_frontmost")) || attempt >= FRONT_SETTLES_MS.length) throw error;
      ctx.log(`keys: pid ${options.pid} was not in front; bringing it back (${attempt + 1} of ${FRONT_SETTLES_MS.length})`);
      bringToFront(options.pid);
      await runner.sleep(FRONT_SETTLES_MS[attempt]!);
    }
  }
}

// How long the app gets to come forward before each new try. One try of 400 ms was not enough for an app that was just
// opened again: on 2026-11-11 Cloudroom's relaunch inside A9 failed its first key with not_frontmost after that one
// try (control-2026-11-10T08-31-19Z-cloudroom-3), the block stopped, its retry failed the same way, and 86 valid rows
// of eight finished tests were set aside with it.
const FRONT_SETTLES_MS = [400, 1500, 4000];

// `open` on a running app brings it forward and needs no Automation permission. Night of 2026-11-05: System Events
// answered -1743 and stopped Emdash and super.engineering.
function bringToFront(pid: number): void {
  const executable = run(["ps", "-o", "comm=", "-p", String(pid)]).stdout.trim();
  const bundle = /^(.*?\.app)\//.exec(executable)?.[1];
  if (bundle === undefined) throw new Error(`keys: pid ${pid} is not inside an app bundle: ${executable}`);
  run(["open", bundle]);
}

export async function paste(ctx: AdapterContext, pid: number, text: string): Promise<void> {
  if (plan(ctx, "paste", [`pid=${pid}`, `text=${text}`])) return;
  assertAdemarkUser();
  run(["pbcopy"], new TextEncoder().encode(text));
  await postKeys(ctx, { pid, combo: "cmd+v" });
  // Pilot 2026-10-20: Claude Code in Ghostty kept "replay:seed" in its input when Enter followed the paste at once; the
  // TUI was still taking the paste in. Callers press Enter after this returns.
  await runner.sleep(PASTE_SETTLE_MS);
}

const PASTE_SETTLE_MS = 500;

export async function press(ctx: AdapterContext, pid: number, combo: string): Promise<void> {
  if (plan(ctx, "press", [`pid=${pid}`, `combo=${combo}`])) return;
  assertAdemarkUser();
  await postKeys(ctx, combo === "enter" ? { pid, enter: true } : { pid, combo });
}

export async function typeText(ctx: AdapterContext, pid: number, text: string): Promise<void> {
  if (plan(ctx, "typeText", [`pid=${pid}`, `text=${text}`])) return;
  assertAdemarkUser();
  await postKeys(ctx, { pid, text });
}

// A click at a window point (contract: `ademark-native click`). Setup only; the helper refuses unless `pid` is
// frontmost, so untimed profile steps use it and the echo timer keeps its own click triggers.
export async function click(
  ctx: AdapterContext,
  pid: number,
  point: { x: number; y: number },
  count = 1,
): Promise<void> {
  if (plan(ctx, "click", [`pid=${pid}`, `at=${point.x},${point.y}`, `count=${count}`])) return;
  assertAdemarkUser();
  run([nativeBinary(), "click", "--pid", String(pid), "--at", `${point.x},${point.y}`, "--count", String(count)]);
}

export async function resizeWindow(
  ctx: AdapterContext,
  pid: number,
  size: { w: number; h: number },
): Promise<void> {
  if (plan(ctx, "window", [`pid=${pid}`, `size=${size.w}x${size.h}`])) return;
  assertAdemarkUser();
  // Pilot 2026-10-20: launch finds the pid before the app has a window ("pid ... has no standard window"), so wait.
  const deadline = runner.now() + WINDOW_WAIT_MS;
  for (;;) {
    try {
      await runner.window({ pid, size, front: true });
      return;
    } catch (error) {
      const noWindow = error instanceof Error && error.message.includes("window_not_found");
      if (!noWindow || runner.now() >= deadline) throw error;
      await runner.sleep(250);
    }
  }
}

const WINDOW_WAIT_MS = 15_000;

export interface PidHints {
  bundlePaths?: readonly string[];
  names?: readonly string[];
}

function isInside(path: string, base: string): boolean {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return path === base || path.startsWith(prefix);
}

function matchesHints(proc: NativeProc, hints: PidHints): boolean {
  const bundles = hints.bundlePaths ?? [];
  const names = hints.names ?? [];
  return bundles.some((bundle) => isInside(proc.path, bundle)) || names.includes(basename(proc.path));
}

function hintsArg(hints: PidHints): string {
  return `bundlePaths=${listArg(hints.bundlePaths ?? [])} names=${listArg(hints.names ?? [])}`;
}

// Attribution by bundle path or executable name, from `ademark-native procs` (TESTS.md 1.7).
export async function procsFor(ctx: AdapterContext, hints: PidHints): Promise<NativeProc[]> {
  if (plan(ctx, "procsFor", [hintsArg(hints)])) return [];
  const all = await runner.procs();
  return all.filter((proc) => matchesHints(proc, hints));
}

// Processes matching `hints` that run under `rootPid` (its children, their children, ...). Pilot 2026-10-20: matching the
// native Claude Code binary by path alone also matched the agent session that ran the pilot, and reset killed it.
// `ademark-native procs` lists only the user's own processes, but Ghostty starts every tab through /usr/bin/login, which
// runs as root (2026-10-24: the bare-cli reset did not see the harness inside Ghostty and quit it). ps reads any ppid.
function parentLookup(all: readonly NativeProc[]): (pid: number) => number | undefined {
  const parent = new Map<number, number | undefined>(all.map((proc) => [proc.pid, proc.ppid]));
  return (pid) => {
    if (parent.has(pid)) return parent.get(pid);
    const result = runner.run(["ps", "-o", "ppid=", "-p", String(pid)]);
    const ppid = Number.parseInt(result.stdout.trim(), 10);
    const value = result.code === 0 && Number.isInteger(ppid) ? ppid : undefined;
    parent.set(pid, value);
    return value;
  };
}

function runsBelow(parentOf: (pid: number) => number | undefined, rootPid: number, pid: number): boolean {
  let current = parentOf(pid);
  for (let depth = 0; depth < 64 && current !== undefined && current > 1; depth++) {
    if (current === rootPid) return true;
    current = parentOf(current);
  }
  return false;
}

export async function procsUnder(ctx: AdapterContext, rootPid: number, hints: PidHints): Promise<NativeProc[]> {
  if (plan(ctx, "procsUnder", [`root=${rootPid}`, hintsArg(hints)])) return [];
  const all = await runner.procs();
  const parentOf = parentLookup(all);
  return all.filter((proc) => matchesHints(proc, hints) && runsBelow(parentOf, rootPid, proc.pid));
}

// Whether `pid` runs inside `rootPid`'s process tree (for example the harness inside a terminal tab).
export async function runsUnder(ctx: AdapterContext, rootPid: number, pid: number): Promise<boolean> {
  if (plan(ctx, "runsUnder", [`root=${rootPid}`, `pid=${pid}`])) return false;
  return runsBelow(parentLookup(await runner.procs()), rootPid, pid);
}

// The app's own main process among the processes that match its hints. 2026-10-24: Zeron's `zeron mcp` children share
// the app's executable, Traycer's host LaunchAgent lives inside the bundle, and a quitting instance can outlive the
// relaunch, so the first match was often a process with no window. The main process runs the bundle's
// Contents/MacOS executable and was started by launchd (ppid 1); the newest one wins.
export function pickMainProc(procs: readonly NativeProc[], hints: PidHints): NativeProc | null {
  const matching = procs.filter((proc) => matchesHints(proc, hints));
  const macosDirs = (hints.bundlePaths ?? []).map((bundle) => join(bundle, "Contents", "MacOS"));
  const launched = matching.filter((proc) => proc.ppid === 1);
  const main = launched.filter((proc) => macosDirs.includes(dirname(proc.path)));
  const newest = (list: readonly NativeProc[]): NativeProc | null =>
    list.length === 0 ? null : list.reduce((best, proc) => (proc.pid > best.pid ? proc : best));
  if (macosDirs.length > 0) return newest(main);
  return newest(launched) ?? newest(matching);
}

export async function mainPid(ctx: AdapterContext, hints: PidHints): Promise<number | null> {
  if (plan(ctx, "mainPid", [hintsArg(hints)])) return null;
  return pickMainProc(await runner.procs(), hints)?.pid ?? null;
}

export async function pidsFor(ctx: AdapterContext, hints: PidHints): Promise<number[]> {
  if (plan(ctx, "pidsFor", [hintsArg(hints)])) return [];
  const all = await runner.procs();
  return all.filter((proc) => matchesHints(proc, hints)).map((proc) => proc.pid);
}

// Waits for an app's main process after `open -b` (ADES.md 3.1: up to 30 s for the pid).
export async function waitForPid(ctx: AdapterContext, hints: PidHints, timeoutMs: number): Promise<number | null> {
  if (ctx.dryRun) {
    ctx.log(planMessage("waitForPid", [hintsArg(hints), `timeoutMs=${timeoutMs}`]));
    return null;
  }
  assertAdemarkUser();
  const startedAt = runner.now();
  while (true) {
    const main = pickMainProc(await runner.procs(), hints);
    if (main !== null) return main.pid;
    if (runner.now() - startedAt >= timeoutMs) return null;
    await runner.sleep(250);
  }
}

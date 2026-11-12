// `ademark machine on|off|status`: the root script for system settings plus the settings that live in this account.
import { basename, join } from "node:path";
import { assertApplyAllowed } from "../fault/kill-agent.ts";
import { MACHINE_BIN } from "./machine-state.ts";
import { defaultOpsRunner, type OpsRunner, type OpsRun } from "./runner.ts";

export const ADEMARK_USER = "ademark";
export const DISPLAYPLACER = "/opt/homebrew/bin/displayplacer";
export const ANALYZERS = ["mediaanalysisd", "photoanalysisd"] as const;
export const TELEMETRY_ENV = "T3CODE_TELEMETRY_ENABLED";
// Variables GUI apps read from launchd for the night: T3 Code telemetry off, Zeron and Superset auto-update off
// (2026-10-24: Zeron updated itself in the middle of a gate), and no claude.ai connectors in agent sessions.
export const NIGHT_ENV: ReadonlyArray<readonly [string, string]> = [
  [TELEMETRY_ENV, "false"],
  ["ZERON_AUTO_UPDATE", "0"],
  ["DISABLE_UPDATE_CHECK", "1"],
  ["ENABLE_CLAUDEAI_MCP_SERVERS", "false"],
];
// What an earlier block can leave in launchd (adapters setenv before launch); doctor blocks the night on them.
export const HARNESS_ENV = [
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "SSL_CERT_FILE",
  "CODEX_CA_CERTIFICATE",
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_LOG_RAW_API_BODIES",
] as const;
export const INSTALL_COMMAND = "sudo zsh bench/ops/install-machine.zsh";

export type MachineAction = "on" | "off" | "status";

export interface PausedProcess {
  pid: number;
  name: string;
}

export interface UserMachineState {
  displayplacer: string | null;
  paused: PausedProcess[];
  saved_at: string;
}

export class MachineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineError";
  }
}

export function userStatePath(home: string): string {
  return join(home, ".ademark", "machine-user.json");
}

export function readUserState(runner: OpsRunner): UserMachineState {
  const text = runner.readFile(userStatePath(runner.home()));
  if (text === null) return { displayplacer: null, paused: [], saved_at: "" };
  try {
    const parsed = JSON.parse(text) as Partial<UserMachineState>;
    const paused = Array.isArray(parsed.paused)
      ? parsed.paused.filter(
          (entry): entry is PausedProcess =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as PausedProcess).pid === "number" &&
            typeof (entry as PausedProcess).name === "string",
        )
      : [];
    return {
      displayplacer: typeof parsed.displayplacer === "string" ? parsed.displayplacer : null,
      paused,
      saved_at: typeof parsed.saved_at === "string" ? parsed.saved_at : "",
    };
  } catch {
    return { displayplacer: null, paused: [], saved_at: "" };
  }
}

export function writeUserState(runner: OpsRunner, state: UserMachineState): void {
  runner.mkdirp(join(runner.home(), ".ademark"));
  runner.writeFile(userStatePath(runner.home()), `${JSON.stringify(state, null, 2)}\n`);
}

// `displayplacer list` ends with the command that reproduces the current mode. That whole string is what `off` wants.
export function parseDisplayplacerMode(listOutput: string): string | null {
  let mode: string | null = null;
  for (const line of listOutput.split("\n")) {
    const quoted = line.match(/^\s*displayplacer\s+"([^"]+)"\s*$/);
    if (quoted) {
      mode = quoted[1]!;
      continue;
    }
    const bare = line.match(/^\s*displayplacer\s+(.+?)\s*$/);
    if (bare) mode = bare[1]!;
  }
  return mode;
}

// The same resolution and scale, at 60 Hz. The list string carries every other display option unchanged.
export function modeAt60(mode: string): string | null {
  if (!/\bhz:\d+(?:\.\d+)?\b/.test(mode)) return null;
  return mode.replace(/\bhz:\d+(?:\.\d+)?\b/, "hz:60");
}

export function parseProcessList(text: string): Array<{ pid: number; uid: number; command: string }> {
  const out: Array<{ pid: number; uid: number; command: string }> = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (match) out.push({ pid: Number(match[1]), uid: Number(match[2]), command: match[3]! });
  }
  return out;
}

export function analyzerPids(text: string, uid: number): PausedProcess[] {
  const wanted = new Set<string>(ANALYZERS);
  const seen = new Set<number>();
  const out: PausedProcess[] = [];
  for (const proc of parseProcessList(text)) {
    const name = basename(proc.command);
    if (proc.uid !== uid || !wanted.has(name) || seen.has(proc.pid)) continue;
    seen.add(proc.pid);
    out.push({ pid: proc.pid, name });
  }
  return out;
}

function shellLine(argv: readonly string[]): string {
  return argv.join(" ");
}

function rootArgv(action: MachineAction): string[] {
  return ["sudo", "-n", MACHINE_BIN, action];
}

function rootRun(runner: OpsRunner, action: MachineAction): string {
  const argv = rootArgv(action);
  const result = runner.run(argv);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new MachineError(
      `${shellLine(argv)} failed: ${detail}\n` +
        `The root script is not installed or the sudoers rule is missing. Run: ${INSTALL_COMMAND}`,
    );
  }
  return result.stdout;
}

interface CommandContext {
  runner: OpsRunner;
  apply: boolean;
  out: (line: string) => void;
}

function displayMode(runner: OpsRunner): { exists: boolean; mode: string | null } {
  if (!runner.exists(DISPLAYPLACER)) return { exists: false, mode: null };
  const result = runner.run([DISPLAYPLACER, "list"]);
  if (result.code !== 0) return { exists: true, mode: null };
  return { exists: true, mode: parseDisplayplacerMode(result.stdout) };
}

function planOrRun(ctx: CommandContext, argv: string[], action: () => OpsRun | void): void {
  if (!ctx.apply) {
    ctx.out(`plan: ${shellLine(argv)}`);
    return;
  }
  const result = action();
  if (result !== undefined && result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new MachineError(`${shellLine(argv)} failed: ${detail}`);
  }
  ctx.out(`ran: ${shellLine(argv)}`);
}

function onUser(ctx: CommandContext): void {
  const state = readUserState(ctx.runner);
  const display = displayMode(ctx.runner);
  if (!display.exists) {
    ctx.out("manual: install displayplacer, or set System Settings > Displays > Refresh rate: 60 Hertz");
  } else if (display.mode === null) {
    ctx.out("manual: displayplacer list printed no current mode; set Refresh rate: 60 Hertz by hand");
  } else {
    const target = modeAt60(display.mode);
    if (target === null) {
      ctx.out("manual: displayplacer lists no hz for the main display; set Refresh rate: 60 Hertz by hand");
    } else {
      ctx.out(`display: ${state.displayplacer === null ? "save the current mode" : "keep the saved mode"}`);
      planOrRun(ctx, [DISPLAYPLACER, target], () => ctx.runner.run([DISPLAYPLACER, target]));
      if (state.displayplacer === null && ctx.apply) {
        state.displayplacer = display.mode;
        state.saved_at = new Date(ctx.runner.now()).toISOString();
        writeUserState(ctx.runner, state);
      }
    }
  }

  const ps = ctx.runner.run(["ps", "-axo", "pid=,uid=,comm="]);
  const analyzers = ps.code === 0 ? analyzerPids(ps.stdout, ctx.runner.uid()) : [];
  if (analyzers.length === 0) {
    ctx.out("analyzers: none running");
  }
  for (const proc of analyzers) {
    planOrRun(ctx, ["kill", "-STOP", String(proc.pid)], () => {
      try {
        ctx.runner.signal(proc.pid, "SIGSTOP");
      } catch {
        // The analyzer can exit between the listing and the signal.
      }
    });
  }
  if (ctx.apply && analyzers.length > 0) {
    const known = new Set(state.paused.map((entry) => entry.pid));
    state.paused = [...state.paused, ...analyzers.filter((entry) => !known.has(entry.pid))];
    state.saved_at = new Date(ctx.runner.now()).toISOString();
    writeUserState(ctx.runner, state);
  }

  for (const [name, value] of NIGHT_ENV) {
    planOrRun(ctx, ["launchctl", "setenv", name, value], () => ctx.runner.run(["launchctl", "setenv", name, value]));
  }
  for (const name of HARNESS_ENV) {
    planOrRun(ctx, ["launchctl", "unsetenv", name], () => ctx.runner.run(["launchctl", "unsetenv", name]));
  }
}

function offUser(ctx: CommandContext): void {
  const state = readUserState(ctx.runner);
  if (state.displayplacer === null) {
    ctx.out("display: nothing saved");
  } else if (!ctx.runner.exists(DISPLAYPLACER)) {
    ctx.out(`manual: install displayplacer to restore: ${DISPLAYPLACER} ${state.displayplacer}`);
  } else {
    planOrRun(ctx, [DISPLAYPLACER, state.displayplacer], () =>
      ctx.runner.run([DISPLAYPLACER, state.displayplacer!]),
    );
  }
  if (state.paused.length === 0) {
    ctx.out("analyzers: nothing paused");
  }
  for (const proc of state.paused) {
    planOrRun(ctx, ["kill", "-CONT", String(proc.pid)], () => {
      try {
        ctx.runner.signal(proc.pid, "SIGCONT");
      } catch {
        // A finished analyzer has no process left to resume.
      }
    });
  }
  for (const name of [...NIGHT_ENV.map(([env]) => env), ...HARNESS_ENV]) {
    planOrRun(ctx, ["launchctl", "unsetenv", name], () => ctx.runner.run(["launchctl", "unsetenv", name]));
  }
  if (ctx.apply) {
    writeUserState(ctx.runner, { displayplacer: null, paused: [], saved_at: new Date(ctx.runner.now()).toISOString() });
  }
}

function statusUser(runner: OpsRunner, out: (line: string) => void): void {
  const state = readUserState(runner);
  out(`user.displayplacer=${state.displayplacer ?? "none"}`);
  out(
    `user.paused=${state.paused.length === 0 ? "none" : state.paused.map((entry) => `${entry.pid}:${entry.name}`).join(",")}`,
  );
}

export interface MachineOptions {
  apply?: boolean;
  runner?: OpsRunner;
  out?: (line: string) => void;
}

export function machineCommand(action: MachineAction, options: MachineOptions = {}): void {
  const runner = options.runner ?? defaultOpsRunner;
  const out = options.out ?? ((line: string) => console.log(line));
  const apply = options.apply === true;
  const ctx: CommandContext = { runner, apply, out };

  if (action === "status") {
    if (runner.username() === ADEMARK_USER) {
      out("root:");
      for (const line of rootRun(runner, "status").trim().split("\n")) out(`  ${line}`);
    } else {
      out(`root: skipped (not the ${ADEMARK_USER} user)`);
    }
    statusUser(runner, out);
    return;
  }

  if (apply) assertApplyAllowed({ apply }, `machine ${action}`);

  if (action === "on") {
    if (apply) {
      out(`root: ${shellLine(rootArgv("on"))}`);
      rootRun(runner, "on");
    } else {
      out(`plan: ${shellLine(rootArgv("on"))}`);
    }
    onUser(ctx);
    return;
  }

  // Both halves run even if the first fails: a partly restored machine is the worst way to end.
  let rootError: unknown = null;
  if (apply) {
    out(`root: ${shellLine(rootArgv("off"))}`);
    try {
      rootRun(runner, "off");
    } catch (error) {
      rootError = error;
    }
  } else {
    out(`plan: ${shellLine(rootArgv("off"))}`);
  }
  offUser(ctx);
  if (rootError !== null) throw rootError;
}

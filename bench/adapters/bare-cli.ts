// Control: Claude Code 2.1.303, Codex 0.163.0 and Ghostty 1.3.1 (ADES.md 3.0).
import type { Adapter, AdapterContext, RunOptions, Trigger } from "../core/contracts.ts";
import { restore } from "../core/snapshot.ts";
import {
  isRealRun,
  killPids,
  openBundle,
  paste,
  pidsFor,
  press,
  procsUnder,
  resizeWindow,
  pause,
  runTool,
  trustClaudeFolder,
  typeText,
  waitForText,
  waitForPid,
  waitGone,
  type PidHints,
} from "./macos.ts";
import { waitForEndOfTurn, type SessionAgent } from "./session-log.ts";
import {
  appPathFor,
  checkBareCli,
  cleanSnapshotDir,
  missingValue,
  planMessage,
  processHints,
  withoutAncestors,
} from "./support.ts";
import { AGENT_EXECUTABLES, CLAUDE_NATIVE_DIR } from "../core/agents.ts";
import { agentSessionKeys } from "../core/env.ts";

export interface BareCliCalibration {
  appName: string;
  bundleId: string;
  newTabCombo: string | null;
  claudeEffortFlag: string | null;
  codexEffortFlag: string | null;
  closeOldTabs: string | null;
}

const EFFORT_WORDING = "ADES.md 3.0: effort setting: find in pilot";
const CODEX_EFFORT_WORDING = "ADES.md 3.0: model and effort settings (find in pilot)";
const NEW_TAB_WORDING = 'ADES.md 3.0: "Ghostty\'s new-tab shortcut: verify in pilot"';
const CLOSE_TABS_WORDING = 'ADES.md 3.0: "close every Ghostty tab except the harness tab"';

// ADES.md 3.0 marks these as "find in pilot". Never guess: fill them from the pilot and record it there.
// Pilot 2026-10-20 (results/pilot/findings.md), Ghostty 1.3.1 with the ademark config (RUNBOOK.md 4.10):
// - newTabCombo: Ghostty's default `super+t=new_tab`; a new tab opened from ademark-native keys.
// - quit: closing a tab with `confirm-close-surface = false` needs no dialog, and the CLI inside it exits with the tab.
// - closeOldTabs: `super+alt+shift+o=close_tab:other` from the ademark Ghostty config, pressed after Cmd+1 focuses
//   the harness tab; three tabs closed down to one.
// - claudeEffortFlag: `--effort <level>` from `claude --help` (2.1.303).
// - codexEffortFlag: `model_reasoning_effort`, a config key present in the Codex 0.163.0 binary, set with `-c`.
export const calibration: BareCliCalibration = {
  appName: "Ghostty",
  bundleId: "com.mitchellh.ghostty",
  newTabCombo: "cmd+t",
  claudeEffortFlag: "--effort high",
  codexEffortFlag: "-c model_reasoning_effort=high",
  closeOldTabs: "cmd+alt+shift+o",
};

// The harness runs in Ghostty's first tab (RUNBOOK.md 7), so reset focuses it before closing the others.
const HARNESS_TAB_COMBO = "cmd+1";
// Pilot 2026-10-20: typing right after Cmd+T lost the first character ("d /Users/..."), so the CLI never started. A
// person waits for the new tab's prompt too; the wait is part of the timed new-thread action.
const NEW_TAB_SETTLE_MS = 400;
// The footer line under the input once the CLI is ready (Claude Code 2.1.303: "bypass permissions on"). Vision reads
// "permissions" as "pepmlsslons" in this font, so the needle is "bypass".
const READY_FOOTER = { x: 0, y: 960, w: 900, h: 40 };
// Codex's footer is not calibrated yet (Codex is not signed in on the bench Mac).
const READY_TEXT: Record<SessionAgent, string | null> = { claude: "bypass", codex: null };
const CODEX_READY_WORDING = "pilot: the Codex TUI's ready line is not calibrated (Codex not signed in)";
const CLI_READY_TIMEOUT_S = 30;
const QUIT_TIMEOUT_MS = 10_000;
const GHOSTTY_LAUNCH_TIMEOUT_MS = 30_000;
// ADES.md 1 rule 3. The regions below are in this window.
const WINDOW = { w: 1600, h: 1000 };

export interface BareCliState {
  agent: SessionAgent;
  model: string | null;
  effort: string | null;
  // The CLI itself, built by configure.
  cliCommand: string | null;
  // The line typed into the new tab, built by launch because the run loop fills ctx.env in between.
  command: string | null;
  // The env launch typed into the command; configure rebuilds a later arena's command with it.
  env: Record<string, string> | null;
  pid: number | null;
  since: number;
}

export const state: BareCliState = {
  agent: "claude",
  model: null,
  effort: null,
  cliCommand: null,
  command: null,
  env: null,
  pid: null,
  since: 0,
};

const GHOSTTY: PidHints = { bundlePaths: [appPathFor("Ghostty")], names: ["ghostty"] };
const AGENT_NAMES = ["claude", "codex"];
// The native Claude Code binary lives in a versions folder under its version number (bench/core/agents.ts).
const AGENT_HINTS: PidHints = { names: AGENT_NAMES, bundlePaths: [CLAUDE_NATIVE_DIR] };

export function cliCommand(agent: SessionAgent, model: string | null, effortFlag: string | null): string {
  const parts = [agent];
  if (model !== null) parts.push("--model", model);
  if (effortFlag !== null) parts.push(effortFlag);
  parts.push(agent === "claude" ? "--dangerously-skip-permissions" : "--dangerously-bypass-approvals-and-sandbox");
  return parts.join(" ");
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

// GUI apps read launchd's environment, not the shell's; a running Ghostty never sees a later `launchctl setenv`,
// so the block's variables ride in the typed command instead (RUNBOOK.md 7.1 step 7).
export function envAssignments(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((name) => `${name}=${shellQuote(env[name]!)}`)
    .join(" ");
}

// RUNBOOK.md 7.1 step 8: the agent must run in the arena copy the run loop prepared.
export function cliStartCommand(worktree: string, env: Record<string, string>, command: string): string {
  const assignments = envAssignments(env);
  const prefix = assignments.length > 0 ? `${assignments} ` : "";
  return `cd ${shellQuote(worktree)} && ${prefix}${command}`;
}

function effortFlagFor(ctx: AdapterContext, agent: SessionAgent): string | null {
  if (agent === "claude") {
    if (calibration.claudeEffortFlag !== null) return calibration.claudeEffortFlag;
    missingValue(ctx, "claudeEffortFlag", EFFORT_WORDING);
    return null;
  }
  if (calibration.codexEffortFlag !== null) return calibration.codexEffortFlag;
  missingValue(ctx, "codexEffortFlag", CODEX_EFFORT_WORDING);
  return null;
}

function commandOf(): string {
  if (state.command === null) throw new Error("configure() must run before driving the CLI");
  return state.command;
}

function newTabCombo(ctx: AdapterContext): string {
  return calibration.newTabCombo ?? missingValue(ctx, "newTabCombo", NEW_TAB_WORDING, "<newTabCombo>");
}

// 2026-11-09 08:34: a second click on ADEMark Control opened a second Ghostty, and reset quit "Ghostty" by name, so
// both instances died with Control inside one of them (results/control-2026-11-09T04-18-06Z-bare-cli-2/events.log:
// "open -b com.mitchellh.ghostty failed ... error -600"). Every instance is looked at now, and one that hosts the
// harness is never quit.
const HARNESS_COMMAND = /bench\/cli\.ts/;
const PS_TABLE = ["ps", "-axww", "-o", "pid=,ppid=,command="];

/**
 * The Ghostty pids that host a `bench/cli.ts` process somewhere below them, from `ps -o pid=,ppid=,command=`. The one
 * that hosts `self` (this harness) comes first. ps also sees /usr/bin/login, which runs as root between Ghostty and
 * the tab's shell.
 */
export function hostingGhostty(ghostty: readonly number[], psTable: string, self: number): number[] {
  const parent = new Map<number, number>();
  const harness: number[] = [];
  for (const line of psTable.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    parent.set(pid, Number(match[2]));
    if (HARNESS_COMMAND.test(match[3]!)) harness.push(pid);
  }
  const hostOf = (pid: number): number | null => {
    let current: number | undefined = pid;
    for (let depth = 0; depth < 64 && current !== undefined && current > 1; depth++) {
      if (ghostty.includes(current)) return current;
      current = parent.get(current);
    }
    return null;
  };
  const hosts = new Set<number>();
  const own = hostOf(self);
  if (own !== null) hosts.add(own);
  for (const pid of harness) {
    const host = hostOf(pid);
    if (host !== null) hosts.add(host);
  }
  return [...hosts];
}

async function ghosttyView(ctx: AdapterContext): Promise<{ pids: number[]; hosting: number[] }> {
  const pids = await pidsFor(ctx, GHOSTTY);
  if (pids.length === 0) return { pids, hosting: [] };
  return { pids, hosting: hostingGhostty(pids, runTool(ctx, PS_TABLE), process.pid) };
}

async function ghosttyPid(ctx: AdapterContext): Promise<number> {
  const { pids, hosting } = await ghosttyView(ctx);
  const pid = hosting[0] ?? pids[0];
  if (pid === undefined) {
    if (ctx.dryRun) return state.pid ?? 0;
    throw new Error("Ghostty is not running; ADES.md 2.1 keeps it open before the block");
  }
  state.pid = pid;
  return pid;
}

// Never by app name: that reaches every instance, the hosting one too. A pid that already left is what we wanted.
async function quitGhosttyPids(ctx: AdapterContext, pids: readonly number[]): Promise<void> {
  for (const pid of pids) {
    try {
      runTool(ctx, ["kill", "-TERM", String(pid)]);
    } catch {
      // It exited between the listing and the signal.
    }
  }
  killPids(ctx, await waitGone(ctx, pids, QUIT_TIMEOUT_MS));
}

// Pilot 2026-10-20: a Ghostty kept open since the morning had a 513 MB footprint (1.9 GB lifetime peak) at the start of
// chain 2, and A5 counts it, while every other ADE starts its block as a new process. Reset restarts Ghostty, unless
// the harness itself runs in one of its tabs (RUNBOOK.md 7). Then the hosting instance stays and only the others go.
export async function freshGhostty(ctx: AdapterContext): Promise<number> {
  const { pids, hosting } = await ghosttyView(ctx);
  const others = pids.filter((pid) => !hosting.includes(pid));
  if (hosting.length > 0) {
    if (others.length > 0) {
      ctx.log(`reset: quitting other Ghostty instances ${others.join(",")}; ${hosting.join(",")} hosts the harness`);
      await quitGhosttyPids(ctx, others);
    }
    ctx.log("reset: Ghostty kept open; the harness runs inside it");
    state.pid = hosting[0]!;
    return hosting[0]!;
  }
  await quitGhosttyPids(ctx, pids);
  openBundle(ctx, calibration.bundleId);
  const fresh = await waitForPid(ctx, GHOSTTY, GHOSTTY_LAUNCH_TIMEOUT_MS);
  if (fresh === null) {
    if (ctx.dryRun) return state.pid ?? 0;
    throw new Error("Ghostty did not start again within 30 s");
  }
  state.pid = fresh;
  return fresh;
}

function pidOrZero(): number {
  return state.pid ?? 0;
}

// A3 posts these through the echo timer; with the shortcut uncalibrated there is no honest trigger to post.
function startTriggers(): Trigger[] {
  if (calibration.newTabCombo === null || state.command === null) return [];
  return [
    { kind: "keys", combo: calibration.newTabCombo },
    { kind: "wait", ms: NEW_TAB_SETTLE_MS },
    { kind: "type", text: state.command },
    { kind: "enter" },
  ];
}

export const bareCli: Adapter = {
  id: "bare-cli",
  name: "Bare CLI",
  family: "control",
  agents: ["claude", "codex"],
  calibration: {
    appName: calibration.appName,
    bundleId: calibration.bundleId,
    // Pilot 2026-10-20, Claude Code 2.1.303 in Ghostty at 1600 x 1000: the input line sits at y 928 to 945 depending on
    // the footer lines under it; lag over this rect read 30 of 30 probes (p50 47 ms).
    composerRect: { x: 0, y: 920, w: 1200, h: 40 },
    // Output above the effort indicator, below the start banner.
    threadRect: { x: 0, y: 150, w: 1600, h: 740 },
    // The input is focused when the CLI starts.
    focusClick: null,
    // Pilot: cmd+a, delete leaves the Claude Code input full; ctrl+u empties it.
    clearKeys: ["ctrl+u"],
    masks: [],
    // ADES.md 3.0: "Drive | keystrokes into Ghostty; logs for harvest".
    drive: "keys",
    // ADES.md 3.0: "Data to move aside | none; the clean snapshot of ~/.claude, ~/.codex and ~/.agents is the state".
    dataDirs: [],
    launchAgents: [],
  },
  login: { kind: "agent-cli", files: [], signIn: null },
  get timed() {
    return {
      launch: startTriggers(),
      newThread: startTriggers(),
      send: [{ kind: "enter" as const }],
      // A11: each thread is a Ghostty tab. The block's first seed thread is tab 2 (tab 1 is the harness), and the long
      // thread is built last, so Ghostty's default `super+9=last_tab` reaches it.
      longThread: [{ kind: "keys" as const, combo: "cmd+9" }],
      shortThread: [{ kind: "keys" as const, combo: "cmd+2" }],
    };
  },
  // ADES.md §3.0: Claude Code has built-in subagents, so its trigger line is a pilot item (undefined);
  // Codex orchestration is "not supported", which is a real null.
  hostStaysOpen: true,
  get orchestrationTrigger(): string | null | undefined {
    return state.agent === "codex" ? null : undefined;
  },
  // C6 (TESTS.md §1.6): `claude --continue` reopens the newest conversation of its folder, and each C6 run has its own
  // arena copy, so that is the thread the restart interrupted. Codex has no proven equivalent, so it stays uncalibrated.
  get returnToThread(): ((ctx: AdapterContext) => Promise<void>) | undefined {
    if (state.agent !== "claude") return undefined;
    return async (ctx: AdapterContext): Promise<void> => {
      isRealRun(ctx);
      if (state.cliCommand === null || state.env === null) throw new Error("launch() must run before returnToThread()");
      await press(ctx, pidOrZero(), newTabCombo(ctx));
      await pause(ctx, NEW_TAB_SETTLE_MS);
      await typeText(ctx, pidOrZero(), cliStartCommand(ctx.worktree, state.env, `${state.cliCommand} --continue`));
      await press(ctx, pidOrZero(), "enter");
      await waitForText(ctx, pidOrZero(), READY_FOOTER, READY_TEXT.claude!, CLI_READY_TIMEOUT_S);
      state.since = Date.now();
    };
  },
  installCheck: checkBareCli,
  async reset(ctx: AdapterContext): Promise<void> {
    isRealRun(ctx);
    const closeOthers = calibration.closeOldTabs ?? missingValue(ctx, "closeOldTabs", CLOSE_TABS_WORDING, "<closeOldTabs>");
    const pid = await freshGhostty(ctx);
    // Pilot 2026-10-20 (bench/core/env.ts): a Ghostty opened from inside an agent session hands its marker to every CLI
    // and Claude Code then saves no transcript, so waitDone never sees a turn end.
    const inherited = agentSessionKeys(runTool(ctx, ["ps", "-E", "-ww", "-o", "command=", "-p", String(pid)]));
    if (inherited.length > 0) {
      throw new Error(`Ghostty (pid ${pid}) was started from an agent session (${inherited.join(", ")}); quit it and open it from the Dock`);
    }
    await resizeWindow(ctx, pid, WINDOW);
    await press(ctx, pid, HARNESS_TAB_COMBO);
    await press(ctx, pid, closeOthers);
    // Only CLIs started inside Ghostty's tabs: never an agent session elsewhere on the machine.
    const agents = await procsUnder(ctx, pid, AGENT_HINTS);
    killPids(ctx, withoutAncestors(agents).map((proc) => proc.pid));
    const dir = cleanSnapshotDir();
    if (ctx.dryRun) ctx.log(planMessage("restoreSnapshot", [dir, "(apply)"]));
    else restore(dir, ctx.home, { apply: true });
  },
  async configure(ctx: AdapterContext, options: RunOptions): Promise<void> {
    isRealRun(ctx);
    if (options.agent === "own") throw new Error("bare-cli runs Claude Code and Codex only (ADES.md 3.0)");
    const agent: SessionAgent = options.agent;
    const effortFlag = effortFlagFor(ctx, agent);
    state.agent = agent;
    state.model = options.model;
    state.effort = options.effort;
    state.cliCommand = cliCommand(agent, options.model, effortFlag);
    if (agent === "claude") trustClaudeFolder(ctx, ctx.worktree);
    // A later test needs the same typed environment in a new arena; before the first launch there is none.
    state.command = state.env === null ? null : cliStartCommand(ctx.worktree, state.env, state.cliCommand);
  },
  async launch(ctx: AdapterContext): Promise<{ pid: number }> {
    isRealRun(ctx);
    if (state.cliCommand === null) throw new Error("configure() must run before launch()");
    state.env = { ...ctx.env };
    state.command = cliStartCommand(ctx.worktree, state.env, state.cliCommand);
    if (ctx.dryRun) ctx.log(planMessage("command", [state.command]));
    return { pid: await ghosttyPid(ctx) };
  },
  async newThread(ctx: AdapterContext): Promise<void> {
    isRealRun(ctx);
    const combo = newTabCombo(ctx);
    await press(ctx, pidOrZero(), combo);
    await pause(ctx, NEW_TAB_SETTLE_MS);
    await typeText(ctx, pidOrZero(), commandOf());
    await press(ctx, pidOrZero(), "enter");
    // Untimed here (A3 times its own triggers): the next keys must reach the CLI, not the shell, so wait for its
    // footer. Pilot: A4 typed its prompt while Claude Code was still starting, and no request reached the replay server.
    const ready = READY_TEXT[state.agent] ?? missingValue(ctx, "codexReadyText", CODEX_READY_WORDING, "<codexReadyText>");
    await waitForText(ctx, pidOrZero(), READY_FOOTER, ready, CLI_READY_TIMEOUT_S);
    state.since = Date.now();
  },
  async send(ctx: AdapterContext, text: string): Promise<void> {
    isRealRun(ctx);
    state.since = Date.now();
    await paste(ctx, pidOrZero(), text);
    await press(ctx, pidOrZero(), "enter");
  },
  async waitDone(ctx: AdapterContext, timeoutMs: number): Promise<{ done: boolean; reason: string }> {
    isRealRun(ctx);
    if (ctx.dryRun) {
      ctx.log(
        planMessage("waitForEndOfTurn", [`agent=${state.agent}`, `cwd=${ctx.worktree}`, `timeoutMs=${timeoutMs}`]),
      );
      return { done: true, reason: "dry run" };
    }
    return waitForEndOfTurn({
      ctx,
      agent: state.agent,
      cwd: ctx.worktree,
      since: state.since || Date.now(),
      timeoutMs,
      pollMs: 2000,
      idleFallback: false,
    });
  },
  // Quitting the control ends every CLI tab, as quitting an app ends all its threads. Pilot 2026-10-20: closing only the
  // current tab left the A10 and A11 tabs running, about 1 % CPU each, and every A2 gate failed at 0.3 cores.
  async quit(ctx: AdapterContext): Promise<void> {
    isRealRun(ctx);
    const closeOthers = calibration.closeOldTabs ?? missingValue(ctx, "closeOldTabs", CLOSE_TABS_WORDING, "<closeOldTabs>");
    const pid = await ghosttyPid(ctx);
    const agents = withoutAncestors(await procsUnder(ctx, pid, AGENT_HINTS)).map((proc) => proc.pid);
    await press(ctx, pid, HARNESS_TAB_COMBO);
    await press(ctx, pid, closeOthers);
    const alive = await waitGone(ctx, agents, QUIT_TIMEOUT_MS);
    if (!ctx.dryRun) {
      const list = alive.length === 0 ? "none" : alive.join(",");
      ctx.log(`quit: CLIs still alive after ${QUIT_TIMEOUT_MS / 1000} s: ${list}`);
    }
  },
  // ADES.md 3.0: "Processes | ghostty, claude or codex subtrees".
  processes: () => processHints({ bundlePaths: [appPathFor("Ghostty")], agentExecutables: [...AGENT_EXECUTABLES] }),
};

// An ADE profile (bench/adapters/profiles/<ade>.json) turned into an Adapter (contracts.ts, `AdeProfile`).
// The profile is loaded on first use, so a missing file never breaks `adapter list` and a stub adapter still works.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  Adapter,
  AdapterContext,
  AdeProfile,
  Agent,
  Calibration,
  Drive,
  Family,
  InstallInfo,
  LoginSpec,
  ProcessHints,
  RunOptions,
  Trigger,
} from "../core/contracts.ts";
import { restore } from "../core/snapshot.ts";
import {
  bootout,
  isRealRun,
  killPids,
  mainPid,
  moveAside,
  openBundle,
  paste,
  pause,
  pidsFor,
  press,
  quitApp,
  resizeWindow,
  restoreSeed,
  runTool,
  setJsonKeys,
  setJsonPath,
  setenv,
  waitForPid,
  waitGone,
  windowText,
  type PidHints,
} from "./macos.ts";
import { waitForEndOfTurn } from "./session-log.ts";
import { appPathFor, checkApp, cleanSnapshotDir, planMessage, processHints } from "./support.ts";
import { validateProfile } from "./profile-validate.ts";
import { clearBlockers } from "../agent/goal.ts";
import { stageProfile } from "../agent/stage.ts";
import { agentDir, runSteps, type StepVars } from "./profile-steps.ts";
import { benchRoot } from "../core/paths.ts";

const APP_LAUNCH_TIMEOUT_MS = 30_000;
const QUIT_TIMEOUT_MS = 10_000;
const HOME_PREFIX = "~/";

// What the adapter knows from ADES.md before a profile exists, so a stub behaves exactly as it did in code.
export interface AdapterBase {
  id: string;
  name: string;
  family: Family;
  agents: Agent[];
  appName: string;
  appPath?: string;
  bundleId: string | null;
  drive: Drive;
  dataDirs: string[];
  launchAgents: string[];
  vendorDirs: string[];
  agentExecutables?: string[];
  teamId?: string | null;
  orchestrationTrigger?: string | null;
  timed?: Adapter["timed"];
}

export interface ProfileCheck {
  id: string;
  status: "ok" | "missing" | "invalid";
  errors: string[];
}

export class ProfileError extends Error {
  readonly errors: string[];

  constructor(id: string, errors: string[]) {
    super(`invalid profile for ${id}:\n${errors.join("\n")}`);
    this.name = "ProfileError";
    this.errors = errors;
  }
}

export function profilesDir(): string {
  return process.env.ADEMARK_PROFILES ?? resolve(benchRoot, "adapters", "profiles");
}

export function profileFile(id: string): string {
  return join(profilesDir(), `${id}.json`);
}

export function checkProfile(id: string, agents: readonly Agent[] = []): ProfileCheck {
  const file = profileFile(id);
  if (!existsSync(file)) return { id, status: "missing", errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return {
      id,
      status: "invalid",
      errors: [`${file}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const errors = validateProfile(raw, id, agents);
  return { id, status: errors.length === 0 ? "ok" : "invalid", errors };
}

export function loadProfile(id: string): AdeProfile | null {
  const checked = checkProfile(id);
  if (checked.status === "missing") return null;
  if (checked.status === "invalid") throw new ProfileError(id, checked.errors);
  return JSON.parse(readFileSync(profileFile(id), "utf8")) as AdeProfile;
}

const PROFILE_BASES = new WeakMap<Adapter, AdapterBase>();

export function isProfileAdapter(adapter: Adapter): boolean {
  return PROFILE_BASES.has(adapter);
}

export function profileAgents(adapter: Adapter): Agent[] | undefined {
  return PROFILE_BASES.get(adapter)?.agents;
}

function baseCalibration(base: AdapterBase): Calibration {
  return {
    appName: base.appName,
    bundleId: base.bundleId,
    composerRect: null,
    threadRect: null,
    focusClick: null,
    masks: [],
    drive: base.drive,
    dataDirs: base.dataDirs,
    launchAgents: base.launchAgents,
  };
}

function emptyTimed(): Adapter["timed"] {
  return { launch: [], newThread: [], send: [] };
}

interface ProfileState {
  profile: AdeProfile | null | undefined;
  pid: number | null;
  project: string | null;
  agent: Agent;
  model: string | null;
  effort: string | null;
  since: number;
  pendingConfigure: boolean;
  // The agent rehearses once per run, at the first launch (bench/agent/stage.ts).
  staged: boolean;
}

function homePath(home: string, file: string): string {
  return join(home, file.slice(HOME_PREFIX.length));
}

// ADES.md 1 rule 12: a reset must not log the app out. Login files go to a temp folder while the data is moved aside.
function keepLoginFiles(ctx: AdapterContext, id: string, files: readonly string[]): string | null {
  if (files.length === 0) return null;
  if (ctx.dryRun) {
    for (const file of files) ctx.log(planMessage("keepLogin", [file]));
    return null;
  }
  const root = mkdtempSync(join(tmpdir(), `ademark-login-${id}-`));
  for (const file of files) {
    const source = homePath(ctx.home, file);
    if (!existsSync(source)) {
      ctx.log(`keepLogin: ${file} is not there, nothing to keep`);
      continue;
    }
    const target = join(root, file.slice(HOME_PREFIX.length));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, force: true });
  }
  return root;
}

function restoreLoginFiles(
  ctx: AdapterContext,
  files: readonly string[],
  root: string | null,
): void {
  if (files.length === 0) return;
  for (const file of files) {
    if (ctx.dryRun) {
      ctx.log(planMessage("restoreLogin", [file]));
      continue;
    }
    if (root === null) throw new Error(`reset: no login backup for ${file}`);
    const source = join(root, file.slice(HOME_PREFIX.length));
    if (!existsSync(source)) continue;
    const target = homePath(ctx.home, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, force: true });
  }
  if (root !== null) rmSync(root, { recursive: true, force: true });
}

function varsFor(ctx: AdapterContext, state: ProfileState): StepVars {
  return {
    worktree: ctx.worktree,
    home: ctx.home,
    model: state.model,
    effort: state.effort,
    agent: state.agent,
  };
}

function hintsFor(profile: AdeProfile): PidHints {
  return { bundlePaths: [profile.app.path], names: profile.app.processNames };
}

const NEW_THREAD_SETTLE_MS = 1500;
// The wait inside paste() in macos.ts after cmd+v. A7 adds it to the setup time of each stream.
const PASTE_SETTLE_MS = 500;

function waitsMs(triggers: readonly Trigger[]): number {
  return triggers.reduce((sum, trigger) => sum + (trigger.kind === "wait" ? trigger.ms : 0), 0);
}

/**
 * The fixed time newThread and send take on a profile adapter before the next A7 stream can start: the waits of the
 * profile's steps, the settle after a new thread and the paste. Null for an adapter that has no profile. 2026-11-09:
 * Orca's 6 s wait after its new-thread keys spread the five starts over about 40 s.
 */
export function profileStreamSetupMs(adapter: Adapter): number | null {
  if (!isProfileAdapter(adapter)) return null;
  const timed = adapter.timed;
  return waitsMs(timed.newThread) + NEW_THREAD_SETTLE_MS + PASTE_SETTLE_MS + waitsMs(timed.send);
}

export function profileAdapter(base: AdapterBase): Adapter {
  const appPath = base.appPath ?? appPathFor(base.appName);
  const state: ProfileState = {
    profile: undefined,
    pid: null,
    project: null,
    agent: base.agents[0] ?? "claude",
    model: null,
    effort: null,
    since: 0,
    pendingConfigure: false,
    staged: false,
  };

  function loaded(): AdeProfile | null {
    if (state.profile !== undefined) return state.profile;
    const profile = loadProfile(base.id);
    if (profile !== null) {
      const missing = base.agents.filter((agent) => !Array.isArray(profile.steps.configure[agent]));
      if (missing.length > 0) {
        throw new ProfileError(
          base.id,
          missing.map((agent) => `steps.configure.${agent}: must be a list for the adapter's agent "${agent}"`),
        );
      }
    }
    state.profile = profile;
    return profile;
  }

  // Getters used by `adapter list`/`adapter check` must never throw on a broken profile; check.ts reports the errors.
  function optionalProfile(): AdeProfile | null {
    try {
      return loaded();
    } catch {
      return null;
    }
  }

  function requireProfile(method: string): AdeProfile {
    const profile = loaded();
    if (profile === null) throw new Error(`not calibrated: ${method}`);
    return profile;
  }

  function pidOrZero(): number {
    return state.pid ?? 0;
  }

  // Quit, confirm a quit dialog with Return (Synara always asks; Emdash and Superset while agents run), and return the
  // attributed processes still alive. A profile's own quit steps need the app's pid, which A1 and A2 do not keep.
  async function quitAndWait(ctx: AdapterContext, profile: AdeProfile, useSteps: boolean): Promise<number[]> {
    const hints = hintsFor(profile);
    const pids = await pidsFor(ctx, hints);
    if (useSteps && profile.steps.quit.length > 0) {
      const pid = state.pid ?? (ctx.dryRun ? 0 : await mainPid(ctx, hints)) ?? 0;
      await runSteps(ctx, pid, profile.steps.quit, varsFor(ctx, state), "steps.quit");
    } else {
      quitApp(ctx, profile.calibration.appName);
    }
    let alive = await waitGone(ctx, pids, QUIT_TIMEOUT_MS);
    const main = alive.length === 0 || ctx.dryRun ? null : await mainPid(ctx, hints);
    if (main !== null && alive.includes(main)) {
      await press(ctx, main, "enter");
      alive = await waitGone(ctx, alive, QUIT_TIMEOUT_MS);
    }
    return alive;
  }

  const adapter: Adapter = {
    id: base.id,
    name: base.name,
    family: base.family,
    agents: base.agents,
    get calibration(): Calibration {
      return optionalProfile()?.calibration ?? baseCalibration(base);
    },
    get orchestrationTrigger(): string | null | undefined {
      const profile = optionalProfile();
      if (profile === null) return base.orchestrationTrigger;
      const trigger = profile.orchestrationTrigger;
      return trigger !== null && typeof trigger === "object" ? undefined : trigger;
    },
    get orchestrationWorkers(): "sessions" | undefined {
      return optionalProfile()?.orchestration?.workers;
    },
    // Only a profile that names settings has something to switch on.
    get prepareOrchestration(): ((ctx: AdapterContext) => Promise<void>) | undefined {
      const settings = optionalProfile()?.orchestration?.settings;
      if (settings === undefined || settings.length === 0) return undefined;
      return async (ctx: AdapterContext): Promise<void> => {
        for (const setting of settings) setJsonPath(ctx, setting.file, setting.path, setting.value);
      };
    },
    // Only a profile with calibrated steps can return to the C6 thread; launch() has already reopened the app.
    get returnToThread(): ((ctx: AdapterContext) => Promise<void>) | undefined {
      const steps = optionalProfile()?.steps.returnToThread;
      if (steps === undefined) return undefined;
      return async (ctx: AdapterContext): Promise<void> => {
        isRealRun(ctx);
        await runSteps(ctx, pidOrZero(), steps, varsFor(ctx, state), "steps.returnToThread");
        state.since = Date.now();
      };
    },
    get login(): LoginSpec | undefined {
      return optionalProfile()?.login;
    },
    get excludedTests(): Adapter["excludedTests"] {
      return (optionalProfile()?.excludeTests ?? {}) as Adapter["excludedTests"];
    },
    get timed(): Adapter["timed"] {
      return optionalProfile()?.timed ?? base.timed ?? emptyTimed();
    },
    installCheck(): Promise<InstallInfo> {
      return checkApp(base.appName, appPath);
    },
    async reset(ctx: AdapterContext): Promise<void> {
      isRealRun(ctx);
      const profile = requireProfile("reset");
      killPids(ctx, await quitAndWait(ctx, profile, false));
      const loginRoot = keepLoginFiles(ctx, base.id, profile.login.files);
      moveAside(ctx, base.id, profile.calibration.dataDirs);
      restoreLoginFiles(ctx, profile.login.files, loginRoot);
      restoreSeed(ctx, base.id, profile.reset.seeds);
      for (const entry of profile.reset.jsonKeys) setJsonKeys(ctx, entry.file, entry.keys);
      for (const label of profile.calibration.launchAgents) bootout(ctx, label);
      state.pid = null;
      state.project = null;
      state.pendingConfigure = false;
      const dir = cleanSnapshotDir();
      if (ctx.dryRun) ctx.log(planMessage("restoreSnapshot", [dir, "(apply)"]));
      else restore(dir, ctx.home, { apply: true });
      const warmMs = profile.reset.warmLaunchMs;
      if (warmMs !== undefined) {
        if (profile.calibration.bundleId !== null) openBundle(ctx, profile.calibration.bundleId);
        else runTool(ctx, ["open", "-a", profile.calibration.appName]);
        await waitForPid(ctx, hintsFor(profile), APP_LAUNCH_TIMEOUT_MS);
        await pause(ctx, warmMs);
        killPids(ctx, await quitAndWait(ctx, profile, false));
      }
    },
    async configure(ctx: AdapterContext, options: RunOptions): Promise<void> {
      isRealRun(ctx);
      const profile = requireProfile("configure");
      if (!base.agents.includes(options.agent)) {
        throw new Error(`${base.name} runs ${base.agents.join(" and ")} only`);
      }
      state.agent = options.agent;
      state.model = options.model;
      state.effort = options.effort;
      const steps = profile.steps.configure[options.agent];
      if (steps === undefined) throw new Error(`not calibrated: configure for ${options.agent}`);
      const pids = await pidsFor(ctx, hintsFor(profile));
      if (pids.length === 0 && state.pid === null) {
        state.pendingConfigure = true;
        return;
      }
      state.pendingConfigure = false;
      await runSteps(ctx, pidOrZero(), steps, varsFor(ctx, state), `steps.configure.${options.agent}`);
      if (state.project !== ctx.worktree) {
        await runSteps(ctx, pidOrZero(), profile.steps.openProject, varsFor(ctx, state), "steps.openProject");
        state.project = ctx.worktree;
      }
    },
    async launch(ctx: AdapterContext): Promise<{ pid: number }> {
      isRealRun(ctx);
      const profile = requireProfile("launch");
      for (const name of Object.keys(ctx.env).sort()) setenv(ctx, name, ctx.env[name]!);
      const open = async (): Promise<void> => {
        if (profile.calibration.bundleId !== null) openBundle(ctx, profile.calibration.bundleId);
        else runTool(ctx, ["open", "-a", profile.calibration.appName]);
        const pid = await waitForPid(ctx, hintsFor(profile), APP_LAUNCH_TIMEOUT_MS);
        if (!ctx.dryRun && pid === null) throw new Error(`${profile.calibration.appName} did not start within 30 s`);
        // A dry run has no process; 0 is the planned pid, and it records that the app is open for configure.
        state.pid = ctx.dryRun ? 0 : pid;
        await resizeWindow(ctx, pidOrZero(), profile.window);
      };
      await open();
      // 2026-11-08, gate-conductor attempt 2: the window was black, and steps.openProject[4] failed with "project" did
      // not show within 30 s. A window with no text at all gets one more launch, never more.
      if (profile.blankRelaunchMs !== undefined) {
        await pause(ctx, profile.blankRelaunchMs);
        let lines: string[] | null = null;
        try {
          lines = await windowText(ctx, pidOrZero(), `blank-check-${base.id}`);
        } catch (error) {
          // Only a window read as empty is relaunched; a failed read leaves the launch as it is.
          ctx.log(`launch: blank check not read: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (lines !== null && lines.every((line) => line.trim() === "")) {
          ctx.log(`launch: ${profile.calibration.appName} showed no text ${profile.blankRelaunchMs} ms after launch; quit and launch once more`);
          killPids(ctx, await quitAndWait(ctx, profile, false));
          await open();
        }
      }
      await runSteps(ctx, pidOrZero(), profile.steps.afterLaunch, varsFor(ctx, state), "steps.afterLaunch");
      // The agent clears the window after every launch. The full rehearsal (typing a probe, moving focus) runs only
      // with ADEMARK_AGENT_REHEARSE=on: on 2026-11-08 the apps it touched failed to seed, and a relaunch without it
      // seeded fine.
      if (state.staged || process.env.ADEMARK_AGENT_REHEARSE !== "on") {
        await clearBlockers(ctx, pidOrZero(), profile.calibration.appName, agentDir(ctx, `clear-${base.id}`));
      }
      if (state.pendingConfigure) {
        const steps = profile.steps.configure[state.agent];
        if (steps === undefined) throw new Error(`not calibrated: configure for ${state.agent}`);
        await runSteps(ctx, pidOrZero(), steps, varsFor(ctx, state), `steps.configure.${state.agent}`);
        state.pendingConfigure = false;
      }
      if (state.project !== ctx.worktree) {
        await runSteps(ctx, pidOrZero(), profile.steps.openProject, varsFor(ctx, state), "steps.openProject");
        state.project = ctx.worktree;
      }
      if (!state.staged) {
        state.staged = true;
        if (process.env.ADEMARK_AGENT_REHEARSE === "on") {
          if (ctx.dryRun) ctx.log(planMessage("rehearse", [`pid=${pidOrZero()}`, `app=${profile.calibration.appName}`]));
          else await stageProfile(ctx, pidOrZero(), profile, agentDir(ctx, `rehearse-${base.id}`));
        }
      }
      return { pid: pidOrZero() };
    },
    async newThread(ctx: AdapterContext): Promise<void> {
      isRealRun(ctx);
      const profile = requireProfile("newThread");
      await runSteps(ctx, pidOrZero(), profile.timed.newThread, varsFor(ctx, state), "timed.newThread");
      // Setup only (seeds, A4, A7, A10): the stopwatch runs the triggers itself. A fresh composer dropped the first typed
      // character on Synara and Diri (2026-11-08), so the prompt reached the model one byte short and matched nothing.
      await pause(ctx, NEW_THREAD_SETTLE_MS);
      state.since = Date.now();
    },
    async send(ctx: AdapterContext, text: string): Promise<void> {
      isRealRun(ctx);
      const profile = requireProfile("send");
      state.since = Date.now();
      await paste(ctx, pidOrZero(), text);
      await runSteps(ctx, pidOrZero(), profile.timed.send, varsFor(ctx, state), "timed.send");
    },
    async waitDone(ctx: AdapterContext, timeoutMs: number): Promise<{ done: boolean; reason: string }> {
      isRealRun(ctx);
      const profile = requireProfile("waitDone");
      // An own agent has no session log, so its wait ends by the idle fallback alone, and that reads file changes in
      // one folder: the project, not the whole home, where something always changes.
      const anyCwd = profile.waitDone.cwd === "any" && state.agent !== "own";
      const cwd = anyCwd ? ctx.home : ctx.worktree;
      if (ctx.dryRun) {
        ctx.log(planMessage("waitForEndOfTurn", [`agent=${state.agent}`, `cwd=${cwd}`, `timeoutMs=${timeoutMs}`]));
        return { done: true, reason: "dry run" };
      }
      return waitForEndOfTurn({
        ctx,
        agent: state.agent,
        cwd,
        cwdPrefix: anyCwd ? ctx.home : undefined,
        since: state.since || Date.now(),
        timeoutMs,
        pollMs: 2000,
        idleFallback: profile.waitDone.idleFallback,
      });
    },
    async quit(ctx: AdapterContext): Promise<void> {
      isRealRun(ctx);
      const profile = requireProfile("quit");
      const alive = await quitAndWait(ctx, profile, true);
      if (!ctx.dryRun) {
        const list = alive.length === 0 ? "none" : alive.join(",");
        ctx.log(`quit: attributed processes still alive after ${QUIT_TIMEOUT_MS / 1000} s: ${list}`);
      }
      state.pid = null;
    },
    async beforeQuit(ctx: AdapterContext, before: "relaunch" | "cold"): Promise<void> {
      isRealRun(ctx);
      const profile = requireProfile("beforeQuit");
      const key = before === "relaunch" ? "beforeRelaunchQuit" : "beforeColdQuit";
      const steps = profile.steps[key] ?? [];
      if (steps.length === 0) return;
      // A1 and A2 launch through the timed triggers, so the adapter does not know the pid of the window they opened.
      const pid = state.pid ?? (ctx.dryRun ? 0 : await mainPid(ctx, hintsFor(profile))) ?? 0;
      await runSteps(ctx, pid, steps, varsFor(ctx, state), `steps.${key}`);
    },
    processes(): ProcessHints {
      const profile = optionalProfile();
      if (profile !== null) {
        return processHints({
          bundlePaths: [profile.app.path],
          vendorDirs: profile.processes.vendorDirs,
          launchAgentLabels: profile.processes.launchAgentLabels,
          teamId: profile.processes.teamId,
          agentExecutables: profile.processes.agentExecutables,
        });
      }
      return processHints({
        bundlePaths: [appPath],
        vendorDirs: base.vendorDirs,
        launchAgentLabels: base.launchAgents,
        teamId: base.teamId ?? null,
        agentExecutables: base.agentExecutables,
      });
    },
  };

  PROFILE_BASES.set(adapter, base);
  return adapter;
}

// Real steps of ADEMark Control. Everything here calls what the harness already has.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../adapters/profile.ts";
import { getAdapter } from "../adapters/registry.ts";
import type { Agent, ResultRow } from "../core/contracts.ts";
import { repoRoot, resultsRoot } from "../core/paths.ts";
import { defaultNightDeps, pruneAsideInChild } from "../night/deps.ts";
import { prepareAll, type PrepareDeps } from "../night/prepare.ts";
import { realPrepareDeps } from "../night/prepare-real.ts";
import { failuresOf, repairNight, repairTemplate } from "../night/repair.ts";
import { realRepairDeps, stopChildren, supervised } from "../night/repair-real.ts";
import type { CheckResult } from "../ops/doctor.ts";
import type { BlockResult } from "../run/loop.ts";
import { MODEL_PINS } from "../run/models.ts";
import { loadRunners, TRACK_ORDER, type TestRunner, type TrackLetter } from "../run/registry.ts";
import { formatSmokeRepeats, REHEARSAL_REPEATS } from "../run/smoke.ts";
import { finishedAttempt } from "./adopt.ts";
import { controlFiles } from "./files.ts";
import { adeRunId, attemptDir, isRehearsalId, lateDir, lateRunId, rehearsalDir, runDir, topUpDir, topUpRunId } from "./folders.ts";
import { isProven, proofFile, proofKey, saveProof } from "./proofs.ts";
import { buildRehearsal, previousRehearsal, writeRehearsal, type CodeId } from "./rehearsal.ts";
import { buildRunReport, type LatePart } from "./report.ts";
import { sessionNow } from "./session.ts";
import { QA_TIMEOUT_MS, rowsIn } from "./qa.ts";
import { buildIdOf, minimumsOf, missing, planTopUp, topUpRefusal, tracksOf, type BuildId, type Minimum, type Missing, type MissingApp } from "./topup.ts";
import { freshCount, testLines } from "./verdicts.ts";
import type { EngineDeps, StepResult } from "./engine.ts";
import type { LatePlan, LateStep, StepName, Task } from "./store.ts";

export const MEASURED_ADES = [
  "bare-cli", "t3code", "bb", "paseo", "synara", "traycer", "cloudroom", "orca", "emdash", "zeron", "diri", "monocode",
  "super-engineering", "conductor", "claude-desktop",
  // 2026-11-11: their profiles come from the app bundle, never from the real screen, so a first measure may stop at a
  // setup step; its screenshot is what calibrates them. Not codex-app: the bench account has no Codex sign-in.
  "capy", "superset",
] as const;
export const AGENTS: readonly Agent[] = ["claude", "own"];
// Which tracks a proof runs (ADEMARK_PROVE=on only). ~/.config/ademark/tracks holds "A" or "A,B" (one line); without it
// both run. Since ADEMARK-49 a measure and a top-up run Track A always, whatever this file says: on 6 Nov a stopped B
// block made Control measure the whole app again. Track B runs in its own tokens step, after every measure.
export function tracksFrom(text: string | null): TrackLetter[] {
  const wanted = (text ?? "A,B").split(",").map((part) => part.trim().toUpperCase()).filter((part) => part === "A" || part === "B");
  return wanted.length === 0 ? ["A", "B"] : ([...new Set(wanted)] as TrackLetter[]);
}
const TRACKS_FILE = join(homedir(), ".config", "ademark", "tracks");
export const TRACKS: readonly TrackLetter[] = tracksFrom(existsSync(TRACKS_FILE) ? readFileSync(TRACKS_FILE, "utf8") : null);
// A clean measurement takes 30 minutes, so a hung app costs one hour of the night at most.
// 2026-11-07, council: a stopped block plus the run's own retry took Emdash 94 min on 6 Nov, and the agent's rehearsal
// adds a few minutes; at 60 min a recoverable app was killed and measured again from zero.
// About 30 min for a healthy app; the run's own retry of a stopped block fits in 75. Twice 150 min could hold one app
// for 5 hours (council, 2026-11-08).
export const MEASURE_TIMEOUT_MS = 75 * 60_000;
// A smoke lap of one app is about 8 minutes; A11 alone may build its 2,000-message thread for up to 30.
export const REHEARSE_TIMEOUT_MS = 45 * 60_000;
// ADEMARK-49. A healthy Track B block takes 4 to 5 minutes, launch included (control-2026-11-06T09-52-52Z-bare-cli-1 and
// -emdash-1, from the A marker to the B marker). The limit holds the worst case, where every turn runs to its cap: four
// B1 turns (three and one extra run) and one B3 turn, each with the 25 s wait for the prompt to leave and the 30 s wait
// for side calls, is about 18 minutes, plus the reset and the launch, and the run tries a stopped block once more.
// Until 2026-11-11 the limit was 20 minutes: it would have cut exactly the apps whose turn end is not found (on 6 and 7
// Nov `the turn failed` 292 times), with exit 124 and no finished attempt in place of rows with their reason.
export const TOKENS_TIMEOUT_MS = 45 * 60_000;
// ADEMARK-49, from the Track C sizing of ADEMARK-50 (2026-11-11): a C1 block takes up to 121 minutes. That is the
// 45-minute cap (tasks/C1-orchestrated-build/task.toml, time_cap_s 2700), a second run when shipped is under 5/5 or the
// app crashed (TESTS.md section 4, C1), the settle and the grading. Since the same day each run also waits until every
// agent was quiet for 5 minutes (QUIET_MS in bench/tracks/c/shared.ts), and that wait may end after the cap: up to 131.
// 140 gives the block a few minutes more. A cut at this limit loses the whole attempt, so it must not be tight.
export const ORCHESTRATION_TIMEOUT_MS = 140 * 60_000;
export const SETTLE_MINUTES = 10;
const DOCTOR_TIMEOUT_MS = 120_000;
/**
 * How long a step may take before the watchdog ends its child, plus 5 minutes there. A measure waits for calm first. A
 * proof has no single bound (it may repair), so it has none here.
 */
export function stepLimitMs(step: StepName): number | null {
  if (step === "measure" || step === "top-up") return (SETTLE_MINUTES + 1) * 60_000 + MEASURE_TIMEOUT_MS;
  if (step === "tokens") return (SETTLE_MINUTES + 1) * 60_000 + TOKENS_TIMEOUT_MS;
  if (step === "orchestration") return (SETTLE_MINUTES + 1) * 60_000 + ORCHESTRATION_TIMEOUT_MS;
  if (step === "rehearse") return (SETTLE_MINUTES + 1) * 60_000 + REHEARSE_TIMEOUT_MS;
  if (step === "check") return QA_TIMEOUT_MS;
  return null;
}
const REPAIR_BUDGET_MS = 240 * 60_000;
// Since 2026-11-07 the agent rehearses every app before it is measured and fixes positions and shortcuts in seconds
// (bench/agent). Claude's code repairs spent hours and the Claude plan the apps need, so they run only on request.
export function claudeRepairs(): boolean {
  return process.env.ADEMARK_CLAUDE_REPAIR === "on";
}
// Doctor reads these for a whole machine, and a block checks what really matters for it.
const NOT_BLOCKING = new Set(["other GUI apps", "gates", "adapter installs", "machine state on", "display at 60 Hz"]);

// One reader of rows for all of Control: it applies the tests set aside after review (ADEMARK-56).
const rowsOf = (dir: string): ResultRow[] => rowsIn(dir);

export function permissionProblems(output: string): string[] {
  let data: Record<string, { state?: string }> = {};
  try {
    data = (JSON.parse(output) as { data?: typeof data }).data ?? {};
  } catch {
    return ["agent-desktop does not answer."];
  }
  return ["accessibility", "screen_recording"].filter((name) => data[name]?.state !== "granted")
    .map((name) => `Ghostty needs ${name.replace("_", " ")}: System Settings > Privacy & Security.`);
}

// What only a person can fix, so it is said at Start and not at 3 in the morning.
export function doctorProblems(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return ["Doctor did not answer: run `bun bench/cli.ts doctor` in Ghostty."];
  }
  const rows = (Array.isArray(parsed) ? parsed : ((parsed as { results?: unknown[] }).results ?? [])) as CheckResult[];
  return rows.filter((entry) => entry.blocking && entry.status === "fail" && !NOT_BLOCKING.has(entry.name))
    .map((entry) => `${entry.name}: ${entry.fix ?? entry.detail}`);
}

async function textOf(argv: string[], timeoutMs: number): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn(argv, { cwd: repoRoot, stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: timeoutMs });
  const text = await new Response(proc.stdout).text();
  return { code: await proc.exited, text };
}

/** Claude answered only if it exited well and its last result says so: a plan limit also prints JSON. */
export function claudeAnswered(code: number, stream: string): boolean {
  if (code !== 0) return false;
  const last = stream.split("\n").filter((line) => line.includes('"type":"result"')).at(-1);
  if (last === undefined) return false;
  try {
    const result = JSON.parse(last) as { is_error?: boolean; result?: string };
    return result.is_error === false && (result.result ?? "").trim().toLowerCase().startsWith("ok");
  } catch {
    return false;
  }
}

/** One call of the pinned model, as the apps make it: false for a plan at its limit or a lost sign-in. */
async function claudeAnswers(): Promise<boolean> {
  const pin = MODEL_PINS.claude;
  const claude = await textOf(
    [join(homedir(), ".local/bin/claude"), "-p", "Reply with only the word ok", "--model", pin.model!, "--effort", pin.effort!,
      "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", "--max-turns", "1"],
    120_000,
  );
  return claudeAnswered(claude.code, claude.text);
}

async function engineProblems(): Promise<string[]> {
  const problems = permissionProblems((await textOf(["agent-desktop", "permissions"], 30_000)).text);
  if (!(await claudeAnswers())) problems.push("Claude does not answer. If the plan hit its limit, wait for the reset. If not, open Ghostty, run `claude`, then /login.");
  if (!existsSync(join(homedir(), ".traycer/cli/credentials"))) problems.push("Traycer has no sign-in: open it, sign in, quit it.");
  return problems;
}

export { adeRunId };

/** The trigger of an app's adapter: a string to send, null for no orchestration, undefined when not calibrated. */
export function adapterTrigger(ade: string): string | null | undefined {
  try {
    return getAdapter(ade).orchestrationTrigger;
  } catch {
    return undefined;
  }
}

/**
 * ADEMARK-49: the apps that get an orchestration step, in order. Bare CLI first, also with no trigger: its solo run of the
 * C1 goal (C1-solo) is the baseline of `orchestration-tax`. Then each app whose adapter has a trigger line. Read each time, because the triggers
 * are filled while nights run. An app with a null trigger has no orchestration (C1 not supported), and an app with no
 * trigger yet is not calibrated: neither gets a step, and the report says why from the adapter.
 */
export function orchestrationApps(ades: readonly string[], triggerOf: (ade: string) => string | null | undefined = adapterTrigger): string[] {
  return [...ades.filter((ade) => ade === "bare-cli"), ...ades.filter((ade) => ade !== "bare-cli" && typeof triggerOf(ade) === "string")];
}

/** Every app gets a tokens step; the orchestration apps come from their adapters. */
export function latePlanOf(ades: readonly string[], triggerOf: (ade: string) => string | null | undefined = adapterTrigger): LatePlan {
  return { tokens: [...ades], orchestration: orchestrationApps(ades, triggerOf) };
}

/**
 * Why an app gets no orchestration step, from its adapter. A profile's `{ notCalibrated }` reaches the adapter as
 * undefined (bench/adapters/profile.ts), so its reason is read from the profile.
 */
export function noOrchestrationReason(trigger: string | null | undefined, notCalibrated: string | null = null): string {
  if (trigger === null) return "C1 not supported: the adapter has no orchestration (orchestrationTrigger is null)";
  return notCalibrated === null ? "C1 not calibrated: the adapter has no orchestrationTrigger yet" : `C1 not calibrated: ${notCalibrated}`;
}

/** The `notCalibrated` reason of an app's profile, or null. */
export function profileNotCalibrated(ade: string): string | null {
  try {
    const trigger = loadProfile(ade)?.orchestrationTrigger as unknown;
    return trigger !== null && typeof trigger === "object" && typeof (trigger as { notCalibrated?: unknown }).notCalibrated === "string"
      ? (trigger as { notCalibrated: string }).notCalibrated : null;
  } catch {
    return null;
  }
}

/** The newest late step of this kind that finished (done), or null. Its folder is the only one the report reads. */
export function lateFolder(root: string, runId: string, tasks: readonly Task[], ade: string, step: LateStep, dry: boolean): { attempt: number; dir: string } | null {
  const done = tasks.filter((task) => task.ade === ade && task.step === step && task.status === "done" && task.attempts > 0).sort((a, b) => a.attempts - b.attempts).at(-1);
  return done === undefined ? null : { attempt: done.attempts, dir: lateDir(root, runId, ade, step, done.attempts, dry) };
}

// The same set as LIVE_MODEL_TESTS in bench/run/loop.ts (a test checks they agree): an app that ignores the replay
// server runs only these Track A tests.
export const LIVE_MODEL_TESTS: readonly string[] = ["A1", "A2", "A3", "A5", "A6", "A9"];

/** The tests an app runs in these tracks, so a test with no row shows as missing in a report. */
export function expectedTests(ade: string, tracks: readonly TrackLetter[], runners: ReadonlyMap<string, TestRunner>): string[] {
  let live = false;
  try {
    live = getAdapter(ade).liveModel === true;
  } catch {
    return [];
  }
  return tracks.flatMap((track) => TRACK_ORDER[track].filter((test) => runners.get(test)?.track === track && (track !== "A" || !live || LIVE_MODEL_TESTS.includes(test))));
}

/**
 * The tracks a measure folder ran: the letters of its block markers (`<row ade>/<track>-<agent>.done`) and of its rows.
 * Read from the folder, not from ~/.config/ademark/tracks: another account cannot read that file, and it may change
 * after the night.
 */
export function tracksOfAttempt(dir: string): TrackLetter[] {
  const found = new Set<TrackLetter>();
  const add = (letter: string | undefined): void => {
    if (letter === "A" || letter === "B" || letter === "C") found.add(letter);
  };
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const sub = join(dir, name);
      if (!statSync(sub).isDirectory()) continue;
      for (const file of readdirSync(sub)) add(/^([ABC])-[a-z]+\.done$/.exec(file)?.[1]);
    }
  }
  for (const row of rowsOf(dir)) add(row.test_id[0]);
  return (["A", "B", "C"] as const).filter((track) => found.has(track));
}

export interface RunFolders {
  /** The measure folder that holds the app's rows (adopted or last), or null when the measure is not done. */
  first: { attempt: number; dir: string } | null;
  /** Each top-up that ran to its end (done or failed), in the order they ran. */
  topUps: { attempt: number; dir: string }[];
}

/**
 * The folders whose rows belong to one app of a night. A top-up that waits in the queue after a crash is left out: its
 * folder is a cut attempt, and the next attempt writes a new one.
 */
export function runFolders(root: string, runId: string, tasks: readonly Task[], ade: string, dry: boolean): RunFolders {
  const measure = tasks.find((task) => task.ade === ade && task.step === "measure");
  const attempt = measure === undefined ? 0 : (measure.adopted_attempt ?? measure.attempts);
  const first = measure?.status === "done" && attempt > 0 ? { attempt, dir: attemptDir(root, runId, ade, attempt, dry) } : null;
  const topUps = tasks
    .filter((task) => task.ade === ade && task.step === "top-up" && task.attempts > 0 && (task.status === "done" || task.status === "failed"))
    .sort((a, b) => a.attempts - b.attempts)
    .map((task) => ({ attempt: task.attempts, dir: topUpDir(root, runId, ade, task.attempts, dry) }));
  return { first, topUps };
}

/**
 * ADEMARK-51: what a pass would measure in this night, in queue order. The tests an app runs come from the tracks of its
 * measure folder; the minimums from the runners of those tracks.
 */
export function missingNow(root: string, runId: string, tasks: readonly Task[], dry: boolean, runners: ReadonlyMap<string, TestRunner>, listed: readonly string[] = [],
  latePlan?: (ades: readonly string[]) => LatePlan): Missing {
  const queued = [...new Set(tasks.filter((task) => task.step === "measure").map((task) => task.ade))];
  // `listed` is the measured list of this Control. An app that joined it after the night began has no measure in the
  // queue: it is missing in full, after the apps of the queue (Capy and Superset, 2026-11-11).
  const ades = [...queued, ...listed.filter((ade) => !queued.includes(ade))];
  const apps: MissingApp[] = [];
  let minimums = new Map<string, Minimum>();
  // ADEMARK-49: a late step is missing until one attempt of it is done. Without `latePlan` none is planned.
  const plan = latePlan?.(ades);
  // A step that ended with no valid row measured nothing (a prompt that never reached the model, a plan at its limit in
  // the middle of the run): the next pass runs it again (2026-11-11). A dry run captures no model request, so every dry B
  // row is invalid: there a done step counts.
  const finished = (ade: string, step: LateStep): boolean => {
    const folder = lateFolder(root, runId, tasks, ade, step, dry);
    return folder !== null && (dry || rowsOf(folder.dir).some((entry) => entry.valid));
  };
  const lateOf = (ade: string): MissingApp["late"] => plan === undefined ? undefined
    : { tokens: !plan.tokens.includes(ade) || finished(ade, "tokens"), orchestration: plan.orchestration.includes(ade) ? finished(ade, "orchestration") : null };
  for (const ade of ades) {
    const measure = tasks.find((task) => task.ade === ade && task.step === "measure");
    const folders = runFolders(root, runId, tasks, ade, dry);
    if (folders.first === null) {
      apps.push({ ade, measured: measure?.status === "done", attempts: [], expected: [], late: lateOf(ade) });
      continue;
    }
    // A measure is Track A since ADEMARK-49; an older folder may also hold B rows, and those are the tokens step's now.
    const tracks: TrackLetter[] = tracksOfAttempt(folders.first.dir).filter((track) => track === "A");
    const mine = new Map([...runners].filter(([, runner]) => tracks.includes(runner.track)));
    minimums = new Map([...minimums, ...minimumsOf(mine)]);
    apps.push({
      ade,
      measured: true,
      attempts: [
        { label: `attempt ${folders.first.attempt}`, rows: rowsOf(folders.first.dir) },
        ...folders.topUps.map((topUp) => ({ label: `top-up ${topUp.attempt}`, rows: rowsOf(topUp.dir) })),
      ],
      expected: expectedTests(ade, tracks, mine),
      late: lateOf(ade),
    });
  }
  const out = missing(runId, apps, minimums);
  // The order of the plan, not of the queue: Bare CLI's solo run is the baseline of every other app's orchestration-tax.
  if (plan !== undefined) out.orchestration.sort((a, b) => plan.orchestration.indexOf(a) - plan.orchestration.indexOf(b));
  return out;
}

function minutesOf(task: Task, now: number): number | null {
  if (task.started_at === null) return null;
  const end = task.ended_at === null ? now : Date.parse(task.ended_at);
  return Math.round((end - Date.parse(task.started_at)) / 60_000);
}

/** Machine and app build now, from a child (hashing a bundle must not block the panel): `ademark build-id`. */
async function buildIdNow(ade: string): Promise<BuildId | null> {
  const out = await textOf(["bun", "bench/cli.ts", "build-id", "--ade", ade], 120_000);
  if (out.code !== 0) return null;
  try {
    return JSON.parse(out.text) as BuildId;
  } catch {
    return null;
  }
}

/**
 * Where a measuring child says what it is doing (bench/run/loop.ts reportProgress); the panel reads it. A dry Control
 * has its own file: in the `ademark` account it would overwrite the "Now:" line of a real night (review R3, 2026-11-10).
 */
export function progressFile(dry: boolean): string {
  return controlFiles(dry).progress;
}

/** The harness commit and the hash of the measuring inputs now: what a rehearsal records and Start compares. */
export function codeIdNow(): CodeId {
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot, timeout: 10_000 });
  let inputs: string | null = null;
  try {
    inputs = realRepairDeps(() => {}).measuringInputs() || null;
  } catch {
    inputs = null;
  }
  return { commit: commit.exitCode === 0 ? commit.stdout.toString().trim() : null, inputs };
}

export function realEngineDeps(log: (line: string) => void, dry: boolean): EngineDeps {
  // Every child run inherits this and reports its stage and test for the panel.
  process.env.ADEMARK_PROGRESS = progressFile(dry);
  const night = defaultNightDeps();
  const repair = realRepairDeps(log);
  let cancelled = false;
  const isCancelled = (): boolean => cancelled;
  // One allowance for the whole run: on 2026-11-05 two apps took three hours of repairs.
  let repairSpentMs = 0;
  const repairMsLeft = (): number => REPAIR_BUDGET_MS - repairSpentMs;
  const proofs = realPrepareDeps(log);
  // One Traycer copy is 2.6 GB, and every reset moves one aside.
  const proofDeps: PrepareDeps = {
    ...proofs,
    check: async (check) => {
      await pruneAsideInChild(log);
      return await proofs.check(check);
    },
  };
  const folder = (runId: string, ade: string, attempt: number): { id: string; dir: string } =>
    ({ id: adeRunId(runId, ade, attempt), dir: attemptDir(resultsRoot(), runId, ade, attempt, dry) });
  // What `measure` and `top-up` ask the child for; adoption needs the same blocks. Track A always (ADEMARK-49).
  const measuredTracks = (): readonly TrackLetter[] => ["A"];
  // Loaded once, in the background of the first top-up or report: the runners hold each test's minimum.
  let runners: Promise<Map<string, TestRunner>> | null = null;
  const runnersOf = (): Promise<Map<string, TestRunner>> => (runners ??= loadRunners() as Promise<Map<string, TestRunner>>);
  let loadedRunners: Map<string, TestRunner> = new Map();
  void runnersOf().then((map) => {
    loadedRunners = map;
  }, (error: unknown) => log(`could not load the test runners: ${String(error)}`));
  // A folder that exists already belongs to a cut attempt: it goes aside and never mixes with the new one.
  const moveAside = (dir: string, ade: string): void => {
    if (!existsSync(dir)) return;
    const aside = `${dir}-cut-${new Date().toISOString().replaceAll(":", "-")}`;
    renameSync(dir, aside);
    log(`${ade}: moved the folder of a cut attempt to ${aside}`);
  };
  let lapCode: { run: string; code: CodeId } | null = null;
  const writeReport = (runId: string, tasks: readonly Task[], ended: boolean): void => {
    const root = resultsRoot();
    const now = Date.now();
    const ades = [...new Set(tasks.map((task) => task.ade))];
    if (isRehearsalId(runId)) {
      const apps = ades.map((ade) => {
        const task = tasks.find((entry) => entry.ade === ade && entry.step === "rehearse")!;
        const rows = task.attempts === 0 ? [] : rowsOf(rehearsalDir(root, runId, ade, task.attempts, dry));
        return { ade, label: adeLabel(ade), status: task.status, note: task.note, minutes: minutesOf(task, now), rows, expected: expectedTests(ade, ["A"], loadedRunners) };
      });
      // Read once per lap: the measuring files stay the same while a run is open.
      lapCode ??= { run: runId, code: codeIdNow() };
      if (lapCode.run !== runId) lapCode = { run: runId, code: codeIdNow() };
      const built = buildRehearsal({ runId, dry, ended, apps, previous: previousRehearsal(root, runId, dry), code: lapCode.code });
      writeRehearsal(runDir(root, runId, dry), built);
      return;
    }
    const apps = ades.map((ade) => {
      const note = tasks.filter((task) => task.ade === ade && task.note.length > 0).map((task) => `${task.step}: ${task.note}`).join("; ");
      const folders = runFolders(root, runId, tasks, ade, dry);
      const lateNote = (step: LateStep): string => tasks.filter((task) => task.ade === ade && task.step === step).at(-1)?.note ?? "";
      const tokensFolder = lateFolder(root, runId, tasks, ade, "tokens", dry);
      const tokens: LatePart = { folder: tokensFolder, note: tokensFolder === null ? `no finished tokens attempt. ${lateNote("tokens")}`.trim() : "" };
      const orchestrationFolder = lateFolder(root, runId, tasks, ade, "orchestration", dry);
      const queued = tasks.some((task) => task.ade === ade && task.step === "orchestration");
      const orchestration: LatePart = orchestrationFolder !== null ? { folder: orchestrationFolder, note: "" }
        : queued || orchestrationApps([ade]).length > 0 ? { folder: null, note: `no finished orchestration attempt. ${lateNote("orchestration")}`.trim() }
        : { folder: null, note: noOrchestrationReason(adapterTrigger(ade), profileNotCalibrated(ade)) };
      return {
        ade,
        label: adeLabel(ade),
        first: folders.first,
        topUps: folders.topUps,
        expected: expectedTests(ade, measuredTracks(), loadedRunners),
        note,
        tokens,
        tokensExpected: expectedTests(ade, ["B"], loadedRunners),
        orchestration,
      };
    });
    const text = buildRunReport({ runId, ended, apps, minimums: minimumsOf(loadedRunners), root });
    const dir = runDir(root, runId, dry);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), text);
  };

  // ADEMARK-49: one late step runs one block of its own in its own folder. Its rows count only for its track, so a failure
  // here never touches the app's Track A result.
  const lateRun = async (ade: string, runId: string, seed: string, step: LateStep, attempt: number): Promise<StepResult> => {
    if (cancelled) return { ok: false, note: "stopped" };
    const dir = lateDir(resultsRoot(), runId, ade, step, attempt, dry);
    moveAside(dir, ade);
    const what = step === "tokens" ? ["--tracks", "B"] : ["--tracks", "C", "--tests", "C1"];
    const args = ["bun", "bench/cli.ts", "run", "--ade", ade, ...what, "--agent", AGENTS.join(","), "--run-id", lateRunId(runId, ade, step, attempt), "--seed", seed];
    const code = await supervised(dry ? [...args, "--dry-run"] : args, step === "tokens" ? TOKENS_TIMEOUT_MS : ORCHESTRATION_TIMEOUT_MS, repoRoot);
    if (cancelled) return { ok: false, note: "stopped" };
    if (!dry) await pruneAsideInChild(log);
    const rows = rowsOf(dir);
    if (code !== 0 || rows.length === 0) return { ok: false, note: `exit ${code}, ${rows.length} rows` };
    return { ok: true, note: `${rows.filter((row) => row.valid).length} of ${rows.length} rows valid` };
  };

  return {
    now: () => new Date().toISOString(),
    log,
    screen: async () => (await sessionNow()).screen,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    finishedAttempt: (ade, runId, attempts, only) =>
      finishedAttempt({ ade, attempts, only, tracks: measuredTracks(), agents: AGENTS, dirOf: (attempt) => folder(runId, ade, attempt).dir }),
    resume: () => {
      cancelled = false;
    },
    settle: async () => {
      if (!dry) await supervised(["bun", "bench/cli.ts", "settle", "--minutes", String(SETTLE_MINUTES)], (SETTLE_MINUTES + 1) * 60_000, repoRoot);
    },
    preflight: async (runId) => {
      if (dry) return [];
      // A crash leaves children, launchd variables and measuring settings behind, and doctor would refuse them before
      // Continue could work. Turning the machine off when it is already off changes nothing.
      try {
        night.machine("off", true, log);
      } catch (error) {
        log(`machine off before start: ${String(error)}`);
      }
      repair.clearHarnessEnv();
      for (const ade of MEASURED_ADES) await repair.cleanUp(ade);
      process.env.ADEMARK_BASELINE = join(resultsRoot(), `${runId}.baseline`);
      // Bounded: a hung setup kept the panel on "Checking" with no way out (council, 2026-11-08).
      const setup = await textOf(["bun", "bench/cli.ts", "account", "setup", "--apply"], 120_000);
      if (setup.code !== 0) log(`account setup exited with ${setup.code}; going on`);
      // A child: doctor's checks block their thread, and the panel lives on this one.
      const doctor = await textOf(["bun", "bench/cli.ts", "doctor", "--agent", AGENTS.join(","), "--json"], DOCTOR_TIMEOUT_MS);
      const problems = doctorProblems(doctor.text);
      // Once a run starts, the files that measure stay the same until it ends.
      const baseline = join(resultsRoot(), `${runId}.inputs`);
      const inputs = repair.measuringInputs();
      if (!existsSync(baseline)) writeFileSync(baseline, inputs);
      else if (readFileSync(baseline, "utf8") !== inputs) problems.push("bench/native/bin or snapshots changed since this run started: restore them.");
      return [...problems, ...(await engineProblems())];
    },
    machineOn: () => {
      if (!dry) night.machine("on", true, log);
    },
    machineOff: () => {
      if (!dry) night.machine("off", true, log);
    },
    prove: async (ade, runId, attempt, allowRepair): Promise<StepResult> => {
      if (dry) return { ok: true, note: "dry run" };
      // 2026-11-08: a proof failed whenever one test failed, so 14 apps were never measured. Every app is measured now;
      // a test that cannot pass is published as invalid with its reason. ADEMARK_PROVE=on brings the proof back.
      if (process.env.ADEMARK_PROVE !== "on") return { ok: true, note: "measured without a proof" };
      if (isProven(proofFile(), ade, proofKey(ade), Date.now())) return { ok: true, note: "proven before" };
      await pruneAsideInChild(log);
      const started = Date.now();
      const [result] = await prepareAll({
        ades: [ade],
        tracks: TRACKS,
        agents: AGENTS,
        rounds: allowRepair && claudeRepairs() && repairMsLeft() > 0 ? undefined : 1,
        runId: `${runId}-prove-${attempt}`,
        runDir: join(resultsRoot(), runId, "prove", ade, String(attempt)),
        template: repairTemplate(),
        deps: proofDeps,
        cancelled: isCancelled,
      });
      if (allowRepair && claudeRepairs()) repairSpentMs += Date.now() - started;
      const note = result?.reason ?? "no result";
      // After the proof: a repair changes what the key reads.
      if (result?.ready === true) saveProof(proofFile(), ade, proofKey(ade), Date.now());
      return { ok: result?.ready === true, note, fatal: note.startsWith("tampered") };
    },
    measure: async (ade, runId, seed, attempt, allowRepair): Promise<StepResult> => {
      if (cancelled) return { ok: false, note: "stopped" };
      const { id, dir } = folder(runId, ade, attempt);
      // A step cut because the account left the screen counts no attempt, so its number comes again.
      moveAside(dir, ade);
      const args = ["bun", "bench/cli.ts", "run", "--ade", ade, "--tracks", measuredTracks().join(","), "--agent", AGENTS.join(","), "--run-id", id, "--seed", seed];
      const code = await supervised(dry ? [...args, "--dry-run"] : args, MEASURE_TIMEOUT_MS, repoRoot);
      if (cancelled) return { ok: false, note: "stopped" };
      const stopped = code !== 0;
      // Dry instruments write no replay log, so a dry block only has to finish.
      if (dry) return { ok: !stopped, note: stopped ? `exit ${code}` : "" };
      let rows = rowsOf(dir);
      let failures = failuresOf(ade, [], rows);
      await pruneAsideInChild(log);
      // A block that ran to the end is a measurement, even with invalid tests: those rows carry their reasons. Only a
      // block that stopped or wrote nothing is tried again at the end of the night.
      if (!stopped && rows.length > 0) {
        return { ok: true, note: failures.length === 0 ? "" : `${failures.length} invalid: ${failures[0]}` };
      }
      if (!allowRepair || !claudeRepairs() || repairMsLeft() <= 0) return { ok: false, note: failures[0] ?? `exit ${code}` };
      // Claude repairs how this ADE is driven, then the ADE is measured again in full.
      const repairStarted = Date.now();
      const blocks: BlockResult[] = stopped || rows.length === 0 ? [{ ade, track: "A", finished: false, rows: 0, error: `exit ${code}` }] : [];
      const attempts = await repairNight({
        runDir: dir,
        runId: id,
        seed,
        tracks: measuredTracks(),
        agents: AGENTS,
        order: [ade],
        blocks,
        deadline: null,
        budgetMs: repairMsLeft(),
        template: repairTemplate(),
        deps: repair,
        cancelled: isCancelled,
      });
      repairSpentMs += Date.now() - repairStarted;
      await pruneAsideInChild(log);
      rows = rowsOf(dir);
      failures = failuresOf(ade, [], rows);
      const last = attempts.at(-1);
      if (last?.result === "tampered") return { ok: false, note: `tampered: ${last.note}`, fatal: true };
      const repaired = attempts.some((entry) => entry.result === "repaired");
      return { ok: repaired && failures.length === 0 && rows.length > 0, note: failures[0] ?? last?.note ?? "" };
    },
    rehearse: async (ade, runId, seed, attempt): Promise<StepResult> => {
      if (cancelled) return { ok: false, note: "stopped" };
      const dir = rehearsalDir(resultsRoot(), runId, ade, attempt, dry);
      moveAside(dir, ade);
      // Track A only: `run --smoke` refuses other tracks, and Track B spends the Claude plan the apps run on.
      const args = ["bun", "bench/cli.ts", "run", "--ade", ade, "--tracks", "A", "--agent", AGENTS.join(","), "--run-id", adeRunId(runId, ade, attempt),
        "--seed", seed, "--smoke", "--smoke-reps", formatSmokeRepeats(REHEARSAL_REPEATS)];
      const code = await supervised(dry ? [...args, "--dry-run"] : args, REHEARSE_TIMEOUT_MS, repoRoot);
      if (cancelled) return { ok: false, note: "stopped" };
      const rows = rowsOf(dir);
      if (!dry) await pruneAsideInChild(log);
      const fresh = freshCount(testLines(ade, rows, expectedTests(ade, ["A"], await runnersOf())));
      if (code !== 0 || rows.length === 0) return { ok: false, note: `exit ${code}, ${rows.length} rows, ${fresh} NEW` };
      return { ok: true, note: fresh === 0 ? "" : `${fresh} NEW` };
    },
    topUpTests: async (ade, runId, attempt) => {
      const all = await runnersOf();
      const tracks = measuredTracks();
      const mine = new Map([...all].filter(([, runner]) => tracks.includes(runner.track)));
      const plan = planTopUp(ade, rowsOf(folder(runId, ade, attempt).dir), minimumsOf(mine), expectedTests(ade, tracks, mine));
      const note = plan.skipped.map((entry) => `${entry.test} has no top-up (${entry.reason})`).join("; ");
      return { tests: plan.tests, note };
    },
    topUp: async (ade, runId, seed, tests, attempt, firstAttempt): Promise<StepResult> => {
      if (cancelled) return { ok: false, note: "stopped" };
      const first = buildIdOf(ade, rowsOf(folder(runId, ade, firstAttempt).dir));
      // Dry instruments drive no app, so there is no build to compare before; the rows are compared after.
      if (!dry) {
        const refusal = topUpRefusal(first, await buildIdNow(ade));
        if (refusal !== null) return { ok: false, note: refusal };
      }
      const dir = topUpDir(resultsRoot(), runId, ade, attempt, dry);
      moveAside(dir, ade);
      const all = await runnersOf();
      const args = ["bun", "bench/cli.ts", "run", "--ade", ade, "--tracks", tracksOf(tests, all).join(","), "--agent", AGENTS.join(","),
        "--run-id", topUpRunId(runId, ade, attempt), "--seed", seed, "--tests", tests.join(",")];
      const code = await supervised(dry ? [...args, "--dry-run"] : args, MEASURE_TIMEOUT_MS, repoRoot);
      if (cancelled) return { ok: false, note: "stopped" };
      if (!dry) await pruneAsideInChild(log);
      const rows = rowsOf(dir);
      const refusal = rows.length === 0 ? null : topUpRefusal(first, buildIdOf(ade, rows));
      if (refusal !== null) return { ok: false, note: refusal };
      if (code !== 0 || rows.length === 0) return { ok: false, note: `exit ${code}, ${rows.length} rows` };
      return { ok: true, note: `${tests.join(",")}: ${rows.filter((row) => row.valid).length} of ${rows.length} rows valid` };
    },
    tokens: (ade, runId, seed, attempt) => lateRun(ade, runId, seed, "tokens", attempt),
    orchestration: (ade, runId, seed, attempt) => lateRun(ade, runId, seed, "orchestration", attempt),
    latePlan: (ades) => latePlanOf(ades),
    // A dry run calls no model.
    modelAnswers: async () => (dry ? true : await claudeAnswers()),
    report: (runId, tasks, ended) => writeReport(runId, tasks, ended),
    abort: () => {
      cancelled = true;
      stopChildren();
    },
    cleanup: async (ade) => (dry ? [] : await repair.cleanUp(ade)),
    // A dry run writes plans, not videos or captures.
    diskFreeBytes: () => {
      if (dry) return null;
      try {
        const disk = statfsSync(resultsRoot());
        return Number(disk.bavail) * Number(disk.bsize);
      } catch {
        return null;
      }
    },
  };
}

export function adeLabel(id: string): string {
  if (id === "bare-cli") return "Bare CLI";
  try {
    return getAdapter(id).calibration.appName;
  } catch {
    return id;
  }
}

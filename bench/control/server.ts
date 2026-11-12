// ADEMark Control: a local panel with one Start button over the durable queue. Only this Mac can reach it, and a write
// needs a custom header, so another web page cannot start a run.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { shuffle } from "../core/order.ts";
import { resultsRoot } from "../core/paths.ts";
import { activeChildGroups, setChildLog } from "../night/repair-real.ts";
import { Engine, PAUSED_NOTE, type EngineDeps } from "./engine.ts";
import { appendLine, controlFiles, writeHeartbeat, type Intent } from "./files.ts";
import { askPermissions } from "./permissions.ts";
import { adeLabel, codeIdNow, latePlanOf, MEASURED_ADES, missingNow, realEngineDeps, runFolders, stepLimitMs } from "./real.ts";
import { latestRehearsal, rehearsalWarning, type CodeId, type RehearsalWarning } from "./rehearsal.ts";
import { watchdogInstall, watchdogLoaded } from "./watchdog.ts";
import { rehearsalDir } from "./folders.ts";
import { rowsIn } from "./qa.ts";
import { runKindOf, Store, STEPS, type LatePlan, type Run, type StepName, type Task } from "./store.ts";
import { testLines } from "./verdicts.ts";
import { mergeAttempts, minimumsOf, missingLine, type Minimum, type Missing } from "./topup.ts";
import { loadRunners, type TestRunner } from "../run/registry.ts";

const PUBLIC = join(dirname(new URL(import.meta.url).pathname), "public");
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/doto.woff2": "doto.woff2",
  "/host-grotesk.woff2": "host-grotesk.woff2",
  "/geist.woff2": "geist.woff2",
};
const LOG_LINES = 5;
const HEARTBEAT_MS = 15_000;
const WATCHDOG_LOOK_MS = 60_000;

export interface ControlOptions {
  port?: number;
  dry?: boolean;
  ades?: readonly string[];
  /** Replaces the real permission pass in tests. */
  permissions?: typeof askPermissions;
  /** Replaces the real steps in tests. */
  deps?: (log: (line: string) => void) => EngineDeps;
  /** Replaces the commit and inputs reader in tests (bench/control/real.ts codeIdNow). */
  codeId?: () => CodeId;
  /** Replaces the LaunchAgent in tests. A dry run never touches it. */
  watchdog?: { install(): Promise<void>; loaded(): Promise<boolean> };
  /** Replaces the adapters' orchestration triggers in tests (ADEMARK-49). */
  latePlan?: (ades: readonly string[]) => LatePlan;
}

function startedOf(tasks: readonly Task[], id: number): number | null {
  const started = tasks.find((task) => task.id === id)?.started_at;
  return started == null ? null : Date.parse(started);
}

function limitMinutesOf(step: StepName): number | null {
  const limit = stepLimitMs(step);
  return limit === null ? null : Math.round(limit / 60_000);
}

function stamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");
}

// Apps by what their 2026-11-08 gates showed, healthiest first, random inside each tier: useful rows come early, and an
// app that needs a person (Cloudroom, Conductor) cannot hold up the others. Unknown ids go to the middle tier.
const HEALTH_TIERS: readonly (readonly string[])[] = [
  ["monocode", "emdash", "traycer", "zeron", "super-engineering", "claude-desktop", "bare-cli"],
  ["t3code", "synara", "bb", "paseo"],
  ["diri", "orca"],
  ["cloudroom", "conductor"],
];

export function healthFirst(ids: readonly string[], seed: string): string[] {
  const tierOf = (id: string): number => {
    const tier = HEALTH_TIERS.findIndex((list) => list.includes(id));
    return tier === -1 ? 1 : tier;
  };
  return HEALTH_TIERS.flatMap((_, tier) => shuffle(ids.filter((id) => tierOf(id) === tier), `${seed}-${tier}`));
}

interface Progress { stage: string; test: string | null; rep: number | null; minutes: number }

// The measuring child's last report for this app, if it came after the step started (bench/run/loop.ts).
function progressOf(path: string, ade: string, startedAt: number | null): Progress | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { ade: string; stage: string; test: string | null; rep: number | null; at: string };
    const at = Date.parse(raw.at);
    if (!raw.ade.startsWith(ade) || (startedAt !== null && at < startedAt)) return null;
    return { stage: raw.stage, test: raw.test, rep: raw.rep, minutes: Math.floor((Date.now() - at) / 60_000) };
  } catch {
    return null;
  }
}

// The panel reads rows every 2 s: the folders are read again only when one of their rows.jsonl changed. A night counts
// the rows the report keeps: each test from one attempt (bench/control/topup.ts mergeAttempts).
const marksCache = new Map<string, { stamp: string; fresh: number; accepted: number; setAside: string[] }>();
function marksOf(ade: string, runId: string, dirs: { first: string | null; topUps: readonly string[]; rehearsal: string | null }, minimums: ReadonlyMap<string, Minimum>):
  { fresh: number; accepted: number; setAside: string[] } {
  const list = [dirs.first, ...dirs.topUps, dirs.rehearsal].filter((dir): dir is string => dir !== null && existsSync(`${dir}/rows.jsonl`));
  if (list.length === 0) return { fresh: 0, accepted: 0, setAside: [] };
  const stamp = list.map((dir) => {
    const info = statSync(`${dir}/rows.jsonl`);
    return `${dir} ${info.mtimeMs} ${info.size}`;
  }).join("|") + ` ${minimums.size}`;
  const key = `${runId} ${ade}`;
  const cached = marksCache.get(key);
  if (cached?.stamp === stamp) return { fresh: cached.fresh, accepted: cached.accepted, setAside: cached.setAside };
  let rows = dirs.rehearsal === null ? [] : rowsIn(dirs.rehearsal);
  if (dirs.first !== null) {
    const topUps = dirs.topUps.map((dir) => ({ label: dir, rows: rowsIn(dir) }));
    try {
      rows = mergeAttempts(ade, runId, { label: "first", rows: rowsIn(dirs.first) }, topUps, minimums).rows;
    } catch {
      rows = rowsIn(dirs.first);
    }
  }
  const all = testLines(ade, rows);
  const lines = all.filter((line) => line.status === "invalid");
  // A test set aside after review shows with its reason until a top-up replaces its rows (ADEMARK-56).
  const setAside = all.filter((line) => line.status === "set aside").map((line) => `${line.test} ${line.reason}`);
  const entry = { stamp, fresh: lines.reduce((sum, line) => sum + line.fresh, 0), accepted: lines.reduce((sum, line) => sum + line.invalid - line.fresh, 0), setAside };
  marksCache.set(key, entry);
  return { fresh: entry.fresh, accepted: entry.accepted, setAside };
}

/**
 * ADEMARK-51: the first pass of a night is over once its queue ran dry, top-ups included. A run from before that column
 * counts as over when it has top-ups and none of the night's own top-ups waits (the night of 10 Nov).
 */
export function firstPassOver(run: Run, tasks: readonly Task[]): boolean {
  if (run.first_pass_at !== null && run.first_pass_at !== undefined) return true;
  const topUps = tasks.filter((task) => task.step === "top-up");
  return topUps.length > 0 && !topUps.some((task) => task.pass === 0 && (task.status === "pending" || task.status === "running"));
}

export function startControl(options: ControlOptions = {}): { url: string; stop(): Promise<void> } {
  const dry = options.dry === true;
  const ades = options.ades ?? MEASURED_ADES;
  mkdirSync(resultsRoot(), { recursive: true });
  const files = controlFiles(dry);
  const store = new Store(files.database);
  const lines: string[] = [];
  // 2026-11-09: Control wrote only to its Ghostty tab, and the night that stopped at 02:20 left no trace. Every line
  // also goes to control.log with its time.
  const log = (line: string): void => {
    console.log(line);
    appendLine(files.log, line);
    lines.push(line);
    lines.splice(0, Math.max(0, lines.length - LOG_LINES));
  };
  setChildLog(log);
  log(`Control started, pid ${process.pid}${dry ? ", dry run" : ""}`);
  const engineDeps = (options.deps ?? ((write) => realEngineDeps(write, dry)))(log);
  if (options.latePlan !== undefined) engineDeps.latePlan = options.latePlan;
  const engine = new Engine(store, engineDeps);
  const watchdog = options.watchdog ?? (dry ? null : { install: watchdogInstall, loaded: watchdogLoaded });
  let watchdogUp: boolean | null = null;
  // Whether a person wants the run to go on. The watchdog restarts Control only while this is "running".
  let intent: Intent = "stopped";
  let port = 0;
  // It opens and quits apps, so nothing else may run beside it.
  let permissionJob: Promise<void> | null = null;
  let closing = false;
  const free = (): boolean => permissionJob === null && (engine.state === "idle" || engine.state === "blocked");

  // What the panel shows: the run that works now, else the newest of any kind (a finished rehearsal stays in view).
  let activeRun: string | null = null;
  const shownRun = () => (activeRun === null ? null : store.latestRunById(activeRun)) ?? store.latestRun();
  // The folders whose rows belong to this app in this run, for the NEW and accepted counts.
  const foldersFor = (runId: string, tasks: readonly Task[], id: string) => {
    const root = resultsRoot();
    const rehearse = tasks.find((task) => task.ade === id && task.step === "rehearse" && task.attempts > 0);
    const folders = runFolders(root, runId, tasks, id, dry);
    return {
      rehearsal: rehearse === undefined ? null : rehearsalDir(root, runId, id, rehearse.attempts, dry),
      first: folders.first?.dir ?? null,
      topUps: folders.topUps.map((topUp) => topUp.dir),
    };
  };
  // Each test's minimum, for the merge. Loaded once in the background; until then the first attempt alone counts.
  let minimums: Map<string, Minimum> = new Map();
  let runners: Map<string, TestRunner> | null = null;
  void (loadRunners() as Promise<Map<string, TestRunner>>).then((loaded) => {
    runners = loaded;
    minimums = minimumsOf(loaded);
  }, (error: unknown) => log(`could not load the test runners: ${String(error)}`));

  // What a pass would measure. Read again only when the queue or a rows.jsonl changed: the panel asks every 2 s and must
  // stay responsive. Null while the runners load, so the panel never says "complete" before it could know.
  let missingRead: { stamp: string; value: { plan: Missing; line: string } | { error: string } } | null = null;
  const missingOf = (run: Run, tasks: readonly Task[]): { plan: Missing; line: string } | { error: string } | null => {
    if (runners === null) return null;
    const dirs = [...new Set(tasks.map((task) => task.ade))].flatMap((id) => {
      const folders = foldersFor(run.id, tasks, id);
      return [folders.first, ...folders.topUps].filter((dir): dir is string => dir !== null);
    });
    const stamp = [run.id, ...tasks.map((task) => `${task.id}:${task.status}:${task.attempts}:${task.adopted_attempt}`), ...dirs.map((dir) => {
      try {
        const info = statSync(`${dir}/rows.jsonl`);
        return `${dir} ${info.mtimeMs} ${info.size}`;
      } catch {
        return `${dir} none`;
      }
    })].join("|");
    if (missingRead?.stamp === stamp) return missingRead.value;
    let value: { plan: Missing; line: string } | { error: string };
    try {
      const plan = missingNow(resultsRoot(), run.id, tasks, dry, runners, ades, options.latePlan ?? latePlanOf);
      value = { plan, line: missingLine(plan, adeLabel) };
    } catch (error) {
      value = { error: error instanceof Error ? error.message : String(error) };
    }
    missingRead = { stamp, value };
    return value;
  };

  const snapshot = () => {
    const run = shownRun();
    const tasks = run === null ? [] : store.tasks(run.id);
    const kind = run === null ? "night" : runKindOf(run.id);
    const ids = [...new Set(tasks.map((task) => task.ade))];
    // Old queues still hold a `check`; it no longer runs at night, so it is not shown.
    const shownSteps = STEPS.filter((step) => tasks.some((task) => task.step === step) || (run === null && (step === "prove" || step === "measure")));
    const list = (run === null ? ades : ids).map((id) => ({
      id,
      label: adeLabel(id),
      steps: shownSteps.map((step) => {
        // The newest top-up of an app stands for its step: a later pass adds a new one (ADEMARK-51).
        const task = tasks.filter((entry) => entry.ade === id && entry.step === step).at(-1);
        return { step, status: task?.status ?? (step === "top-up" || step === "tokens" || step === "orchestration" ? "none" : "pending"), note: task?.note ?? "" };
      }),
      marks: run === null ? { fresh: 0, accepted: 0, setAside: [] } : marksOf(id, run.id, foldersFor(run.id, tasks, id), minimums),
    }));
    // The big number counts apps already measured (or rehearsed).
    const finishedAde = (id: string): boolean =>
      tasks.some((task) => task.ade === id && (task.step === "measure" || task.step === "rehearse") && (task.status === "done" || (task.step === "rehearse" && task.status === "failed")));
    const night = kind === "night" && run !== null && run.ended_at === null && tasks.length > 0;
    const passOver = night && firstPassOver(run!, tasks);
    const stale = kind === "night" && run !== null && run.ended_at === null && engine.state === "idle" && cannotGoOn(run.id);
    const read = passOver && !stale && free() ? missingOf(run!, tasks) : null;
    const missing = read === null ? null : "error" in read ? { line: "", error: read.error, measure: [], topUps: [], tokens: [], orchestration: [] }
      : { line: read.line, error: null, measure: read.plan.measure, topUps: read.plan.topUps.map((entry) => ({ ade: entry.ade, tests: entry.short })),
        tokens: read.plan.tokens, orchestration: read.plan.orchestration };
    const currentSteps = engine.current === null ? [] : STEPS.filter((step) => tasks.some((task) => task.ade === engine.current!.ade && task.step === step));
    return {
      kind,
      run_id: run?.id ?? null,
      qa: "QA: run by day",
      // Shown with a night only: a rehearsal is the check itself.
      rehearsal: kind === "night" ? rehearsalLine : null,
      state: permissionJob === null ? engine.state : "permissions",
      problems: engine.problems,
      notice: engine.state === "paused" ? PAUSED_NOTE : null,
      // ADEMARK-49: the late steps of this pass were skipped because the model did not answer.
      lateNote: engine.lateNote,
      watchdog: watchdogUp,
      open: run !== null && run.ended_at === null && tasks.length > 0,
      // The open night cannot go on: the one button then says Start, and Start begins a new night.
      stale,
      // ADEMARK-51: after the first pass, the button measures what is missing, or the night is complete.
      passOver,
      missing,
      complete: missing !== null && missing.error === null && missing.line.length === 0,
      current: engine.current === null ? null : {
        ade: engine.current.ade,
        label: adeLabel(engine.current.ade),
        step: engine.current.step,
        stepIndex: currentSteps.indexOf(engine.current.step) + 1,
        stepCount: currentSteps.length,
        tests: engine.current.tests,
        phase: engine.phase,
        minutes: Math.floor((Date.now() - (startedOf(tasks, engine.current.id) ?? Date.now())) / 60_000),
        // The same number the heartbeat gives the watchdog: one constant, so the panel never says 60 when it is 75.
        limitMinutes: limitMinutesOf(engine.current.step),
        progress: progressOf(files.progress, engine.current.ade, startedOf(tasks, engine.current.id)),
      },
      done: ids.filter(finishedAde).length,
      total: ids.length,
      // The queue ran to its end. A night stays open after that (ADEMARK-51); `closed` says the owner ended it.
      finished: run !== null && (run.ended_at !== null || (passOver && !tasks.some((task) => task.status === "pending" || task.status === "running"))),
      closed: run !== null && run.ended_at !== null,
      prepared: run !== null && tasks.every((task) => task.step === "prove"),
      newTotal: list.reduce((sum, entry) => sum + entry.marks.fresh, 0),
      ades: list,
      log: lines,
    };
  };

  const newRun = (steps?: readonly StepName[]): void => {
    const id = `control-${stamp()}`;
    store.createRun(id, id, healthFirst([...ades], id), dry, new Date().toISOString(), steps);
  };

  const beat = (): void => {
    const run = shownRun();
    const task = engine.current;
    writeHeartbeat(files.heartbeat, {
      pid: process.pid,
      port,
      run_id: run?.id ?? null,
      state: permissionJob === null ? engine.state : "permissions",
      intent,
      ade: task?.ade ?? null,
      step: task?.step ?? null,
      step_started_at: task === null ? null : (store.tasks(task.run_id).find((entry) => entry.id === task.id)?.started_at ?? null),
      step_limit_ms: task === null ? null : stepLimitMs(task.step),
      child_group: activeChildGroups()[0] ?? null,
      written_at: new Date().toISOString(),
    });
  };
  const setIntent = (next: Intent): void => {
    intent = next;
    beat();
  };
  const lookAtWatchdog = (): void => {
    if (watchdog === null) return;
    watchdog.loaded().then((up) => {
      watchdogUp = up;
    }, () => {
      watchdogUp = false;
    });
  };

  const work = (runId: string, seed: string): void => {
    activeRun = runId;
    setIntent("running");
    // Safe to repeat: it changes nothing when the LaunchAgent is already loaded. A child, so the panel never waits.
    if (watchdog !== null) {
      watchdog.install().catch((error: unknown) => log(`watchdog install failed: ${String(error)}`)).finally(lookAtWatchdog);
    }
    void engine.run(runId, seed).finally(() => {
      // The run ended, a person stopped it, or it needs a person: in each case nobody may restart it alone.
      setIntent("stopped");
      if (engine.problems.length > 0) log(`Control waits for a person: ${engine.problems.join(" | ")}`);
    });
  };

  // Review R2, 2026-11-10: the RUNBOOK says to start a night only after a clean rehearsal. A line says whether the last
  // lap covers this code. It is a warning and never a gate: on 7 Nov a gate stopped 13 of 15 apps.
  let rehearsalLine: RehearsalWarning | null = null;
  const lookAtRehearsal = (): void => {
    try {
      rehearsalLine = rehearsalWarning(latestRehearsal(resultsRoot(), dry), (options.codeId ?? codeIdNow)());
    } catch (error) {
      rehearsalLine = { level: "warn", text: `The last rehearsal could not be read: ${error instanceof Error ? error.message : String(error)}. Start still works.` };
    }
    log(rehearsalLine.text);
  };

  // One button (2026-11-10): the owner presses Start and nothing else. A night whose measuring files changed since it
  // began cannot go on, because the preflight refuses it (`<run>.inputs`). Start then ends it and begins a new night,
  // and its folders stay on disk. Read at most once a minute: the reader hashes the helper and the snapshots.
  let staleRead: { run: string; at: number; stale: boolean } | null = null;
  const cannotGoOn = (runId: string): boolean => {
    if (staleRead !== null && staleRead.run === runId && Date.now() - staleRead.at < 60_000) return staleRead.stale;
    let stale = false;
    try {
      const baseline = join(resultsRoot(), `${runId}.inputs`);
      const now = existsSync(baseline) ? (options.codeId ?? codeIdNow)().inputs : null;
      stale = now !== null && readFileSync(baseline, "utf8") !== now;
    } catch {
      stale = false;
    }
    staleRead = { run: runId, at: Date.now(), stale };
    return stale;
  };

  // Start goes on with the open night, or begins one. A rehearsal is never continued as a night.
  const start = (): void => {
    if (!free()) return;
    lookAtRehearsal();
    const latest = store.latestRun("night");
    if (latest !== null && latest.ended_at === null && cannotGoOn(latest.id)) {
      store.endRun(latest.id, new Date().toISOString());
      log(`Start: the measuring files changed since ${latest.id} began. It ends here, its folders stay on disk, and a new night starts`);
      newRun();
    } else if (latest === null || latest.ended_at !== null) newRun();
    else if (firstPassOver(latest, store.tasks(latest.id))) {
      // After the first pass Start never measures again in full: it measures what is missing, or nothing.
      fill();
      return;
    }
    const run = store.latestRun("night")!;
    work(run.id, run.seed);
  };

  // ADEMARK-51: after a fix by day, one pass measures only what is missing, in the same run and with the same native
  // helper (the preflight refuses a changed one): the apps never measured go back to the queue with their attempt count,
  // and each app with a test under its minimum gets one more top-up. It exists only through this button.
  const fill = (): void => {
    if (!free()) return;
    const latest = store.latestRun("night");
    if (latest === null || latest.ended_at !== null || cannotGoOn(latest.id)) return;
    const tasks = store.tasks(latest.id);
    if (!firstPassOver(latest, tasks)) return;
    const read = missingOf(latest, tasks);
    if (read === null) {
      log("Measure what is missing: the test runners are still loading; press it again in a moment");
      return;
    }
    if ("error" in read) {
      log(`Measure what is missing: ${read.error}`);
      return;
    }
    if (read.line.length === 0) {
      log(`Measure what is missing: nothing is missing in ${latest.id}; the night is complete`);
      return;
    }
    const pass = store.fill(latest.id, read.plan.measure, read.plan.topUps, { tokens: read.plan.tokens, orchestration: read.plan.orchestration });
    log(`Measure what is missing, pass ${pass} of ${latest.id}: ${read.line}`);
    work(latest.id, latest.seed);
  };

  // Ends the open night and starts nothing. Its folders stay on disk; the button then starts a new night.
  const closeNight = (): void => {
    if (!free()) return;
    const latest = store.latestRun("night");
    if (latest === null || latest.ended_at !== null) return;
    store.endRun(latest.id, new Date().toISOString());
    log(`Close this night: ended ${latest.id}; its folders stay on disk`);
  };

  // ADEMARK-44: one smoke lap of each app, healthy apps first, with the steps of the night. A run of its own, so its rows
  // never mix with a measuring run; an open night stays open and Start goes on with it afterwards.
  const rehearse = (only?: readonly string[]): void => {
    if (!free()) return;
    const open = store.latestRun("rehearsal");
    if (open !== null && open.ended_at === null) store.endRun(open.id, new Date().toISOString());
    const id = `rehearsal-${stamp()}`;
    const chosen = only === undefined || only.length === 0 ? [...ades] : ades.filter((ade) => only.includes(ade));
    store.createRun(id, id, healthFirst(chosen, id), dry, new Date().toISOString());
    log(`Rehearsal ${id}: ${chosen.length} apps`);
    work(id, id);
  };

  // `control --continue`: the watchdog's restart goes on with the open run, and starts nothing new.
  const continueRun = (): void => {
    const latest = store.openRun();
    if (latest === null) {
      log("Continue: no open run, nothing to do");
      return;
    }
    if (!free()) return;
    log(`Continue: going on with ${latest.id}`);
    work(latest.id, latest.seed);
  };

  // A run that cannot go on (2026-11-09: the native helper changed, so the preflight refuses the old run) ends, and a
  // new one starts with healthy apps first. The old rows stay on disk.
  const startNew = (): void => {
    if (!free()) return;
    lookAtRehearsal();
    const latest = store.latestRun("night");
    if (latest !== null && latest.ended_at === null) {
      store.endRun(latest.id, new Date().toISOString());
      log(`New run: ended ${latest.id}; its folders stay on disk`);
    }
    newRun();
    const run = store.latestRun("night")!;
    work(run.id, run.seed);
  };

  // By day: proves every app and leaves a proof, so the night only measures. Proofs that still hold cost nothing.
  const prepare = (): void => {
    if (!free()) return;
    const latest = store.latestRun("night");
    if (latest !== null && latest.ended_at === null) store.endRun(latest.id, new Date().toISOString());
    newRun(["prove"]);
    const run = store.latestRun("night")!;
    work(run.id, run.seed);
  };

  const server = Bun.serve({
    port: options.port ?? 7788,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === "GET") {
        if (pathname === "/api/state") return Response.json(snapshot());
        const file = STATIC[pathname];
        return file === undefined ? new Response("Not found", { status: 404 }) : new Response(Bun.file(join(PUBLIC, file)));
      }
      if (request.headers.get("x-ademark") !== "1") return new Response("Forbidden", { status: 403 });
      if (pathname === "/api/permissions") {
        if (free()) {
          permissionJob = (options.permissions ?? askPermissions)(log, () => closing)
            .then((missing) => {
              engine.problems = missing;
            })
            .catch((error: unknown) => {
              engine.problems = [String(error)];
            })
            .finally(() => {
              permissionJob = null;
            });
        }
      } else if (pathname === "/api/start") start();
      else if (pathname === "/api/new-run") startNew();
      else if (pathname === "/api/fill") fill();
      else if (pathname === "/api/close") closeNight();
      else if (pathname === "/api/prepare") prepare();
      else if (pathname === "/api/rehearse") {
        const body = (await request.json().catch(() => ({}))) as { ades?: unknown };
        const only = Array.isArray(body.ades) ? body.ades.filter((id): id is string => typeof id === "string") : undefined;
        if (only !== undefined && only.some((id) => !ades.includes(id))) return Response.json({ ok: false, error: `unknown app: ${only.filter((id) => !ades.includes(id)).join(",")}` }, { status: 400 });
        rehearse(only);
      }
      else if (pathname === "/api/stop") {
        // Before anything else: a watchdog that looks during the stop must not bring the run back.
        setIntent("stopped");
        log("Stop pressed");
        engine.stop();
      }
      else if (pathname === "/api/retry") {
        const run = shownRun();
        const { ade } = (await request.json()) as { ade?: string };
        if (run !== null && typeof ade === "string" && free()) {
          store.retry(run.id, ade);
          store.reopenRun(run.id);
        }
      } else return new Response("Not found", { status: 404 });
      return Response.json({ ok: true });
    },
  });

  port = server.port ?? 0;
  beat();
  const beats = setInterval(beat, HEARTBEAT_MS);
  lookAtWatchdog();
  const looks = setInterval(lookAtWatchdog, WATCHDOG_LOOK_MS);

  return {
    url: `http://127.0.0.1:${server.port}`,
    continueRun,
    stop: async () => {
      closing = true;
      clearInterval(beats);
      clearInterval(looks);
      setIntent("stopped");
      log("Control stopping");
      engine.stop();
      await permissionJob;
      // The worker restores the machine and ends its children: nothing closes before that.
      await engine.idle();
      await server.stop(true);
      beat();
      store.close();
    },
  };
}

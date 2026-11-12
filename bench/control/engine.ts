// The worker of ADEMark Control. It runs the queue one step at a time, so nothing else runs during a measurement.
import type { Screen } from "./session.ts";
import { isLate, runKindOf, type LatePlan, type Store, type Task } from "./store.ts";

export interface StepResult {
  ok: boolean;
  note: string;
  /** Nothing more may run until a person looks: the measuring files changed. */
  fatal?: boolean;
}

export interface EngineDeps {
  now(): string;
  log(line: string): void;
  /** Waits for a calm machine before a step. A busy Mac is a reason to wait, never a failure of the app. */
  settle(): Promise<void>;
  /** What stops a real run before it starts, empty when it can go. */
  preflight(runId: string): Promise<string[]>;
  machineOn(): void;
  machineOff(): void;
  /** The first attempt only looks. Repair is true on the last pass, when healthy apps are already measured. */
  prove(ade: string, runId: string, attempt: number, repair: boolean): Promise<StepResult>;
  /** Each attempt writes to its own folder, so an interrupted one cannot mix with the next. Repair comes only on the last pass. */
  measure(ade: string, runId: string, seed: string, attempt: number, repair: boolean): Promise<StepResult>;
  /** One `run --smoke` lap of this app (ADEMARK-44). Its rows never count as a measurement. */
  rehearse(ade: string, runId: string, seed: string, attempt: number): Promise<StepResult>;
  /**
   * The tests of this app under their minimum of valid repetitions in the measure folder `attempt`, with the tests
   * they need (ADEMARK-47). Empty when nothing is short. The note says why short tests were left out.
   */
  topUpTests(ade: string, runId: string, attempt: number): Promise<{ tests: string[]; note: string }>;
  /** `run --tests` in a new attempt folder of the same run. It refuses another build or machine than `firstAttempt`. */
  topUp(ade: string, runId: string, seed: string, tests: readonly string[], attempt: number, firstAttempt: number): Promise<StepResult>;
  /** ADEMARK-49: Track B alone (`run --tracks B`) in `<run>-<ade>-tokens-<n>`. Its result never touches Track A. */
  tokens(ade: string, runId: string, seed: string, attempt: number): Promise<StepResult>;
  /** ADEMARK-49: C1 alone (`run --tracks C --tests C1`) in `<run>-<ade>-orchestration-<n>`. */
  orchestration(ade: string, runId: string, seed: string, attempt: number): Promise<StepResult>;
  /**
   * The late steps of a night's own first pass: tokens for every app, orchestration for Bare CLI first and each app whose
   * adapter has a trigger. Read when the pass gets there, because the triggers are filled while nights run.
   */
  latePlan(ades: readonly string[]): LatePlan;
  /** One call of the real model before the first late step of a pass: false when the plan did not answer. */
  modelAnswers(): Promise<boolean>;
  /** Writes what the run knows so far: rehearsal.md for a rehearsal, report.md for a night. It never throws. */
  report(runId: string, tasks: readonly Task[], ended: boolean): void;
  /** Ends whatever child runs now, and stops any step from starting another. */
  abort(): void;
  /** Stops what a stopped step left, such as an app outside the child group. Returns what is still alive. */
  cleanup(ade: string): Promise<string[]>;
  /** A new run starts with nothing cancelled. */
  resume(): void;
  /**
   * "on" when this account owns the screen and it is not locked, "off" for a clear answer that it does not, "unknown"
   * when the reader could not tell. 2026-11-08 23:28: the screen switched to another macOS account, the apps went to the background,
   * and MonoCode attempt 1 ended with 0 rows.
   */
  screen(): Promise<Screen>;
  sleep(ms: number): Promise<void>;
  /** The newest attempt folder of a measure that has every block marker and rows, or null (ADEMARK-37). */
  finishedAttempt(ade: string, runId: string, attempts: number, only?: number): { attempt: number; rows: number } | null;
  /** Free bytes on the disk that holds the results, or null when it cannot be read. Absent in a dry run. */
  diskFreeBytes?(): number | null;
}

// 2026-11-11: the Mac had 12 GB free before a pass of more than a day, and nothing looked at the disk. A full disk in
// the middle of a step breaks rows, videos and the queue's own database. Under this, the run stops before the next step
// with everything it has, and waits for a person. One C1 step can write a few GB (request bodies and worktrees).
export const MIN_FREE_DISK_BYTES = 5 * 1024 ** 3;

export type EngineState = "idle" | "starting" | "working" | "paused" | "stopping" | "blocked";

/** While paused, how often Control looks whether the account came back. */
export const SESSION_POLL_MS = 15_000;
/** During a step: a cut needs this many off reads in a row, this far apart. One slow ioreg must not cost a measure. */
export const STEP_LOOK_MS = 5_000;
export const OFF_READS_TO_CUT = 3;
/** Before a step: an unknown read is read again this often, for this long, and then counts as on screen. */
export const UNKNOWN_RETRY_MS = 5_000;
export const UNKNOWN_WAIT_MS = 60_000;
export const PAUSED_NOTE = "Paused: this account is not on screen";
export const NO_MODEL_NOTE = "the Claude plan did not answer";
// One C1 spends 10 to 46 M tokens (ADEMARK-50), so a night of late steps can use up a 5-hour window of the plan more than
// once. The window opens again at most 5 hours after its first use: the engine asks every 10 minutes and gives up after 6
// hours (a weekly limit, or a lost sign-in).
export const PLAN_POLL_MS = 10 * 60_000;
export const PLAN_WAIT_MS = 6 * 60 * 60_000;
const OFF_SCREEN = "This account is not on screen (another user is in front, or the screen is locked). Come back to it, then press the button again.";

export class Engine {
  state: EngineState = "idle";
  current: Task | null = null;
  /** What the current step is doing, for the panel: a wait for a calm Mac looked like a hang on 2026-11-08. */
  phase: "settling" | "running" | null = null;
  problems: string[] = [];
  /** Why the late steps of this pass were skipped, for the panel. Null when they were not. */
  lateNote: string | null = null;
  private stopRequested = false;
  private active: Promise<void> | null = null;

  constructor(private store: Store, private deps: EngineDeps) {}

  stop(): void {
    if (this.state !== "working" && this.state !== "starting" && this.state !== "paused") return;
    this.stopRequested = true;
    this.state = "stopping";
    this.deps.abort();
  }

  /** Resolves when no worker is left, so a caller can close the store or exit. */
  async idle(): Promise<void> {
    await this.active;
  }

  /** Runs what is pending in `runId`, also after a crash. Only one worker can exist. */
  run(runId: string, seed: string): Promise<void> {
    if (this.active !== null) return this.active;
    this.active = this.work(runId, seed).finally(() => {
      this.active = null;
    });
    return this.active;
  }

  private async work(runId: string, seed: string): Promise<void> {
    this.stopRequested = false;
    this.state = "starting";
    this.problems = [];
    this.lateNote = null;
    this.deps.resume();
    if ((await this.clearScreen()) === "off") {
      this.problems = [OFF_SCREEN];
      this.state = "blocked";
      return;
    }
    this.problems = await this.deps.preflight(runId);
    if (this.problems.length > 0) {
      this.state = "blocked";
      return;
    }
    if (this.stopRequested) {
      this.state = "idle";
      return;
    }
    this.recoverRun(runId);
    this.store.reopenRun(runId);
    let machineTouched = false;
    const planned = new Set<string>();
    let lateAdded = false;
    try {
      // Set first: machine on can fail halfway, and what it already changed must go back.
      machineTouched = true;
      this.deps.machineOn();
      this.state = "working";
      while (!this.stopRequested) {
        await this.waitForScreen();
        if (this.stopRequested) break;
        const task = this.store.next(runId);
        const night = runKindOf(runId) === "night";
        if (night && (task === null || isLate(task.step))) {
          // After the first pass of every app: a test under its minimum runs again, once, in the same run, before any
          // tokens or orchestration step (ADEMARK-49).
          if (await this.planTopUps(runId, planned)) continue;
          if (!lateAdded) {
            lateAdded = true;
            if (this.addOwnLate(runId)) continue;
          }
        }
        // Before any step, and before the wait for the plan: a full disk is not worth 6 hours of waiting.
        const free = task === null ? null : (this.deps.diskFreeBytes?.() ?? null);
        if (task !== null && free !== null && free < MIN_FREE_DISK_BYTES) {
          const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);
          this.problems = [`Only ${gb(free)} GB free on the disk (the run needs ${gb(MIN_FREE_DISK_BYTES)}). It stopped before ${task.ade} ${task.step}, and nothing is lost. Free space, then press the button again.`];
          this.deps.log(this.problems[0]!);
          break;
        }
        if (task !== null && isLate(task.step)) {
          // Before every late step, not only the first (2026-11-11): the step before it may have used up the plan. A plan
          // at its limit fails a late step in seconds or holds it to its cap, and that says nothing about the app.
          if (!(await this.waitForModel())) {
            if (this.stopRequested) break;
            const count = this.store.skipLate(runId, NO_MODEL_NOTE, this.deps.now());
            this.lateNote = `Tokens and orchestration skipped in this pass: ${NO_MODEL_NOTE}. The next pass runs them.`;
            this.deps.log(`${count} tokens and orchestration steps skipped: ${NO_MODEL_NOTE}`);
            this.report(runId, false);
            continue;
          }
        }
        if (task === null) {
          // ADEMARK-51: a night stays open after its queue runs dry, so the owner can measure what is missing in the
          // same run after a fix by day. Only the owner ends it (Close this night, or a new night).
          if (runKindOf(runId) === "night") this.store.markFirstPass(runId, this.deps.now());
          else this.store.endRun(runId, this.deps.now());
          this.report(runId, true);
          break;
        }
        await this.runTask(task, runId, seed);
      }
    } catch (error) {
      this.problems = [error instanceof Error ? error.message : String(error)];
    } finally {
      this.current = null;
      this.phase = null;
      if (machineTouched) {
        try {
          this.deps.machineOff();
        } catch (error) {
          this.problems.push(`machine off failed: ${String(error)}`);
        }
      }
      this.state = this.problems.length > 0 ? "blocked" : "idle";
    }
  }

  private report(runId: string, ended: boolean): void {
    try {
      this.deps.report(runId, this.store.tasks(runId), ended);
    } catch (error) {
      this.deps.log(`report failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async modelAnswers(): Promise<boolean> {
    try {
      return await this.deps.modelAnswers();
    } catch (error) {
      this.deps.log(`the model check failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  // True when the model answers, at once or after a wait for the plan's window. False after PLAN_WAIT_MS, or on Stop.
  private async waitForModel(): Promise<boolean> {
    for (let waited = 0; !this.stopRequested; waited += PLAN_POLL_MS) {
      if (await this.modelAnswers()) {
        if (waited > 0) {
          this.deps.log(`the Claude plan answers again after ${Math.round(waited / 60_000)} minutes`);
          this.lateNote = null;
        }
        return true;
      }
      if (waited >= PLAN_WAIT_MS) return false;
      if (waited === 0) this.deps.log(`${NO_MODEL_NOTE}: asking again every ${PLAN_POLL_MS / 60_000} minutes, for up to ${PLAN_WAIT_MS / 3_600_000} hours`);
      this.lateNote = `Waiting for the Claude plan: it does not answer (${Math.round(waited / 60_000)} minutes so far). Asked again every ${PLAN_POLL_MS / 60_000} minutes, for up to ${PLAN_WAIT_MS / 3_600_000} hours.`;
      // In short sleeps, so Stop does not wait 10 minutes.
      for (let slept = 0; slept < PLAN_POLL_MS && !this.stopRequested; slept += SESSION_POLL_MS) await this.deps.sleep(SESSION_POLL_MS);
    }
    return false;
  }

  // The night adds its own late steps once, in its first pass, after its top-ups. A later pass gets them only through the
  // owner's button (Store.fill). The UNIQUE key of the queue makes a restart add nothing twice.
  private addOwnLate(runId: string): boolean {
    const run = this.store.latestRunById(runId);
    if (run === null || run.first_pass_at !== null) return false;
    const tasks = this.store.tasks(runId);
    const ades = [...new Set(tasks.filter((task) => task.step === "measure").map((task) => task.ade))];
    // Only an app that never had a step of that kind gets one here. 2026-11-11: the night of 10 Nov began before the
    // late steps existed, so it has no first_pass_at, and its tokens and orchestration steps came from the owner's
    // pass. When that pass was cut and the night went on, this would have queued the tokens of all 17 apps and the
    // finished orchestration steps again. A step that ran, in any state, is the owner's to run again (Store.fill).
    const has = (ade: string, step: string): boolean => tasks.some((task) => task.ade === ade && task.step === step);
    const plan = this.deps.latePlan(ades);
    const own = { tokens: plan.tokens.filter((ade) => !has(ade, "tokens")), orchestration: plan.orchestration.filter((ade) => !has(ade, "orchestration")) };
    const added = this.store.addLateSteps(runId, own, 0);
    if (added > 0) this.deps.log(`${added} tokens and orchestration steps queued after the measures`);
    return added > 0;
  }

  // The night's own top-up is one per app: an app planned once in this worker is not asked again, and an app with any
  // top-up gets none here. A later top-up exists only through the owner's pass (Store.fill), so a test that keeps
  // failing cannot loop.
  private async planTopUps(runId: string, planned: Set<string>): Promise<boolean> {
    let added = false;
    for (const task of this.store.tasks(runId)) {
      if (task.step !== "measure" || task.status !== "done" || planned.has(task.ade)) continue;
      planned.add(task.ade);
      if (this.store.tasks(runId).some((entry) => entry.ade === task.ade && entry.step === "top-up")) continue;
      const plan = await this.deps.topUpTests(task.ade, runId, this.measureAttempt(runId, task.ade));
      if (plan.note.length > 0) this.deps.log(`${task.ade} top-up: ${plan.note}`);
      if (plan.tests.length === 0) continue;
      if (this.store.addTopUp(runId, task.ade, plan.tests)) {
        this.deps.log(`${task.ade} top-up: ${plan.tests.join(",")} queued`);
        added = true;
      }
    }
    return added;
  }

  /** Top-ups and old checks read the folder that holds the measure: an adopted one, else the last attempt. */
  private measureAttempt(runId: string, ade: string): number {
    const measure = this.store.tasks(runId).find((task) => task.ade === ade && task.step === "measure");
    return measure?.adopted_attempt ?? measure?.attempts ?? 1;
  }

  // A measure that was running when Control died may have finished: its folder decides, never the queue.
  private recoverRun(runId: string): void {
    for (const task of this.store.running(runId)) {
      if (task.step !== "measure") continue;
      const found = this.deps.finishedAttempt(task.ade, runId, task.attempts);
      if (found === null) continue;
      this.store.adopt(task.id, found.attempt, `adopted attempt ${found.attempt} after a restart (${found.rows} rows)`, this.deps.now());
      this.deps.log(`${task.ade} measure: done, adopted attempt ${found.attempt} (${found.rows} rows, every block marker present)`);
    }
    this.store.recover(runId);
  }

  // An unknown read is read again for up to 60 s, then counts as on screen: a broken reader must never stop a night
  // that worked before the reader existed (review, 2026-11-10).
  private async clearScreen(): Promise<"on" | "off"> {
    let screen = await this.deps.screen();
    for (let waited = 0; screen === "unknown" && waited < UNKNOWN_WAIT_MS && !this.stopRequested; waited += UNKNOWN_RETRY_MS) {
      await this.deps.sleep(UNKNOWN_RETRY_MS);
      screen = await this.deps.screen();
    }
    if (screen !== "unknown") return screen;
    this.deps.log(`the session reader gave no answer for ${UNKNOWN_WAIT_MS / 1000} s; going on as on screen`);
    return "on";
  }

  // Off screen nothing may start: the apps would run in the background and every test would fail.
  private async waitForScreen(): Promise<void> {
    if ((await this.clearScreen()) === "on") return;
    this.state = "paused";
    this.deps.log(PAUSED_NOTE);
    while (!this.stopRequested && (await this.clearScreen()) === "off") await this.deps.sleep(SESSION_POLL_MS);
    if (this.stopRequested) return;
    this.deps.log("Back on screen: waiting for a calm Mac");
    this.phase = "settling";
    await this.deps.settle();
    this.phase = null;
    if (!this.stopRequested) this.state = "working";
  }

  // The step was cut because the account left the screen. That is no attempt of the app: no failure, no count. A measure
  // that finished just before the cut is adopted from its own folder.
  private async pauseStep(task: Task, runId: string): Promise<void> {
    const attempt = task.attempts + 1;
    const found = task.step === "measure" ? this.deps.finishedAttempt(task.ade, runId, attempt, attempt) : null;
    if (found !== null) {
      this.store.finish(task.id, "done", `${found.rows} rows, finished before the screen was lost`, this.deps.now());
    } else {
      this.store.release(task.id);
      this.deps.log(`${task.ade} ${task.step}: back in the queue, no attempt counted`);
    }
    const alive = await this.deps.cleanup(task.ade);
    if (alive.length > 0) this.deps.log(`${task.ade}: processes still alive after cleanup: ${alive.join(", ")}; going on`);
    this.deps.resume();
  }

  private async runTask(task: Task, runId: string, seed: string): Promise<void> {
    // A queue from before 2026-11-10 still holds checks. QA runs by day now (`ademark qa`), never inside the night.
    if (task.step === "check") {
      this.store.finish(task.id, "skipped", "QA: run by day", this.deps.now());
      return;
    }
    this.current = task;
    this.store.start(task.id, this.deps.now());
    this.deps.log(`${task.ade} ${task.step}: start`);
    let result: StepResult;
    // During the step: three off reads in a row, 5 s apart, end the child, and the step goes back untouched. An unknown
    // read neither counts nor resets the count.
    let stepDone = false;
    let lostScreen = false;
    const watch = (async () => {
      let offReads = 0;
      let unknownLogged = false;
      while (!stepDone) {
        await this.deps.sleep(STEP_LOOK_MS);
        if (stepDone || this.stopRequested) return;
        const screen = await this.deps.screen();
        if (stepDone || this.stopRequested) return;
        if (screen === "on") offReads = 0;
        else if (screen === "off") offReads += 1;
        else if (!unknownLogged) {
          unknownLogged = true;
          this.deps.log(`${task.ade} ${task.step}: the session reader gave no answer; it does not count toward a pause`);
        }
        if (offReads >= OFF_READS_TO_CUT) {
          lostScreen = true;
          this.deps.log(`${task.ade} ${task.step}: ${PAUSED_NOTE.toLowerCase()} (${OFF_READS_TO_CUT} reads in a row); ending the step`);
          this.deps.abort();
          return;
        }
      }
    })();
    try {
      // Only what measures waits for a calm Mac. A proof is not published, and its app should open at once.
      if (task.step !== "prove") {
        this.phase = "settling";
        await this.deps.settle();
      }
      this.phase = "running";
      if (this.stopRequested) result = { ok: false, note: "stopped" };
      else if (task.step === "prove") result = await this.deps.prove(task.ade, runId, task.attempts + 1, task.attempts > 0);
      else if (task.step === "measure") result = await this.deps.measure(task.ade, runId, seed, task.attempts + 1, task.attempts > 0);
      else if (task.step === "rehearse") result = await this.deps.rehearse(task.ade, runId, seed, task.attempts + 1);
      else if (task.step === "tokens") result = await this.deps.tokens(task.ade, runId, seed, task.attempts + 1);
      else if (task.step === "orchestration") result = await this.deps.orchestration(task.ade, runId, seed, task.attempts + 1);
      else {
        const tests = (task.tests ?? "").split(",").filter((test) => test.length > 0);
        result = await this.deps.topUp(task.ade, runId, seed, tests, task.attempts + 1, this.measureAttempt(runId, task.ade));
      }
    } catch (error) {
      result = { ok: false, note: error instanceof Error ? error.message : String(error) };
    }
    stepDone = true;
    void watch;
    if (lostScreen && !this.stopRequested) {
      await this.pauseStep(task, runId);
      return;
    }
    // A stop in the middle leaves the step pending, so the next Start repeats it from the beginning.
    if (this.stopRequested) {
      this.store.recover(runId);
      const alive = await this.deps.cleanup(task.ade);
      if (alive.length > 0) this.problems = [`Still running after Stop: ${alive.join(", ")}. Restart the Mac.`];
      return;
    }
    this.store.finish(task.id, result.ok ? "done" : "failed", result.note, this.deps.now());
    this.deps.log(`${task.ade} ${task.step}: ${result.ok ? "done" : `failed (${result.note})`}`);
    this.report(runId, false);
    if (result.fatal === true) {
      this.problems = [`${task.ade}: ${result.note}. Restore bench/native/bin and snapshots before going on.`];
      this.stopRequested = true;
      return;
    }
    if (result.ok) return;
    // A killed child can leave the app and its agents alive, and they would land in the next app's measurement.
    // A process that survives 15 s of kills is stuck, not working: the night goes on, because each app's RAM counts
    // only its own processes, and the warning stays on the panel for the morning.
    const alive = await this.deps.cleanup(task.ade);
    if (alive.length > 0) {
      this.problems = [...this.problems, `Still running after ${task.ade} failed: ${alive.join(", ")}. Restart the Mac after the run.`];
      this.deps.log(`${task.ade}: processes still alive after cleanup: ${alive.join(", ")}; going on`);
    }
    // No repair in the middle of the night: every healthy app goes first, and this one waits at the end.
    if ((task.step === "prove" || task.step === "measure") && task.attempts === 0) {
      this.store.defer(runId, task.ade);
      return;
    }
    // A rehearsal lap, a top-up, a tokens and an orchestration step run once: a failure stays with its reason, and it
    // changes nothing in the app's other steps (ADEMARK-49). The owner's next pass runs it again.
    if (task.step === "prove") this.store.skip(runId, task.ade, ["measure"], "not proven", this.deps.now());
  }
}

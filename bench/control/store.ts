// The queue of ADEMark Control: every step of every ADE is one row, so a crash, a reboot or a stop loses nothing.
import { Database } from "bun:sqlite";

// `check` stays a name for queues written before 2026-11-10: QA runs by day now (`ademark qa`, ADEMARK-46).
export type StepName = "prove" | "measure" | "top-up" | "tokens" | "orchestration" | "rehearse" | "check";
export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";
/** The steps of a night. QA left the night on 2026-11-10: it only reads files, and it took up to 2.5 h. */
export const NIGHT_STEPS: readonly StepName[] = ["prove", "measure"];
/** The steps the panel shows for each app, in order. A top-up exists only for an app that needs one. */
export const STEPS: readonly StepName[] = ["prove", "measure", "top-up", "tokens", "orchestration", "rehearse"];
/**
 * ADEMARK-49: the steps that run after every measure and top-up of a pass, in this order. A failed one changes nothing
 * in the Track A result of its app. The riskiest goes last, so it can never cost an earlier result. A `reliability`
 * step (C2 to C6) would go after `orchestration` here, with its own folder and limit; it is not built.
 */
export const LATE_STEPS = ["tokens", "orchestration"] as const;
export type LateStep = (typeof LATE_STEPS)[number];
export const isLate = (step: StepName): step is LateStep => (LATE_STEPS as readonly StepName[]).includes(step);
/** What `fill` and the engine's own first pass add: the apps of each late step, in queue order. */
export interface LatePlan {
  tokens: readonly string[];
  orchestration: readonly string[];
}
export type RunKind = "night" | "rehearsal";
export const runKindOf = (id: string): RunKind => (id.startsWith("rehearsal-") ? "rehearsal" : "night");

export interface Task {
  id: number;
  run_id: string;
  ade: string;
  step: StepName;
  position: number;
  status: TaskStatus;
  attempts: number;
  note: string;
  started_at: string | null;
  ended_at: string | null;
  /** The attempt folder that holds this measure when Continue adopted it, null when the last attempt is the one. */
  adopted_attempt: number | null;
  /** The tests of a top-up, comma separated; null for every other step. */
  tests: string | null;
  /** 0 for what the night queued by itself, n for the n-th pass the owner started (ADEMARK-51). */
  pass: number;
}

export interface Run {
  id: string;
  seed: string;
  dry: number;
  started_at: string;
  /** A night ends when the owner closes it (Close this night, or a new night); a rehearsal when its queue drains. */
  ended_at: string | null;
  /** When the queue of a night first ran dry, top-ups included: from then on the button measures what is missing. */
  first_pass_at: string | null;
}

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, seed TEXT NOT NULL, dry INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, ade TEXT NOT NULL, step TEXT NOT NULL, position INTEGER NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
      started_at TEXT, ended_at TEXT, adopted_attempt INTEGER, tests TEXT, pass INTEGER NOT NULL DEFAULT 0,
      UNIQUE (run_id, ade, step, pass))`);
    // ADEMARK-37: a database from before adoption has no such column.
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all().map((column) => column.name);
    if (!columns.includes("adopted_attempt")) this.db.run("ALTER TABLE tasks ADD COLUMN adopted_attempt INTEGER");
    if (!columns.includes("tests")) this.db.run("ALTER TABLE tasks ADD COLUMN tests TEXT");
    const runColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(runs)").all().map((column) => column.name);
    if (!runColumns.includes("first_pass_at")) this.db.run("ALTER TABLE runs ADD COLUMN first_pass_at TEXT");
    this.addPassColumn();
  }

  // ADEMARK-51: a later top-up of the same app is a new row, one for each pass. SQLite cannot change a UNIQUE key in
  // place, so the table is copied once, ids and all, inside one write lock: a second process waits and then sees it done.
  private addPassColumn(): void {
    const has = (): boolean => this.db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all().some((column) => column.name === "pass");
    if (has()) return;
    this.db.transaction(() => {
      if (has()) return;
      this.db.run(`CREATE TABLE tasks_next (
        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, ade TEXT NOT NULL, step TEXT NOT NULL, position INTEGER NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
        started_at TEXT, ended_at TEXT, adopted_attempt INTEGER, tests TEXT, pass INTEGER NOT NULL DEFAULT 0,
        UNIQUE (run_id, ade, step, pass))`);
      this.db.run(`INSERT INTO tasks_next (id, run_id, ade, step, position, status, attempts, note, started_at, ended_at, adopted_attempt, tests, pass)
        SELECT id, run_id, ade, step, position, status, attempts, note, started_at, ended_at, adopted_attempt, tests, 0 FROM tasks`);
      this.db.run("DROP TABLE tasks");
      this.db.run("ALTER TABLE tasks_next RENAME TO tasks");
    }).immediate();
  }

  /** A night proves and measures each ADE. A rehearsal (`rehearsal-<time>`) has one `rehearse` step per ADE. */
  createRun(id: string, seed: string, ades: readonly string[], dry: boolean, now: string, steps?: readonly StepName[]): void {
    const wanted = steps ?? (runKindOf(id) === "rehearsal" ? ["rehearse"] : NIGHT_STEPS);
    this.db.transaction(() => {
      this.db.run("INSERT INTO runs (id, seed, dry, started_at) VALUES (?, ?, ?, ?)", [id, seed, dry ? 1 : 0, now]);
      let position = 0;
      const add = (ade: string, step: StepName): void => {
        if (!wanted.includes(step)) return;
        this.db.run("INSERT INTO tasks (run_id, ade, step, position, status) VALUES (?, ?, ?, ?, 'pending')", [id, ade, step, position++]);
      };
      for (const ade of ades) {
        add(ade, "prove");
        add(ade, "measure");
        add(ade, "rehearse");
      }
      for (const ade of ades) add(ade, "check");
    })();
  }

  /** The newest run, or the newest of one kind: a rehearsal never continues a night, and a night never a rehearsal. */
  latestRun(kind?: RunKind): Run | null {
    const runs = this.db.query<Run, []>("SELECT * FROM runs ORDER BY started_at DESC, rowid DESC").all();
    return runs.find((run) => kind === undefined || runKindOf(run.id) === kind) ?? null;
  }

  latestRunById(id: string): Run | null {
    return this.db.query<Run, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
  }

  /** The newest run that has not ended, of any kind: what the watchdog's Continue goes on with. */
  openRun(): Run | null {
    return this.db.query<Run, []>("SELECT * FROM runs WHERE ended_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1").get();
  }

  /**
   * One top-up per app and pass: the UNIQUE key makes a second one in the same pass impossible. False when it exists.
   * Its attempt count starts where the app's last top-up stopped, so its folder takes the next number (`topup-<n>`).
   */
  addTopUp(runId: string, ade: string, tests: readonly string[], pass = 0): boolean {
    const last = this.db.query<{ top: number }, [string]>("SELECT MAX(position) AS top FROM tasks WHERE run_id = ?").get(runId)?.top ?? 0;
    const base = this.db.query<{ top: number | null }, [string, string]>("SELECT MAX(attempts) AS top FROM tasks WHERE run_id = ? AND ade = ? AND step = 'top-up'").get(runId, ade)?.top ?? 0;
    return this.db.run("INSERT OR IGNORE INTO tasks (run_id, ade, step, position, status, tests, attempts, pass) VALUES (?, ?, 'top-up', ?, 'pending', ?, ?, ?)",
      [runId, ade, last + 1, tests.join(","), base, pass]).changes > 0;
  }

  /** The queue of a night ran dry once. Set once: a later pass never moves it. */
  markFirstPass(runId: string, now: string): void {
    this.db.run("UPDATE runs SET first_pass_at = ? WHERE id = ? AND first_pass_at IS NULL", [now, runId]);
  }

  /**
   * ADEMARK-51, the owner's pass: each app of `measure` is measured again in full with its attempt count kept (a failed
   * proof of it comes back too), or for the first time when the run has no step of it, and each app of `topUps` gets a top-up of the next pass. An app whose top-up still waits
   * in the queue gets no second one. Returns the pass number.
   */
  fill(runId: string, measure: readonly string[], topUps: readonly { ade: string; tests: readonly string[] }[], late: LatePlan = { tokens: [], orchestration: [] }): number {
    let pass = 0;
    this.db.transaction(() => {
      pass = (this.db.query<{ top: number | null }, [string]>("SELECT MAX(pass) AS top FROM tasks WHERE run_id = ?").get(runId)?.top ?? 0) + 1;
      for (const ade of measure) {
        // An app that joined the measured list after this night began (Capy and Superset, 2026-11-11) has no step yet:
        // it gets its proof and its measure at the end of the queue, in this pass.
        if (!this.tasks(runId).some((task) => task.ade === ade && (task.step === "prove" || task.step === "measure"))) {
          const last = this.db.query<{ top: number | null }, [string]>("SELECT MAX(position) AS top FROM tasks WHERE run_id = ?").get(runId)?.top ?? 0;
          for (const [index, step] of (["prove", "measure"] as const).entries()) {
            this.db.run("INSERT INTO tasks (run_id, ade, step, position, status, pass) VALUES (?, ?, ?, ?, 'pending', ?)", [runId, ade, step, last + 1 + index, pass]);
          }
          continue;
        }
        this.db.run(`UPDATE tasks SET status = 'pending', note = '', started_at = NULL, ended_at = NULL
          WHERE run_id = ? AND ade = ? AND step IN ('prove', 'measure') AND status IN ('pending', 'failed', 'skipped')`, [runId, ade]);
      }
      for (const entry of topUps) {
        const waiting = this.tasks(runId).some((task) => task.ade === entry.ade && task.step === "top-up" && (task.status === "pending" || task.status === "running"));
        if (!waiting && entry.tests.length > 0) this.addTopUp(runId, entry.ade, entry.tests, pass);
      }
      this.addLateSteps(runId, late, pass);
    })();
    return pass;
  }

  /**
   * ADEMARK-49: one tokens or orchestration step per app and pass, as a new row; the UNIQUE key makes a second one in the
   * same pass impossible, so the engine's own first pass may call this again after a restart. An app whose step still
   * waits gets no second one. The attempt count starts where the app's last step of that kind stopped, so its folder takes
   * the next number (`tokens-<n>`, `orchestration-<n>`). Returns how many steps it added.
   */
  addLateSteps(runId: string, late: LatePlan, pass: number): number {
    let added = 0;
    for (const step of LATE_STEPS) {
      for (const ade of late[step]) {
        const mine = this.tasks(runId).filter((task) => task.ade === ade && task.step === step);
        if (mine.some((task) => task.status === "pending" || task.status === "running")) continue;
        const last = this.db.query<{ top: number | null }, [string]>("SELECT MAX(position) AS top FROM tasks WHERE run_id = ?").get(runId)?.top ?? 0;
        const base = Math.max(0, ...mine.map((task) => task.attempts));
        added += this.db.run("INSERT OR IGNORE INTO tasks (run_id, ade, step, position, status, attempts, pass) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
          [runId, ade, step, last + 1, base, pass]).changes;
      }
    }
    return added;
  }

  /** The late steps that wait, skipped with the reason. They never ran: no attempt is counted. */
  skipLate(runId: string, note: string, now: string): number {
    return this.db.run(`UPDATE tasks SET status = 'skipped', note = ?, ended_at = ? WHERE run_id = ? AND status = 'pending' AND step IN ('tokens', 'orchestration')`,
      [note, now, runId]).changes;
  }

  tasks(runId: string): Task[] {
    return this.db.query<Task, [string]>("SELECT * FROM tasks WHERE run_id = ? ORDER BY position").all(runId);
  }

  /**
   * Proofs, measures and top-ups first, by position; then every tokens step, then every orchestration step (ADEMARK-49).
   * A measure deferred to the end of the queue still runs before any late step. Checks of an old queue come last; the
   * engine skips them, because QA runs by day.
   */
  next(runId: string): Task | null {
    return this.db.query<Task, [string]>(`SELECT * FROM tasks WHERE run_id = ? AND status = 'pending'
      ORDER BY CASE step WHEN 'tokens' THEN 1 WHEN 'orchestration' THEN 2 WHEN 'check' THEN 3 ELSE 0 END, position LIMIT 1`).get(runId);
  }

  /** A task that was running when the process died starts again: its half-done work is never counted. */
  recover(runId: string): number {
    return this.db.run("UPDATE tasks SET status = 'pending', started_at = NULL WHERE run_id = ? AND status = 'running'", [runId]).changes;
  }

  /** Running tasks, so recovery can look at what each one left on disk before it starts them again. */
  running(runId: string): Task[] {
    return this.db.query<Task, [string]>("SELECT * FROM tasks WHERE run_id = ? AND status = 'running' ORDER BY position").all(runId);
  }

  start(id: number, now: string): void {
    this.db.run("UPDATE tasks SET status = 'running', attempts = attempts + 1, adopted_attempt = NULL, started_at = ?, ended_at = NULL WHERE id = ?", [now, id]);
  }

  /** A measure that finished before Control died: done with the folder of that attempt, and nothing measured again. */
  adopt(id: number, attempt: number, note: string, now: string): void {
    this.db.run("UPDATE tasks SET status = 'done', adopted_attempt = ?, note = ?, ended_at = ? WHERE id = ?", [attempt, note, now, id]);
  }

  /** A step cut because the account left the screen was not an attempt of the app: it goes back with its count. */
  release(id: number): void {
    this.db.run("UPDATE tasks SET status = 'pending', attempts = MAX(attempts - 1, 0), started_at = NULL, ended_at = NULL WHERE id = ?", [id]);
  }

  finish(id: number, status: TaskStatus, note: string, now: string): void {
    this.db.run("UPDATE tasks SET status = ?, note = ?, ended_at = ? WHERE id = ?", [status, note, now, id]);
  }

  skip(runId: string, ade: string, steps: readonly StepName[], note: string, now: string): void {
    for (const step of steps) {
      this.db.run("UPDATE tasks SET status = 'skipped', note = ?, ended_at = ? WHERE run_id = ? AND ade = ? AND step = ? AND status = 'pending'", [note, now, runId, ade, step]);
    }
  }

  /** Healthy apps get measured first: this one comes back at the end, when Claude may repair it. */
  defer(runId: string, ade: string): void {
    const last = this.db.query<{ top: number }, [string]>("SELECT MAX(position) AS top FROM tasks WHERE run_id = ?").get(runId)?.top ?? 0;
    // A tokens or orchestration step keeps its place and status: a failed measure must not send a done one back (ADEMARK-49).
    const mine = this.tasks(runId).filter((task) => task.ade === ade && !isLate(task.step));
    mine.forEach((task, index) => {
      this.db.run("UPDATE tasks SET position = ?, status = 'pending', started_at = NULL, ended_at = NULL WHERE id = ?", [last + 1 + index, task.id]);
    });
  }

  /**
   * A retry sends this ADE's failed and skipped steps back. A QA verdict never starts a measurement (ADEMARK-46), and a
   * top-up, a tokens or an orchestration step never comes back: a later one exists only through the owner's pass
   * (ADEMARK-47, ADEMARK-51, ADEMARK-49).
   */
  retry(runId: string, ade: string): void {
    this.db.run(`UPDATE tasks SET status = 'pending', note = '', started_at = NULL, ended_at = NULL
      WHERE run_id = ? AND ade = ? AND status IN ('failed', 'skipped') AND step NOT IN ('check', 'top-up', 'tokens', 'orchestration')`, [runId, ade]);
  }

  endRun(id: string, now: string): void {
    this.db.run("UPDATE runs SET ended_at = ? WHERE id = ?", [now, id]);
  }

  reopenRun(id: string): void {
    this.db.run("UPDATE runs SET ended_at = NULL WHERE id = ?", [id]);
  }

  close(): void {
    this.db.close();
  }
}

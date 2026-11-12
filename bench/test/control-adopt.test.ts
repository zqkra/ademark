// ADEMARK-37: Continue adopts a measure that finished before Control died, and never a folder without proof of it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishedAttempt } from "../control/adopt.ts";
import { Engine, type EngineDeps } from "../control/engine.ts";
import { Store } from "../control/store.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-adopt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const folder = (attempt: number): string => join(dir, `run-bare-cli-${attempt}`);

// What the run loop leaves: rows.jsonl, and a marker per finished block (bare-cli Track A, agent claude).
function made(attempt: number, o: { rows: number; marker: boolean }): void {
  const path = folder(attempt);
  mkdirSync(join(path, "bare-cli-claude"), { recursive: true });
  writeFileSync(join(path, "rows.jsonl"), Array.from({ length: o.rows }, (_, i) => JSON.stringify({ i })).join("\n") + (o.rows > 0 ? "\n" : ""));
  if (o.marker) writeFileSync(join(path, "bare-cli-claude", "A-claude.done"), "");
}

const find = (attempts: number, only?: number) =>
  finishedAttempt({ ade: "bare-cli", attempts, only, tracks: ["A"], agents: ["claude", "own"], dirOf: folder });

describe("finishedAttempt", () => {
  test("adopts a folder with every marker and rows", () => {
    made(1, { rows: 89, marker: true });
    expect(find(1)).toEqual({ attempt: 1, rows: 89 });
  });

  test("never a folder with a missing marker", () => {
    made(1, { rows: 89, marker: false });
    expect(find(1)).toBeNull();
  });

  test("never a folder with 0 rows", () => {
    made(1, { rows: 0, marker: true });
    expect(find(1)).toBeNull();
  });

  test("two attempts where only the older is complete: the older", () => {
    made(1, { rows: 89, marker: true });
    made(2, { rows: 0, marker: false });
    expect(find(2)).toEqual({ attempt: 1, rows: 89 });
  });

  test("the newest complete attempt wins", () => {
    made(1, { rows: 10, marker: true });
    made(2, { rows: 20, marker: true });
    expect(find(2)).toEqual({ attempt: 2, rows: 20 });
  });

  test("a block of another requested track without its marker blocks the adoption", () => {
    made(1, { rows: 89, marker: true });
    expect(finishedAttempt({ ade: "bare-cli", attempts: 1, tracks: ["A", "B"], agents: ["claude", "own"], dirOf: folder })).toBeNull();
  });

  test("only looks at the attempt asked for", () => {
    made(1, { rows: 89, marker: true });
    expect(find(2, 2)).toBeNull();
  });
});

function engineDeps(log: string[], over: Partial<EngineDeps> = {}): EngineDeps {
  const ok = (name: string) => async (ade: string, _run: string, ...rest: unknown[]) => {
    log.push(`${name} ${ade} ${rest.join(" ")}`.trim());
    return { ok: true, note: "" };
  };
  return {
    now: () => "2026-11-10T00:00:00.000Z",
    log: () => {},
    settle: async () => {},
    preflight: async () => [],
    machineOn: () => {},
    machineOff: () => {},
    prove: ok("prove"),
    measure: async (ade, _run, _seed, attempt) => {
      log.push(`measure ${ade} ${attempt}`);
      return { ok: true, note: "" };
    },
    rehearse: async () => ({ ok: true, note: "" }),
    topUpTests: async (ade, _run, attempt) => {
      log.push(`top-up plan ${ade} ${attempt}`);
      return { tests: [], note: "" };
    },
    topUp: async () => ({ ok: true, note: "" }),
    // ADEMARK-49: no tokens or orchestration step in these tests.
    tokens: async () => ({ ok: true, note: "" }),
    orchestration: async () => ({ ok: true, note: "" }),
    latePlan: () => ({ tokens: [], orchestration: [] }),
    modelAnswers: async () => true,
    report: () => {},
    abort: () => {},
    cleanup: async () => [],
    resume: () => {},
    screen: async () => "on",
    sleep: () => new Promise((done) => setTimeout(done, 0)),
    finishedAttempt: (ade, _run, attempts, only) =>
      finishedAttempt({ ade, attempts, only, tracks: ["A"], agents: ["claude", "own"], dirOf: folder }),
    ...over,
  };
}

describe("recovery", () => {
  // The state of 2026-11-09 08:34: Bare CLI's measure running at attempt 2, attempt 1 complete on disk.
  function crashedRun(store: Store): void {
    store.createRun("run", "seed", ["bare-cli"], false, "2026-11-09T04:18:06.182Z");
    const tasks = store.tasks("run");
    const measure = tasks.find((task) => task.step === "measure")!;
    store.start(tasks.find((task) => task.step === "prove")!.id, "t");
    store.finish(tasks.find((task) => task.step === "prove")!.id, "done", "", "t");
    store.start(measure.id, "t");
    store.start(measure.id, "t");
  }

  test("a running measure with a finished folder is done, nothing is measured again, the top-up plan reads that folder", async () => {
    const store = new Store(join(dir, "control.sqlite"));
    crashedRun(store);
    made(1, { rows: 89, marker: true });
    made(2, { rows: 0, marker: false });
    const log: string[] = [];
    await new Engine(store, engineDeps(log)).run("run", "seed");
    const measure = store.tasks("run").find((task) => task.step === "measure")!;
    expect(measure.status).toBe("done");
    expect(measure.adopted_attempt).toBe(1);
    expect(measure.attempts).toBe(2);
    expect(log).toEqual(["top-up plan bare-cli 1"]);
    store.close();
  });

  test("a running measure with no finished folder runs again in a new folder", async () => {
    const store = new Store(join(dir, "control.sqlite"));
    crashedRun(store);
    made(1, { rows: 0, marker: true });
    const log: string[] = [];
    await new Engine(store, engineDeps(log)).run("run", "seed");
    expect(log).toEqual(["measure bare-cli 3", "top-up plan bare-cli 3"]);
    expect(store.tasks("run").find((task) => task.step === "measure")!.adopted_attempt).toBeNull();
    store.close();
  });

  test("a database from before adoption gets the column", () => {
    const path = join(dir, "old.sqlite");
    const db = new Database(path, { create: true });
    db.run(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, ade TEXT NOT NULL, step TEXT NOT NULL,
      position INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
      started_at TEXT, ended_at TEXT, UNIQUE (run_id, ade, step))`);
    db.run("INSERT INTO tasks (run_id, ade, step, position, status, attempts) VALUES ('r', 'a', 'measure', 0, 'running', 2)");
    db.close();
    const store = new Store(path);
    expect(store.tasks("r")[0]!.adopted_attempt).toBeNull();
    store.close();
    new Store(path).close();
  });
});

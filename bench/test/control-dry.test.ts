// ADEMARK-44, 46 and 47 with the dry instruments: the real Control server and the real `run` children, no app.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDayReport } from "../control/day.ts";
import { realEngineDeps } from "../control/real.ts";
import type { EngineDeps } from "../control/engine.ts";
import { refuseRehearsal } from "../control/report.ts";
import { parseSmokeRepeats } from "../run/smoke.ts";
import { repoRoot } from "../core/paths.ts";

let dir: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-dry-"));
  for (const name of ["ADEMARK_RESULTS", "ADEMARK_PROGRESS"]) saved[name] = process.env[name];
  process.env.ADEMARK_RESULTS = dir;
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

interface State {
  state: string;
  finished: boolean;
  passOver: boolean;
  complete: boolean;
  missing: { line: string; error: string | null } | null;
  kind: string;
  run_id: string | null;
  qa: string;
  newTotal: number;
  ades: { id: string; steps: { step: string; status: string; note: string }[]; marks: { fresh: number; accepted: number; setAside: string[] } }[];
}

async function control(ades: string[], over: (deps: EngineDeps) => Partial<EngineDeps> = () => ({})) {
  const { startControl } = await import("../control/server.ts");
  // The real dry steps; only the session reader is fixed, so the test runs in any account.
  const handle = startControl({ dry: true, port: 0, ades, deps: (log) => {
    const real = { ...realEngineDeps(log, true), screen: async () => "on" as const };
    return { ...real, ...over(real) };
  } });
  const post = (path: string, body: unknown = {}) =>
    fetch(`${handle.url}${path}`, { method: "POST", headers: { "x-ademark": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  const state = async (): Promise<State> => (await (await fetch(`${handle.url}/api/state`)).json()) as State;
  const finished = async (): Promise<State> => {
    for (let i = 0; i < 1200; i++) {
      const now = await state();
      if (now.finished && (now.state === "idle" || now.state === "blocked")) return now;
      await Bun.sleep(50);
    }
    throw new Error("the run never finished");
  };
  return { handle, post, state, finished };
}

const rowsOf = (path: string) => readFileSync(join(path, "rows.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { test_id: string; rep: number; notes: string });

describe("rehearsal, dry", () => {
  test("a lap of 2 apps writes rehearsal.md with each app and test, its time, and what changed", async () => {
    const c = await control(["bare-cli", "orca"]);
    await c.post("/api/rehearse");
    const first = await c.finished();
    expect(first.kind).toBe("rehearsal");
    expect(first.run_id).toMatch(/^rehearsal-\d{4}-\d\d-\d\dT/);
    expect(first.ades.map((ade) => ade.steps.map((step) => `${step.step} ${step.status}`))).toEqual([["rehearse done"], ["rehearse done"]]);
    const runDir = join(dir, `${first.run_id}-dry`);
    const report = readFileSync(join(runDir, "rehearsal.md"), "utf8");
    // Dry A4 has no replay request: 3 invalid rows per app, none an accepted limit.
    expect(report.split("\n")[0]).toBe("6 invalid rows that are not accepted limits (NEW)");
    expect(first.newTotal).toBe(6);
    expect(report).toContain("## Bare CLI (bare-cli)");
    expect(report).toContain("## Orca (orca)");
    expect(report).toContain("| A4 | invalid (NEW): no replay request |");
    expect(report).toContain("| A11 | valid |");
    expect(report).toMatch(/- time: \d+ min/);
    expect(report).toContain("## Changed since the last rehearsal\n\nNo earlier rehearsal to compare with.");
    // The lap records the code it ran on, for the line at Start (review R2).
    const lapFile = JSON.parse(readFileSync(join(runDir, "rehearsal.json"), "utf8")) as { ended: boolean; commit: string; inputs: string };
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
    expect(lapFile.ended).toBe(true);
    expect(lapFile.commit).toBe(head);
    expect(lapFile.inputs.length).toBeGreaterThan(10);
    // A1 and A2 ran 3 repetitions, every other test 1; every row says smoke. Orca's A3 is one excluded row (ADEMARK-53).
    const orca = rowsOf(join(dir, `${first.run_id}-orca-1-dry-smoke`));
    const repsOf = (id: string) => new Set(orca.filter((entry) => entry.test_id === id).map((entry) => entry.rep)).size;
    expect([repsOf("A1"), repsOf("A2"), repsOf("A3"), repsOf("A5"), repsOf("A9")]).toEqual([3, 3, 1, 1, 1]);
    expect(orca.find((entry) => entry.test_id === "A3")?.invalid_reason).toStartWith("not supported here: cmd+alt+t opens a shell tab");
    expect(orca.every((entry) => entry.notes.startsWith("dry run; smoke"))).toBe(true);

    await Bun.sleep(1100);
    await c.post("/api/rehearse", { ades: ["orca"] });
    const second = await c.finished();
    expect(second.run_id).not.toBe(first.run_id);
    const again = readFileSync(join(dir, `${second.run_id}-dry`, "rehearsal.md"), "utf8");
    expect(again.split("\n")[0]).toBe("3 invalid rows that are not accepted limits (NEW)");
    // Only orca ran, so Bare CLI is not reported as gone.
    expect(again).toContain("## Changed since the last rehearsal\n\nNothing changed.");
    await c.handle.stop();
  }, 60_000);

  test("a lap limited to some apps runs those only, and an unknown app is refused", async () => {
    const c = await control(["bare-cli", "orca", "paseo"]);
    expect((await c.post("/api/rehearse", { ades: ["nope"] })).status).toBe(400);
    await c.post("/api/rehearse", { ades: ["paseo"] });
    const done = await c.finished();
    expect(done.ades.map((ade) => ade.id)).toEqual(["paseo"]);
    expect(readdirSync(dir).filter((name) => name.endsWith("-smoke"))).toEqual([`${done.run_id}-paseo-1-dry-smoke`]);
    await c.handle.stop();
  }, 60_000);

  test("smoke rows never count: the report and publishing refuse a rehearsal, and Start begins a night of its own", async () => {
    const c = await control(["orca"]);
    await c.post("/api/rehearse");
    const lap = await c.finished();
    const smoke = join(dir, `${lap.run_id}-orca-1-dry-smoke`);
    expect(() => refuseRehearsal(lap.run_id!)).toThrow("smoke rows are never a measurement");
    expect(() => refuseRehearsal("control-x", [smoke])).toThrow("smoke folder");
    await expect(writeDayReport({ root: dir, runId: lap.run_id!, ades: ["orca"] })).rejects.toThrow("rehearsal");
    const cli = Bun.spawnSync(["bun", "bench/cli.ts", "report", "--run", lap.run_id!], { cwd: repoRoot, env: { ...process.env, ADEMARK_RESULTS: dir } });
    expect(cli.exitCode).toBe(2);
    expect(cli.stderr.toString()).toContain("rehearsal");
    await c.post("/api/start");
    const night = await c.finished();
    expect(night.kind).toBe("night");
    expect(night.run_id).toMatch(/^control-/);
    await c.handle.stop();
  }, 60_000);
});

describe("night, dry", () => {
  test("no check at night, and one app with one failing test gets a top-up of that test only", async () => {
    const c = await control(["orca"]);
    await c.post("/api/start");
    const night = await c.finished();
    expect(night.qa).toBe("QA: run by day");
    expect(night.ades[0]!.steps.map((step) => `${step.step} ${step.status}`)).toEqual(["prove done", "measure done", "top-up done", "tokens done", "orchestration done"]);
    const { Store } = await import("../control/store.ts");
    const { controlFiles } = await import("../control/files.ts");
    await c.handle.stop();
    const store = new Store(controlFiles(true, dir).database);
    const tasks = store.tasks(night.run_id!);
    store.close();
    // ADEMARK-49: Orca has an orchestration trigger, so it gets both late steps, after its top-up.
    expect(tasks.map((task) => task.step)).toEqual(["prove", "measure", "top-up", "tokens", "orchestration"]);
    // Dry A4 has no replay request; every other test is valid in a dry run.
    expect(tasks.find((task) => task.step === "top-up")?.tests).toBe("A4");
    const topUp = rowsOf(join(dir, `${night.run_id}-orca-topup-1-dry`));
    expect([...new Set(topUp.map((entry) => entry.test_id))]).toEqual(["A4"]);
    const report = readFileSync(join(dir, `${night.run_id}-dry`, "report.md"), "utf8");
    // Dry instruments capture no model request, so the dry B rows are invalid with that reason (ADEMARK-49): 9 rows of
    // Track A and 33 of Track B. One of the 33 is B4 `obeyed`, invalid with `no session log` since b0fae10 (a dry run
    // writes no session log; before that fix the row was valid with no value). The dry C1 rows of Orca are valid.
    expect(report.split("\n")[0]).toBe("42 invalid rows that are not accepted limits (NEW)");
    expect(report).toContain("| B4 | tokens 1 | invalid (NEW): no session log |");
    expect(report).toContain("| A4 | top-up 1 | invalid (NEW): no replay request |");
    expect(report).toContain(`### Track B (tokens)\n\n- tokens 1: ${night.run_id}-orca-tokens-1-dry`);
    expect(report).toContain("| B1 | tokens 1 | invalid (NEW): no main-thread request captured |");
    expect(report).toContain(`### Track C (orchestration, C1)\n\n- orchestration 1: ${night.run_id}-orca-orchestration-1-dry`);
    expect(report).toContain("| A5 | attempt 1 | valid |");
    expect(night.ades[0]!.marks).toEqual({ fresh: 9, accepted: 0, setAside: [] });
  }, 60_000);
});

describe("measure what is missing, dry", () => {
  // ADEMARK-51. Until the "fix by day", Paseo's measure fails, and Bare CLI's night top-up of A5 (a test that wrote no
  // row) fails too. After it, one pass measures Paseo in full and gives Bare CLI a second top-up; then nothing is missing.
  test("a night with a failed app and a short test, a pass that fills both, then no button", async () => {
    let fixed = false;
    const c = await control(["bare-cli", "paseo"], (real) => ({
      measure: async (ade, runId, seed, attempt, repair) => {
        if (ade === "paseo" && !fixed) return { ok: false, note: "exit 1" };
        const result = await real.measure(ade, runId, seed, attempt, repair);
        // Dry A4 has no replay request and stops at 3 of its 6 repetitions in every dry run. Here it gets 6 valid ones, so
        // a dry night can end complete. A5 wrote no row in Bare CLI's first attempt: one test under its minimum.
        const path = join(dir, `${runId}-${ade}-${attempt}-dry`, "rows.jsonl");
        const rows = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as { test_id: string; rep: number; valid: boolean; invalid_reason: string | null });
        const a4 = rows.filter((entry) => entry.test_id === "A4").map((entry) => ({ ...entry, valid: true, invalid_reason: null }));
        const kept = [...rows.filter((entry) => entry.test_id !== "A4" && (ade !== "bare-cli" || entry.test_id !== "A5")), ...a4, ...a4.map((entry) => ({ ...entry, rep: entry.rep + 3 }))];
        writeFileSync(path, kept.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
        return result;
      },
      topUp: async (ade, runId, seed, tests, attempt, first) => {
        if (!fixed) return { ok: false, note: "exit 1, 0 rows" };
        return await real.topUp(ade, runId, seed, tests, attempt, first);
      },
    }));
    await c.post("/api/start");
    let now = await c.finished();
    for (let i = 0; i < 200 && now.missing === null; i++) {
      await Bun.sleep(50);
      now = await c.state();
    }
    expect(now.passOver).toBe(true);
    expect(now.complete).toBe(false);
    expect(now.missing?.line).toBe("Paseo: all tests. Bare CLI: A5.");
    // Start after the first pass never measures a whole night again: before the fix, the pass fails as the night did.
    fixed = true;
    await c.post("/api/fill");
    await Bun.sleep(100);
    now = await c.finished();
    for (let i = 0; i < 200 && (now.missing === null || now.missing.line !== ""); i++) {
      await Bun.sleep(50);
      now = await c.state();
    }
    expect(now.missing).toEqual({ line: "", error: null, measure: [], topUps: [], tokens: [], orchestration: [] } as never);
    expect(now.complete).toBe(true);
    const { Store } = await import("../control/store.ts");
    const { controlFiles } = await import("../control/files.ts");
    // Close this night ends it and starts nothing.
    await c.post("/api/close");
    const closed = await c.state();
    expect(closed.state).toBe("idle");
    await c.handle.stop();
    const store = new Store(controlFiles(true, dir).database);
    const tasks = store.tasks(now.run_id!);
    const run = store.latestRun("night");
    store.close();
    expect(run?.ended_at).not.toBeNull();
    // ADEMARK-49: Paseo's tokens ran in the night's own first pass although its measure failed: Track B is apart from A.
    // Paseo has no orchestration (a null trigger), so it gets no orchestration step.
    expect(tasks.filter((task) => task.ade === "paseo").map((task) => `${task.step} ${task.status} ${task.attempts}`)).toEqual(["prove done 2", "measure done 3", "tokens done 1"]);
    expect(tasks.filter((task) => task.ade === "bare-cli").map((task) => `${task.step} ${task.pass} ${task.status}`))
      .toEqual(["prove 0 done", "measure 0 done", "top-up 0 failed", "tokens 0 done", "orchestration 0 done", "top-up 1 done"]);
    // In the first pass every late step started after its top-up, which ran after every measure of that pass. (Paseo's
    // measure row ran again in pass 1, in place, so its times are of pass 1.)
    const firstPass = tasks.filter((task) => task.pass === 0);
    const lastEarly = Date.parse(firstPass.find((task) => task.step === "top-up")!.ended_at!);
    const firstLate = Math.min(...firstPass.filter((task) => task.step === "tokens" || task.step === "orchestration").map((task) => Date.parse(task.started_at!)));
    expect(firstLate).toBeGreaterThanOrEqual(lastEarly);
    const order = firstPass.filter((task) => task.step === "tokens" || task.step === "orchestration").sort((a, b) => Date.parse(a.started_at!) - Date.parse(b.started_at!))
      .map((task) => `${task.step} ${task.ade}`);
    expect(order.slice(0, 2).every((entry) => entry.startsWith("tokens"))).toBe(true);
    expect(order.at(-1)).toBe("orchestration bare-cli");
    expect(tasks.filter((task) => task.ade === "bare-cli" && task.step === "top-up").map((task) => `${task.pass} ${task.status} ${task.attempts} ${task.tests}`))
      .toEqual(["0 failed 1 A5", "1 done 2 A5"]);
    const report = readFileSync(join(dir, `${now.run_id}-dry`, "report.md"), "utf8");
    expect(report).toContain("| A5 (bare-cli-claude) | top-up 2 | valid |");
    expect(report).toContain("- top-up 2: ");
  }, 120_000);
});

describe("progress file", () => {
  // Review R3, 2026-11-10: a dry Control in the `ademark` account wrote control-progress.json, the file of a real night.
  test("a dry Control and its children write only the dry progress file", async () => {
    const c = await control(["orca"]);
    expect(process.env.ADEMARK_PROGRESS).toBe(join(dir, "control-dry-progress.json"));
    await c.post("/api/rehearse");
    await c.finished();
    await c.handle.stop();
    expect(existsSync(join(dir, "control-dry-progress.json"))).toBe(true);
    expect(existsSync(join(dir, "control-progress.json"))).toBe(false);
  }, 60_000);
});

describe("run options", () => {
  test("--smoke-reps sets the repetitions of some tests and needs --smoke", () => {
    expect(parseSmokeRepeats("A1=3,A2=3,A3=3")).toEqual({ A1: 3, A2: 3, A3: 3 });
    expect(parseSmokeRepeats("A1=0")).toBeNull();
    expect(parseSmokeRepeats("A1")).toBeNull();
    const refused = Bun.spawnSync(["bun", "bench/cli.ts", "run", "--ade", "orca", "--tracks", "A", "--dry-run", "--smoke-reps", "A1=3"], { cwd: repoRoot, env: { ...process.env, ADEMARK_RESULTS: dir } });
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr.toString()).toContain("--smoke-reps needs --smoke");
  });

  test("a top-up of A11 alone still gets the seed threads of its block", () => {
    const run = Bun.spawnSync(["bun", "bench/cli.ts", "run", "--ade", "orca", "--tracks", "A", "--dry-run", "--tests", "A11", "--run-id", "seeds"], { cwd: repoRoot, env: { ...process.env, ADEMARK_RESULTS: dir } });
    expect(run.exitCode).toBe(0);
    const out = run.stdout.toString();
    const firstA11 = out.indexOf("A11");
    const seedsBefore = out.slice(0, firstA11 === -1 ? out.length : firstA11).split("text=replay:seed").length - 1;
    // 5 seed threads of the block, then A11 builds its own short and long threads.
    expect(seedsBefore).toBeGreaterThanOrEqual(5);
    expect(existsSync(join(dir, "seeds-dry", "rows.jsonl"))).toBe(true);
  });
});

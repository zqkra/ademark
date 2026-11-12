// ADEMARK-35 and 36 through the real server: the log file, the heartbeat with its intent, Continue, a new run, and a
// second Control that opens the first.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineDeps } from "../control/engine.ts";
import { controlFiles, readHeartbeat } from "../control/files.ts";
import { Store } from "../control/store.ts";

let dir: string;
let before: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-server-"));
  before = process.env.ADEMARK_RESULTS;
  process.env.ADEMARK_RESULTS = dir;
});
afterEach(() => {
  if (before === undefined) delete process.env.ADEMARK_RESULTS;
  else process.env.ADEMARK_RESULTS = before;
  rmSync(dir, { recursive: true, force: true });
});

function fakeDeps(measured: string[], hold?: Promise<void>): (log: (line: string) => void) => EngineDeps {
  return (log) => ({
    now: () => new Date().toISOString(),
    log,
    settle: async () => {},
    preflight: async () => [],
    machineOn: () => {},
    machineOff: () => {},
    prove: async () => ({ ok: true, note: "" }),
    measure: async (ade, runId) => {
      measured.push(`${runId} ${ade}`);
      await hold;
      return { ok: true, note: "" };
    },
    rehearse: async (ade, runId) => {
      measured.push(`${runId} ${ade}`);
      return { ok: true, note: "" };
    },
    topUpTests: async () => ({ tests: [], note: "" }),
    topUp: async () => ({ ok: true, note: "" }),
    report: () => {},
    abort: () => {},
    cleanup: async () => [],
    resume: () => {},
    screen: async () => "on",
    sleep: (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 5))),
    finishedAttempt: () => null,
    // ADEMARK-49: these tests plan no tokens or orchestration step; bench/test/control-late.test.ts does.
    tokens: async () => ({ ok: true, note: "" }),
    orchestration: async () => ({ ok: true, note: "" }),
    latePlan: () => ({ tokens: [], orchestration: [] }),
    modelAnswers: async () => true,
  });
}

const settle = async (url: string, wanted: (state: { state: string; finished: boolean }) => boolean): Promise<void> => {
  for (let i = 0; i < 500; i++) {
    if (wanted((await (await fetch(`${url}/api/state`)).json()) as { state: string; finished: boolean })) return;
    await Bun.sleep(5);
  }
  throw new Error("the server never reached the state");
};
const post = (url: string, path: string) => fetch(`${url}${path}`, { method: "POST", headers: { "x-ademark": "1" }, body: "{}" });

describe("Control server", () => {
  test("the panel's Now line reads the progress file of its own kind", async () => {
    const { startControl } = await import("../control/server.ts");
    const { writeFileSync } = await import("node:fs");
    let release = (): void => {};
    const hold = new Promise<void>((done) => {
      release = done;
    });
    const control = startControl({ dry: true, port: 0, ades: ["a"], deps: fakeDeps([], hold) });
    await post(control.url, "/api/start");
    await settle(control.url, (s) => s.state === "working");
    const at = new Date(Date.now() + 1000).toISOString();
    writeFileSync(controlFiles(false, dir).progress, JSON.stringify({ ade: "a", stage: "test", test: "A9", rep: 1, at }));
    const progress = async () => ((await (await fetch(`${control.url}/api/state`)).json()) as { current: { progress: { test: string } | null } }).current.progress;
    expect(await progress()).toBeNull();
    writeFileSync(controlFiles(true, dir).progress, JSON.stringify({ ade: "a", stage: "test", test: "A5", rep: 1, at }));
    expect((await progress())?.test).toBe("A5");
    release();
    await settle(control.url, (s) => s.finished);
    await control.stop();
  });

  test("writes control.log and a heartbeat whose intent follows Start and the end of the run", async () => {
    const { startControl } = await import("../control/server.ts");
    const measured: string[] = [];
    let release = (): void => {};
    const hold = new Promise<void>((done) => {
      release = done;
    });
    const control = startControl({ dry: true, port: 0, ades: ["a", "b"], deps: fakeDeps(measured, hold) });
    const files = controlFiles(true, dir);
    expect(readHeartbeat(files.heartbeat)?.intent).toBe("stopped");
    await post(control.url, "/api/start");
    await settle(control.url, (s) => s.state === "working");
    const running = readHeartbeat(files.heartbeat)!;
    expect(running.intent).toBe("running");
    expect(running.pid).toBe(process.pid);
    expect(running.port).toBe(Number(new URL(control.url).port));
    release();
    await settle(control.url, (s) => s.finished && s.state === "idle");
    expect(readHeartbeat(files.heartbeat)?.intent).toBe("stopped");
    await control.stop();
    const log = readFileSync(files.log, "utf8");
    expect(log).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z Control started/m);
    expect(log).toContain("a measure: done");
    // A dry run never writes the files of a real night.
    expect(existsSync(controlFiles(false, dir).log)).toBe(false);
    expect(existsSync(controlFiles(false, dir).heartbeat)).toBe(false);
  });

  test("Stop writes intent stopped", async () => {
    const { startControl } = await import("../control/server.ts");
    let release = (): void => {};
    const hold = new Promise<void>((done) => {
      release = done;
    });
    const control = startControl({ dry: true, port: 0, ades: ["a"], deps: fakeDeps([], hold) });
    await post(control.url, "/api/start");
    await settle(control.url, (s) => s.state === "working");
    await post(control.url, "/api/stop");
    // The child has not ended yet, and the intent is already written.
    expect(readHeartbeat(controlFiles(true, dir).heartbeat)?.intent).toBe("stopped");
    expect(readFileSync(controlFiles(true, dir).log, "utf8")).toContain("Stop pressed");
    release();
    await control.stop();
  });

  test("Continue goes on with the open run without a click, and starts nothing when no run is open", async () => {
    const store = new Store(controlFiles(true, dir).database);
    store.createRun("open-run", "seed", ["a"], true, "2026-11-09T00:00:00.000Z");
    store.close();
    const { startControl } = await import("../control/server.ts");
    const measured: string[] = [];
    const control = startControl({ dry: true, port: 0, ades: ["a"], deps: fakeDeps(measured) });
    control.continueRun();
    await settle(control.url, (s) => s.finished);
    expect(measured).toEqual(["open-run a"]);
    control.continueRun();
    await Bun.sleep(20);
    expect(measured).toEqual(["open-run a"]);
    await control.stop();
  });

  test("New run ends the open run, keeps its tasks, and starts a new one", async () => {
    const store = new Store(controlFiles(true, dir).database);
    store.createRun("old-run", "seed", ["a", "b"], true, "2026-11-09T00:00:00.000Z");
    store.close();
    const { startControl } = await import("../control/server.ts");
    const measured: string[] = [];
    const control = startControl({ dry: true, port: 0, ades: ["a", "b"], deps: fakeDeps(measured) });
    const state = (await (await fetch(`${control.url}/api/state`)).json()) as { open: boolean };
    expect(state.open).toBe(true);
    await post(control.url, "/api/new-run");
    await settle(control.url, (s) => s.finished);
    await control.stop();
    const after = new Store(controlFiles(true, dir).database);
    // Two apps, each proved and measured: QA runs by day.
    expect(after.tasks("old-run").length).toBe(4);
    expect(measured.every((entry) => !entry.startsWith("old-run"))).toBe(true);
    expect(measured.length).toBe(2);
    expect(after.latestRun()!.id).not.toBe("old-run");
    after.close();
  });
});

describe("one Control only", () => {
  test("a second control opens the first and exits with 0", async () => {
    const cli = join(import.meta.dir, "..", "cli.ts");
    const env = { ...process.env, ADEMARK_RESULTS: dir };
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const first = Bun.spawn(["bun", cli, "control", "--dry-run", "--no-open", "--port", String(port), "--ade", "bare-cli"], { env, stdout: "pipe", stderr: "inherit" });
    try {
      for (let i = 0; i < 200 && !existsSync(controlFiles(true, dir).lock); i++) await Bun.sleep(25);
      for (let i = 0; i < 200; i++) {
        if ((await fetch(`http://127.0.0.1:${port}/api/state`).catch(() => null))?.ok) break;
        await Bun.sleep(25);
      }
      const second = Bun.spawn(["bun", cli, "control", "--dry-run", "--no-open", "--port", String(port + 1)], { env, stdout: "pipe", stderr: "pipe" });
      expect(await second.exited).toBe(0);
      expect(await new Response(second.stdout).text()).toContain(`already runs (pid ${first.pid}`);
      expect(JSON.parse(readFileSync(controlFiles(true, dir).lock, "utf8")).port).toBe(port);
    } finally {
      first.kill("SIGTERM");
      await first.exited;
    }
    expect(existsSync(controlFiles(true, dir).lock)).toBe(false);
  }, 30_000);
});

describe("one number for the measure limit", () => {
  test("the panel and the heartbeat read the step limit from MEASURE_TIMEOUT_MS", async () => {
    const { MEASURE_TIMEOUT_MS, SETTLE_MINUTES, stepLimitMs } = await import("../control/real.ts");
    expect(stepLimitMs("measure")).toBe(MEASURE_TIMEOUT_MS + (SETTLE_MINUTES + 1) * 60_000);
    const { startControl } = await import("../control/server.ts");
    let release = (): void => {};
    const hold = new Promise<void>((done) => {
      release = done;
    });
    const control = startControl({ dry: true, port: 0, ades: ["a"], deps: fakeDeps([], hold) });
    await post(control.url, "/api/start");
    let current: { step: string; limitMinutes: number | null } | null = null;
    for (let i = 0; i < 500 && current?.step !== "measure"; i++) {
      current = ((await (await fetch(`${control.url}/api/state`)).json()) as { current: typeof current }).current;
      await Bun.sleep(5);
    }
    expect(current!.limitMinutes).toBe(stepLimitMs("measure")! / 60_000);
    // The next beat carries the same limit.
    const { readHeartbeat: read } = await import("../control/files.ts");
    await post(control.url, "/api/stop");
    expect(read(controlFiles(true, dir).heartbeat)?.step_limit_ms).toBe(stepLimitMs("measure"));
    release();
    await control.stop();
    const html = readFileSync(join(import.meta.dir, "..", "control", "public", "index.html"), "utf8");
    expect(html).not.toContain("LIMITS");
    expect(html).toContain("limitMinutes");
  });
});

// 2026-11-10: the owner asked for one button. Start does the right thing with an open night, and the panel shows one
// primary button.
describe("one button", () => {
  const NOW = { commit: "c0ffee1234567", inputs: "inputs-now" };
  async function withOpenNight(baseline: string | null) {
    const { writeFileSync } = await import("node:fs");
    const store = new Store(controlFiles(true, dir).database);
    store.createRun("old-night", "seed", ["a", "b"], true, "2026-11-09T00:00:00.000Z");
    store.close();
    if (baseline !== null) writeFileSync(join(dir, "old-night.inputs"), baseline);
    const { startControl } = await import("../control/server.ts");
    const measured: string[] = [];
    const control = startControl({ dry: true, port: 0, ades: ["a", "b"], deps: fakeDeps(measured), codeId: () => NOW });
    const before = (await (await fetch(`${control.url}/api/state`)).json()) as { stale: boolean; open: boolean };
    await post(control.url, "/api/start");
    await settle(control.url, (s) => s.finished && s.state === "idle");
    await control.stop();
    const after = new Store(controlFiles(true, dir).database);
    const latest = after.latestRun()!.id;
    after.close();
    const { Database } = await import("bun:sqlite");
    const db = new Database(controlFiles(true, dir).database, { readonly: true });
    const oldEnded = db.query<{ ended_at: string | null }, [string]>("SELECT ended_at FROM runs WHERE id = ?").get("old-night")?.ended_at ?? null;
    db.close();
    return { before, measured, latest, oldEnded };
  }

  test("Start ends a night whose measuring files changed and begins a new one", async () => {
    const result = await withOpenNight("inputs-of-9-nov");
    expect(result.before).toMatchObject({ open: true, stale: true });
    expect(result.latest).not.toBe("old-night");
    expect(result.oldEnded).not.toBeNull();
    expect(result.measured.length).toBe(2);
    expect(result.measured.every((entry) => !entry.startsWith("old-night"))).toBe(true);
  });

  test("Start goes on with a night whose measuring files are the same", async () => {
    const result = await withOpenNight("inputs-now");
    expect(result.before).toMatchObject({ open: true, stale: false });
    expect(result.latest).toBe("old-night");
    expect(result.measured.every((entry) => entry.startsWith("old-night"))).toBe(true);
  });

  test("Start goes on with a night that has no baseline yet", async () => {
    const result = await withOpenNight(null);
    expect(result.before.stale).toBe(false);
    expect(result.latest).toBe("old-night");
  });

  test("the panel has one primary button, and the other actions sit closed under More", () => {
    const html = readFileSync(join(import.meta.dir, "..", "control", "public", "index.html"), "utf8");
    expect(html.match(/class="primary"/g)?.length).toBe(1);
    const more = html.slice(html.indexOf('<details class="more"'), html.indexOf("</details>"));
    for (const id of ["rehearse", "newrun", "permissions"]) expect(more).toContain(`id="${id}"`);
    expect(html).toContain("Start the night");
    expect(html).not.toContain("Grant permissions first");
  });
});

// Review R2, 2026-11-10: Start says whether a clean rehearsal covers this code, and starts in every case.
describe("rehearsal line at Start", () => {
  const NOW = { commit: "c0ffee1234567", inputs: "inputs-now" };
  async function startWith(lap: { commit: string; inputs: string; fresh: number } | null) {
    const { writeRehearsal } = await import("../control/rehearsal.ts");
    if (lap !== null) {
      writeRehearsal(join(dir, "rehearsal-2026-11-10T09-00-00Z-dry"), {
        markdown: "x\n",
        file: { run_id: "rehearsal-2026-11-10T09-00-00Z", dry: true, ended: true, commit: lap.commit, inputs: lap.inputs, fresh: lap.fresh, lines: {} },
      });
    }
    const { startControl } = await import("../control/server.ts");
    const measured: string[] = [];
    const control = startControl({ dry: true, port: 0, ades: ["a"], deps: fakeDeps(measured), codeId: () => NOW });
    await post(control.url, "/api/start");
    await settle(control.url, (s) => s.finished && s.state === "idle");
    const state = (await (await fetch(`${control.url}/api/state`)).json()) as { rehearsal: { level: string; text: string } | null };
    await control.stop();
    return { line: state.rehearsal!, measured };
  }

  test("no rehearsal: a warning, and the night runs", async () => {
    const { line, measured } = await startWith(null);
    expect(line).toEqual({ level: "warn", text: "No rehearsal yet: press Rehearse by day before a night." });
    expect(measured).toHaveLength(1);
  });

  test("a lap on an older commit or other inputs: a warning with the reason, and the night runs", async () => {
    const { line, measured } = await startWith({ commit: "0ldc0mmit999", inputs: "inputs-then", fresh: 0 });
    expect(line.level).toBe("warn");
    expect(line.text).toContain("it ran on commit 0ldc0mm, now c0ffee1");
    expect(line.text).toContain("the measuring inputs (bench/native/bin, snapshots) changed since");
    expect(line.text).toContain("Start still works");
    expect(measured).toHaveLength(1);
  });

  test("a lap with NEW rows: a warning with the count, and the night runs", async () => {
    const { line, measured } = await startWith({ ...NOW, fresh: 4 });
    expect(line.level).toBe("warn");
    expect(line.text).toContain("4 invalid rows are not accepted limits");
    expect(measured).toHaveLength(1);
  });

  test("a clean lap on this commit and these inputs: no warning", async () => {
    const { line, measured } = await startWith({ ...NOW, fresh: 0 });
    expect(line).toEqual({ level: "ok", text: "Last rehearsal rehearsal-2026-11-10T09-00-00Z: 0 NEW, on this commit and these inputs." });
    expect(measured).toHaveLength(1);
  });
});

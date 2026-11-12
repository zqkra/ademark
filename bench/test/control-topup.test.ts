// ADEMARK-47: the top-up pass. Which tests run again, which tests run with them, the merge by test and attempt, and the
// two refusals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type EngineDeps } from "../control/engine.ts";
import { LIVE_MODEL_TESTS, missingNow } from "../control/real.ts";
import { firstPassOver } from "../control/server.ts";
import { Store, type StepName, type Task, type TaskStatus } from "../control/store.ts";
import { mergeAttempts, minimumsOf, missing, missingLine, planTopUp, RUNS_WITH, topUpRefusal, underMinimum, type Minimum, type MissingApp } from "../control/topup.ts";
import { NOT_SUPPORTED } from "../calibrate/pass.ts";
import { ACCEPTED_LIMITS } from "../night/known-failures.ts";
import { loadRunners, type TestRunner } from "../run/registry.ts";
import { leftoverReason } from "../tracks/a-timing/a2-relaunch.ts";
import { row } from "./control-rows.ts";

const MIN = new Map<string, Minimum>([
  ["A4", { variant: "total", min: 6 }],
  ["A5", { variant: null, min: 1 }],
  ["A6", { variant: null, min: 1 }],
  ["A9", { variant: null, min: 3 }],
  ["A11", { variant: null, min: 5 }],
]);
const reps = (test: string, variant: string, valid: boolean[], over: Parameters<typeof row>[0] = {}) =>
  valid.map((ok, index) => row({ test_id: test as never, variant, rep: index + 1, valid: ok, invalid_reason: ok ? null : "timed_out", ...over }));

describe("minimums", () => {
  test("come from each runner: adaptive.min, else repeats", async () => {
    const minimums = minimumsOf((await loadRunners()) as Map<string, TestRunner>);
    expect(minimums.get("A1")).toEqual({ variant: "cold", min: 6 });
    expect(minimums.get("A4")).toEqual({ variant: "total", min: 6 });
    expect(minimums.get("A9")).toEqual({ variant: null, min: 3 });
    expect(minimums.get("A11")).toEqual({ variant: null, min: 5 });
    expect(minimums.get("A5")).toEqual({ variant: null, min: 1 });
  });

  test("a test with a variant only at repetition 1 is complete when its repetitions are", () => {
    const a9 = [...reps("A9", "no-sessions", [true, true, true]), row({ test_id: "A9", variant: "sessions-kept", rep: 1 })];
    expect(underMinimum(a9, MIN.get("A9")!)).toBe(false);
    expect(underMinimum(a9.slice(2), MIN.get("A9")!)).toBe(true);
    // A repetition with one invalid row is not a valid repetition.
    expect(underMinimum([...a9, row({ test_id: "A9", variant: "sessions-kept", rep: 2, valid: false, invalid_reason: "x" })], MIN.get("A9")!)).toBe(true);
  });

  test("the copy of the live-model set agrees with bench/run/loop.ts", () => {
    const source = readFileSync(join(import.meta.dir, "..", "run", "loop.ts"), "utf8");
    const set = /const LIVE_MODEL_TESTS = new Set<string>\(\[([^\]]*)\]\)/.exec(source)![1]!;
    expect(set.split(",").map((entry) => entry.trim().replaceAll('"', ""))).toEqual([...LIVE_MODEL_TESTS]);
  });
});

describe("plan", () => {
  test("only the tests under their minimum run again", () => {
    const rows = [...reps("A4", "total", [true, false, true, false, false, true]), ...reps("A5", "app", [true]), ...reps("A11", "open", [true, true, true, true, true])];
    expect(planTopUp("orca", rows, MIN)).toEqual({ short: ["A4"], tests: ["A4"], skipped: [] });
  });

  test("a test that needs another test's state runs with it, and A11 needs only its block's seeds", () => {
    expect(RUNS_WITH).toEqual({ A6: ["A5"], A10: ["A5"], A11: [] });
    const rows = [...reps("A5", "app", [true]), ...reps("A6", "front", [false]), ...reps("A11", "open", [false, true, true, true, true])];
    expect(planTopUp("orca", rows, MIN).tests).toEqual(["A5", "A6", "A11"]);
  });

  test("a test with no row at all runs again; a test the app does not support does not", () => {
    const rows = [...reps("A5", "app", [true]), row({ test_id: "A6", variant: "excluded", valid: false, invalid_reason: "not supported here: no window" })];
    expect(planTopUp("orca", rows, MIN, ["A5", "A6", "A9"]).tests).toEqual(["A9"]);
  });

  test("rows of a variant the app does not support never make a test short (Diri A5, 10 Nov)", () => {
    const unsupported = { ade: "diri", valid: false, invalid_reason: "not supported here: Diri starts its Claude sessions detached" };
    const a5 = [1, 2].flatMap((rep) => [
      row({ ade: "diri", test_id: "A5", variant: "app", rep }),
      row({ test_id: "A5", variant: "agents", rep, ...unsupported }),
    ]);
    expect(planTopUp("diri", a5, MIN)).toEqual({ short: [], tests: [], skipped: [] });
    // A supported row that fails still makes a repetition short.
    const failed = a5.map((entry) => (entry.variant === "app" ? { ...entry, valid: false, invalid_reason: "timed_out" } : entry));
    expect(planTopUp("diri", failed, MIN).short).toEqual(["A5"]);
  });

  test("an approved accepted limit gets no top-up; an unapproved one still does", () => {
    const reason = leftoverReason(1.58, 1);
    const minimums = new Map<string, Minimum>([["A2", { variant: "relaunch", min: 6 }]]);
    const rows = reps("A2", "relaunch", [false, false, false], { invalid_reason: reason });
    expect(planTopUp("orca", rows, minimums).tests).toEqual(["A2"]);
    const approved = ACCEPTED_LIMITS.map((limit) => ({ ...limit, approved: "2026-11-10" }));
    const plan = planTopUp("orca", rows, minimums, [], approved);
    expect(plan.tests).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain("accepted limit");
  });
});

describe("merge", () => {
  const first = [...reps("A4", "total", [true, false, false]), ...reps("A5", "app", [true]), ...reps("A6", "front", [false])].map((entry) => ({ ...entry, run_id: "control-x-orca-1" }));
  const topUp = [...reps("A4", "total", [true, true, true, true, true, true]), ...reps("A5", "app", [true]), ...reps("A6", "front", [true])]
    .map((entry) => ({ ...entry, run_id: "control-x-orca-topup-1" }));

  test("every repetition of one test comes from one attempt, and the report names it", () => {
    const merged = mergeAttempts("orca", "control-x", { label: "attempt 1", rows: first }, [{ label: "top-up 1", rows: topUp }], MIN);
    expect(merged.refused).toEqual([]);
    expect(Object.fromEntries(merged.source)).toEqual({ "orca A4": "top-up 1", "orca A5": "attempt 1", "orca A6": "top-up 1" });
    // A4 has the 6 top-up rows and none of the first attempt's 3.
    expect(merged.rows.filter((entry) => entry.test_id === "A4").map((entry) => entry.run_id)).toEqual(Array(6).fill("control-x-orca-topup-1"));
    // A5 ran in the top-up only because A6 needs it: the first attempt's A5 stays.
    expect(merged.rows.filter((entry) => entry.test_id === "A5").map((entry) => entry.run_id)).toEqual(["control-x-orca-1"]);
  });

  test("a complete test keeps its attempt when it fails as a companion in a top-up (review R1)", () => {
    const companion = [...reps("A5", "app", [false], { invalid_reason: "timed_out" }), ...reps("A6", "front", [true])].map((entry) => ({ ...entry, run_id: "control-x-orca-topup-1" }));
    const merged = mergeAttempts("orca", "control-x", { label: "attempt 1", rows: first }, [{ label: "top-up 1", rows: companion }], MIN);
    expect(merged.source.get("orca A5")).toBe("attempt 1");
    expect(merged.rows.filter((entry) => entry.test_id === "A5").map((entry) => [entry.run_id, entry.valid])).toEqual([["control-x-orca-1", true]]);
    expect(merged.source.get("orca A6")).toBe("top-up 1");
  });

  test("a second top-up replaces a test still short after the first, even when its rows are worse", () => {
    const still = reps("A4", "total", [true, false, true], { run_id: "control-x-orca-topup-1" });
    const second = reps("A4", "total", [false, false, false], { run_id: "control-x-orca-topup-2", invalid_reason: "timed_out again" });
    const merged = mergeAttempts("orca", "control-x", { label: "attempt 1", rows: first }, [{ label: "top-up 1", rows: still }, { label: "top-up 2", rows: second }], MIN);
    expect(merged.source.get("orca A4")).toBe("top-up 2");
    // The choice was made before top-up 2 had rows: its 3 invalid rows stand, never the 2 valid ones of top-up 1.
    expect(merged.rows.filter((entry) => entry.test_id === "A4").every((entry) => entry.run_id === "control-x-orca-topup-2" && !entry.valid)).toBe(true);
    // A test complete after top-up 1 keeps top-up 1.
    const done = mergeAttempts("orca", "control-x", { label: "attempt 1", rows: first }, [{ label: "top-up 1", rows: topUp }, { label: "top-up 2", rows: second }], MIN);
    expect(done.source.get("orca A4")).toBe("top-up 1");
  });

  test("a top-up of another build is refused whole, and a later one of the right build still counts", () => {
    const other = topUp.map((entry) => ({ ...entry, ade_build_sha256: "bbbbbbbbbbbbbbbb" }));
    const second = reps("A4", "total", [true, true, true, true, true, true], { run_id: "control-x-orca-topup-2" });
    const merged = mergeAttempts("orca", "control-x", { label: "attempt 1", rows: first }, [{ label: "top-up 1", rows: other }, { label: "top-up 2", rows: second }], MIN);
    expect(merged.refused.map((entry) => entry.label)).toEqual(["top-up 1"]);
    expect(Object.fromEntries(merged.source)).toEqual({ "orca A4": "top-up 2", "orca A5": "attempt 1", "orca A6": "attempt 1" });
  });

  test("a top-up that fails again keeps its own rows and their reason", () => {
    const again = reps("A4", "total", [false, false], { run_id: "control-x-orca-topup-1", invalid_reason: "still timed out" });
    const merged = mergeAttempts("orca", "control-x", { label: "attempt 1", rows: first }, [{ label: "top-up 1", rows: again }], MIN);
    expect(merged.rows.filter((entry) => entry.test_id === "A4").every((entry) => !entry.valid && entry.invalid_reason === "still timed out")).toBe(true);
  });

  test("refuses a top-up from another machine", () => {
    const other = topUp.map((entry) => ({ ...entry, machine_id: "another-mac" }));
    const merged = mergeAttempts("orca", "control-x", { label: "attempt 1", rows: first }, [{ label: "top-up 1", rows: other }], MIN);
    expect(merged.refused[0]?.reason).toContain("machine another-mac");
    expect([...merged.source.values()].every((label) => label === "attempt 1")).toBe(true);
    expect(merged.rows).toHaveLength(first.length);
  });

  test("refuses a top-up of an app that updated itself", () => {
    const updated = topUp.map((entry) => ({ ...entry, ade_build_sha256: "bbbbbbbbbbbbbbbb" }));
    const merged = mergeAttempts("orca", "control-x", { label: "attempt 1", rows: first }, [{ label: "top-up 1", rows: updated }], MIN);
    expect(merged.refused[0]?.reason).toContain("the app build changed");
    expect(merged.refused[0]?.reason).toContain("measure it again in full");
    expect(merged.rows).toHaveLength(first.length);
  });

  test("never mixes rows of two runs", () => {
    const old = topUp.map((entry) => ({ ...entry, run_id: "control-2026-11-09T04-18-06Z-orca-1" }));
    expect(() => mergeAttempts("orca", "control-x", { label: "attempt 1", rows: first }, [{ label: "top-up 1", rows: old }], MIN)).toThrow("is not of control-x");
  });

  test("the refusal before a top-up compares machine and build", () => {
    const id = { machine_id: "ref-mac-mini-m4-16gb", ade_build_sha256: "aaa" };
    expect(topUpRefusal(id, id)).toBeNull();
    expect(topUpRefusal(id, { ...id, machine_id: "x" })).toContain("machine x");
    expect(topUpRefusal(id, { ...id, ade_build_sha256: "b" })).toContain("build changed");
    expect(topUpRefusal(null, id)).toContain("no rows");
  });
});

describe("engine", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ademark-topup-"));
    store = new Store(join(dir, "control.sqlite"));
    store.createRun("r", "s", ["a", "b"], false, "2026-11-10T00:00:00.000Z");
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = (seen: string[], over: Partial<EngineDeps> = {}): EngineDeps => ({
    now: () => "2026-11-10T00:00:00.000Z",
    log: () => {},
    settle: async () => {},
    preflight: async () => [],
    machineOn: () => {},
    machineOff: () => {},
    prove: async () => ({ ok: true, note: "" }),
    measure: async (ade) => {
      seen.push(`measure ${ade}`);
      return { ok: true, note: "" };
    },
    rehearse: async () => ({ ok: true, note: "" }),
    topUpTests: async (ade) => ({ tests: ade === "a" ? ["A5", "A6"] : [], note: "" }),
    topUp: async (ade, _run, _seed, tests, attempt, first) => {
      seen.push(`top-up ${ade} ${tests.join(",")} attempt ${attempt} of measure ${first}`);
      return { ok: false, note: "A6 still failed" };
    },
    report: () => {},
    abort: () => {},
    cleanup: async () => [],
    resume: () => {},
    screen: async () => "on",
    sleep: () => new Promise((done) => setTimeout(done, 0)),
    finishedAttempt: () => null,
    // ADEMARK-49: these tests plan no tokens or orchestration step; bench/test/control-late.test.ts does.
    tokens: async () => ({ ok: true, note: "" }),
    orchestration: async () => ({ ok: true, note: "" }),
    latePlan: () => ({ tokens: [], orchestration: [] }),
    modelAnswers: async () => true,
    ...over,
  });

  test("after the first pass of every app, once per app; a second failure stays with its reason", async () => {
    const seen: string[] = [];
    await new Engine(store, deps(seen)).run("r", "s");
    expect(seen).toEqual(["measure a", "measure b", "top-up a A5,A6 attempt 1 of measure 1"]);
    const topUp = store.tasks("r").find((task) => task.step === "top-up")!;
    expect(topUp).toMatchObject({ ade: "a", status: "failed", note: "A6 still failed", tests: "A5,A6" });
    // ADEMARK-51: the night stays open for the owner's pass; its first pass is recorded.
    expect(store.latestRun()?.ended_at).toBeNull();
    expect(store.latestRun()?.first_pass_at).not.toBeNull();
    // Continue, Retry and a second plan bring no second top-up.
    expect(store.addTopUp("r", "a", ["A6"])).toBe(false);
    store.retry("r", "a");
    seen.length = 0;
    await new Engine(store, deps(seen)).run("r", "s");
    expect(seen).toEqual([]);
  });

  // 2026-11-11: Capy and Superset joined the measured list while the night of 10 Nov was open.
  test("an app that joined the list after the night began is missing in full, and the pass proves and measures it last", async () => {
    const seen: string[] = [];
    let cFails = true;
    const over: Partial<EngineDeps> = {
      topUpTests: async () => ({ tests: [], note: "" }),
      prove: async (ade) => {
        seen.push(`prove ${ade}`);
        return { ok: true, note: "" };
      },
      measure: async (ade) => {
        seen.push(`measure ${ade}`);
        return ade === "c" && cFails ? { ok: false, note: "setup step: composer not found" } : { ok: true, note: "" };
      },
    };
    await new Engine(store, deps(seen, over)).run("r", "s");
    expect(seen).toEqual(["prove a", "measure a", "prove b", "measure b"]);
    const plan = (): ReturnType<typeof missingNow> => missingNow(dir, "r", store.tasks("r"), false, new Map(), ["a", "b", "c"]);
    expect(plan().measure).toEqual(["c"]);
    expect(missingLine(plan(), (ade) => ade.toUpperCase())).toBe("C: all tests.");
    // Without the list, the run knows only its own apps.
    expect(missingNow(dir, "r", store.tasks("r"), false, new Map()).measure).toEqual([]);
    seen.length = 0;
    store.fill("r", plan().measure, plan().topUps);
    expect(store.tasks("r").slice(-2).map((task) => [task.ade, task.step, task.status, task.pass])).toEqual([["c", "prove", "pending", 1], ["c", "measure", "pending", 1]]);
    await new Engine(store, deps(seen, over)).run("r", "s");
    // A failed first measure moves to the end and runs once more, as for every app.
    expect(seen).toEqual(["prove c", "measure c", "prove c", "measure c"]);
    // A failed measure (a profile made from the bundle) shows like any other, and the next pass measures it again.
    expect(store.tasks("r").find((task) => task.ade === "c" && task.step === "measure")).toMatchObject({ status: "failed", attempts: 2, note: "setup step: composer not found" });
    expect(plan().measure).toEqual(["c"]);
    cFails = false;
    seen.length = 0;
    store.fill("r", plan().measure, plan().topUps);
    await new Engine(store, deps(seen, over)).run("r", "s");
    expect(seen).toEqual(["measure c"]);
    expect(store.tasks("r").filter((task) => task.ade === "c").map((task) => [task.step, task.status, task.attempts])).toEqual([["prove", "done", 2], ["measure", "done", 3]]);
  });

  test("a rehearsal gets no top-up", async () => {
    store.createRun("rehearsal-x", "s", ["a"], false, "2026-11-10T00:00:01.000Z");
    const seen: string[] = [];
    await new Engine(store, deps(seen, { rehearse: async (ade) => {
      seen.push(`rehearse ${ade}`);
      return { ok: true, note: "" };
    } })).run("rehearsal-x", "s");
    expect(seen).toEqual(["rehearse a"]);
    expect(store.tasks("rehearsal-x").map((task) => task.step)).toEqual(["rehearse"]);
  });
});

// ADEMARK-51: the pass that measures only what is missing, on rows shaped like the night of 10 Nov
// (control-2026-11-10T08-31-19Z: 13 of 15 apps measured, 7 top-ups done, Conductor pending, Cloudroom failed).
describe("missing", () => {
  const RUN = "control-2026-11-10T08-31-19Z";
  const A = ["A5", "A6", "A7", "A8", "A10", "A11", "A3", "A4", "A9", "A2", "A1"];
  let minimums: Map<string, Minimum>;
  beforeEach(async () => {
    minimums = minimumsOf((await loadRunners()) as Map<string, TestRunner>);
  });

  // Every test of `tests` at its minimum: valid unless named in `bad`, `not supported` when named in `unsupported`.
  const attempt = (ade: string, folder: string, tests: readonly string[], bad: readonly string[] = [], unsupported: readonly string[] = []) =>
    tests.flatMap((test) => {
      const minimum = minimums.get(test)!;
      return Array.from({ length: minimum.min }, (_, index) => {
        const ok = !bad.includes(test) && !unsupported.includes(test);
        const reason = unsupported.includes(test) ? `${NOT_SUPPORTED} without the replay server` : ok ? null : "quit failed: the app is still running";
        return row({ ade, run_id: `${RUN}-${ade}-${folder}`, test_id: test as never, variant: minimum.variant ?? "main", rep: index + 1, valid: ok, invalid_reason: reason });
      });
    });
  const measured = (ade: string, expected: readonly string[], firstBad: readonly string[], topUps: { tests: string[]; bad: string[] }[] = [], unsupported: readonly string[] = []): MissingApp => ({
    ade,
    measured: true,
    expected,
    attempts: [
      { label: "attempt 1", rows: attempt(ade, "1", expected, firstBad, unsupported) },
      ...topUps.map((topUp, index) => ({ label: `top-up ${index + 1}`, rows: attempt(ade, `topup-${index + 1}`, topUp.tests, topUp.bad) })),
    ],
  });
  // Diri's A5: each repetition also has an `agents` row that is not supported (detached sessions), in both folders.
  const withAgentsUnsupported = (app: MissingApp): MissingApp => ({
    ...app,
    attempts: app.attempts.map((entry) => ({
      ...entry,
      rows: [...entry.rows, ...entry.rows.filter((one) => one.test_id === "A5").map((one) => ({ ...one, variant: "agents", valid: false, invalid_reason: "not supported here: detached sessions" }))],
    })),
  });
  const night = (): MissingApp[] => [
    ...["super-engineering", "bare-cli", "monocode", "paseo", "t3code"].map((ade) => measured(ade, A, [])),
    measured("claude-desktop", LIVE_MODEL_TESTS, [], [], ["A3"]),
    measured("traycer", A, ["A11", "A2"], [{ tests: ["A11", "A2"], bad: ["A2"] }]),
    measured("emdash", A, ["A7"], [{ tests: ["A7"], bad: ["A7"] }]),
    measured("zeron", A, ["A2"], [{ tests: ["A2"], bad: ["A2"] }]),
    measured("synara", A, ["A2"], [{ tests: ["A2"], bad: ["A2"] }]),
    measured("bb", A, ["A11"], [{ tests: ["A11"], bad: ["A11"] }]),
    withAgentsUnsupported(measured("diri", A.filter((test) => test !== "A7"), ["A3", "A4", "A2"], [{ tests: ["A5", "A3", "A4", "A2"], bad: ["A3", "A4", "A2"] }])),
    measured("orca", A, ["A3", "A2", "A1"], [{ tests: ["A3", "A2", "A1"], bad: ["A3", "A2", "A1"] }]),
    { ade: "conductor", measured: false, attempts: [], expected: [] },
    { ade: "cloudroom", measured: false, attempts: [], expected: [] },
  ];

  test("Conductor and Cloudroom in full, a top-up for 7 apps, nothing for the 5 complete apps and Claude desktop", () => {
    const plan = missing(RUN, night(), minimums, []);
    expect(plan.measure).toEqual(["conductor", "cloudroom"]);
    expect(Object.fromEntries(plan.topUps.map((entry) => [entry.ade, entry.short]))).toEqual({
      traycer: ["A2"],
      emdash: ["A7"],
      zeron: ["A2"],
      synara: ["A2"],
      bb: ["A11"],
      diri: ["A3", "A4", "A2"],
      orca: ["A3", "A2", "A1"],
    });
    // Traycer's A11 came back in its first top-up, and Diri's A5 is complete in its supported rows: neither runs again.
    expect(plan.topUps.find((entry) => entry.ade === "traycer")?.tests).toEqual(["A2"]);
    expect(missingLine(plan)).toBe("conductor, cloudroom: all tests. traycer: A2. emdash: A7. zeron: A2. synara: A2. bb: A11. diri: A3, A4, A2. orca: A3, A2, A1.");
  });

  test("a test filled by a later top-up is no longer missing, and an approved accepted limit never is", () => {
    const apps = night().filter((app) => app.ade === "zeron" || app.ade === "emdash");
    const zeron = apps.find((app) => app.ade === "zeron")!;
    const filled = { ...zeron, attempts: [...zeron.attempts, { label: "top-up 2", rows: attempt("zeron", "topup-2", ["A2"]) }] };
    expect(missing(RUN, [filled, apps.find((app) => app.ade === "emdash")!], minimums, []).topUps.map((entry) => entry.ade)).toEqual(["emdash"]);
    const reason = leftoverReason(1.58, 1);
    const relaunch = minimums.get("A2")!;
    const limited: MissingApp = {
      ade: "orca",
      measured: true,
      expected: ["A2"],
      attempts: [{ label: "attempt 1", rows: Array.from({ length: relaunch.min }, (_, index) => row({ run_id: `${RUN}-orca-1`, test_id: "A2", variant: relaunch.variant ?? "main", rep: index + 1, valid: false, invalid_reason: reason })) }],
    };
    expect(missing(RUN, [limited], minimums, []).topUps.map((entry) => entry.ade)).toEqual(["orca"]);
    const approved = ACCEPTED_LIMITS.map((limit) => ({ ...limit, approved: "2026-11-10" }));
    expect(missing(RUN, [limited], minimums, approved)).toEqual({ measure: [], topUps: [], tokens: [], orchestration: [] });
  });

  test("a complete night has nothing missing and an empty line", () => {
    const plan = missing(RUN, night().slice(0, 6), minimums, []);
    expect(plan).toEqual({ measure: [], topUps: [], tokens: [], orchestration: [] });
    expect(missingLine(plan)).toBe("");
  });
});

describe("store, the owner's pass", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ademark-fill-"));
    store = new Store(join(dir, "control.sqlite"));
    store.createRun("r", "s", ["a", "b"], false, "2026-11-10T00:00:00.000Z");
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a failed measure comes back with its attempts, and a top-up of the next pass takes the next folder number", () => {
    const [, measureA, , measureB] = store.tasks("r");
    store.start(measureA!.id, "t");
    store.start(measureA!.id, "t");
    store.finish(measureA!.id, "failed", "exit 1", "t");
    store.start(measureB!.id, "t");
    store.finish(measureB!.id, "done", "", "t");
    expect(store.addTopUp("r", "b", ["A2"])).toBe(true);
    const first = store.tasks("r").find((task) => task.step === "top-up")!;
    store.start(first.id, "t");
    store.finish(first.id, "done", "", "t");
    expect(store.fill("r", ["a"], [{ ade: "b", tests: ["A2"] }])).toBe(1);
    const tasks = store.tasks("r");
    expect(tasks.find((task) => task.id === measureA!.id)).toMatchObject({ status: "pending", attempts: 2, note: "" });
    const topUps = tasks.filter((task) => task.ade === "b" && task.step === "top-up");
    expect(topUps.map((task) => [task.pass, task.attempts, task.status])).toEqual([[0, 1, "done"], [1, 1, "pending"]]);
    // The engine runs a step as attempt `attempts + 1`: top-up 2, a new folder.
    // A second press while that top-up waits adds nothing.
    expect(store.fill("r", [], [{ ade: "b", tests: ["A2"] }])).toBe(2);
    expect(store.tasks("r").filter((task) => task.step === "top-up")).toHaveLength(2);
    // The night's own plan can never add a second top-up of pass 0.
    expect(store.addTopUp("r", "b", ["A2"])).toBe(false);
  });

  test("a database from before the pass column keeps its rows and ids", () => {
    store.close();
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const path = join(dir, "old.sqlite");
    const db = new Database(path, { create: true });
    db.run("CREATE TABLE runs (id TEXT PRIMARY KEY, seed TEXT NOT NULL, dry INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT)");
    db.run(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, ade TEXT NOT NULL, step TEXT NOT NULL, position INTEGER NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', started_at TEXT, ended_at TEXT,
      adopted_attempt INTEGER, tests TEXT, UNIQUE (run_id, ade, step))`);
    db.run("INSERT INTO runs VALUES ('n', 'n', 0, 't', NULL)");
    db.run("INSERT INTO tasks (id, run_id, ade, step, position, status, attempts, tests) VALUES (7, 'n', 'emdash', 'top-up', 3, 'done', 1, 'A7')");
    db.close();
    store = new Store(path);
    expect(store.tasks("n")).toEqual([expect.objectContaining({ id: 7, step: "top-up", status: "done", attempts: 1, tests: "A7", pass: 0 })]);
    expect(store.latestRun()?.first_pass_at).toBeNull();
    expect(store.addTopUp("n", "emdash", ["A7"], 1)).toBe(true);
    expect(store.tasks("n").at(-1)).toMatchObject({ pass: 1, attempts: 1 });
  });
});

describe("first pass", () => {
  const run = (first: string | null) => ({ id: "n", seed: "n", dry: 0, started_at: "t", ended_at: null, first_pass_at: first });
  const task = (step: StepName, status: TaskStatus, pass = 0): Task =>
    ({ id: 1, run_id: "n", ade: "a", step, position: 0, status, attempts: 1, note: "", started_at: null, ended_at: null, adopted_attempt: null, tests: null, pass });

  test("is over when the queue ran dry once, or, before that column, when every top-up of the night ran", () => {
    expect(firstPassOver(run("2026-11-10T17:14:41Z"), [task("measure", "pending")])).toBe(true);
    // The night of 10 Nov: 7 top-ups done, Conductor's measure back to pending by Retry, no first_pass_at yet.
    expect(firstPassOver(run(null), [task("measure", "pending"), task("top-up", "done")])).toBe(true);
    // A night stopped during its own top-ups, or before them, is still in its first pass: Start goes on as before.
    expect(firstPassOver(run(null), [task("measure", "done"), task("top-up", "pending")])).toBe(false);
    expect(firstPassOver(run(null), [task("measure", "pending")])).toBe(false);
  });
});

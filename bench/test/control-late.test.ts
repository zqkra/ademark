// ADEMARK-49: the tokens and orchestration steps. They run after every measure and top-up of a pass, each in its own
// folder, and a failed one never changes the app's Track A result.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultRow } from "../core/contracts.ts";
import { Engine, MIN_FREE_DISK_BYTES, NO_MODEL_NOTE, PLAN_POLL_MS, PLAN_WAIT_MS, SESSION_POLL_MS, type EngineDeps } from "../control/engine.ts";
import { lateDir } from "../control/folders.ts";
import { lateFolder, latePlanOf, MEASURED_ADES, missingNow, noOrchestrationReason, ORCHESTRATION_TIMEOUT_MS, orchestrationApps, profileNotCalibrated, stepLimitMs, TOKENS_TIMEOUT_MS } from "../control/real.ts";
import { buildRunReport, orchestrationTax, type ReportApp } from "../control/report.ts";
import { Store, type LatePlan } from "../control/store.ts";
import { missing, missingLine, type MissingApp } from "../control/topup.ts";
import { lineText, testLines } from "../control/verdicts.ts";
import type { AcceptedLimit } from "../night/known-failures.ts";
import type { SetAside } from "../night/set-aside.ts";
import { loadRunners, type TestRunner } from "../run/registry.ts";
import { loadTask } from "../core/tasks.ts";
import { PROMPT_START_WAIT_MS, SIDE_CALL_WAIT_MS } from "../tracks/b/shared.ts";
import { QUIET_MS } from "../tracks/c/shared.ts";
import { row } from "./control-rows.ts";

const RUN = "control-2026-11-12T00-00-00Z";
let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-late-"));
  store = new Store(join(dir, "control.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// `orch` has a trigger, `none` a null one, `later` none yet. Bare CLI has none either, and still comes first.
const TRIGGERS: Record<string, string | null | undefined> = { orch: "/orchestrate", none: null, later: undefined, "bare-cli": undefined };
const plan = (ades: readonly string[]): LatePlan => latePlanOf(ades, (ade) => TRIGGERS[ade]);

function deps(seen: string[], over: Partial<EngineDeps> = {}): EngineDeps {
  const step = (name: string) => async (ade: string) => {
    seen.push(`${name} ${ade}`);
    return { ok: true, note: "" };
  };
  return {
    now: () => "2026-11-12T00:00:00.000Z",
    log: () => {},
    settle: async () => {},
    preflight: async () => [],
    machineOn: () => {},
    machineOff: () => {},
    prove: async () => ({ ok: true, note: "" }),
    measure: step("measure"),
    rehearse: async () => ({ ok: true, note: "" }),
    topUpTests: async (ade) => ({ tests: ade === "orch" ? ["A4"] : [], note: "" }),
    topUp: async (ade, _run, _seed, _tests, attempt) => {
      seen.push(`top-up ${ade} ${attempt}`);
      return { ok: true, note: "" };
    },
    tokens: async (ade, _run, _seed, attempt) => {
      seen.push(`tokens ${ade} ${attempt}`);
      return { ok: true, note: "" };
    },
    orchestration: async (ade, _run, _seed, attempt) => {
      seen.push(`orchestration ${ade} ${attempt}`);
      return { ok: true, note: "" };
    },
    latePlan: plan,
    modelAnswers: async () => {
      seen.push("model check");
      return true;
    },
    report: () => {},
    abort: () => {},
    cleanup: async () => [],
    resume: () => {},
    screen: async () => "on",
    sleep: () => new Promise((done) => setTimeout(done, 0)),
    finishedAttempt: () => null,
    ...over,
  };
}

const view = (): string[] => store.tasks(RUN).map((task) => `${task.ade} ${task.step} ${task.status} ${task.attempts}`);

describe("the apps of each late step", () => {
  test("Bare CLI first, then each app whose adapter has a trigger; a null or missing trigger gets no step", () => {
    expect(orchestrationApps(["orch", "none", "later", "bare-cli"], (ade) => TRIGGERS[ade])).toEqual(["bare-cli", "orch"]);
    expect(orchestrationApps(["none", "later"], (ade) => TRIGGERS[ade])).toEqual([]);
    expect(plan(["orch", "none", "bare-cli"])).toEqual({ tokens: ["orch", "none", "bare-cli"], orchestration: ["bare-cli", "orch"] });
    expect(noOrchestrationReason(null)).toContain("not supported");
    expect(noOrchestrationReason(undefined)).toContain("not calibrated");
    expect(noOrchestrationReason(undefined, "no trigger line proven yet")).toBe("C1 not calibrated: no trigger line proven yet");
  });

  // ADEMARK-50 on main, 2026-11-11: a profile's trigger is a line, null, or { notCalibrated }.
  test("from the real adapters: Bare CLI, bb, Capy, Cloudroom, Orca, Super Engineering, Synara", () => {
    const apps = orchestrationApps([...MEASURED_ADES]);
    expect(apps[0]).toBe("bare-cli");
    expect([...apps].sort()).toEqual(["bare-cli", "bb", "capy", "cloudroom", "orca", "super-engineering", "synara"]);
    expect(profileNotCalibrated("traycer")).not.toBeNull();
    expect(profileNotCalibrated("orca")).toBeNull();
  });

  test("each has its own folder and its own limit, after up to 11 minutes of calm", () => {
    expect(lateDir("/r", RUN, "orca", "tokens", 2, false)).toBe(`/r/${RUN}-orca-tokens-2`);
    expect(lateDir("/r", RUN, "orca", "orchestration", 1, true)).toBe(`/r/${RUN}-orca-orchestration-1-dry`);
    expect(TOKENS_TIMEOUT_MS).toBe(45 * 60_000);
    expect(ORCHESTRATION_TIMEOUT_MS).toBe(140 * 60_000);
    expect(stepLimitMs("tokens")).toBe(56 * 60_000);
    expect(stepLimitMs("orchestration")).toBe(151 * 60_000);
  });

  test("the orchestration limit holds two runs at the cap, each with its wait for quiet and its grade", () => {
    const cap = loadTask("C1-orchestrated-build").time_cap_s * 1000;
    // Two runs (TESTS.md C1: a second one when shipped is under 5/5), 2 minutes of grade each, 10 for the reset, the
    // launch and the settle of the block.
    expect(ORCHESTRATION_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * (cap + QUIET_MS + 2 * 60_000) + 10 * 60_000);
  });

  // 2026-11-11: at 20 minutes the limit was under the worst case of the block, so an app whose turn end is not found
  // would have been cut with no finished attempt, in place of rows with their reason.
  test("the tokens limit holds a block where every turn runs to its cap, twice (the run tries a stopped block once more)", async () => {
    const runners = (await loadRunners()) as Map<string, TestRunner>;
    const turns = (test: string): number => runners.get(test)!.repeats({ smoke: false } as never) + (runners.get(test)!.maxExtraRuns ?? 0);
    const turnMs = (task: string): number => PROMPT_START_WAIT_MS + loadTask(task).time_cap_s * 1000 + SIDE_CALL_WAIT_MS;
    const block = turns("B1") * turnMs("B1-hello") + turns("B3") * turnMs("B3-real-prompt");
    expect(turns("B1")).toBe(4);
    expect(block).toBeGreaterThan(17 * 60_000);
    // Four minutes for the reset and the launch of each try.
    expect(TOKENS_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * (block + 4 * 60_000));
  });
});

describe("engine", () => {
  test("a pass runs measures, top-ups, every tokens step, then every orchestration step", async () => {
    store.createRun(RUN, "s", ["orch", "none", "bare-cli"], false, "2026-11-12T00:00:00.000Z");
    const seen: string[] = [];
    await new Engine(store, deps(seen)).run(RUN, "s");
    expect(seen).toEqual([
      "measure orch", "measure none", "measure bare-cli", "top-up orch 1",
      // The model is asked before every late step: the step before it may have used up the plan.
      "model check", "tokens orch 1", "model check", "tokens none 1", "model check", "tokens bare-cli 1",
      "model check", "orchestration bare-cli 1", "model check", "orchestration orch 1",
    ]);
    expect(store.latestRunById(RUN)?.first_pass_at).not.toBeNull();
    // Continue adds no second late step to the first pass.
    seen.length = 0;
    await new Engine(store, deps(seen)).run(RUN, "s");
    expect(seen).toEqual([]);
  });

  // 2026-11-11: the night of 10 Nov has no first_pass_at (it began before the late steps), and its pass was cut in the
  // middle of the orchestration steps. Going on must finish what waits and queue nothing that already ran.
  test("a night that goes on after a cut pass runs only the late steps that wait, never the ones that ran", async () => {
    store.createRun(RUN, "s", ["orch", "bare-cli"], false, "2026-11-12T00:00:00.000Z");
    for (const task of store.tasks(RUN)) {
      store.start(task.id, "t");
      store.finish(task.id, "done", "", "t");
    }
    // The owner's pass queued every late step; tokens ran (one failed), Bare CLI's orchestration ran, orch's waits.
    store.fill(RUN, [], [], plan(["orch", "bare-cli"]));
    const late = (ade: string, step: string) => store.tasks(RUN).find((task) => task.ade === ade && task.step === step)!;
    for (const [ade, step, status] of [["orch", "tokens", "done"], ["bare-cli", "tokens", "failed"], ["bare-cli", "orchestration", "done"]] as const) {
      store.start(late(ade, step).id, "t");
      store.finish(late(ade, step).id, status, "", "t");
    }
    expect(store.latestRunById(RUN)?.first_pass_at).toBeNull();
    const seen: string[] = [];
    await new Engine(store, deps(seen, { topUpTests: async () => ({ tests: [], note: "" }) })).run(RUN, "s");
    expect(seen).toEqual(["model check", "orchestration orch 1"]);
    expect(view().filter((line) => line.includes("tokens") || line.includes("orchestration"))).toEqual([
      "orch tokens done 1", "bare-cli tokens failed 1", "bare-cli orchestration done 1", "orch orchestration done 1",
    ]);
  });

  test("a measure deferred to the end still runs before the first tokens step", async () => {
    store.createRun(RUN, "s", ["orch", "none"], false, "2026-11-12T00:00:00.000Z");
    const seen: string[] = [];
    await new Engine(store, deps(seen, {
      measure: async (ade, _run, _seed, attempt) => {
        seen.push(`measure ${ade} ${attempt}`);
        return { ok: ade !== "orch" || attempt === 2, note: "x" };
      },
    })).run(RUN, "s");
    expect(seen.indexOf("measure orch 2")).toBeLessThan(seen.indexOf("tokens orch 1"));
    expect(seen.indexOf("top-up orch 1")).toBeLessThan(seen.indexOf("tokens orch 1"));
  });

  test("a failed tokens or orchestration step leaves the measure done and adds no top-up, no retry and no defer", async () => {
    store.createRun(RUN, "s", ["orch", "none"], false, "2026-11-12T00:00:00.000Z");
    const seen: string[] = [];
    await new Engine(store, deps(seen, {
      topUpTests: async () => ({ tests: [], note: "" }),
      tokens: async (ade) => {
        seen.push(`tokens ${ade}`);
        return { ok: false, note: "exit 1, 0 rows" };
      },
      orchestration: async (ade) => {
        seen.push(`orchestration ${ade}`);
        return { ok: false, note: "exit 143, 0 rows" };
      },
    })).run(RUN, "s");
    // Each late step ran once: a failure is not deferred and does not run again in the same pass.
    expect(seen).toEqual(["measure orch", "measure none", "model check", "tokens orch", "model check", "tokens none", "model check", "orchestration orch"]);
    expect(view()).toEqual([
      "orch prove done 1", "orch measure done 1", "none prove done 1", "none measure done 1",
      "orch tokens failed 1", "none tokens failed 1", "orch orchestration failed 1",
    ]);
    expect(store.tasks(RUN).find((task) => task.ade === "orch" && task.step === "orchestration")?.note).toBe("exit 143, 0 rows");
    // Retry brings back measures and proofs only.
    store.retry(RUN, "orch");
    expect(view().filter((line) => line.includes("pending"))).toEqual([]);
  });

  test("a model that does not answer skips every late step of the pass, with the reason, and fails none", async () => {
    store.createRun(RUN, "s", ["orch", "none"], false, "2026-11-12T00:00:00.000Z");
    const seen: string[] = [];
    let asked = 0;
    let slept = 0;
    const engine = new Engine(store, deps(seen, {
      modelAnswers: async () => {
        asked += 1;
        return false;
      },
      // The wait for the plan sleeps in SESSION_POLL_MS; a running step is looked at in shorter sleeps.
      sleep: async (ms) => {
        if (ms === SESSION_POLL_MS) slept += ms;
      },
    }));
    await engine.run(RUN, "s");
    expect(seen).toEqual(["measure orch", "measure none", "top-up orch 1"]);
    // It waited for the plan's window first: asked every 10 minutes for 6 hours, then gave up once for the whole pass.
    expect(slept).toBe(PLAN_WAIT_MS);
    expect(asked).toBe(PLAN_WAIT_MS / PLAN_POLL_MS + 1);
    const late = store.tasks(RUN).filter((task) => task.step === "tokens" || task.step === "orchestration");
    expect(late.map((task) => `${task.ade} ${task.step} ${task.status} ${task.attempts} ${task.note}`)).toEqual([
      `orch tokens skipped 0 ${NO_MODEL_NOTE}`, `none tokens skipped 0 ${NO_MODEL_NOTE}`, `orch orchestration skipped 0 ${NO_MODEL_NOTE}`,
    ]);
    expect(engine.lateNote).toContain(NO_MODEL_NOTE);
    expect(engine.problems).toEqual([]);
    expect(store.latestRunById(RUN)?.first_pass_at).not.toBeNull();
  });

  test("a model check that throws counts as no answer", async () => {
    store.createRun(RUN, "s", ["none"], false, "2026-11-12T00:00:00.000Z");
    await new Engine(store, deps([], { sleep: async () => {}, modelAnswers: async () => {
      throw new Error("spawn failed");
    } })).run(RUN, "s");
    expect(view()).toContain("none tokens skipped 0");
  });

  // 2026-11-11: one C1 can use up a 5-hour window of the plan. The steps after it wait for the window, they are not lost.
  test("a plan that stops answering in the middle of the pass is waited for, and the late steps after it run", async () => {
    store.createRun(RUN, "s", ["orch", "bare-cli"], false, "2026-11-12T00:00:00.000Z");
    const seen: string[] = [];
    let slept = 0;
    // The plan is used up after Bare CLI's orchestration, and answers again at the fourth ask.
    let refusals = 0;
    const notes: (string | null)[] = [];
    const engine: Engine = new Engine(store, deps(seen, {
      topUpTests: async () => ({ tests: [], note: "" }),
      modelAnswers: async () => {
        if (seen.at(-1) !== "orchestration bare-cli 1" || refusals === 3) return true;
        refusals += 1;
        notes.push(engine.lateNote);
        return false;
      },
      sleep: async (ms) => {
        if (ms === SESSION_POLL_MS) slept += ms;
      },
    }));
    await engine.run(RUN, "s");
    expect(seen).toEqual(["measure orch", "measure bare-cli", "tokens orch 1", "tokens bare-cli 1", "orchestration bare-cli 1", "orchestration orch 1"]);
    expect(slept).toBe(3 * PLAN_POLL_MS);
    expect(view().filter((line) => line.includes("skipped") || line.includes("failed"))).toEqual([]);
    // While it waits the panel says so; after it, the note is gone.
    expect(notes[1]).toContain("Waiting for the Claude plan");
    expect(engine.lateNote).toBeNull();
  });

  // 2026-11-11: 12 GB free before a pass of more than a day, and nothing looked at the disk.
  test("a disk under its minimum stops the run before the next step, with a reason, and loses nothing", async () => {
    store.createRun(RUN, "s", ["orch", "none"], false, "2026-11-12T00:00:00.000Z");
    const seen: string[] = [];
    let free = 20 * 1024 ** 3;
    const engine = new Engine(store, deps(seen, {
      topUpTests: async () => ({ tests: [], note: "" }),
      diskFreeBytes: () => free,
      // The first tokens step fills the disk.
      tokens: async (ade) => {
        seen.push(`tokens ${ade}`);
        free = 3 * 1024 ** 3;
        return { ok: true, note: "" };
      },
    }));
    await engine.run(RUN, "s");
    expect(seen).toEqual(["measure orch", "measure none", "model check", "tokens orch"]);
    expect(engine.state).toBe("blocked");
    expect(engine.problems[0]).toContain("Only 3.0 GB free on the disk");
    expect(engine.problems[0]).toContain("before none tokens");
    // The steps left wait as they were: no failure, no attempt counted.
    expect(view().filter((line) => line.includes("pending"))).toEqual(["none tokens pending 0", "orch orchestration pending 0"]);
    expect(MIN_FREE_DISK_BYTES).toBe(5 * 1024 ** 3);
    // With space again, the same run goes on where it stopped.
    free = 20 * 1024 ** 3;
    seen.length = 0;
    await new Engine(store, deps(seen, { topUpTests: async () => ({ tests: [], note: "" }), diskFreeBytes: () => free })).run(RUN, "s");
    expect(seen).toEqual(["model check", "tokens none 1", "model check", "orchestration orch 1"]);
    // A disk that cannot be read stops nothing.
    expect(new Engine(store, deps([], { diskFreeBytes: () => null })).problems).toEqual([]);
  });

  test("Stop during the wait for the plan ends the wait and skips nothing", async () => {
    store.createRun(RUN, "s", ["none"], false, "2026-11-12T00:00:00.000Z");
    let sleeps = 0;
    const engine: Engine = new Engine(store, deps([], {
      modelAnswers: async () => false,
      sleep: async (ms) => {
        if (ms !== SESSION_POLL_MS) return;
        sleeps += 1;
        if (sleeps === 2) void engine.stop();
      },
    }));
    await engine.run(RUN, "s");
    expect(sleeps).toBeLessThan(5);
    expect(view()).toContain("none tokens pending 0");
  });
});

describe("missing and the owner's pass", () => {
  const app = (ade: string, late: MissingApp["late"]): MissingApp => ({ ade, measured: false, attempts: [], expected: [], late });

  test("names the apps with no finished tokens attempt, then those with no orchestration attempt, at the end of the line", () => {
    const plan = missing(RUN, [app("a", { tokens: false, orchestration: false }), app("b", { tokens: true, orchestration: null }), app("c", { tokens: false, orchestration: true })], new Map());
    expect(plan.tokens).toEqual(["a", "c"]);
    expect(plan.orchestration).toEqual(["a"]);
    expect(missingLine(plan, (ade) => ade.toUpperCase())).toBe("A, B, C: all tests. Tokens: A, C. Orchestration: A.");
    expect(missingLine({ measure: [], topUps: [], tokens: [], orchestration: [] })).toBe("");
  });

  test("from the queue: a failed or skipped tokens step is missing, a done one is not, and the pass adds the next folder number", async () => {
    store.createRun(RUN, "s", ["orch", "none"], false, "2026-11-12T00:00:00.000Z");
    let tokensOk = false;
    // A tokens step that ends writes its rows in its own folder, as the real one does.
    const rowsOfStep = (ade: string, attempt: number, valid: boolean, step: "tokens" | "orchestration" = "tokens"): void => {
      const folder = join(dir, `${RUN}-${ade}-${step}-${attempt}`);
      mkdirSync(folder, { recursive: true });
      const entry = row({ run_id: `${RUN}-${ade}-${step}-${attempt}`, ade, test_id: (step === "tokens" ? "B1" : "C1") as never, variant: "main", valid, invalid_reason: valid ? null : "no main-thread request captured" });
      writeFileSync(join(folder, "rows.jsonl"), JSON.stringify(entry) + "\n");
    };
    await new Engine(store, deps([], {
      topUpTests: async () => ({ tests: [], note: "" }),
      tokens: async (ade, _run, _seed, attempt) => {
        if (ade === "none") rowsOfStep(ade, attempt, true);
        return { ok: ade === "none" || tokensOk, note: "exit 1" };
      },
      orchestration: async (ade, _run, _seed, attempt) => {
        rowsOfStep(ade, attempt, true, "orchestration");
        return { ok: true, note: "" };
      },
    })).run(RUN, "s");
    const now = () => missingNow(dir, RUN, store.tasks(RUN), false, new Map(), [], plan);
    // The fake measures wrote no folder, so both apps are missing in full too.
    expect(now()).toMatchObject({ tokens: ["orch"], orchestration: [] });
    // Without a late plan nothing late is named (the callers of ADEMARK-51).
    expect(missingNow(dir, RUN, store.tasks(RUN), false, new Map())).toMatchObject({ tokens: [], orchestration: [] });
    const pass = store.fill(RUN, [], [], { tokens: now().tokens, orchestration: now().orchestration });
    expect(store.tasks(RUN).filter((task) => task.ade === "orch" && task.step === "tokens").map((task) => `${task.pass} ${task.status} ${task.attempts}`))
      .toEqual(["0 failed 1", `${pass} pending 1`]);
    // A second fill of the same pass adds nothing while one waits.
    expect(store.addLateSteps(RUN, { tokens: ["orch"], orchestration: [] }, pass + 1)).toBe(0);
    tokensOk = true;
    const seen: string[] = [];
    await new Engine(store, deps(seen, { topUpTests: async () => ({ tests: [], note: "" }), tokens: async (ade, _run, _seed, attempt) => {
      seen.push(`tokens ${ade} ${attempt}`);
      rowsOfStep(ade, attempt, false);
      return { ok: true, note: "" };
    } })).run(RUN, "s");
    expect(seen).toEqual(["model check", "tokens orch 2"]);
    expect(lateFolder(dir, RUN, store.tasks(RUN), "orch", "tokens", false)).toEqual({ attempt: 2, dir: join(dir, `${RUN}-orch-tokens-2`) });
    // 2026-11-11: the step is done, but no row of it is valid (the prompt never reached the model): it measured nothing,
    // so it is still missing and the next pass runs it again. A dry run has no valid B row at all, so there done counts.
    expect(now()).toMatchObject({ tokens: ["orch"], orchestration: [] });
    expect(missingNow(dir, RUN, store.tasks(RUN), true, new Map(), [], plan)).toMatchObject({ tokens: [], orchestration: [] });
    rowsOfStep("orch", 2, true);
    expect(now()).toMatchObject({ tokens: [], orchestration: [] });
  });

  test("in a later pass Bare CLI's orchestration still comes first, whatever the queue order", () => {
    store.createRun(RUN, "s", ["orch", "bare-cli"], false, "2026-11-12T00:00:00.000Z");
    const plan2 = missingNow(dir, RUN, store.tasks(RUN), false, new Map(), [], plan);
    expect(plan2.orchestration).toEqual(["bare-cli", "orch"]);
    store.fill(RUN, [], [], { tokens: [], orchestration: plan2.orchestration });
    expect(store.tasks(RUN).filter((task) => task.step === "orchestration").map((task) => task.ade)).toEqual(["bare-cli", "orch"]);
  });

  test("a measure that fails at its first attempt in a later pass leaves a done tokens step as it is", () => {
    store.createRun(RUN, "s", ["orch"], false, "2026-11-12T00:00:00.000Z");
    store.addLateSteps(RUN, { tokens: ["orch"], orchestration: [] }, 0);
    const tokens = store.tasks(RUN).find((task) => task.step === "tokens")!;
    store.start(tokens.id, "t");
    store.finish(tokens.id, "done", "", "t");
    store.defer(RUN, "orch");
    expect(view()).toEqual(["orch tokens done 1", "orch prove pending 0", "orch measure pending 0"]);
  });

  test("a measure folder of an older night with B rows plans no B top-up: a measure is Track A", async () => {
    const runners = (await loadRunners()) as Map<string, TestRunner>;
    store.createRun(RUN, "s", ["orca"], false, "2026-11-12T00:00:00.000Z");
    const measure = store.tasks(RUN).find((task) => task.step === "measure")!;
    store.start(measure.id, "t");
    store.finish(measure.id, "done", "", "t");
    const folder = join(dir, `${RUN}-orca-1`);
    mkdirSync(join(folder, "orca"), { recursive: true });
    writeFileSync(join(folder, "orca", "B-claude.done"), "");
    // One invalid B1 row: under its minimum if B counted.
    writeFileSync(join(folder, "rows.jsonl"), JSON.stringify(row({ run_id: `${RUN}-orca-1`, test_id: "B1" as never, variant: "main", valid: false, invalid_reason: "no capture" })) + "\n");
    const plan = missingNow(dir, RUN, store.tasks(RUN), false, runners);
    expect(plan.topUps.flatMap((entry) => entry.tests).filter((test) => test.startsWith("B"))).toEqual([]);
  });
});

describe("report", () => {
  const write = (name: string, rows: readonly ResultRow[]): string => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "rows.jsonl"), rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return path;
  };
  const b = (folder: string, test: string, valid = true, reason: string | null = null) =>
    row({ run_id: `${RUN}-orca-${folder}`, test_id: test as never, variant: "main", valid, invalid_reason: reason, unit: "tokens", value: 100 });
  const c1 = (ade: string, folder: string, variant: string, value: number | null, rep = 1) =>
    row({ run_id: `${RUN}-${ade}-${folder}`, ade, test_id: "C1" as never, variant, value, rep, unit: "x" });

  test("a Track B part and a Track C part beside Track A, each with its attempt; orchestration-tax from Bare CLI's solo run", () => {
    const first = write(`${RUN}-orca-1`, [row({ run_id: `${RUN}-orca-1` })]);
    const tokens = write(`${RUN}-orca-tokens-2`, [b("tokens-2", "B1"), b("tokens-2", "B3", false, "no main-thread request captured")]);
    const orch = write(`${RUN}-orca-orchestration-1`, [
      c1("orca", "orchestration-1", "shipped", 5), c1("orca", "orchestration-1", "time-to-green", 31.5), c1("orca", "orchestration-1", "fan-out-max", 4),
      c1("orca", "orchestration-1", "fan-out-total", 6), c1("orca", "orchestration-1", "handoff", 3), c1("orca", "orchestration-1", "tokens-total", 300_000),
      c1("orca", "orchestration-1", "usd-total", 3),
    ]);
    const bare = write(`${RUN}-bare-cli-orchestration-1`, [c1("bare-cli", "orchestration-1", "solo-tokens-total", 100_000), c1("bare-cli", "orchestration-1", "solo-usd-total", 2)]);
    const apps: ReportApp[] = [
      { ade: "bare-cli", label: "Bare CLI", first: null, topUps: [], expected: [], note: "", orchestration: { folder: { attempt: 1, dir: bare }, note: "" } },
      {
        ade: "orca", label: "Orca", first: { attempt: 1, dir: first }, topUps: [], expected: ["A2"], note: "",
        tokens: { folder: { attempt: 2, dir: tokens }, note: "" }, tokensExpected: ["B1", "B2", "B3"],
        orchestration: { folder: { attempt: 1, dir: orch }, note: "" },
      },
      { ade: "paseo", label: "Paseo", first: null, topUps: [], expected: [], note: "", tokens: { folder: null, note: "no finished tokens attempt. exit 1" }, orchestration: { folder: null, note: noOrchestrationReason(null) } },
    ];
    const text = buildRunReport({ runId: RUN, ended: false, apps, minimums: new Map(), setAside: [] });
    expect(text).toContain(`### Track B (tokens)\n\n- tokens 2: ${RUN}-orca-tokens-2`);
    expect(text).toContain("| B1 | tokens 2 | valid |");
    expect(text).toContain("| B2 | tokens 2 | invalid (NEW): no row: the block stopped before it |");
    expect(text).toContain("| B3 | tokens 2 | invalid (NEW): no main-thread request captured |");
    expect(text).toContain(`### Track C (orchestration, C1)\n\n- orchestration 1: ${RUN}-orca-orchestration-1`);
    expect(text).toContain("| 1 | shipped | 5 x |");
    expect(text).toContain("| 1 | time-to-green | 31.5 x |");
    expect(text).toContain("| 1 | handoff | 3 x |");
    expect(text).toContain("| 1 | orchestration-tax (tokens) | 3.00x |");
    expect(text).toContain("| 1 | orchestration-tax ($) | 1.50x |");
    expect(text).toContain("No tokens attempt finished. no finished tokens attempt. exit 1");
    expect(text).toContain("C1 not supported: the adapter has no orchestration");
    // Bare CLI has no tax of its own rows here (no tokens-total row): no number.
    expect(text).toContain("| 1 | orchestration-tax (tokens) | no value: no valid tokens-total row |");
    // NEW: Orca's B2 (missing) and B3 (invalid), and one each for Bare CLI and Paseo, which have no measured folder.
    expect(text.split("\n")[0]).toBe("4 invalid rows that are not accepted limits (NEW)");
  });

  test("a set-aside entry of a tokens attempt makes its B test not valid, with the reason", () => {
    const tokens = write(`${RUN}-orca-tokens-1`, [b("tokens-1", "B1"), b("tokens-1", "B4")]);
    const entry: SetAside = { run: RUN, ade: "orca", test: "B4", attempt: "tokens-1", reason: "the capture missed the rules file", evidence: `${RUN}-orca-tokens-1/orca/B4/notes.md`, date: "2026-11-12" };
    const app: ReportApp = { ade: "orca", label: "Orca", first: null, topUps: [], expected: [], note: "", tokens: { folder: { attempt: 1, dir: tokens }, note: "" }, tokensExpected: ["B1", "B4"] };
    const text = buildRunReport({ runId: RUN, ended: false, apps: [app], minimums: new Map(), setAside: [entry] });
    expect(text).toContain("| B4 | tokens 1 | set aside after review: the capture missed the rules file |");
    expect(text).toContain("- B4 of tokens 1: set aside after review (2026-11-12)");
    expect(text).toContain("| B1 | tokens 1 | valid |");
  });

  test("an approved accepted limit marks a B row as for an A row", () => {
    const limit: AcceptedLimit = { ade: "orca", test: "B3", reason: /^the app sends no request for this prompt/, evidence: "x", approved: "2026-11-12" };
    const rows = [b("tokens-1", "B3", false, "the app sends no request for this prompt")];
    expect(testLines("orca", rows, ["B3"], [limit]).map(lineText)).toEqual(["invalid (accepted limit): the app sends no request for this prompt"]);
    expect(testLines("orca", rows, ["B3"], [{ ...limit, approved: "" }]).map(lineText)).toEqual(["invalid (NEW): the app sends no request for this prompt"]);
  });

  test("orchestration-tax gives no number from an invalid or missing row", () => {
    const own = [c1("orca", "o-1", "tokens-total", 300), c1("orca", "o-1", "usd-total", 3)];
    expect(orchestrationTax(own, 1, null).tokens).toBe("no value: Bare CLI has no finished orchestration attempt");
    const badSolo = [{ ...c1("bare-cli", "o-1", "solo-tokens-total", 100), valid: false, invalid_reason: "crashed" }];
    expect(orchestrationTax(own, 1, badSolo).tokens).toBe("no value: Bare CLI's solo run has no valid tokens row");
    const solo = [c1("bare-cli", "o-1", "solo-tokens-total", 100, 2), c1("bare-cli", "o-1", "solo-usd-total", 0, 2)];
    expect(orchestrationTax(own, 1, solo)).toEqual({ tokens: "3.00x", usd: "no value: no valid solo-usd-total row of Bare CLI" });
  });
});

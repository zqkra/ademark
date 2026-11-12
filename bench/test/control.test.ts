import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type EngineDeps, type StepResult } from "../control/engine.ts";
import { evidence, parseVerdict } from "../control/qa.ts";
import { claudeAnswered, doctorProblems, permissionProblems } from "../control/real.ts";
import { isProven, PROOF_MAX_AGE_MS, saveProof } from "../control/proofs.ts";
import { Store } from "../control/store.ts";
import type { ResultRow } from "../core/contracts.ts";

let dir: string;
let store: Store;
let log: string[];

function deps(over: Partial<EngineDeps> = {}): EngineDeps {
  const step = (name: string) => async (ade: string): Promise<StepResult> => {
    log.push(`${name} ${ade}`);
    return { ok: true, note: "" };
  };
  return {
    now: () => "2026-11-06T00:00:00.000Z",
    log: () => {},
    preflight: async () => [],
    machineOn: () => {
      log.push("on");
    },
    machineOff: () => {
      log.push("off");
    },
    prove: step("prove"),
    measure: step("measure"),
    rehearse: step("rehearse"),
    topUpTests: async () => ({ tests: [], note: "" }),
    topUp: async (ade, _run, _seed, tests) => {
      log.push(`top-up ${ade} ${tests.join(",")}`);
      return { ok: true, note: "" };
    },
    report: () => {},
    abort: () => {
      log.push("abort");
    },
    resume: () => {},
    cleanup: async (ade) => {
      log.push(`cleanup ${ade}`);
      return [];
    },
    settle: async () => {
      log.push("settle");
    },
    screen: async () => "on",
    sleep: () => new Promise((done) => setTimeout(done, 0)),
    finishedAttempt: () => null,
    // ADEMARK-49: these tests plan no tokens or orchestration step; bench/test/control-late.test.ts does.
    tokens: async () => ({ ok: true, note: "" }),
    orchestration: async () => ({ ok: true, note: "" }),
    latePlan: () => ({ tokens: [], orchestration: [] }),
    modelAnswers: async () => true,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-control-"));
  store = new Store(join(dir, "control.sqlite"));
  store.createRun("r", "s", ["a", "b"], false, "2026-11-06T00:00:00.000Z");
  log = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const statuses = (): string[] => store.tasks("r").map((task) => `${task.ade} ${task.step} ${task.status}`);

describe("engine", () => {
  test("takes one ADE at a time, inside machine on and off", async () => {
    await new Engine(store, deps()).run("r", "s");
    // QA runs by day since 2026-11-10: the night ends after the last measure (ADEMARK-46).
    expect(log.filter((line) => line !== "settle")).toEqual(["on", "prove a", "measure a", "prove b", "measure b", "off"]);
    expect(store.tasks("r").some((task) => task.step === "check")).toBe(false);
    // Only a measure waits for a calm Mac; a proof opens its app at once.
    expect(log.filter((line) => line === "settle")).toHaveLength(2);
    expect(statuses().every((line) => line.endsWith("done"))).toBe(true);
    // ADEMARK-51: a night stays open after its queue ran dry; only the owner closes it.
    expect(store.latestRun()?.ended_at).toBeNull();
    expect(store.latestRun()?.first_pass_at).not.toBeNull();
  });

  test("a failed proof waits at the end: healthy apps are measured first, and only then may Claude repair", async () => {
    const seen: string[] = [];
    const engine = new Engine(store, deps({
      prove: async (ade, _run, attempt, repair) => {
        seen.push(`prove ${ade} ${attempt} ${repair}`);
        return { ok: ade !== "a" || attempt === 2, note: "x" };
      },
      measure: async (ade) => {
        seen.push(`measure ${ade}`);
        return { ok: true, note: "" };
      },
    }));
    await engine.run("r", "s");
    expect(seen).toEqual(["prove a 1 false", "prove b 1 false", "measure b", "prove a 2 true", "measure a"]);
  });

  test("a proof that fails twice skips that ADE and the others go on", async () => {
    const engine = new Engine(store, deps({ prove: async (ade) => ({ ok: ade !== "a", note: "sign-in" }) }));
    await engine.run("r", "s");
    expect(statuses()).toContain("a measure skipped");
    expect(statuses()).toContain("b measure done");
  });

  test("a step that throws fails only itself", async () => {
    const engine = new Engine(store, deps({
      measure: async (ade) => {
        if (ade === "a") throw new Error("disk full");
        return { ok: true, note: "" };
      },
    }));
    await engine.run("r", "s");
    expect(store.tasks("r").find((task) => task.ade === "a" && task.step === "measure")).toMatchObject({ status: "failed", note: "disk full" });
    expect(statuses()).toContain("b measure done");
  });

  test("a crash leaves a running step that the next start repeats", async () => {
    const first = store.next("r")!;
    store.start(first.id, "t");
    await new Engine(store, deps()).run("r", "s");
    expect(log.filter((line) => line === "prove a")).toHaveLength(1);
    expect(store.tasks("r")[0]).toMatchObject({ status: "done", attempts: 2 });
  });

  test("a stop ends the child, restores the machine and leaves the step pending", async () => {
    let engine: Engine;
    engine = new Engine(store, deps({
      measure: async () => {
        engine.stop();
        return { ok: false, note: "killed" };
      },
    }));
    await engine.run("r", "s");
    expect(log).toContain("abort");
    expect(log).toContain("cleanup a");
    expect(log.at(-1)).toBe("off");
    expect(store.tasks("r").find((task) => task.step === "measure")?.status).toBe("pending");
    expect(engine.state).toBe("idle");
  });

  test("a second Start while a worker lives starts nothing", async () => {
    let release = (): void => {};
    const hold = new Promise<void>((done) => {
      release = done;
    });
    let measures = 0;
    const engine = new Engine(store, deps({
      measure: async () => {
        measures += 1;
        await hold;
        return { ok: true, note: "" };
      },
    }));
    const first = engine.run("r", "s");
    while (measures === 0) await Bun.sleep(1);
    engine.stop();
    void engine.run("r", "s");
    release();
    await first;
    expect(measures).toBe(1);
  });

  test("idle waits until the machine is restored", async () => {
    const engine = new Engine(store, deps());
    void engine.run("r", "s");
    await engine.idle();
    expect(log.at(-1)).toBe("off");
  });

  test("a fatal step stops the whole queue and asks for a person", async () => {
    const engine = new Engine(store, deps({ prove: async () => ({ ok: false, note: "tampered: changed", fatal: true }) }));
    await engine.run("r", "s");
    expect(log.filter((line) => line.startsWith("prove"))).toHaveLength(0);
    expect(engine.state).toBe("blocked");
    expect(engine.problems[0]).toContain("Restore bench/native/bin");
    expect(store.next("r")).not.toBeNull();
  });

  test("a failed measure waits at the end, and only that pass may repair", async () => {
    const seen: string[] = [];
    await new Engine(store, deps({
      measure: async (ade, _run, _seed, attempt, repair) => {
        seen.push(`measure ${ade} ${attempt} ${repair}`);
        return { ok: ade !== "a" || attempt === 2, note: "x" };
      },
    })).run("r", "s");
    expect(seen).toEqual(["measure a 1 false", "measure b 1 false", "measure a 2 true"]);
    expect(statuses().every((line) => line.endsWith("done"))).toBe(true);
  });

  test("a failed step cleans its app, and a survivor is reported while the night goes on", async () => {
    const cleaned: string[] = [];
    const engine = new Engine(store, deps({
      measure: async () => ({ ok: false, note: "timeout" }),
      cleanup: async (ade) => {
        cleaned.push(ade);
        return ["Survivor"];
      },
    }));
    await engine.run("r", "s");
    // Each failed measure is cleaned; the stuck process never stops the other app.
    expect(cleaned).toEqual(["a", "b", "a", "b"]);
    expect(engine.problems[0]).toContain("Survivor");
    expect(engine.problems[0]).toContain("after the run");
  });

  test("an app sent to the end measures before any top-up", async () => {
    const seen: string[] = [];
    await new Engine(store, deps({
      measure: async (ade, _run, _seed, attempt) => {
        seen.push(`measure ${ade} ${attempt}`);
        return { ok: ade !== "a" || attempt === 2, note: "x" };
      },
      topUpTests: async (ade) => ({ tests: ade === "b" ? ["A4"] : [], note: "" }),
      topUp: async (ade) => {
        seen.push(`top-up ${ade}`);
        return { ok: true, note: "" };
      },
    })).run("r", "s");
    expect(seen.indexOf("measure a 2")).toBeGreaterThan(-1);
    expect(seen.indexOf("measure a 2")).toBeLessThan(seen.indexOf("top-up b"));
  });

  test("a run of proofs only has no measure and no check", async () => {
    store.createRun("day", "s", ["a", "b"], true, "2026-11-06T00:00:01.000Z", ["prove"]);
    await new Engine(store, deps()).run("day", "s");
    expect(log.filter((line) => line !== "settle")).toEqual(["on", "prove a", "prove b", "off"]);
  });

  test("a proof holds for the same key and a day and a half", () => {
    const file = join(dir, "proofs.json");
    expect(isProven(file, "a", "k", 1000)).toBe(false);
    saveProof(file, "a", "k", 1000);
    saveProof(file, "b", "j", 1000);
    expect(isProven(file, "a", "k", 2000)).toBe(true);
    expect(isProven(file, "a", "other", 2000)).toBe(false);
    expect(isProven(file, "a", "k", 1000 + PROOF_MAX_AGE_MS)).toBe(false);
  });

  test("each measure attempt has its own number, and the top-up plan reads the same one", async () => {
    const seen: string[] = [];
    const first = store.tasks("r").find((task) => task.step === "measure" && task.ade === "a")!;
    store.start(first.id, "t");
    await new Engine(store, deps({
      measure: async (ade, _run, _seed, attempt) => {
        seen.push(`measure ${ade} ${attempt}`);
        return { ok: true, note: "" };
      },
      topUpTests: async (ade, _run, attempt) => {
        seen.push(`plan ${ade} ${attempt}`);
        return { tests: [], note: "" };
      },
    })).run("r", "s");
    expect(seen).toContain("measure a 2");
    expect(seen).toContain("plan a 2");
  });

  test("machine off runs when machine on fails halfway", async () => {
    const engine = new Engine(store, deps({
      machineOn: () => {
        throw new Error("display failed");
      },
    }));
    await engine.run("r", "s");
    expect(log).toContain("off");
  });

  test("a Stop during the wait for calm starts no measure", async () => {
    let engine: Engine;
    let measures = 0;
    engine = new Engine(store, deps({
      settle: async () => engine.stop(),
      measure: async () => {
        measures += 1;
        return { ok: true, note: "" };
      },
    }));
    await engine.run("r", "s");
    expect(measures).toBe(0);
    expect(store.next("r")?.status).toBe("pending");
  });

  test("a preflight problem blocks the run and touches nothing", async () => {
    const engine = new Engine(store, deps({ preflight: async () => ["Claude login: run claude"] }));
    await engine.run("r", "s");
    expect(engine.state).toBe("blocked");
    expect(engine.problems).toEqual(["Claude login: run claude"]);
    expect(log).toEqual([]);
  });

  test("a failed machine on blocks the run", async () => {
    const engine = new Engine(store, deps({
      machineOn: () => {
        throw new Error("root script missing");
      },
    }));
    await engine.run("r", "s");
    expect(engine.state).toBe("blocked");
    expect(engine.problems[0]).toContain("root script missing");
  });

  test("retry brings back failed and skipped steps of one ADE", async () => {
    await new Engine(store, deps({ prove: async (ade) => ({ ok: ade !== "a", note: "x" }) })).run("r", "s");
    store.retry("r", "a");
    log = [];
    await new Engine(store, deps()).run("r", "s");
    expect(log.filter((line) => line !== "settle")).toEqual(["on", "prove a", "measure a", "off"]);
  });

  // ADEMARK-46: a QA verdict goes to the report and never starts a measurement, also through Retry.
  test("an old queue's checks do not run at night, and a failed check never brings a measure back", async () => {
    store.createRun("old", "s", ["a"], false, "2026-11-06T00:00:02.000Z", ["prove", "measure", "check"]);
    await new Engine(store, deps()).run("old", "s");
    expect(log.filter((line) => line !== "settle")).toEqual(["on", "prove a", "measure a", "off"]);
    const check = store.tasks("old").find((task) => task.step === "check")!;
    expect(check).toMatchObject({ status: "skipped", note: "QA: run by day" });
    store.finish(check.id, "failed", "false row", "t");
    store.retry("old", "a");
    expect(store.tasks("old").map((task) => `${task.step} ${task.status}`)).toEqual(["prove done", "measure done", "check failed"]);
  });
});

describe("start checks", () => {
  test("reads the doctor list, and only real blockers stop a start", () => {
    const rows = [
      { name: "Claude login", status: "fail", blocking: true, detail: "x", fix: "run claude" },
      { name: "gates", status: "fail", blocking: true, detail: "busy" },
      { name: "seeds", status: "fail", blocking: false, detail: "x" },
    ];
    expect(doctorProblems(JSON.stringify(rows))).toEqual(["Claude login: run claude"]);
    expect(doctorProblems("not json")[0]).toContain("Doctor did not answer");
  });


  test("a plan limit is not an answer, even with ok inside other fields", () => {
    const limit = '{"type":"result","is_error":true,"result":"usage limit reached","usage":{"input_tokens":0}}';
    expect(claudeAnswered(1, limit)).toBe(false);
    expect(claudeAnswered(0, limit)).toBe(false);
    expect(claudeAnswered(0, '{"type":"result","is_error":false,"result":"ok"}')).toBe(true);
    expect(claudeAnswered(0, "")).toBe(false);
  });


  test("reads the real agent-desktop output", () => {
    const granted = '{"ok":true,"data":{"accessibility":{"state":"granted"},"automation":{"state":"unknown"},"screen_recording":{"state":"granted"}}}';
    expect(permissionProblems(granted)).toEqual([]);
    expect(permissionProblems(granted.replace('"screen_recording":{"state":"granted"}', '"screen_recording":{"state":"denied"}'))).toHaveLength(1);
    expect(permissionProblems("")).toEqual(["agent-desktop does not answer."]);
  });
});

describe("qa", () => {
  test("reads the last verdict line", () => {
    expect(parseVerdict("looks fine\nVERDICT: pass")).toEqual({ ok: true, note: "" });
    expect(parseVerdict("VERDICT: fail: the prompt was never sent")).toEqual({ ok: false, note: "the prompt was never sent" });
    expect(parseVerdict("no line").ok).toBe(false);
  });

  test("evidence names failed outputs and takes only this ADE", () => {
    const row = (ade: string, valid: boolean) => ({ ade, test_id: "A5", variant: "app", value: 1, unit: "MB", valid, invalid_reason: valid ? null : "timed_out", model: null }) as unknown as ResultRow;
    const text = evidence(dir, "orca", [row("orca", false), row("bb", true)]);
    expect(text).toContain("Rows: 1, valid 0.");
    expect(text).toContain("orca A5 app: timed_out");
  });
});

describe("permissions", () => {
  test("every measured app has a name and bundle to ask for", async () => {
    const { MEASURED_ADES } = await import("../control/real.ts");
    const { getAdapter } = await import("../adapters/registry.ts");
    for (const ade of MEASURED_ADES.filter((id) => id !== "bare-cli")) {
      const { appName, bundleId } = getAdapter(ade).calibration;
      expect(appName.length).toBeGreaterThan(0);
      expect(String(bundleId).length).toBeGreaterThan(0);
    }
  });
});

describe("permission setup is exclusive", () => {
  test("Start and a second setup do nothing while it runs, and shutdown waits for it", async () => {
    const before = process.env.ADEMARK_RESULTS;
    process.env.ADEMARK_RESULTS = dir;
    const { startControl } = await import("../control/server.ts");
    let calls = 0;
    let release = (): void => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    const control = startControl({
      dry: true,
      port: 0,
      ades: ["bare-cli"],
      permissions: async () => {
        calls += 1;
        await held;
        return [];
      },
    });
    const post = (path: string) => fetch(`${control.url}${path}`, { method: "POST", headers: { "x-ademark": "1" }, body: "{}" });
    await post("/api/permissions");
    await post("/api/permissions");
    await post("/api/start");
    const state = (await (await fetch(`${control.url}/api/state`)).json()) as { state: string; total: number };
    expect(calls).toBe(1);
    expect(state.state).toBe("permissions");
    expect(state.total).toBe(0);
    release();
    await control.stop();
    if (before === undefined) delete process.env.ADEMARK_RESULTS;
    else process.env.ADEMARK_RESULTS = before;
  });
});

describe("Claude desktop", () => {
  test("runs on the real model and is in the measured list", async () => {
    const { MEASURED_ADES } = await import("../control/real.ts");
    const { getAdapter } = await import("../adapters/registry.ts");
    expect(MEASURED_ADES).toContain("claude-desktop");
    expect(getAdapter("claude-desktop").liveModel).toBe(true);
    expect(getAdapter("orca").liveModel).toBeUndefined();
  });
});

describe("run order", () => {
  test("healthy apps first, apps that need a person last, random inside a tier", async () => {
    const { healthFirst } = await import("../control/server.ts");
    const ids = ["conductor", "orca", "bb", "monocode", "cloudroom", "emdash", "diri", "t3code"];
    const order = healthFirst(ids, "seed-1");
    expect(order.slice(0, 2).sort()).toEqual(["emdash", "monocode"]);
    expect(order.slice(-2).sort()).toEqual(["cloudroom", "conductor"]);
    expect(order.slice(4, 6).sort()).toEqual(["diri", "orca"]);
    expect([...order].sort()).toEqual([...ids].sort());
  });
});

// ADEMARK-38: Control pauses when this account is not on screen, and goes on alone when it comes back. Review of
// 2026-11-10: only clear answers count, three off reads in a row cut a step, and unknown never cuts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, PAUSED_NOTE, type EngineDeps } from "../control/engine.ts";
import { readSession, type Screen } from "../control/session.ts";
import { Store } from "../control/store.ts";

const session = (user: string, extra = ""): string => `<plist><dict><key>IOConsoleUsers</key><array>
<dict><key>kCGSSessionOnConsoleKey</key><true/>${extra}<key>kCGSSessionUserNameKey</key><string>${user}</string></dict>
</array></dict></plist>`;
const offConsole = (user: string): string => session(user).replace("<true/>", "<false/>");

describe("readSession", () => {
  test("on: console user is me, my session is on console and unlocked", () => {
    expect(readSession("ademark\n", session("ademark"), "ademark")).toEqual({ screen: "on", reason: "" });
  });
  test("off: another account in front", () => {
    expect(readSession("owner\n", session("owner"), "ademark").screen).toBe("off");
  });
  test("off: my session is not on console", () => {
    expect(readSession("ademark", offConsole("ademark"), "ademark").screen).toBe("off");
  });
  test("off: the screen is locked", () => {
    const locked = readSession("ademark", session("ademark", "<key>CGSSessionScreenIsLocked</key><true/>"), "ademark");
    expect(locked).toEqual({ screen: "off", reason: "the screen is locked" });
  });
  test("unknown: a plist with no IOConsoleUsers", () => {
    expect(readSession("ademark", "<plist/>", "ademark").screen).toBe("unknown");
  });
  test("unknown: stat named nobody", () => {
    expect(readSession("\n", session("ademark"), "ademark").screen).toBe("unknown");
  });
});

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-session-"));
  store = new Store(join(dir, "control.sqlite"));
  store.createRun("r", "s", ["a", "b"], false, "2026-11-10T00:00:00.000Z");
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake reader. `start` is read first (Start, then before each step), `during` is read during the first measure of
 * app a, then `after`, then "on". The first measure of a ends when it is aborted, or two reads after its script.
 */
function harness(o: { start?: Screen[]; during?: Screen[]; after?: Screen[] } = {}) {
  const log: string[] = [];
  const panel: string[] = [];
  const start = [...(o.start ?? [])];
  const after = [...(o.after ?? [])];
  let during: Screen[] | null = null;
  let extra = 0;
  let endMeasure: (() => void) | null = null;
  let firstMeasure = true;
  const screen = async (): Promise<Screen> => {
    if (during !== null) {
      if (during.length > 0) return during.shift()!;
      if (++extra >= 2) endMeasure?.();
      return "on";
    }
    return start.shift() ?? (firstMeasure ? undefined : after.shift()) ?? "on";
  };
  const deps: EngineDeps = {
    now: () => "2026-11-10T00:00:00.000Z",
    log: (line) => panel.push(line),
    settle: async () => {
      log.push("settle");
    },
    preflight: async () => [],
    machineOn: () => {},
    machineOff: () => {},
    prove: async (ade) => {
      log.push(`prove ${ade}`);
      return { ok: true, note: "" };
    },
    measure: async (ade, _run, _seed, attempt) => {
      log.push(`measure ${ade} ${attempt}`);
      if (ade !== "a" || !firstMeasure) return { ok: true, note: "" };
      firstMeasure = false;
      during = [...(o.during ?? [])];
      await new Promise<void>((done) => {
        endMeasure = done;
      });
      during = null;
      return { ok: true, note: "" };
    },
    rehearse: async () => ({ ok: true, note: "" }),
    topUpTests: async (ade, _run, attempt) => {
      log.push(`top-up plan ${ade} ${attempt}`);
      return { tests: [], note: "" };
    },
    topUp: async () => ({ ok: true, note: "" }),
    report: () => {},
    abort: () => {
      log.push("abort");
      endMeasure?.();
    },
    cleanup: async (ade) => {
      log.push(`cleanup ${ade}`);
      return [];
    },
    resume: () => {},
    screen,
    sleep: () => new Promise((done) => setTimeout(done, 1)),
    finishedAttempt: () => null,
    // ADEMARK-49: these tests plan no tokens or orchestration step; bench/test/control-late.test.ts does.
    tokens: async () => ({ ok: true, note: "" }),
    orchestration: async () => ({ ok: true, note: "" }),
    latePlan: () => ({ tokens: [], orchestration: [] }),
    modelAnswers: async () => true,
  };
  return { deps, log, panel };
}

const measures = (log: string[]): string[] => log.filter((line) => line.startsWith("measure a"));
const allDoneOnce = (): boolean => store.tasks("r").every((task) => task.status === "done" && task.attempts === 1);

describe("during a step", () => {
  test("one off read between good ones cuts nothing", async () => {
    const { deps, log } = harness({ during: ["on", "off", "on", "off", "on"] });
    await new Engine(store, deps).run("r", "s");
    expect(log).not.toContain("abort");
    expect(measures(log)).toEqual(["measure a 1"]);
    expect(allDoneOnce()).toBe(true);
  });

  test("two off reads, then on, then two off: no cut, an on read resets the count", async () => {
    const { deps, log } = harness({ during: ["off", "off", "on", "off", "off"] });
    await new Engine(store, deps).run("r", "s");
    expect(log).not.toContain("abort");
    expect(allDoneOnce()).toBe(true);
  });

  test("unknown reads cut nothing, and the first one is logged once", async () => {
    const { deps, log, panel } = harness({ during: Array<Screen>(10).fill("unknown") });
    await new Engine(store, deps).run("r", "s");
    expect(log).not.toContain("abort");
    expect(panel.filter((line) => line.includes("gave no answer")).length).toBe(1);
    expect(allDoneOnce()).toBe(true);
  });

  test("unknown neither counts nor resets: off, off, unknown, unknown, off cuts", async () => {
    const { deps, log } = harness({ during: ["off", "off", "unknown", "unknown", "off"] });
    await new Engine(store, deps).run("r", "s");
    expect(log).toContain("abort");
    expect(measures(log)).toEqual(["measure a 1", "measure a 1"]);
  });

  test("three off reads in a row cut the step: back in the queue, no attempt counted, no failure, then it runs again", async () => {
    // After the cut: two clear off reads keep Control paused, then the account comes back.
    const { deps, log, panel } = harness({ during: ["on", "off", "off", "off"], after: ["off", "off"] });
    const engine = new Engine(store, deps);
    const states: string[] = [];
    const watch = setInterval(() => states.push(engine.state), 1);
    await engine.run("r", "s");
    clearInterval(watch);
    const tasks = store.tasks("r");
    expect(tasks.filter((task) => task.status === "failed")).toEqual([]);
    expect(allDoneOnce()).toBe(true);
    expect(measures(log)).toEqual(["measure a 1", "measure a 1"]);
    expect(log.indexOf("cleanup a")).toBeLessThan(log.lastIndexOf("measure a 1"));
    expect(panel).toContain(PAUSED_NOTE);
    expect(states).toContain("paused");
    expect(engine.state).toBe("idle");
  });
});

describe("before a step and at Start", () => {
  test("off before a step: nothing starts until it comes back", async () => {
    // Start: on. Before prove a: off three times, then on.
    const { deps, log } = harness({ start: ["on", "off", "off", "off"] });
    await new Engine(store, deps).run("r", "s");
    expect(log.slice(0, 2)).toEqual(["settle", "prove a"]);
    expect(allDoneOnce()).toBe(true);
  });

  test("unknown is read again, and an off answer then pauses", async () => {
    const { deps, panel } = harness({ start: ["on", "unknown", "unknown", "off", "off"] });
    await new Engine(store, deps).run("r", "s");
    expect(panel).toContain(PAUSED_NOTE);
    expect(allDoneOnce()).toBe(true);
  });

  test("still unknown after 60 s: going on as on screen, and it says so", async () => {
    const { deps, log, panel } = harness({ start: Array<Screen>(13).fill("unknown") });
    const engine = new Engine(store, deps);
    await engine.run("r", "s");
    expect(engine.problems).toEqual([]);
    expect(panel.some((line) => line.includes("no answer for 60 s; going on as on screen"))).toBe(true);
    expect(log).toContain("prove a");
    expect(allDoneOnce()).toBe(true);
  });

  test("Start refuses to begin on a clear off answer, with a clear message", async () => {
    const { deps, log } = harness({ start: ["off"] });
    let preflight = 0;
    const engine = new Engine(store, { ...deps, preflight: async () => {
      preflight += 1;
      return [];
    } });
    await engine.run("r", "s");
    expect(engine.state).toBe("blocked");
    expect(engine.problems[0]).toContain("not on screen");
    expect(preflight).toBe(0);
    expect(log).toEqual([]);
    expect(store.tasks("r").every((task) => task.status === "pending" && task.attempts === 0)).toBe(true);
  });

  test("Stop while paused ends the wait", async () => {
    const { deps } = harness({ start: ["on", ...Array<Screen>(10_000).fill("off")] });
    const engine = new Engine(store, deps);
    const running = engine.run("r", "s");
    while (engine.state !== "paused") await new Promise((done) => setTimeout(done, 1));
    engine.stop();
    await running;
    expect(engine.state).toBe("idle");
    expect(store.tasks("r").every((task) => task.status === "pending")).toBe(true);
  });
});

// ADEMARK-36: each branch of one watchdog pass, with a fake clock and fake processes.
import { describe, expect, test } from "bun:test";
import type { Heartbeat } from "../control/files.ts";
import { MAX_RESTARTS, watchdogPass, watchdogPlist, type WatchdogDeps, type WatchdogState } from "../control/watchdog.ts";

const NOW = Date.parse("2026-11-10T03:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function beat(over: Partial<Heartbeat> = {}): Heartbeat {
  return {
    pid: 4242, port: 7788, run_id: "run", state: "working", intent: "running", ade: "orca", step: "measure",
    step_started_at: ago(10 * 60_000), step_limit_ms: 86 * 60_000, child_group: 5151, written_at: ago(20_000), ...over,
  };
}

function fake(o: { beat?: Heartbeat | null; run?: string | null; screen?: "on" | "off" | "unknown"; state?: WatchdogState | null; stubborn?: number[] } = {}) {
  const alive = new Set<number>([4242, -5151]);
  const signals: string[] = [];
  const lines: string[] = [];
  let launched = 0;
  let state: WatchdogState | null = o.state ?? null;
  const deps: WatchdogDeps = {
    now: () => NOW,
    heartbeat: () => (o.beat === undefined ? beat() : o.beat),
    openRun: () => (o.run === undefined ? "run" : o.run),
    screen: async () => o.screen ?? "on",
    isControl: async (pid) => pid === 4242,
    alive: (target) => alive.has(target),
    signal: (target, name) => {
      signals.push(`${name} ${target}`);
      if (name === "SIGKILL" || !(o.stubborn ?? []).includes(target)) alive.delete(target);
    },
    sleep: async () => {},
    launch: async () => {
      launched += 1;
    },
    log: (line) => lines.push(line),
    readState: () => state,
    writeState: (next) => {
      state = next;
    },
  };
  return { deps, signals, lines, launched: () => launched, state: () => state };
}

describe("watchdog pass", () => {
  test("no open run: nothing", async () => {
    const f = fake({ run: null, beat: beat({ written_at: ago(60 * 60_000) }) });
    expect(await watchdogPass(f.deps)).toBe("no open run");
    expect(f.signals).toEqual([]);
  });

  test("intent stopped: nothing, also with an old heartbeat", async () => {
    const f = fake({ beat: beat({ intent: "stopped", written_at: ago(60 * 60_000) }) });
    expect(await watchdogPass(f.deps)).toBe("intent stopped");
    expect(f.launched()).toBe(0);
  });

  test("this account is not on screen: nothing", async () => {
    const f = fake({ screen: "off", beat: beat({ written_at: ago(60 * 60_000) }) });
    expect(await watchdogPass(f.deps)).toBe("this account is not on screen");
    expect(f.signals).toEqual([]);
  });

  test("a reader that cannot tell does not hold a restart back", async () => {
    const f = fake({ screen: "unknown", beat: beat({ written_at: ago(60 * 60_000) }) });
    expect(await watchdogPass(f.deps)).toBe("restarted");
    expect(f.launched()).toBe(1);
  });

  test("a fresh heartbeat and a step inside its limit: nothing", async () => {
    const f = fake();
    expect(await watchdogPass(f.deps)).toBe("healthy");
    expect(f.signals).toEqual([]);
  });

  test("a heartbeat of exactly 5 minutes is still fresh", async () => {
    const f = fake({ beat: beat({ written_at: ago(5 * 60_000) }) });
    expect(await watchdogPass(f.deps)).toBe("healthy");
  });

  test("an old heartbeat while running: the reason is logged, Control and its group end, Control starts again", async () => {
    const f = fake({ beat: beat({ written_at: ago(5 * 60_000 + 1) }), stubborn: [4242] });
    expect(await watchdogPass(f.deps)).toBe("restarted");
    expect(f.signals).toEqual(["SIGTERM 4242", "SIGTERM -5151", "SIGKILL 4242"]);
    expect(f.launched()).toBe(1);
    expect(f.state()).toEqual({ run_id: "run", restarts: 1, gave_up: false });
    expect(f.lines[0]).toContain("heartbeat 300 s old");
  });

  test("a pid that is no Control any more is never signalled", async () => {
    const f = fake({ beat: beat({ pid: 999, written_at: ago(10 * 60_000) }) });
    expect(await watchdogPass(f.deps)).toBe("restarted");
    expect(f.signals).toEqual(["SIGTERM -5151"]);
  });

  test("a step past its limit plus 5 minutes, with a fresh heartbeat: only the child group ends", async () => {
    const f = fake({ beat: beat({ step_started_at: ago(86 * 60_000 + 5 * 60_000 + 1) }), stubborn: [-5151] });
    expect(await watchdogPass(f.deps)).toBe("ended an overdue step");
    expect(f.signals).toEqual(["SIGTERM -5151", "SIGKILL -5151"]);
    expect(f.launched()).toBe(0);
  });

  test("a step at its limit plus 5 minutes exactly: nothing", async () => {
    const f = fake({ beat: beat({ step_started_at: ago(91 * 60_000) }) });
    expect(await watchdogPass(f.deps)).toBe("healthy");
  });

  test(`after ${MAX_RESTARTS} restarts of one run it writes the reason once and does nothing more`, async () => {
    const f = fake({ beat: beat({ written_at: ago(10 * 60_000) }), state: { run_id: "run", restarts: MAX_RESTARTS, gave_up: false } });
    expect(await watchdogPass(f.deps)).toBe("gave up");
    expect(await watchdogPass(f.deps)).toBe("gave up");
    expect(f.lines.length).toBe(1);
    expect(f.signals).toEqual([]);
    expect(f.launched()).toBe(0);
  });

  test("the count belongs to one run: a new run starts at 0", async () => {
    const f = fake({ beat: beat({ written_at: ago(10 * 60_000) }), state: { run_id: "old", restarts: MAX_RESTARTS, gave_up: true } });
    expect(await watchdogPass(f.deps)).toBe("restarted");
    expect(f.state()).toEqual({ run_id: "run", restarts: 1, gave_up: false });
  });
});

describe("LaunchAgent", () => {
  test("runs one pass every 60 s with the launcher's PATH", () => {
    const plist = watchdogPlist("/Users/ademark/ADEMark", "/Users/ademark/ADEMark/results/watchdog-launchd.log");
    expect(plist).toContain("<string>dev.ademark.watchdog</string>");
    expect(plist).toContain("<key>StartInterval</key>\n  <integer>60</integer>");
    expect(plist).toContain("$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin");
    expect(plist).toContain("cd '/Users/ademark/ADEMark' &amp;&amp; exec bun bench/cli.ts watchdog --once");
  });
});

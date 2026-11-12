import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAdapter } from "../adapters/registry.ts";
import { resetMacosRunner, setMacosRunner } from "../adapters/macos.ts";
import type { Adapter, NativeProc, ResultRow, TestId } from "../core/contracts.ts";
import { RunWriter, validateRow } from "../core/results.ts";
import { createTestContext, type TestContext } from "../run/context.ts";
import { runTest } from "../run/loop.ts";
import type { TestRunner } from "../run/registry.ts";
import { runners } from "../tracks/a-timing/index.ts";
import { leftoverReason, notQuietNote, QUIT_FAILED } from "../tracks/a-timing/a2-relaunch.ts";
import {
  FIRST_READ_UNCHECKED,
  LATE_PROBE_LIMIT,
  lateProbeReason,
  lineHoldsProbe,
  probeRunLength,
  READY_NOT_PROBE,
  PROBE_IN_SHELL_REASON,
} from "../tracks/a-timing/shared.ts";
import {
  NEW_THREAD_REGION_OVERLAPS,
  NEW_THREAD_REGION_UNPROVEN,
  OLD_THREAD_AFTER_READY,
} from "../tracks/a-timing/a3-thread-open.ts";
import { LONG_MARKERS } from "../tracks/a-timing/a11-long-thread.ts";
import { PASTE_PROMPT } from "../tracks/a-timing/a4-first-word.ts";
import { makeTimingAdapter } from "./fixtures/tracks-a-timing/adapter.ts";
import { fakeRunner, FIXED_NOW } from "./adapters-fake.ts";
import {
  fixtureReplay,
  timingInstruments,
  writeEchoFrames,
  type TimingFailure,
  type TimingInstruments,
} from "./fixtures/tracks-a-timing/instruments.ts";

const REPLAY = resolve(import.meta.dir, "fixtures", "tracks-a-timing", "replay.jsonl");
const RUNNERS = new Map(runners.map((runner) => [runner.id, runner]));

function runnerFor(id: TestId): TestRunner {
  const runner = RUNNERS.get(id);
  if (runner === undefined) throw new Error(`no runner ${id}`);
  return runner;
}

let dir: string;

interface Harness {
  ctx: TestContext;
  instruments: TimingInstruments;
  writer: RunWriter;
  runDir: string;
}

function harness(options: {
  failure?: TimingFailure;
  dryRun?: boolean;
  adapter?: Adapter;
  gatesOk?: boolean;
  adapterDryRun?: boolean;
  replayMode?: "fixture" | "missing" | "none";
} = {}): Harness {
  const writer = new RunWriter(dir).open("timing-run");
  const instruments = timingInstruments(join(dir, "plan.jsonl"), {
    failure: options.failure,
    dryRun: options.dryRun,
    gatesOk: options.gatesOk,
  });
  const adapter = options.adapter ?? makeTimingAdapter();
  const state = new Map<string, unknown>([["launch_pid", 4242]]);
  const replayMode = options.replayMode ?? "fixture";
  if (replayMode === "fixture") state.set("replay", fixtureReplay(REPLAY));
  if (replayMode === "missing") state.set("replay", fixtureReplay(join(dir, "no-such-replay.jsonl")));
  const ctx = createTestContext({
    runId: "timing-run",
    runDir: writer.runDir,
    machineId: "machine-1",
    adapter,
    rowAde: adapter.id,
    track: "A",
    options: { model: null, effort: null, server: "replay", agent: "claude" },
    instruments,
    writer,
    adapterCtx: {
      runDir: writer.runDir,
      arenaPath: dir,
      worktree: dir,
      home: "/tmp/fixture-home",
      env: {},
      dryRun: options.adapterDryRun ?? true,
      log: () => {},
    },
    installed: { installed: true, version: "1.0.0", path: "/Applications/Fixture Timing.app", binarySha256: null },
    freshArena: async () => dir,
    state,
  });
  return { ctx, instruments, writer, runDir: writer.runDir };
}

async function runReps(id: TestId, h: Harness): Promise<ResultRow[]> {
  const runner = runnerFor(id);
  const rows: ResultRow[] = [];
  for (let rep = 1; rep <= runner.repeats(h.ctx); rep++) {
    for (const row of await runner.runRep(h.ctx, rep)) rows.push(validateRow(row));
  }
  return rows;
}

let savedFirstLaunch: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-timing-"));
  savedFirstLaunch = process.env.ADEMARK_FIRST_LAUNCH;
  process.env.ADEMARK_FIRST_LAUNCH = "1";
});

afterEach(() => {
  resetMacosRunner();
  rmSync(dir, { recursive: true, force: true });
  if (savedFirstLaunch === undefined) delete process.env.ADEMARK_FIRST_LAUNCH;
  else process.env.ADEMARK_FIRST_LAUNCH = savedFirstLaunch;
});

describe("A3: the old thread's marker proves the new thread (ADEMARK-40)", () => {
  type EchoCall = Parameters<TimingInstruments["echo"]>[0];
  type WatchCall = Parameters<TimingInstruments["watch"]>[0];

  // A fake screen: the seeded thread shows its marker in threadRect until a new-thread action that works replaces it.
  // The echo mirrors the native rule: a frame is Ready only when its composer echoes and threadRect has no marker.
  // markerAfterReady: the old thread's marker is read again right after Ready (Emdash 10 Nov: one misread Ready frame).
  // readyLines: the composer OCR of the Ready frame in the frames file.
  function screen(
    h: Harness,
    options: { markerOnScreen?: boolean; actionWorks?: boolean; nativeChecks?: boolean; markerAfterReady?: boolean; readyLines?: string[] } = {},
  ) {
    const watches: WatchCall[] = [];
    const afterReady: WatchCall[] = [];
    const echoes: EchoCall[] = [];
    h.instruments.watch = async (o) => {
      if (o.frames.endsWith("frames-after-ready.json")) {
        afterReady.push(o);
        return options.markerAfterReady === true
          ? { t0_ns: 0, seen_ns: 40_000_000, ms: 40, timed_out: false }
          : { t0_ns: 0, seen_ns: null, ms: null, timed_out: true };
      }
      watches.push(o);
      const seen = options.markerOnScreen ?? true;
      return seen ? { t0_ns: 0, seen_ns: 120_000_000, ms: 120, timed_out: false } : { t0_ns: 0, seen_ns: null, ms: null, timed_out: true };
    };
    h.instruments.echo = async (o) => {
      echoes.push(o);
      const opened = options.actionWorks ?? true;
      if (!opened) {
        // The probe echoes in the old composer, but the marker is still in threadRect on every frame: no Ready.
        return { t0_ns: 0, ready_ns: null, ready_ms: null, settled_ms: null, frames: 1800, timed_out: true, absent_seen: true, absent_checked: false };
      }
      const checked = options.nativeChecks ?? true;
      const echo = { t0_ns: 0, ready_ns: 180_000_000, ready_ms: 180, settled_ms: 900, frames: 60, timed_out: false, absent_seen: false, absent_checked: checked };
      writeEchoFrames(o.frames, echo, options.readyLines);
      return echo;
    };
    return { watches, echoes, afterReady };
  }

  function realHarness(adapter?: Adapter): Harness {
    return harness({ adapterDryRun: false, dryRun: false, adapter });
  }

  test("the good path opens the seeded thread untimed, reads its marker, then times the action with the marker as absent", async () => {
    const h = realHarness();
    const seen = screen(h);
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(true);
    expect(rows[0]!.value).toBe(180);
    expect(seen.watches).toHaveLength(1);
    expect(seen.watches[0]!).toMatchObject({ text: ["unchanged", "repository is unchanged"], nearly: true, region: { x: 0, y: 100, w: 1200, h: 600 } });
    expect(seen.watches[0]!.triggers).toEqual([]);
    expect(seen.echoes[0]!).toMatchObject({ absent: "unchanged", absentRegion: { x: 0, y: 100, w: 1200, h: 600 }, absentAlso: "repository is unchanged" });
    const notes = JSON.parse(rows[0]!.notes) as { absent_checked: boolean; marker_read_ms: number };
    expect(notes.absent_checked).toBe(true);
    expect(notes.marker_read_ms).toBe(120);
  });

  test("a marker never read before the action makes the repetition invalid only after shortThread was tried", async () => {
    const h = realHarness();
    const seen = screen(h, { markerOnScreen: false });
    await runnerFor("A3").runRep(h.ctx, 1);
    // On screen, then shortThread, then once more after a thread was seeded for the proof (2026-11-11).
    expect(seen.watches.map((watch) => watch.triggers)).toEqual([[], [{ kind: "click", point: { x: 30, y: 160 } }], []]);
  });

  test("no draft is typed in the old composer", async () => {
    const h = realHarness();
    screen(h);
    const order: string[] = [];
    const echo = h.instruments.echo;
    h.instruments.echo = async (o) => {
      order.push("echo");
      return echo(o);
    };
    const keys = h.instruments.keys;
    h.instruments.keys = async (o) => {
      order.push("keys");
      return keys(o);
    };
    await runnerFor("A3").runRep(h.ctx, 1);
    // The only keys are the clear before the seed, after the timed echo (ADEMARK-53).
    expect(order[0]).toBe("echo");
    expect(order.slice(1).every((call) => call === "keys")).toBe(true);
  });

  test("a marker never read before the action makes the repetition invalid before any time", async () => {
    const h = realHarness();
    const seen = screen(h, { markerOnScreen: false });
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(false);
    expect(rows[0]!.invalid_reason).toBe("the old thread's marker was not read before the action");
    expect(seen.echoes).toHaveLength(0);
  });

  test("a marker still present at the probe gives no Ready and the 30 s timeout reason", async () => {
    const h = realHarness();
    screen(h, { actionWorks: false });
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(false);
    expect(rows[0]!.invalid_reason).toBe("new thread did not appear in 30 s");
  });

  test("a new-thread action that does nothing gives an invalid row", async () => {
    const base = makeTimingAdapter();
    const h = realHarness({ ...base, timed: { ...base.timed, newThread: [{ kind: "wait", ms: 10 }] } });
    screen(h, { actionWorks: false });
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(false);
  });

  test("a Ready whose frame did not check the marker publishes no time", async () => {
    const h = realHarness();
    screen(h, { nativeChecks: false });
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(false);
    expect(rows[0]!.invalid_reason).toBe("the old thread's marker was not checked on the Ready frame, so the new thread is not proven");
  });

  test("a profile without threadRect or shortThread is invalid and never falls back to a draft", async () => {
    const base = makeTimingAdapter();
    const noRect = realHarness({ ...base, calibration: { ...base.calibration, threadRect: null } });
    const a = screen(noRect);
    expect((await runnerFor("A3").runRep(noRect.ctx, 1))[0]!.invalid_reason).toBe("not calibrated: threadRect");
    expect(a.echoes).toHaveLength(0);
    const { shortThread: _dropped, ...timed } = base.timed;
    const noShort = realHarness({ ...base, timed });
    const b = screen(noShort);
    expect((await runnerFor("A3").runRep(noShort.ctx, 1))[0]!.invalid_reason).toBe("not calibrated: shortThread");
    expect(b.echoes).toHaveLength(0);
    expect(noShort.instruments.calls).not.toContain("keys");
  });

  test("Orca's trailing wait is no longer timed nor a reason for not supported; a wait in the middle stays", async () => {
    const base = makeTimingAdapter();
    const orcaLike = realHarness({
      ...base,
      timed: { ...base.timed, newThread: [{ kind: "keys", combo: "cmd+alt+t" }, { kind: "wait", ms: 6000 }] },
    });
    const orca = screen(orcaLike);
    const rows = await runnerFor("A3").runRep(orcaLike.ctx, 1);
    expect(rows[0]!.valid).toBe(true);
    expect(orca.echoes[0]!.triggers).toEqual([{ kind: "keys", combo: "cmd+alt+t" }]);

    const middle = realHarness({
      ...base,
      timed: { ...base.timed, newThread: [{ kind: "keys", combo: "cmd+n" }, { kind: "wait", ms: 800 }, { kind: "click", point: { x: 1, y: 2 } }] },
    });
    const kept = screen(middle);
    await runnerFor("A3").runRep(middle.ctx, 1);
    expect(kept.echoes[0]!.triggers).toEqual([
      { kind: "keys", combo: "cmd+n" },
      { kind: "wait", ms: 800 },
      { kind: "click", point: { x: 1, y: 2 } },
    ]);
  });
});

describe("A3: each repetition seeds the thread it opened (ADEMARK-40 review R1)", () => {
  type WatchCall = Parameters<TimingInstruments["watch"]>[0];

  // A stateful fake app: the marker is on screen in a seeded thread. The timed action opens an empty thread; a seed turn
  // that finishes makes it a seeded thread; shortThread stops reaching a seeded thread once A3 has added one, as a
  // positional trigger (cmd+2, a fixed click) does.
  function app(options: { seed?: "ok" | "not-done" | "throws" } = {}) {
    let markerOnScreen = true;
    let shortThreadWorks = true;
    let sentSeed = false;
    const sends: string[] = [];
    const base = makeTimingAdapter();
    const adapter: Adapter = {
      ...base,
      send: async (_ctx, text) => {
        sends.push(text);
        if (options.seed === "throws") throw new Error("paste failed");
        sentSeed = text === "replay:seed";
      },
      waitDone: async () => {
        const done = (options.seed ?? "ok") === "ok";
        if (done && sentSeed) markerOnScreen = true;
        return { done, reason: done ? "fixture" : "fixture: seed turn did not end" };
      },
    };
    const h = harness({ adapterDryRun: false, dryRun: false, adapter });
    const watches: WatchCall[] = [];
    h.instruments.watch = async (o) => {
      watches.push(o);
      if (o.triggers.length > 0) markerOnScreen = shortThreadWorks;
      return markerOnScreen ? { t0_ns: 0, seen_ns: 1, ms: 50, timed_out: false } : { t0_ns: 0, seen_ns: null, ms: null, timed_out: true };
    };
    h.instruments.echo = async (o) => {
      markerOnScreen = false;
      shortThreadWorks = false;
      sentSeed = false;
      const echo = { t0_ns: 0, ready_ns: 1, ready_ms: 210, settled_ms: 800, frames: 40, timed_out: false, absent_seen: false, absent_checked: true };
      writeEchoFrames(o.frames, echo);
      return echo;
    };
    return { h, watches, sends };
  }

  test("repetition 2 finds the marker with no trigger, because repetition 1 seeded its new thread", async () => {
    const { h, watches, sends } = app();
    const first = await runnerFor("A3").runRep(h.ctx, 1);
    const second = await runnerFor("A3").runRep(h.ctx, 2);
    expect(sends).toEqual(["replay:seed", "replay:seed"]);
    expect(first[0]!.valid).toBe(true);
    expect(second[0]!.valid).toBe(true);
    expect(watches.filter((watch) => watch.triggers.length > 0)).toHaveLength(0);
    expect((JSON.parse(second[0]!.notes) as { marker_found_by: string }).marker_found_by).toBe("on screen");
  });

  test("a failed seed falls back to shortThread on the next repetition", async () => {
    for (const seed of ["not-done", "throws"] as const) {
      const { h, watches } = app({ seed });
      await runnerFor("A3").runRep(h.ctx, 1);
      watches.length = 0;
      const second = await runnerFor("A3").runRep(h.ctx, 2);
      expect(watches.map((watch) => watch.triggers.length)).toEqual([0, 1, 0]);
      // The positional shortThread no longer reaches a seeded thread here, and the seed for the proof fails as the
      // one before it did, so the repetition is invalid, not timed.
      expect(second[0]!.valid).toBe(false);
      expect(second[0]!.invalid_reason).toBe("the old thread's marker was not read before the action");
    }
  });

  // 2026-11-11, Emdash's top-up of A7 and A3: the open thread was one of A7's streams, and shortThread's click on the
  // first sidebar row opened another one. All three repetitions were invalid with no fault of the app.
  test("with no seeded thread on screen and a shortThread that reaches none, a thread is seeded before the timed action", async () => {
    const { h, watches, sends } = app();
    // A7 left a stream thread open: no marker, and the positional trigger opens another stream.
    const order: string[] = [];
    const watch = h.instruments.watch;
    let first = true;
    h.instruments.watch = async (o) => {
      order.push(o.triggers.length > 0 ? "watch shortThread" : "watch");
      if (first || o.triggers.length > 0) {
        first = false;
        watches.push(o);
        return { t0_ns: 0, seen_ns: null, ms: null, timed_out: true };
      }
      return watch(o);
    };
    const echo = h.instruments.echo;
    h.instruments.echo = async (o) => {
      order.push("echo");
      return echo(o);
    };
    const send = h.ctx.adapter.send;
    h.ctx.adapter.send = async (ctx, text) => {
      order.push(`send ${text}`);
      return send(ctx, text);
    };
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(true);
    expect(rows[0]!.value).toBe(210);
    expect((JSON.parse(rows[0]!.notes) as { marker_found_by: string }).marker_found_by).toBe("seeded now");
    // The seed for the proof goes out before the stopwatch, and the usual seed after it. The watch after the echo is
    // the read after Ready.
    expect(order).toEqual(["watch", "watch shortThread", "send replay:seed", "watch", "echo", "watch", "send replay:seed"]);
    expect(sends).toEqual(["replay:seed", "replay:seed"]);
  });

  test("a failed seed never changes the timed row", async () => {
    const good = app();
    const kept = (await runnerFor("A3").runRep(good.h.ctx, 1))[0]!;
    for (const seed of ["not-done", "throws"] as const) {
      const bad = app({ seed });
      const row = (await runnerFor("A3").runRep(bad.h.ctx, 1))[0]!;
      expect(row.valid).toBe(true);
      expect(row.value).toBe(kept.value);
      expect(row.invalid_reason).toBe(kept.invalid_reason);
      const { setup_ms: _a, ...rowNotes } = JSON.parse(row.notes) as Record<string, unknown>;
      const { setup_ms: _b, ...keptNotes } = JSON.parse(kept.notes) as Record<string, unknown>;
      expect(rowNotes).toEqual(keptNotes);
    }
  });

  // 2026-11-10, Diri: a composer that still held "demadem" sent it with the seed, and the next repetition had no marker.
  test("the composer is cleared with the profile's clear keys right before the seed", async () => {
    const order: string[] = [];
    const base = makeTimingAdapter();
    const { h } = app();
    const adapter = h.ctx.adapter;
    const send = adapter.send;
    adapter.send = async (ctx, text) => {
      order.push(`send ${text}`);
      await send(ctx, text);
    };
    Object.defineProperty(adapter, "calibration", { value: { ...base.calibration, clearKeys: ["ctrl+u"] } });
    h.instruments.keys = async (o) => {
      order.push(`keys ${"combo" in o ? o.combo : "text" in o ? o.text : "enter"}`);
      return { t_ns: 0 };
    };
    await runnerFor("A3").runRep(h.ctx, 1);
    expect(order).toEqual(["keys ctrl+u", "send replay:seed"]);
  });

  test("a profile without clear keys gets the helper's cmd+a, delete before the seed", async () => {
    const order: string[] = [];
    const { h } = app();
    const send = h.ctx.adapter.send;
    h.ctx.adapter.send = async (ctx, text) => {
      order.push(`send ${text}`);
      await send(ctx, text);
    };
    h.instruments.keys = async (o) => {
      order.push(`keys ${"combo" in o ? o.combo : "?"}`);
      return { t_ns: 0 };
    };
    expect(h.ctx.adapter.calibration.clearKeys).toBeUndefined();
    await runnerFor("A3").runRep(h.ctx, 1);
    expect(order).toEqual(["keys cmd+a", "keys delete", "send replay:seed"]);
  });

  test("a new thread that never appeared is not seeded", async () => {
    const { h, sends } = app();
    h.instruments.echo = async () => ({ t0_ns: 0, ready_ns: null, ready_ms: null, settled_ms: null, frames: 1800, timed_out: true, absent_seen: true, absent_checked: false });
    await runnerFor("A3").runRep(h.ctx, 1);
    expect(sends).toEqual([]);
  });
});

describe("A3 on a block with no replay (ADEMARK-40 review R2)", () => {
  test("Claude desktop's live model gives an exact not-supported reason, with no watch, echo or prompt", async () => {
    const base = makeTimingAdapter();
    const sends: string[] = [];
    const h = harness({
      adapterDryRun: false,
      dryRun: false,
      adapter: { ...base, liveModel: true, send: async (_ctx, text) => void sends.push(text) },
    });
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(false);
    expect(rows[0]!.invalid_reason).toBe("not supported here: without the replay server no seeded thread shows a certain marker");
    expect(h.instruments.calls).not.toContain("watch");
    expect(h.instruments.calls).not.toContain("echo");
    expect(sends).toEqual([]);
  });
});

describe("a known state before the quit (ADEMARK-42)", () => {
  function tracked(): { adapter: Adapter; calls: string[] } {
    const calls: string[] = [];
    const adapter = makeTimingAdapter({ onCall: (call) => calls.push(call) });
    adapter.beforeQuit = async (_ctx, before) => {
      calls.push(`adapter.beforeQuit.${before}`);
    };
    return { adapter, calls };
  }

  test("A1 runs the cold step before the quit, and A2 the relaunch step", async () => {
    const a1 = tracked();
    await runnerFor("A1").runRep(harness({ dryRun: false, adapter: a1.adapter }).ctx, 2);
    expect(a1.calls.slice(0, 2)).toEqual(["adapter.beforeQuit.cold", "adapter.quit"]);
    const a2 = tracked();
    await runnerFor("A2").runRep(harness({ dryRun: false, adapter: a2.adapter }).ctx, 1);
    expect(a2.calls.slice(0, 2)).toEqual(["adapter.beforeQuit.relaunch", "adapter.quit"]);
  });

  // 2026-11-10 (ADEMARK-53): Orca's step failed on a stopped app and made 13 rows invalid that 9 Nov had measured.
  test("a failed step is logged and noted, and the repetition is still quit and measured", async () => {
    for (const id of ["A1", "A2"] as TestId[]) {
      const { adapter, calls } = tracked();
      adapter.beforeQuit = async () => {
        throw new Error("step steps.beforeColdQuit[0] (run): orca failed");
      };
      const h = harness({ dryRun: false, adapter });
      const rows = await runnerFor(id).runRep(h.ctx, 2);
      expect(rows.map((row) => row.valid)).toEqual([true]);
      expect(rows[0]!.invalid_reason).toBeNull();
      expect(String(JSON.parse(rows[0]!.notes).before_quit_failed)).toContain("step steps.beforeColdQuit[0] (run): orca failed");
      expect(h.instruments.calls).toContain("echo");
      expect(calls).toContain("adapter.quit");
    }
  });

  test("a failed step stays in the notes of a row that is invalid for its own reason", async () => {
    const { adapter } = tracked();
    adapter.beforeQuit = async () => {
      throw new Error("orca failed");
    };
    const h = harness({ dryRun: false, adapter, failure: "timed-out" });
    const rows = await runnerFor("A2").runRep(h.ctx, 1);
    expect(rows[0]!.invalid_reason).toBe("timed_out");
    const notes = readFileSync(join(h.runDir, rows[0]!.receipts.log!), "utf8");
    expect(notes).toContain('"before_quit_failed": "before the relaunch quit: orca failed"');
  });
});

describe("A2 counts only the bundle's own executable as the app (ADEMARK-53)", () => {
  // Zeron 0.2.136 on 10 Nov: `zeron` quit, and `Zeron Engine` (also in Contents/MacOS) stayed with its Claude sessions.
  function zeronLike(alive: Array<{ pid: number; exe: string }>): Harness {
    const bundle = join(dir, "Zeron.app");
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    writeFileSync(
      join(bundle, "Contents", "Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>zeron</string></dict></plist>',
    );
    const procs: NativeProc[] = alive.map(({ pid, exe }) => ({
      pid,
      ppid: 1,
      path: join(bundle, "Contents", "MacOS", exe),
      name: exe,
      responsible_pid: null,
    }));
    setMacosRunner(
      fakeRunner("ademark", {
        run: (argv) => ({
          code: 0,
          stdout: argv[0] === "ps" ? procs.map((proc) => `${proc.pid} 501 ${proc.path}`).join("\n") : "",
          stderr: "",
        }),
        procs: async () => procs,
      }),
    );
    const base = makeTimingAdapter();
    const adapter: Adapter = { ...base, processes: () => ({ ...base.processes(), bundlePaths: [bundle], vendorDirs: [] }) };
    return harness({ dryRun: false, adapterDryRun: false, adapter });
  }

  test("an engine the quit leaves running is not the app, so the relaunch is measured", async () => {
    const h = zeronLike([{ pid: 900, exe: "Zeron Engine" }]);
    const rows = await runnerFor("A2").runRep(h.ctx, 1);
    expect(rows[0]!.invalid_reason).toBeNull();
    expect(rows[0]!.valid).toBe(true);
  });

  test("the bundle's executable still running fails the quit, and the reason names it", async () => {
    const h = zeronLike([
      { pid: 900, exe: "Zeron Engine" },
      { pid: 901, exe: "zeron" },
    ]);
    const rows = await runnerFor("A2").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(false);
    expect(rows[0]!.invalid_reason).toBe(`${QUIT_FAILED} (1 processes after 45 s: zeron)`);
    expect(h.instruments.calls).not.toContain("echo");
  });

  test("without a readable Info.plist every Contents/MacOS executable still counts", async () => {
    const h = zeronLike([{ pid: 900, exe: "Zeron Engine" }]);
    rmSync(join(dir, "Zeron.app", "Contents", "Info.plist"));
    const rows = await runnerFor("A2").runRep(h.ctx, 1);
    expect(rows[0]!.invalid_reason).toBe(`${QUIT_FAILED} (1 processes after 45 s: Zeron Engine)`);
  });
});

describe("A1 timeout reads the window once (ADEMARK-42)", () => {
  function timedOut(lines: string[]): Harness {
    setMacosRunner(
      fakeRunner("ademark", {
        run: (argv) => ({
          code: 0,
          stdout: argv[0] === "ps" ? "  555   501 /Applications/Fixture Timing.app/Contents/MacOS/Fixture Timing\n" : "",
          stderr: "",
        }),
      }),
    );
    const h = harness({ dryRun: false, failure: "timed-out" });
    h.instruments.ocr = async () => ({ lines });
    return h;
  }

  test("command not found in the window names the probe in the shell", async () => {
    const h = timedOut(["d", "ademark@reference-mac orca % dclaude --plugin-dir x --resume e5a3", "zsh: command not found: dclaude"]);
    const rows = await runnerFor("A1").runRep(h.ctx, 2);
    expect(rows[0]!.valid).toBe(false);
    expect(rows[0]!.invalid_reason).toBe(PROBE_IN_SHELL_REASON);
    const notes = readFileSync(join(h.runDir, rows[0]!.receipts.log!), "utf8");
    expect(notes).toContain("zsh: command not found: dclaude");
    expect(notes).toContain("timeout-window.png");
  });

  test("a window without it keeps timed_out", async () => {
    const h = timedOut(["Claude Code", "> "]);
    const rows = await runnerFor("A1").runRep(h.ctx, 2);
    expect(rows[0]!.invalid_reason).toBe("timed_out");
  });

  test("A2 never reads the window on a timeout", async () => {
    setMacosRunner(fakeRunner("ademark"));
    const h = harness({ dryRun: false, failure: "timed-out" });
    let reads = 0;
    h.instruments.ocr = async () => {
      reads += 1;
      return { lines: ["zsh: command not found: dclaude"] };
    };
    const rows = await runnerFor("A2").runRep(h.ctx, 1);
    expect(rows[0]!.invalid_reason).toBe("timed_out");
    expect(reads).toBe(0);
  });
});

describe("A2 after a quit that leaves the Mac busy", () => {
  // 2026-11-09: a 5 s cap ended A2 on MonoCode and Claude desktop with 0 processes of the app running.
  function busyHarness(leftovers: NativeProc[]): Harness {
    let listed = false;
    setMacosRunner(
      fakeRunner("ademark", {
        // The sweep lists the leftovers once; after the kill they are gone.
        procs: async () => {
          if (listed) return [];
          listed = true;
          return leftovers;
        },
      }),
    );
    const h = harness({ dryRun: false, adapterDryRun: false });
    h.instruments.idle = async () => ({ waited_ms: 60_000, quiet: false, cores_last: 0 });
    return h;
  }

  test("a quiet Mac launches as before", async () => {
    setMacosRunner(fakeRunner("ademark"));
    const h = harness({ dryRun: false, adapterDryRun: false });
    const rows = await runnerFor("A2").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(true);
    expect(rows[0]!.notes).not.toContain("idle_note");
    expect(h.ctx.state.get("A2.ended")).toBeUndefined();
  });

  test("busy with nothing of the app running goes on to the launch and notes the wait", async () => {
    const h = busyHarness([]);
    const first = await runnerFor("A2").runRep(h.ctx, 1);
    expect(first[0]!.valid).toBe(true);
    const notes = JSON.parse(first[0]!.notes) as { idle_note: string; idle_quiet: boolean; idle_ms: number };
    expect(notes.idle_note).toBe("the Mac was not quiet 60 s after the quit (0.00 cores), but no process of the app was running");
    expect(notes.idle_quiet).toBe(false);
    expect(notes.idle_ms).toBe(60_000);
    expect(h.ctx.state.get("A2.ended")).toBeUndefined();
    const second = await runnerFor("A2").runRep(h.ctx, 2);
    expect(second[0]!.valid).toBe(true);
  });

  test("busy with leftovers of the app sweeps them, ends A2 for the app and reopens it", async () => {
    const leftover: NativeProc = {
      pid: 777,
      ppid: 1,
      path: "/Applications/Fixture Timing.app/Contents/MacOS/agent",
      name: "agent",
      responsible_pid: null,
    };
    const h = busyHarness([leftover]);
    h.instruments.idle = async () => ({ waited_ms: 60_000, quiet: false, cores_last: 1.58 });
    h.ctx.state.set("launch_pid", 1);
    const first = await runnerFor("A2").runRep(h.ctx, 1);
    expect(first[0]!.valid).toBe(false);
    expect(first[0]!.invalid_reason).toBe(
      "1 processes of the app were still running after the quit (Mac at 1.58 cores after 60 s, busiest in cpu_top of notes.md), so A2 ends for this app",
    );
    expect(h.ctx.state.get("launch_pid")).toBe(4242);
    const second = await runnerFor("A2").runRep(h.ctx, 2);
    expect(second[0]!.valid).toBe(false);
    expect(second[0]!.invalid_reason).toBe(`A2 ended for this app: ${leftoverReason(1.58, 1)}`);
  });

  test("a busy Mac writes the busiest processes into notes.md, read once before the sweep (9 Nov)", async () => {
    const leftover: NativeProc = {
      pid: 777,
      ppid: 1,
      path: "/Applications/Fixture Timing.app/Contents/MacOS/agent",
      name: "agent",
      responsible_pid: null,
    };
    const h = busyHarness([leftover]);
    const waits: Array<number | undefined> = [];
    h.instruments.gates = async (o) => {
      waits.push(o?.quietWaitMs);
      return { swap_ok: true, swap_used_mb: 0, thermal_ok: true, cpu_quiet_ok: false, cpu_cores_used: 1.58, cpu_top: ["2.1.303 54.0", "zsh 1.2"] };
    };
    const rows = await runnerFor("A2").runRep(h.ctx, 1);
    expect(waits).toEqual([0]);
    const notes = readFileSync(join(h.runDir, rows[0]!.receipts.log!), "utf8");
    expect(notes).toContain('"2.1.303 54.0"');

    const idle = busyHarness([]);
    const valid = await runnerFor("A2").runRep(idle.ctx, 1);
    expect((JSON.parse(valid[0]!.notes) as { cpu_top: unknown }).cpu_top).toEqual([]);
  });

  test("the two texts differ", () => {
    expect(leftoverReason(0, 1)).not.toBe(notQuietNote(0));
  });
});

describe("timing runner shape", () => {
  test("index exports A1, A2, A3, A4 and A11 on track A", () => {
    expect(runners.map((runner) => runner.id).sort()).toEqual(["A1", "A11", "A2", "A3", "A4"]);
    for (const runner of runners) expect(runner.track).toBe("A");
  });

  test("repeats and extra runs follow TESTS.md", () => {
    const h = harness();
    expect(runnerFor("A1").repeats(h.ctx)).toBe(10);
    expect(runnerFor("A2").repeats(h.ctx)).toBe(10);
    expect(runnerFor("A3").repeats(h.ctx)).toBe(10);
    expect(runnerFor("A4").repeats(h.ctx)).toBe(10);
    expect(runnerFor("A11").repeats(h.ctx)).toBe(5);
    expect(runnerFor("A1").maxExtraRuns).toBe(3);
    expect(runnerFor("A4").maxExtraRuns).toBe(3);
    expect(runnerFor("A11").maxExtraRuns).toBe(1);
  });

  test("A1 to A4 declare their adaptive variant, minimum and tolerance", () => {
    expect(runnerFor("A1").adaptive).toEqual({ variant: "cold", min: 6, absTol: 1 / 60 });
    expect(runnerFor("A2").adaptive).toEqual({ variant: "relaunch", min: 6, absTol: 1 / 60 });
    expect(runnerFor("A3").adaptive).toEqual({ variant: "default-mode", min: 6, absTol: 1000 / 60 });
    expect(runnerFor("A4").adaptive).toEqual({ variant: "total", min: 6, absTol: 1000 / 60 });
    expect(runnerFor("A11").adaptive).toBeUndefined();
  });

  test("A1's adaptive stop still runs the first-launch tier before the sixth cold row", async () => {
    const h = harness({ dryRun: false });
    const written = await runTest(runnerFor("A1"), h.ctx, h.writer);
    expect(written).toBe(7);
    const rows = readFileSync(h.writer.rowsPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ResultRow);
    expect(rows.map((row) => row.variant)).toEqual(["first-launch", ...Array(6).fill("cold")]);
    expect(h.ctx.state.get("A1.first_launch")).toBe(true);
  });

  test("A1 and A2 wait for a quiet machine instead of a fixed sleep", async () => {
    const planPath = join(dir, "plan.jsonl");
    const readPlan = (): Array<{ call: string; args: Record<string, unknown> }> =>
      readFileSync(planPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { call: string; args: Record<string, unknown> });

    const a1 = await runReps("A1", harness({ dryRun: false }));
    expect(a1.length).toBe(11);
    const a1Notes = JSON.parse(a1[1]!.notes) as { idle_ms: number; idle_quiet: boolean };
    expect(a1Notes.idle_ms).toBe(0);
    expect(a1Notes.idle_quiet).toBe(true);
    const a1Idles = readPlan().filter((entry) => entry.call === "idle");
    expect(a1Idles.length).toBe(11);
    expect(a1Idles[0]!.args).toEqual({ cpuCores: 0.1, quietMs: 2000, capS: 10 });
    expect(readPlan().some((entry) => entry.call === "sleep" && entry.args.ms === 10000)).toBe(false);

    rmSync(planPath, { force: true });
    const a2 = await runReps("A2", harness({ dryRun: false }));
    expect(a2.length).toBe(10);
    const a2Notes = JSON.parse(a2[0]!.notes) as { idle_ms: number; idle_quiet: boolean };
    expect(a2Notes.idle_ms).toBe(0);
    expect(a2Notes.idle_quiet).toBe(true);
    const a2Idles = readPlan().filter((entry) => entry.call === "idle");
    expect(a2Idles.length).toBe(10);
    expect(a2Idles[0]!.args).toEqual({ cpuCores: 0.1, quietMs: 1000, capS: 60 });
    expect(readPlan().some((entry) => entry.call === "sleep" && entry.args.ms === 5000)).toBe(false);
  });
});

describe("timing runners with dry instruments", () => {
  test("A1 skips the first-launch tier unless ADEMARK_FIRST_LAUNCH=1", async () => {
    delete process.env.ADEMARK_FIRST_LAUNCH;
    const rows = await runReps("A1", harness({ dryRun: false }));
    expect(rows.map((row) => row.variant)).toEqual(Array(10).fill("cold"));
  });

  test("A1 writes the first-launch tier once and then ten cold rows in seconds", async () => {
    const h = harness({ dryRun: false });
    const rows = await runReps("A1", h);

    expect(rows.length).toBe(11);
    expect(rows.map((row) => row.variant)).toEqual(["first-launch", ...Array(10).fill("cold")]);
    for (const row of rows) {
      expect(row.valid).toBe(true);
      expect(row.invalid_reason).toBeNull();
      expect(row.unit).toBe("s");
      expect(row.value).toBeCloseTo(1.2, 10);
      expect(row.server).toBe("replay");
      expect(row.test_id).toBe("A1");
    }
    expect(h.ctx.state.get("A1.first_launch")).toBe(true);
    expect(rows[0]!.notes).toContain("not ranked");
    expect(rows[0]!.notes).toContain("Gatekeeper");
    expect(rows[0]!.notes).toContain('"settled_ms":1800');
    expect(rows[1]!.notes).not.toContain("not ranked");
    expect(rows[0]!.receipts.frames).toBe("fixture-timing/A1/rep-01/first-launch-frames.json");
    expect(rows[1]!.receipts.frames).toBe("fixture-timing/A1/rep-01/frames.json");
    expect(rows[1]!.receipts.video).toBe("fixture-timing/A1/rep-01/video.mov");
  });

  test("A2 writes ten relaunch rows in seconds", async () => {
    const rows = await runReps("A2", harness());
    expect(rows.length).toBe(10);
    expect(new Set(rows.map((row) => row.variant))).toEqual(new Set(["relaunch"]));
    for (const row of rows) {
      expect(row.valid).toBe(true);
      expect(row.unit).toBe("s");
      expect(row.value).toBeCloseTo(1.2, 10);
    }
  });

  test("A3 writes ten default-mode rows in milliseconds with the ±67 ms bound in notes", async () => {
    const rows = await runReps("A3", harness({ dryRun: false }));
    expect(rows.length).toBe(10);
    for (const row of rows) {
      expect(row.valid).toBe(true);
      expect(row.variant).toBe("default-mode");
      expect(row.unit).toBe("ms");
      expect(row.value).toBe(1200);
      expect(row.notes).toContain('"bound_ms":67');
      expect(row.notes).toContain('"settled_ms":1800');
    }
  });

  test("A4 splits total, before-request and on-screen from the replay log", async () => {
    const h = harness({ dryRun: false });
    const rows = await runReps("A4", h);
    expect(rows.length).toBe(30);
    for (let rep = 0; rep < 10; rep++) {
      const group = rows.slice(rep * 3, rep * 3 + 3);
      expect(group.map((row) => row.variant)).toEqual(["total", "before-request", "on-screen"]);
      expect(group.map((row) => row.value)).toEqual([900, 2, 898]);
      for (const row of group) {
        expect(row.valid).toBe(true);
        expect(row.unit).toBe("ms");
        expect(row.receipts.frames).toBe(`fixture-timing/A4/rep-${String(rep + 1).padStart(2, "0")}/frames.json`);
      }
    }
    expect(rows[0]!.notes).toContain('"t_request_ns":2000000');
    expect(h.instruments.calls).toEqual(Array(10).fill(["keys", "watch"]).flat());
  });

  test("A4 pastes the prompt on Diri, which reads key codes and got replayahi on 10 Nov", async () => {
    const h = harness({ dryRun: false, adapter: makeTimingAdapter({ id: "diri" }) });
    const logged: string[] = [];
    h.ctx.adapterCtx.log = (line: string) => logged.push(line);
    const rows = await runReps("A4", h);
    expect(rows.every((row) => row.valid)).toBe(true);
    expect(h.instruments.calls).toEqual(Array(10).fill(["watch"]).flat());
    expect(logged.filter((line) => line.startsWith("plan: paste") && line.includes("text=replay:hi")).length).toBe(10);
    expect(PASTE_PROMPT.has("fixture-timing")).toBe(false);
  });

  test("A11 builds the long thread once and writes four rows per repetition", async () => {
    const h = harness({ dryRun: false });
    const rows = await runReps("A11", h);
    expect(rows.length).toBe(20);
    for (let rep = 0; rep < 5; rep++) {
      const group = rows.slice(rep * 4, rep * 4 + 4);
      expect(group.map((row) => row.variant)).toEqual(["open", "scroll-gaps", "scroll-max-gap", "switch"]);
      expect(group.map((row) => row.unit)).toEqual(["ms", "frames", "ms", "ms"]);
      expect(group.map((row) => row.value)).toEqual([900, 0, 0, 900]);
      expect(group.every((row) => row.valid)).toBe(true);
    }
    expect(h.ctx.state.get("A11.ready")).toBe(true);
    expect(rows[0]!.notes).toContain("pilot item");
    // 20 per-repetition watches plus one that waits for the long thread to finish drawing.
    expect(h.instruments.calls.filter((call) => call === "watch").length).toBe(21);
    expect(h.instruments.calls.filter((call) => call === "scroll").length).toBe(10);
  });

  test("A11's end texts match Orca's two spellings and never a line about loading or switching threads", () => {
    // The watch's own rule (ProbeMatcher.normalize): lowercase, letters and digits only, then an exact substring.
    const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
    const matches = (line: string) => LONG_MARKERS.some((needle) => normalize(line).includes(normalize(needle)));
    expect(matches("L(NGTHREA&END. That ts every IMe of src/Mvoice5.t5. and the totals add up.")).toBe(true);
    expect(matches("L(NGTHREAFEND. That is every line of 5rc/invoices.ts, and the totals add up.")).toBe(true);
    expect(matches("LONfjTHREAD-END. That is every line")).toBe(true);
    for (const line of ["Loading thread...", "Opening thread", "Switching threads"]) expect(matches(line)).toBe(false);
  });

  test("A11 watches the drain, the open and the return for THREAD-END, then Orca's two spellings (8 and 9 Nov)", async () => {
    const h = harness({ dryRun: false });
    await runReps("A11", h);
    const watches = readFileSync(join(dir, "plan.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { call: string; args: { text: unknown; frames: string } })
      .filter((entry) => entry.call === "watch");
    const ends = watches.filter((entry) => /frames-(drain|open|return)\.json$/.test(entry.args.frames));
    // One drain, then an open and a return in each of 5 repetitions.
    expect(ends.length).toBe(11);
    for (const entry of ends) expect(entry.args.text).toEqual(["THREAD-END", "NGTHREAEND", "NGTHREAFEND"]);
    const others = watches.filter((entry) => /frames-(setup|switch)\.json$/.test(entry.args.frames));
    for (const entry of others) expect(typeof entry.args.text).toBe("string");
  });
});

describe("timing runners without calibration", () => {
  // T3 Code's regions were calibrated in the pilot (2026-10-20); this copy has them cleared again.
  function uncalibratedT3Code(): Adapter {
    const adapter = getAdapter("t3code");
    return {
      ...adapter,
      calibration: { ...adapter.calibration, composerRect: null, activeComposerRect: null, threadRect: null },
    };
  }

  test("t3code gaps give one invalid row per variant and no instrument call", async () => {
    const cases: Array<[TestId, number, string]> = [
      ["A1", 2, "not calibrated: composerRect"],
      ["A2", 1, "not calibrated: composerRect"],
      ["A3", 1, "not calibrated: composerRect"],
      ["A4", 3, "not calibrated: threadRect"],
      ["A11", 4, "not calibrated: threadRect"],
    ];
    for (const [id, count, reason] of cases) {
      const h = harness({ adapter: uncalibratedT3Code() });
      const rows = await runnerFor(id).runRep(h.ctx, 1);
      expect(rows.length).toBe(count);
      for (const row of rows) {
        expect(row.valid).toBe(false);
        expect(row.invalid_reason).toBe(reason);
      }
      expect(h.instruments.calls).toEqual([]);
    }
  });

  test("the first-launch row is invalid only once per block when calibration is missing", async () => {
    const h = harness({ adapter: getAdapter("t3code") });
    const first = await runnerFor("A1").runRep(h.ctx, 1);
    const second = await runnerFor("A1").runRep(h.ctx, 2);
    expect(first.map((row) => row.variant)).toEqual(["first-launch", "cold"]);
    expect(second.map((row) => row.variant)).toEqual(["cold"]);
  });
});

describe("timing runner invalidity rules", () => {
  test("A1 invalidates the row when an attributed process survives the kill", async () => {
    const survivor: NativeProc = {
      pid: 777,
      ppid: 1,
      path: "/Applications/Fixture Timing.app/Contents/MacOS/Fixture Timing",
      name: "Fixture Timing",
      responsible_pid: null,
    };
    let clock = FIXED_NOW;
    const runner = fakeRunner("ademark", { now: () => (clock += 1_000), procs: async () => [survivor] });
    setMacosRunner(runner);
    const h = harness({ adapterDryRun: false });
    const rows = await runnerFor("A1").runRep(h.ctx, 1);

    expect(rows.map((row) => row.variant)).toEqual(["first-launch", "cold"]);
    for (const row of rows) {
      expect(row.valid).toBe(false);
      expect(row.invalid_reason).toBe("processes survived");
    }
    expect(h.instruments.calls).toEqual([]);
    expect(runner.commands).toContainEqual(["kill", "-9", "777"]);
    expect(runner.commands).toContainEqual(["launchctl", "bootout", "gui/501/com.fixture.timing.helper"]);
  });

  test("A1 with a host that stays open kills only the agent CLIs under it and skips the first-launch tier", async () => {
    const proc = (pid: number, ppid: number, path: string): NativeProc => ({
      pid,
      ppid,
      path,
      name: path.split("/").pop()!,
      responsible_pid: null,
    });
    const host = proc(4242, 1, "/Applications/Fixture Timing.app/Contents/MacOS/Fixture Timing");
    const shell = proc(500, 4242, "/bin/zsh");
    const agent = proc(501, 500, "/Users/ademark/.local/bin/claude");
    const elsewhere = proc(900, 1, "/Users/ademark/.local/bin/claude");
    let clock = FIXED_NOW;
    const killed = (p: NativeProc) => runner.commands.some((argv) => argv[0] === "kill" && argv[2] === String(p.pid));
    const runner = fakeRunner("ademark", {
      now: () => (clock += 1_000),
      procs: async () => [host, shell, agent, elsewhere].filter((p) => !killed(p)),
    });
    setMacosRunner(runner);
    const h = harness({ adapter: { ...makeTimingAdapter(), hostStaysOpen: true }, adapterDryRun: false });
    const rows = await runnerFor("A1").runRep(h.ctx, 1);

    expect(rows.map((row) => row.variant)).toEqual(["cold"]);
    const kills = runner.commands.filter((argv) => argv[0] === "kill");
    expect(kills).toEqual([["kill", "-9", "501"]]);
  });

  test("A1 and A2 invalidate on a failed quiet-CPU gate", async () => {
    const a1 = await runReps("A1", harness({ gatesOk: false }));
    expect(a1.length).toBe(11);
    expect(a1.every((row) => row.invalid_reason === "gate failure")).toBe(true);

    const a2 = await runReps("A2", harness({ gatesOk: false }));
    expect(a2.every((row) => row.invalid_reason === "gate failure")).toBe(true);
  });

  test("A4 invalidates all three splits when the replay log has no request", async () => {
    const rows = await runReps("A4", harness({ replayMode: "missing" }));
    expect(rows.length).toBe(30);
    expect(rows.every((row) => row.invalid_reason === "no replay request")).toBe(true);
  });

  test("A4 invalidates all three splits when the block publishes no replay control", async () => {
    const h = harness({ replayMode: "none" });
    const rows = await runReps("A4", h);
    expect(rows.length).toBe(30);
    expect(rows.every((row) => row.invalid_reason === "no replay control")).toBe(true);
    expect(h.instruments.calls).toEqual([]);
  });

  test("A11 invalidates every row when the long thread does not finish", async () => {
    const h = harness({ adapter: makeTimingAdapter({ waitDone: false }) });
    const rows = await runReps("A11", h);
    expect(rows.length).toBe(20);
    expect(rows.every((row) => row.invalid_reason === "long thread not built")).toBe(true);
    expect(h.ctx.state.get("A11.ready")).toBe(false);
    expect(h.instruments.calls).toEqual([]);
  });
});

describe("timing runner instrument failures", () => {
  test("echo and watch timeouts invalidate the rows with their reasons", async () => {
    const a1 = await runReps("A1", harness({ failure: "timed-out" }));
    expect(a1.length).toBe(11);
    expect(a1.every((row) => !row.valid && row.invalid_reason === "timed_out")).toBe(true);

    const a2 = await runReps("A2", harness({ failure: "timed-out" }));
    expect(a2.every((row) => !row.valid && row.invalid_reason === "timed_out")).toBe(true);

    // The watch that reads the old thread's marker times out first, so no A3 time is taken.
    const a3 = await runReps("A3", harness({ failure: "timed-out" }));
    expect(a3.every((row) => row.invalid_reason === "the old thread's marker was not read before the action")).toBe(true);

    const a4 = await runReps("A4", harness({ failure: "timed-out" }));
    expect(a4.every((row) => !row.valid && row.invalid_reason === "timed_out")).toBe(true);

    const a11 = await runReps("A11", harness({ failure: "timed-out" }));
    // The setup watch timed out too, so the open is never timed: the long thread could still be on screen.
    expect(a11.filter((row) => row.variant === "open").every((row) => row.invalid_reason === "the short thread did not show before the open")).toBe(true);
    // Without the long thread, scroll and switch would time the short one and look valid.
    const others = a11.filter((row) => row.variant !== "open");
    // Scroll and switch need the long thread on screen; here the setup already failed, and they say so.
    expect(others.every((row) => row.invalid_reason === "the short thread did not show before the open")).toBe(true);
  });

  test("a NativeFailure becomes an invalid row with trigger_skipped", async () => {
    for (const id of ["A1", "A2", "A3", "A4", "A11"] as TestId[]) {
      const rows = await runReps(id, harness({ failure: "native-failure" }));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => !row.valid && row.invalid_reason === "trigger_skipped")).toBe(true);
    }
  });
});

// ADEMARK-55: the first read of the probe on the Ready frame. The OCR lines are the night's own
// (control-2026-11-10T08-31-19Z): T3 Code's composer region read nothing until the probe was 88 characters long.
const NIGHT_READS = JSON.parse(
  readFileSync(resolve(import.meta.dir, "fixtures", "tracks-a-timing", "first-reads-2026-11-10.json"), "utf8"),
) as { reads: Array<{ attempt: string; test: string; rep: number; ocr: string[]; chars: number }> };
const T3_READ = NIGHT_READS.reads.find((read) => read.attempt.endsWith("t3code-1") && read.test === "A3")!;

describe("the first read of the probe must be short (ADEMARK-55)", () => {
  test("only T3 Code's rows of 10 Nov read more than two probe cycles at the first read", () => {
    expect(LATE_PROBE_LIMIT).toBe(18);
    expect(NIGHT_READS.reads.length).toBeGreaterThan(25);
    for (const read of NIGHT_READS.reads) {
      const chars = Math.max(0, ...read.ocr.map((line) => probeRunLength(line)));
      expect(chars).toBe(read.chars);
      const late = chars > LATE_PROBE_LIMIT;
      expect(`${read.attempt} ${read.test} ${late}`).toBe(`${read.attempt} ${read.test} ${read.attempt.endsWith("t3code-1")}`);
    }
  });

  test("an OCR misread inside the run does not shorten it", () => {
    expect(probeRunLength("ademarkqzademarkq2ademarkqz")).toBe(27);
    // Bare CLI A1 on 10 Nov: its prompt glyph and a misread "r" are around the run.
    expect(probeRunLength("l adeMapkqzadem")).toBe(13);
    // Traycer A1 on 10 Nov: ordinary text. The misread tolerance lets it reach 4, far below the limit.
    expect(probeRunLength("point-. the comparison has to be on the parsed date, not on the string, or a I")).toBe(4);
  });

  function lateEcho(h: Harness, lines: string[]) {
    h.instruments.echo = async (o) => {
      const echo = { t0_ns: 0, ready_ns: 8_540_000_000, ready_ms: 8540, settled_ms: 9000, frames: 200, timed_out: false, absent_seen: false, absent_checked: true };
      writeEchoFrames(o.frames, echo, lines);
      return echo;
    };
  }

  for (const id of ["A1", "A2"] as const) {
    test(`${id}: a first read of 88 characters makes the row invalid; a short one stays valid`, async () => {
      const late = harness({ dryRun: false });
      lateEcho(late, T3_READ.ocr);
      const rows = await runnerFor(id).runRep(late.ctx, 2);
      expect(rows.at(-1)!.valid).toBe(false);
      expect(rows.at(-1)!.invalid_reason).toBe(lateProbeReason(88));
      const short = harness({ dryRun: false });
      lateEcho(short, ["ademarkqzade"]);
      const kept = await runnerFor(id).runRep(short.ctx, 2);
      expect(kept.at(-1)!.valid).toBe(true);
      expect(kept.at(-1)!.notes).toContain('"first_read_chars":12');
    });
  }

  test("A3: a first read of 88 characters makes the row invalid", async () => {
    const h = harness({ adapterDryRun: false, dryRun: false });
    lateEcho(h, T3_READ.ocr);
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(false);
    expect(rows[0]!.invalid_reason).toBe(lateProbeReason(88));
  });

  test("a real run without the Ready frame in the frames file is invalid; a dry run only notes it", async () => {
    const real = harness({ dryRun: false });
    real.instruments.echo = async () => ({ t0_ns: 0, ready_ns: 5, ready_ms: 1200, settled_ms: 1800, frames: 72, timed_out: false });
    const rows = await runnerFor("A2").runRep(real.ctx, 1);
    expect(rows[0]!.invalid_reason).toBe(`${FIRST_READ_UNCHECKED}: the frames file is missing`);
    const dry = harness({ dryRun: true });
    dry.instruments.dryRun = true;
    dry.instruments.echo = real.instruments.echo;
    const dryRows = await runnerFor("A2").runRep(dry.ctx, 1);
    expect(dryRows[0]!.valid).toBe(true);
  });
});

describe("A3: the old thread must be gone after Ready too (ADEMARK-55)", () => {
  function a3Harness(adapter?: Adapter, options: { markerAfterReady?: boolean } = {}) {
    const h = harness({ adapterDryRun: false, dryRun: false, adapter });
    const afterReady: Array<Parameters<TimingInstruments["watch"]>[0]> = [];
    const echoes: Array<Parameters<TimingInstruments["echo"]>[0]> = [];
    h.instruments.watch = async (o) => {
      if (o.frames.endsWith("frames-after-ready.json")) {
        afterReady.push(o);
        if (options.markerAfterReady === true) return { t0_ns: 0, seen_ns: 30_000_000, ms: 30, timed_out: false };
        return { t0_ns: 0, seen_ns: null, ms: null, timed_out: true };
      }
      return { t0_ns: 0, seen_ns: 1, ms: 50, timed_out: false };
    };
    h.instruments.echo = async (o) => {
      echoes.push(o);
      const echo = { t0_ns: 0, ready_ns: 190_000_000, ready_ms: 190, settled_ms: 800, frames: 40, timed_out: false, absent_seen: false, absent_checked: o.absentRegion !== undefined };
      writeEchoFrames(o.frames, echo);
      return echo;
    };
    return { h, afterReady, echoes };
  }

  test("the marker read after Ready makes the row invalid", async () => {
    const { h, afterReady } = a3Harness(undefined, { markerAfterReady: true });
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(false);
    expect(rows[0]!.invalid_reason).toBe(OLD_THREAD_AFTER_READY);
    expect(afterReady).toHaveLength(1);
    expect(afterReady[0]!).toMatchObject({
      text: ["unchanged", "repository is unchanged"],
      nearly: true,
      region: { x: 0, y: 100, w: 1200, h: 600 },
      triggers: [],
      timeoutS: 1,
    });
  });

  test("a clean new thread stays valid, with the same time", async () => {
    const { h, afterReady } = a3Harness();
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(true);
    expect(rows[0]!.value).toBe(190);
    expect(afterReady).toHaveLength(1);
    expect(JSON.parse(rows[0]!.notes)).toMatchObject({ marker_after_ready: "not read", first_read_chars: 3 });
  });
});

describe("A3: the new thread's own composer region (ADEMARK-55, Emdash's Create Task modal)", () => {
  const MODAL = { x: 565, y: 558, w: 470, h: 32 };
  const OLD_COMPOSER = { x: 328, y: 908, w: 1260, h: 26 };

  function withRegion(region: { x: number; y: number; w: number; h: number }, old: typeof OLD_COMPOSER | null): Adapter {
    const base = makeTimingAdapter();
    return { ...base, calibration: { ...base.calibration, newThreadComposerRect: region, activeComposerRect: old } };
  }

  function harnessFor(adapter: Adapter) {
    const h = harness({ adapterDryRun: false, dryRun: false, adapter });
    const echoes: Array<Parameters<TimingInstruments["echo"]>[0]> = [];
    const afterReady: string[] = [];
    h.instruments.watch = async (o) => {
      if (o.frames.endsWith("frames-after-ready.json")) afterReady.push(o.frames);
      // The modal leaves the old thread on screen: its marker is read every time.
      return { t0_ns: 0, seen_ns: 1, ms: 50, timed_out: false };
    };
    h.instruments.echo = async (o) => {
      echoes.push(o);
      const echo = { t0_ns: 0, ready_ns: 1_001_000_000, ready_ms: 1001, settled_ms: 1500, frames: 60, timed_out: false, absent_seen: false, absent_checked: false };
      writeEchoFrames(o.frames, echo, ["add"]);
      return echo;
    };
    return { h, echoes, afterReady };
  }

  test("the echo is read in that region, with no marker asked to go and no read after Ready", async () => {
    const { h, echoes, afterReady } = harnessFor(withRegion(MODAL, OLD_COMPOSER));
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(true);
    expect(rows[0]!.value).toBe(1001);
    expect(echoes[0]!.region).toEqual(MODAL);
    expect(echoes[0]!.absent).toBeUndefined();
    expect(echoes[0]!.absentRegion).toBeUndefined();
    expect(afterReady).toHaveLength(0);
    expect(JSON.parse(rows[0]!.notes)).toMatchObject({ new_thread_region: "newThreadComposerRect", fixed_wait_ms: 0 });
  });

  test("a region that overlaps the old composer, or one with no old composer to compare, proves nothing", async () => {
    const over = harnessFor(withRegion({ x: 400, y: 900, w: 300, h: 40 }, OLD_COMPOSER));
    expect((await runnerFor("A3").runRep(over.h.ctx, 1))[0]!.invalid_reason).toBe(NEW_THREAD_REGION_OVERLAPS);
    expect(over.echoes).toHaveLength(0);
    const unproven = harnessFor(withRegion(MODAL, null));
    expect((await runnerFor("A3").runRep(unproven.h.ctx, 1))[0]!.invalid_reason).toBe(NEW_THREAD_REGION_UNPROVEN);
  });

  test("without the region A3 still asks the native helper to check the marker on the Ready frame", async () => {
    const { h, echoes } = harnessFor(makeTimingAdapter());
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(echoes[0]!.absent).toBe("unchanged");
    expect(rows[0]!.invalid_reason).toBe("the old thread's marker was not checked on the Ready frame, so the new thread is not proven");
  });

  test("the long first-read guard applies in that region too", async () => {
    const { h } = harnessFor(withRegion(MODAL, OLD_COMPOSER));
    h.instruments.echo = async (o) => {
      const echo = { t0_ns: 0, ready_ns: 9, ready_ms: 900, settled_ms: 1500, frames: 60, timed_out: false };
      writeEchoFrames(o.frames, echo, T3_READ.ocr);
      return echo;
    };
    expect((await runnerFor("A3").runRep(h.ctx, 1))[0]!.invalid_reason).toBe(lateProbeReason(88));
  });
});

describe("A3 names a fixed wait inside the stopwatch (ADEMARK-55)", () => {
  test("Emdash's 800 ms before the click on the modal's prompt box is in the row's notes", async () => {
    const base = makeTimingAdapter();
    const adapter: Adapter = {
      ...base,
      timed: {
        ...base.timed,
        newThread: [{ kind: "keys", combo: "cmd+n" }, { kind: "wait", ms: 800 }, { kind: "click", point: { x: 770, y: 573 } }, { kind: "wait", ms: 500 }],
      },
    };
    const h = harness({ adapterDryRun: false, dryRun: false, adapter });
    h.instruments.watch = async (o) =>
      o.frames.endsWith("frames-after-ready.json")
        ? { t0_ns: 0, seen_ns: null, ms: null, timed_out: true }
        : { t0_ns: 0, seen_ns: 1, ms: 50, timed_out: false };
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(rows[0]!.valid).toBe(true);
    // The trailing wait is dropped from the triggers; the one in the middle stays and is named.
    expect(JSON.parse(rows[0]!.notes)).toMatchObject({ fixed_wait_ms: 800, dropped_trailing_waits: 1 });
  });
});

describe("Ready must come from the probe, not from ordinary text (ADEMARK-55 review R1)", () => {
  // Real OCR lines of 10 Nov (control-2026-11-10T08-31-19Z). Echoes: Bare CLI, bb, Diri, Emdash, MonoCode, Paseo,
  // Traycer A3, Zeron. Text: bb's placeholder (A1, A2), Traycer's start and transcript (A1), Emdash's placeholder (A3).
  const ECHOES = ["ad4", "adl", "adern", "ad\u2022nl", "denl", "detn", "brk", "ozadl", "adl | Full accee", "> Tharkqzl", ") rkgiadl", "l ademl", "l adeMapkl", "add"];
  const TEXT = [
    "SK anythlng. @ io meniion flles. folders. or sectlons",
    "Ask anythlng. @ io meniion flles. folders. or sectlons",
    "...the comparison has to be on the parsed date, not on the string",
    "Show det8ils v | Open setting5",
    "De8crlb8 whatth8 agent should do, or us8 I tO 88lect a prompt",
  ];

  // 11 Nov: bb and Traycer reached Ready on their placeholder again, so the typing stopped and no echo was ever timed.
  test("a profile's own probe: no pair of it is in the app's placeholder, and only its typed text is an echo", () => {
    const pairs = (probe: string): string[] => [...probe].map((letter, index) => `${letter}${probe[(index + 1) % probe.length]}`);
    const placeholders: Record<string, string> = {
      bb: "Ask anything. @ to mention files, folders, or sections",
      traycer: "Ask anything, @tag files/folder, or use / to show available commands",
    };
    for (const [ade, placeholder] of Object.entries(placeholders)) {
      const profile = JSON.parse(readFileSync(join(import.meta.dir, "..", "adapters", "profiles", `${ade}.json`), "utf8")) as { calibration: { probe?: string } };
      const probe = profile.calibration.probe!;
      expect(probe).toBe("xkvw");
      const letters = placeholder.toLowerCase().replace(/[^a-z]/g, " ");
      // The default probe has a pair in the placeholder; the profile's probe has none.
      expect(pairs("ademarkqz").some((pair) => letters.includes(pair))).toBe(true);
      expect(pairs(probe).filter((pair) => letters.includes(pair))).toEqual([]);
      for (const line of TEXT) expect(lineHoldsProbe(line, probe)).toBe(false);
      expect(lineHoldsProbe(placeholder, probe)).toBe(false);
    }
    // Typed text of that probe is an echo, with a misread letter and the caret too.
    for (const line of ["xkvw", "xkv", "kvwxkl", "> xkvwxkvw", "xkyw xk"]) expect(`${line}: ${lineHoldsProbe(line, "xkvw")}`).toBe(`${line}: true`);
    expect(lineHoldsProbe("ademarkqz", "xkvw")).toBe(false);
    expect(probeRunLength("xkvwxkvwxk", "xkvw")).toBe(10);
    expect(probeRunLength("Ask anything", "xkvw")).toBeLessThanOrEqual(1);
  });

  test("the night's real echoes pass and its ordinary text does not", () => {
    for (const line of ECHOES) expect(`${line}: ${lineHoldsProbe(line)}`).toBe(`${line}: true`);
    for (const line of TEXT) expect(`${line}: ${lineHoldsProbe(line)}`).toBe(`${line}: false`);
  });

  test("bb A1 on 10 Nov: Ready on the placeholder makes the row invalid", async () => {
    const h = harness({ dryRun: false });
    h.instruments.echo = async (o) => {
      const echo = { t0_ns: 0, ready_ns: 2_100_000_000, ready_ms: 2100, settled_ms: 2600, frames: 120, timed_out: false };
      writeEchoFrames(o.frames, echo, [TEXT[0]!]);
      return echo;
    };
    const rows = await runnerFor("A1").runRep(h.ctx, 2);
    expect(rows.at(-1)!.valid).toBe(false);
    expect(rows.at(-1)!.invalid_reason).toBe(READY_NOT_PROBE);
  });

  test("A3: Ready on a placeholder makes the row invalid", async () => {
    const h = harness({ adapterDryRun: false, dryRun: false });
    h.instruments.echo = async (o) => {
      const echo = { t0_ns: 0, ready_ns: 150_000_000, ready_ms: 150, settled_ms: 900, frames: 60, timed_out: false, absent_seen: false, absent_checked: true };
      writeEchoFrames(o.frames, echo, [TEXT[4]!]);
      return echo;
    };
    const rows = await runnerFor("A3").runRep(h.ctx, 1);
    expect(rows[0]!.invalid_reason).toBe(READY_NOT_PROBE);
  });
});

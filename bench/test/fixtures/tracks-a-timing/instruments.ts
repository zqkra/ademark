// Dry instruments for the timing tests, with injectable timeouts, native failures and gates.
import type { Instruments, ReplayControl } from "../../../run/instruments.ts";
import { dryInstruments } from "../../../run/dry.ts";
import { NativeFailure } from "../../../core/native.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NativeEcho } from "../../../core/contracts.ts";

/** A frames file as the native echo writes it: the Ready frame (t_ns = ready_ns) shows these composer lines. */
export function writeEchoFrames(path: string, echo: NativeEcho, readyLines: string[] = ["ade"]): void {
  if (echo.ready_ns === null) return;
  const frames = [
    { t_ns: echo.t0_ns, source: "pts", ocr: [], dirty_outside_masks: 0, dirty_rects: [] },
    { t_ns: echo.ready_ns, source: "pts", ocr: readyLines, dirty_outside_masks: 1, dirty_rects: [] },
  ];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ cleared: true, time_sources: { pts: 2, display: 0, arrival: 0 }, frames })}\n`);
}

export type TimingFailure = "ok" | "timed-out" | "native-failure";

export interface TimingInstrumentOptions {
  failure?: TimingFailure;
  /** Default true: ctx.row writes "dry run". False lets a test read the runner's own notes. */
  dryRun?: boolean;
  /** Default true: the pre-block gate passes. */
  gatesOk?: boolean;
}

export interface TimingInstruments extends Instruments {
  calls: string[];
}

export function timingInstruments(planPath: string, options: TimingInstrumentOptions = {}): TimingInstruments {
  const base = dryInstruments(planPath);
  const failure = options.failure ?? "ok";
  const calls: string[] = [];
  const fail = (name: string): never => {
    throw new NativeFailure(`ademark-native ${name} failed (exit 4): trigger_skipped: the trigger could not be posted`);
  };
  return {
    ...base,
    dryRun: options.dryRun ?? base.dryRun,
    calls,
    echo: async (o) => {
      calls.push("echo");
      if (failure === "native-failure") return fail("echo");
      const value = await base.echo(o);
      if (failure === "timed-out") return { ...value, ready_ns: null, ready_ms: null, timed_out: true };
      writeEchoFrames(o.frames, value);
      return value;
    },
    watch: async (o) => {
      calls.push("watch");
      if (failure === "native-failure") return fail("watch");
      // A3's read after Ready: the new-thread action worked, so the old thread's marker is gone.
      if (failure === "ok" && o.frames.endsWith("frames-after-ready.json")) {
        return { t0_ns: 0, seen_ns: null, ms: null, timed_out: true, seen_text: null };
      }
      const value = await base.watch(o);
      // A fixed t0 makes the fixture replay log deterministic: t_request is 2 ms after Enter.
      return failure === "timed-out"
        ? { ...value, t0_ns: 0, seen_ns: null, ms: null, timed_out: true }
        : { ...value, t0_ns: 0 };
    },
    scroll: async (o) => {
      calls.push("scroll");
      if (failure === "native-failure") return fail("scroll");
      return base.scroll(o);
    },
    keys: async (o) => {
      calls.push("keys");
      if (failure === "native-failure") return fail("keys");
      return base.keys(o);
    },
    gates: async () => {
      calls.push("gates");
      const gates = await base.gates();
      return options.gatesOk === false ? { ...gates, cpu_quiet_ok: false, cpu_cores_used: 0.7 } : gates;
    },
  };
}

export function fixtureReplay(logPath: string): ReplayControl {
  return {
    port: 8787,
    logPath,
    stats: async () => ({ requests: 0, by_session: {}, unknown: 0, rewrite_misses: 0 }),
    reset: async () => {},
    stop: async () => {},
  };
}

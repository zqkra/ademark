// The Track C runners against a fixture ADE: rows, units, values, notes and validateRow.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "../core/contracts.ts";
import { RunWriter, validateRow } from "../core/results.ts";
import { loadTask, renderHandoffCodes } from "../core/tasks.ts";
import { createTestContext, type TestContext } from "../run/context.ts";
import { dryInstruments } from "../run/dry.ts";
import type { CaptureControl, Instruments } from "../run/instruments.ts";
import { c1 } from "../tracks/c/c1-orchestrated-build.ts";
import { c2 } from "../tracks/c/c2-message-delivery.ts";
import { c3 } from "../tracks/c/c3-chat-lock.ts";
import { c4 } from "../tracks/c/c4-agent-killed.ts";
import { c5 } from "../tracks/c/c5-network-cut.ts";
import { c6 } from "../tracks/c/c6-app-restart.ts";
import { runProbe } from "../tracks/c/probe.ts";
import { C1_SOLO_TASK, C1_TASK, C2_TASK, NO_WORKER_STOP_MS, QUIET_MS, QUIET_POLL_MS, adeCrashed, crashNote, handoffSeedFor } from "../tracks/c/shared.ts";
import { makeFixtureAdapter } from "./fixtures/run/adapter.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-c-runners-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface VirtualInstruments {
  instruments: Instruments;
  /** Virtual host clock in ms; the run's t0 is its value when the prompt is sent. `endMs` is the end of the last run. */
  clock: { ms: number; endMs?: number };
}

// The dry instruments with a clock the test moves: notes survive (dryRun false) and nothing sleeps. `gradeMs` is how
// long a grade takes.
function virtualInstruments(planPath: string, o: { gradeMs?: number } = {}): VirtualInstruments {
  const base = dryInstruments(planPath);
  const clock: { ms: number; endMs?: number } = { ms: 1_000_000 };
  // C1 looks at the capture every QUIET_POLL_MS after the first end of turn of a run: the first look is at that end.
  let looking = false;
  const advance = (ms: number): void => {
    if (ms === QUIET_POLL_MS && !looking) {
      looking = true;
      clock.endMs = clock.ms;
    }
    if (ms > 0) clock.ms += ms;
  };
  const instruments: Instruments = {
    ...base,
    dryRun: false,
    now: () => BigInt(Math.round(clock.ms * 1_000_000)),
    sleep: async (ms) => advance(ms),
    lag: async (options) => {
      const result = await base.lag(options);
      advance(options.count * options.intervalMs);
      return result;
    },
    watch: async (options) => {
      const result = await base.watch(options);
      advance(500);
      return result;
    },
    grade: async (options) => {
      looking = false;
      advance(o.gradeMs ?? 0);
      return await base.grade(options);
    },
  };
  return { instruments, clock };
}

function calibratedAdapter(id = "fixture-ade"): Adapter {
  const adapter = makeFixtureAdapter({ id });
  adapter.calibration.composerRect = { x: 0, y: 0, w: 100, h: 40 };
  adapter.calibration.threadRect = { x: 0, y: 0, w: 800, h: 600 };
  adapter.timed.launch = [{ kind: "wait", ms: 0 }];
  adapter.timed.newThread = [{ kind: "wait", ms: 0 }];
  adapter.timed.send = [{ kind: "enter" }];
  adapter.orchestrationTrigger = "/orchestrate";
  return adapter;
}

function captureControl(outPath: string, clock: { ms: number }, bodyFile: string | null): CaptureControl {
  return {
    outPath,
    rows: () =>
      bodyFile === null
        ? []
        : [
            {
              // Just before "now", so the row lands inside [t0, end] of the run.
              t_ns: Math.round((clock.ms - 1_000) * 1_000_000),
              host: "api.anthropic.com",
              path: "/v1/messages",
              pid: null,
              process: null,
              model: "claude-opus-5-5",
              user_agent: null,
              req_bytes: 10,
              status: 200,
              usage: { input: 100, cache_write: 0, cache_read: 0, output: 50 },
              main_thread: null,
              user_text_sha256: [],
              chunk_t_ns: [],
              body_file: bodyFile,
            },
          ],
    stop: async () => {},
  };
}

interface Call {
  /** The first user message of this request. */
  text: string;
  /** The client session that sends it. */
  session?: string;
  host?: string;
  path?: string;
  model?: string;
  /** The request ends this long after the first end of turn of the run. */
  afterEndMs?: number;
  /** The last user message answers a tool: an agent in the middle of its work. */
  toolAnswer?: boolean;
  /** 0 for a call with no tools (a title, a quota call). Default: the tools of a coding agent. */
  tools?: 0;
  status?: number;
  usage?: { input: number; cache_write: number; cache_read: number; output: number } | null;
}

// A capture as the proxy writes it (bench/capture/addon.py): one row per call, in order, each with its body saved next
// to capture.jsonl and named by a path relative to that folder (`bodies/0001.json`). A row exists from the moment its
// answer ended.
function callsCapture(clock: { ms: number; endMs?: number }, calls: readonly Call[]): Map<string, unknown> {
  const folder = join(dir, "capture-C-1");
  mkdirSync(join(folder, "bodies"), { recursive: true });
  calls.forEach((call, index) => {
    const tools = call.tools === 0 ? [] : [{ name: "Bash" }, { name: "Edit" }, { name: "Agent" }];
    const answer = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] };
    const messages = call.toolAnswer === true ? [{ role: "user", content: call.text }, { role: "assistant", content: "..." }, answer] : [{ role: "user", content: call.text }];
    const body = { system: "cc_turn_origin=human", metadata: { user_id: JSON.stringify({ session_id: call.session ?? "lead" }) }, tools, messages };
    writeFileSync(join(folder, "bodies", `${String(index + 1).padStart(4, "0")}.json`), JSON.stringify(body), "utf8");
  });
  const control: CaptureControl = {
    outPath: join(folder, "capture.jsonl"),
    rows: () =>
      calls
        .map((call, index) => ({
          // At the first end of turn of the run (the runner reads the capture from there on), so every row lands inside
          // [t0, end], also in a solo run that takes no virtual time. The rows keep the order of the calls (the sort
          // is stable). `afterEndMs` puts a call after that end.
          t_ns: Math.round(((clock.endMs ?? clock.ms) + (call.afterEndMs ?? 0)) * 1_000_000),
          host: call.host ?? "api.anthropic.com",
          path: call.path ?? "/v1/messages",
          pid: null,
          process: null,
          model: call.model ?? "claude-opus-5-5",
          user_agent: null,
          req_bytes: 10,
          status: call.status ?? 200,
          usage: call.usage === undefined ? { input: 100, cache_write: 0, cache_read: 0, output: 50 } : call.usage,
          main_thread: null,
          user_text_sha256: [],
          chunk_t_ns: [],
          body_file: `bodies/${String(index + 1).padStart(4, "0")}.json`,
        }))
        .filter((row) => row.t_ns <= Math.round(clock.ms * 1_000_000)),
    stop: async () => {},
  };
  return new Map<string, unknown>([["capture", control]]);
}

// The prompts of a C1 block of the run `c-run`, as c1 sends them.
const c1TaskText = (): string => renderHandoffCodes(loadTask(C1_TASK).prompt, handoffSeedFor("c-run"));
const c1Prompt = (trigger = "/orchestrate"): string => `${trigger}\n${c1TaskText()}`;
const soloPrompt = (): string => renderHandoffCodes(loadTask(C1_SOLO_TASK).prompt, handoffSeedFor("c-run"));
// The calls of one agent that started a thread and answered a tool, and of a run with a lead and one worker.
const lead = (text = c1Prompt(), o: Partial<Call> = {}): Call[] => [{ text, ...o }, { text, toolAnswer: true, ...o }];
const worker = (n = 1, o: Partial<Call> = {}): Call[] => lead(`Worker W${n}: build work item ${n}`, { session: `worker-${n}`, ...o });
const team = (): Call[] => [...lead(), ...worker()];

function makeContext(options: {
  adapter: Adapter;
  instruments: Instruments;
  state?: Map<string, unknown>;
}): TestContext {
  const adapter = options.adapter;
  const writer = new RunWriter(join(dir, "results")).open("c-run");
  const state = options.state ?? new Map<string, unknown>();
  if (!state.has("launch_pid")) state.set("launch_pid", 4242);
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return createTestContext({
    runId: "c-run",
    runDir: writer.runDir,
    machineId: "machine-1",
    adapter,
    rowAde: adapter.id,
    track: "C",
    options: { model: "claude-opus-5-5", effort: "high", server: "live", agent: "claude" },
    instruments: options.instruments,
    writer,
    adapterCtx: {
      runDir: writer.runDir,
      arenaPath: dir,
      worktree: dir,
      home,
      env: {},
      dryRun: true,
      log: () => {},
    },
    installed: { installed: true, version: "1.0.0", path: null, binarySha256: null },
    freshArena: async (label) => join(dir, "arena", label),
    state,
  });
}

function expectValid(rows: Array<{ test_id: string }>): void {
  for (const row of rows) expect(() => validateRow(row)).not.toThrow();
}

describe("track C runners", () => {
  test("C1 rows with an orchestration trigger", async () => {
    const { instruments, clock } = virtualInstruments(join(dir, "plan-c1.jsonl"));
    const ctx = makeContext({ adapter: calibratedAdapter(), instruments, state: callsCapture(clock, team()) });
    const rows = await c1.runRep(ctx, 1);
    expect(rows.map((row) => row.variant)).toEqual([
      "shipped",
      "time-to-green",
      "fan-out-max",
      "fan-out-total",
      "handoff",
      "codes-placed",
      "tokens-total",
      "usd-total",
    ]);
    expect(rows.map((row) => row.unit)).toEqual(["x/5", "min", "agents", "agents", "x/4", "x/4", "tokens", "USD"]);
    expect(rows.every((row) => row.valid)).toBe(true);
    expect(rows.every((row) => row.server === "live")).toBe(true);
    const values = Object.fromEntries(rows.map((row) => [row.variant, row.value]));
    expect(values.shipped).toBe(5);
    expect(values["time-to-green"]).toBeGreaterThanOrEqual(0);
    expect(values["fan-out-max"]).toBe(0);
    expect(values["fan-out-total"]).toBe(0);
    expect(values.handoff).toBe(0);
    expect(values["codes-placed"]).toBe(0);
    expect(values["tokens-total"]).toBe(600);
    expect(values["usd-total"]).toBeGreaterThan(0);
    expect(rows[0]!.notes).toContain("5/5");
    expect(rows[2]!.notes).toContain("capture: 2 agents in 2 sessions, 2 tool answers");
    expect(rows[2]!.notes).toContain("validate in pilot");
    expect(c1.needsExtraRun(rows)).toBe(false);
    expect(c1.needsExtraRun([{ ...rows[0]!, value: 4 }])).toBe(true);
    expectValid(rows);
  });

  test("C1 without a trigger is not calibrated", async () => {
    const adapter = calibratedAdapter();
    delete adapter.orchestrationTrigger;
    const { instruments } = virtualInstruments(join(dir, "plan-c1-missing.jsonl"));
    const ctx = makeContext({ adapter, instruments });
    const rows = await c1.runRep(ctx, 1);
    expect(rows.length).toBe(8);
    expect(rows.every((row) => !row.valid)).toBe(true);
    expect(rows.every((row) => row.value === null)).toBe(true);
    expect(rows[0]!.invalid_reason).toBe("not calibrated: orchestrationTrigger");
    expectValid(rows);
  });

  test("C1 with a null trigger is not supported, never 0", async () => {
    const adapter = calibratedAdapter();
    adapter.orchestrationTrigger = null;
    const { instruments } = virtualInstruments(join(dir, "plan-c1-null.jsonl"));
    const ctx = makeContext({ adapter, instruments });
    const rows = await c1.runRep(ctx, 1);
    expect(rows.length).toBe(8);
    expect(rows.every((row) => row.valid && row.value === null)).toBe(true);
    expect(rows.every((row) => row.notes === "not supported")).toBe(true);
    expect(rows.every((row) => row.invalid_reason === null)).toBe(true);
    // A not-supported run is never retried as an under-5 shipped run.
    expect(c1.needsExtraRun(rows)).toBe(false);
    expectValid(rows);
  });

  test("C1 on the bare CLI also runs C1-solo", async () => {
    const { instruments, clock } = virtualInstruments(join(dir, "plan-c1-solo.jsonl"));
    const state = callsCapture(clock, [...team(), ...lead(soloPrompt(), { session: "solo" })]);
    const ctx = makeContext({ adapter: calibratedAdapter("bare-cli"), instruments, state });
    const rows = await c1.runRep(ctx, 1);
    expect(rows.length).toBe(11);
    expect(rows.slice(8).map((row) => row.variant)).toEqual(["solo-shipped", "solo-tokens-total", "solo-usd-total"]);
    expect(rows.slice(8).map((row) => row.unit)).toEqual(["x/5", "tokens", "USD"]);
    expect(rows.slice(8).every((row) => row.valid && row.value !== null)).toBe(true);
    expectValid(rows);
  });

  test("C1 on the plain dry instruments keeps every row valid", async () => {
    const adapter = calibratedAdapter();
    adapter.orchestrationTrigger = null;
    const ctx = makeContext({ adapter, instruments: dryInstruments(join(dir, "plan-plain.jsonl")) });
    const rows = await c1.runRep(ctx, 1);
    expect(rows.length).toBe(8);
    expect(rows.every((row) => row.valid && row.value === null)).toBe(true);
    expect(rows.every((row) => row.notes === "dry run; not supported")).toBe(true);
    expectValid(rows);
  });

  test("C2 rows carry dropped, applied and the per-follow-up states", async () => {
    const { instruments, clock } = virtualInstruments(join(dir, "plan-c2.jsonl"));
    const task = loadTask(C2_TASK);
    const first = task.followups[0]!;
    // The proxy names a body by a path relative to the folder of capture.jsonl. Until 2026-11-11 C2 read that path from
    // the working directory, found nothing on a real capture, and counted every follow-up as dropped.
    mkdirSync(join(dir, "capture-C-1", "bodies"), { recursive: true });
    writeFileSync(join(dir, "capture-C-1", "bodies", "0001.json"), JSON.stringify({ messages: [{ role: "user", content: first.text }] }), "utf8");
    const capturePath = join(dir, "capture-C-1", "capture.jsonl");
    const state = new Map<string, unknown>();
    state.set("capture", captureControl(capturePath, clock, "bodies/0001.json"));
    state.set("capture_path", capturePath);
    const ctx = makeContext({ adapter: calibratedAdapter(), instruments, state });
    const rows = await c2.runRep(ctx, 1);
    expect(rows.map((row) => row.variant)).toEqual(["dropped", "applied"]);
    expect(rows.map((row) => row.unit)).toEqual(["x/3", "x/3"]);
    expect(rows[0]!.value).toBe(2);
    expect(rows[1]!.value).toBe(3);
    expect(rows[0]!.notes).toContain(`${first.id} delivered`);
    expect(rows[0]!.notes).toContain("C2-F2 dropped");
    expect(rows[0]!.notes).toContain("accepted");
    expectValid(rows);
  });

  test("C2 without the thread rect is not calibrated", async () => {
    const adapter = calibratedAdapter();
    adapter.calibration.threadRect = null;
    const { instruments } = virtualInstruments(join(dir, "plan-c2-missing.jsonl"));
    const ctx = makeContext({ adapter, instruments });
    const rows = await c2.runRep(ctx, 1);
    expect(rows.length).toBe(2);
    expect(rows.every((row) => !row.valid)).toBe(true);
    expect(rows[0]!.invalid_reason).toBe("not calibrated: threadRect");
  });

  test("C3 counts locks from the probe state", async () => {
    const { instruments } = virtualInstruments(join(dir, "plan-c3.jsonl"));
    const state = new Map<string, unknown>();
    state.set("C3.probes", [
      { t_ns: 0, ms: 12 },
      { t_ns: 2_000_000_000, ms: null },
      { t_ns: 4_000_000_000, ms: null },
      { t_ns: 6_000_000_000, ms: 5 },
    ]);
    const ctx = makeContext({ adapter: calibratedAdapter(), instruments, state });
    const rows = await c3.runRep(ctx, 1);
    expect(rows.map((row) => row.variant)).toEqual(["locks", "longest-lock"]);
    expect(rows.map((row) => row.unit)).toEqual(["count", "s"]);
    expect(rows[0]!.value).toBe(1);
    expect(rows[1]!.value).toBe(4);
    expect(rows[0]!.duration_ms).toBe(6_000);
    expectValid(rows);
  });

  test("C3 without probes is invalid", async () => {
    const { instruments } = virtualInstruments(join(dir, "plan-c3-empty.jsonl"));
    const ctx = makeContext({ adapter: calibratedAdapter(), instruments });
    const rows = await c3.runRep(ctx, 1);
    expect(rows.length).toBe(2);
    expect(rows.every((row) => !row.valid)).toBe(true);
    expect(rows[0]!.invalid_reason).toBe("no probes");
    expectValid(rows);
  });

  test("C4, C5 and C6 report survival, resumed and manual-continue", async () => {
    const cases: Array<[typeof c4, string]> = [
      [c4, ""],
      [c5, ""],
      [c6, "returned to the thread"],
    ];
    for (const [runner, extra] of cases) {
      const { instruments } = virtualInstruments(join(dir, `plan-${runner.id}.jsonl`));
      const adapter = calibratedAdapter();
      adapter.returnToThread = async () => {};
      const ctx = makeContext({ adapter, instruments });
      const rows = await runner.runRep(ctx, 1);
      expect(rows.map((row) => row.variant)).toEqual(["survival", "resumed", "manual-continue"]);
      expect(rows.map((row) => row.value)).toEqual([1, 0, 1]);
      expect(rows.map((row) => row.unit)).toEqual(["survival", "0/1", "0/1"]);
      expect(rows[0]!.notes).toContain("partial");
      if (extra.length > 0) expect(rows[0]!.notes).toContain(extra);
      expect(runner.needsExtraRun(rows)).toBe(false);
      expect(runner.needsExtraRun([{ ...rows[0]!, value: 0 }])).toBe(true);
      expectValid(rows);
    }
  });

  test("C4 with a real kill keeps the survival rows", async () => {
    const { instruments } = virtualInstruments(join(dir, "plan-c4-killed.jsonl"));
    const patched: Instruments = {
      ...instruments,
      fault: async (fault, options) => {
        const outcome = await instruments.fault(fault, options);
        return { ...outcome, applied: true, detail: "pids=101,102" };
      },
    };
    const ctx = makeContext({ adapter: calibratedAdapter(), instruments: patched });
    const rows = await c4.runRep(ctx, 1);
    expect(rows.map((row) => row.value)).toEqual([1, 0, 1]);
    expect(rows[0]!.notes).toContain("pids=101,102");
    expectValid(rows);
  });

  test("C4 fails when the ADE is gone at the end", async () => {
    const adapter = calibratedAdapter();
    const hints = adapter.processes();
    adapter.processes = () => ({ ...hints, bundlePaths: ["/Applications/Fixture.app"] });
    const { instruments } = virtualInstruments(join(dir, "plan-c4-crash.jsonl"));
    const patched: Instruments = {
      ...instruments,
      procs: async () => [
        { pid: 1, ppid: 0, path: "/usr/sbin/launchd", name: "launchd", responsible_pid: null },
        { pid: 2, ppid: 1, path: "/Applications/Fixture.apprentice/x", name: "x", responsible_pid: null },
      ],
    };
    const ctx = makeContext({ adapter, instruments: patched });
    const rows = await c4.runRep(ctx, 1);
    expect(rows.map((row) => row.value)).toEqual([0, 0, 1]);
    expect(rows[0]!.notes).toContain("fail");
    expect(rows[0]!.notes).toContain("app not running at the end");
    expectValid(rows);
  });

  test("C1 notes a crash and asks for another run", async () => {
    const adapter = calibratedAdapter();
    const hints = adapter.processes();
    adapter.processes = () => ({ ...hints, bundlePaths: ["/Applications/Fixture.app"] });
    const { instruments } = virtualInstruments(join(dir, "plan-c1-crash.jsonl"));
    const patched: Instruments = { ...instruments, procs: async () => [] };
    const ctx = makeContext({ adapter, instruments: patched });
    const rows = await c1.runRep(ctx, 1);
    expect(rows.every((row) => row.notes.includes("app not running at the end"))).toBe(true);
    expect(c1.needsExtraRun(rows)).toBe(true);
    expectValid(rows);
  });

  test("the crash check is skipped in a dry run", async () => {
    const ctx = makeContext({
      adapter: calibratedAdapter(),
      instruments: dryInstruments(join(dir, "plan-crash-dry.jsonl")),
    });
    expect(await adeCrashed(ctx)).toBeNull();
    expect(crashNote(null)).toBe("dry run: crash check skipped");
    expect(crashNote(true)).toBe("app not running at the end");
    expect(crashNote(false)).toBeNull();
  });

  test("C4 with no agent process killed is not applicable", async () => {
    const cases = [
      { applied: false, detail: "pids=none" },
      { applied: true, detail: "pids=none" },
      { applied: true, detail: "pids=" },
    ];
    for (const [index, outcomeCase] of cases.entries()) {
      const { instruments } = virtualInstruments(join(dir, `plan-c4-none-${index}.jsonl`));
      const patched: Instruments = {
        ...instruments,
        fault: async (fault, options) => {
          const outcome = await instruments.fault(fault, options);
          return { ...outcome, ...outcomeCase };
        },
      };
      const ctx = makeContext({ adapter: calibratedAdapter(), instruments: patched });
      const rows = await c4.runRep(ctx, 1);
      expect(rows.every((row) => row.valid && row.value === null)).toBe(true);
      expect(rows[0]!.notes).toBe("not applicable: no separate agent process");
      expectValid(rows);
    }
  });

  test("the C3 probe keeps the lost probes in order and skips a pause window", async () => {
    const base = dryInstruments(join(dir, "plan-probe.jsonl"));
    const clock = { ms: 1_000_000 };
    const segments: number[] = [];
    const instruments: Instruments = {
      ...base,
      dryRun: false,
      now: () => BigInt(Math.round(clock.ms * 1_000_000)),
      sleep: async (ms) => {
        clock.ms += ms;
      },
      lag: async (options) => {
        segments.push(options.count);
        clock.ms += options.count * options.intervalMs;
        return { samples_ms: [10, 20], p50: 10, p95: 20, lost: 1, probes_ms: [10, null] };
      },
    };
    const ctx = makeContext({ adapter: calibratedAdapter(), instruments });
    const t0 = clock.ms;
    const ns = (ms: number): bigint => BigInt(ms) * 1_000_000n;
    const pause = { start_ns: ns(t0 + 70_000), end_ns: ns(t0 + 73_000) };
    const probes = await runProbe(ctx, ns(t0 + 240_000), [pause]);

    // 30 + 5, then the 3 s pause, then 30 + 30 + 24 = five segments of the fake's two probes.
    expect(segments).toEqual([30, 5, 30, 30, 24]);
    expect(probes.length).toBe(10);
    for (const [index, probe] of probes.entries()) {
      expect(probe.ms).toBe(index % 2 === 0 ? 10 : null);
      expect(probe.t_ns).toBeGreaterThanOrEqual(t0 * 1_000_000);
    }
    const inside = probes.filter((probe) => BigInt(probe.t_ns) >= pause.start_ns && BigInt(probe.t_ns) < pause.end_ns);
    expect(inside).toEqual([]);
    expect(probes[0]!.t_ns).toBe(t0 * 1_000_000);
  });
});

// ADEMARK-50 (2026-11-11): the faults the first dry C block of every measured app showed.
describe("track C guards before the first real C block", () => {
  function invalidGrade(instruments: Instruments): Instruments {
    return {
      ...instruments,
      grade: async (o) => {
        const graded = await instruments.grade(o);
        return {
          ...graded,
          groups: graded.groups.map((group) => ({ ...group, passed: 0 })),
          valid: false,
          reasons: ["missing hidden tests"],
        };
      },
    };
  }

  test("C1 never publishes shipped 0 from a grade the grader could not make", async () => {
    const { instruments, clock } = virtualInstruments(join(dir, "plan-c1-grade.jsonl"));
    const ctx = makeContext({ adapter: calibratedAdapter(), instruments: invalidGrade(instruments), state: callsCapture(clock, team()) });
    const rows = await c1.runRep(ctx, 1);
    const byVariant = Object.fromEntries(rows.map((row) => [row.variant, row]));
    for (const variant of ["shipped", "time-to-green"]) {
      expect(byVariant[variant]!.valid).toBe(false);
      expect(byVariant[variant]!.value).toBeNull();
      expect(byVariant[variant]!.invalid_reason).toBe("grade invalid: missing hidden tests");
    }
    // Facts that do not come from the hidden tests stay.
    for (const variant of ["fan-out-max", "handoff", "codes-placed", "tokens-total"]) {
      expect(byVariant[variant]!.valid).toBe(true);
    }
    // An invalid shipped row is not an under-5 run.
    expect(c1.needsExtraRun(rows)).toBe(false);
    expectValid(rows);
  });

  // 2026-11-11: what Track B learned on 6 and 7 Nov, checked on a C1 run before the first real one.
  async function c1With(calls: readonly Call[], id = "fixture-ade", o: { gradeMs?: number } = {}) {
    const { instruments, clock } = virtualInstruments(join(dir, `plan-c1-check-${Math.random().toString(36).slice(2)}.jsonl`), o);
    const ctx = makeContext({ adapter: calibratedAdapter(id), instruments, state: callsCapture(clock, calls) });
    return c1.runRep(ctx, 1);
  }
  const reasons = (rows: Array<{ invalid_reason: string | null }>): string[] => [...new Set(rows.map((row) => row.invalid_reason ?? "valid"))];

  test("C1 with no model request captured is invalid, never shipped 0/5 with 0 tokens", async () => {
    const { instruments } = virtualInstruments(join(dir, "plan-c1-none.jsonl"));
    const rows = await c1.runRep(makeContext({ adapter: calibratedAdapter(), instruments }), 1);
    expect(rows.length).toBe(8);
    expect(rows.every((row) => !row.valid && row.value === null && row.invalid_reason === "no model request captured")).toBe(true);
    expect(c1.needsExtraRun(rows)).toBe(false);
    expectValid(rows);
  });

  test("C1 whose prompt never reached the model is invalid", async () => {
    const rows = await c1With([...lead("an older chat of the app answered something else"), ...worker()]);
    expect(reasons(rows)).toEqual(["the prompt never reached the model: no main-thread request captured"]);
    expectValid(rows);
  });

  test("C1 on another model is invalid", async () => {
    const rows = await c1With([...lead(c1Prompt(), { model: "claude-sonnet-5" }), ...worker()]);
    expect(reasons(rows)).toEqual(["wrong model: claude-sonnet-5"]);
    // A worker on another model is the app's own choice: only the main thread must run the pinned model.
    const mixed = await c1With([...lead(), ...worker(1, { model: "claude-haiku-4-5" })]);
    expect(reasons(mixed)).toEqual(["valid"]);
  });

  test("C1 that ends on a refused request is invalid: a plan at its limit is not a partial build", async () => {
    const refused = await c1With([...team(), { text: "Worker W1: build work item 1", session: "worker-1", toolAnswer: true, status: 429, usage: null }]);
    expect(reasons(refused)).toEqual(["the run ended on a refused request (status 429): the Claude plan or the sign-in"]);
    expect(c1.needsExtraRun(refused)).toBe(false);
    // A refusal the client retried is followed by an answer, and the run stays valid.
    const retried = await c1With([...lead(), { text: "Worker W1: build work item 1", session: "worker-1", status: 429, usage: null }, ...worker()]);
    expect(reasons(retried)).toEqual(["valid"]);
    const all = await c1With([{ text: c1Prompt(), status: 401, usage: null }]);
    expect(reasons(all)).toEqual(["the turn failed"]);
    // 6 and 7 Nov: Cloudroom and bb also ask chatgpt.com for a Codex answer and get 401, with no Codex sign-in in the
    // bench account. That refusal at the end is not the run's: only the host of the main thread counts.
    const codex = await c1With([...team(), { text: "title", host: "chatgpt.com", path: "/backend-api/codex/responses", model: "gpt-6.1-sol", status: 401, usage: null, tools: 0 }]);
    expect(reasons(codex)).toEqual(["valid"]);
  });

  // The first session log with an end of turn can be one worker that finished, or a lead that handed the work out
  // and ended its turn, while the others still build. The capture decides when the run is over.
  test("C1 goes on after the first end of turn until every agent is quiet, and the end is the last answer to a tool", async () => {
    const rows = await c1With([...team(), { text: "Worker W2: build work item 2", session: "worker-2", afterEndMs: 60_000 },
      { text: "Worker W2: build work item 2", session: "worker-2", toolAnswer: true, afterEndMs: 200_000 }]);
    expect(reasons(rows)).toEqual(["valid"]);
    const byVariant = Object.fromEntries(rows.map((row) => [row.variant, row]));
    // The two later calls are part of the run, and the run ends at the last answer to a tool, not at the end of the wait.
    expect(byVariant["tokens-total"]!.value).toBe(900);
    expect(byVariant["time-to-green"]!.notes).toContain("went on 200 s after the first end of turn");
    // 200 s longer than the same run with nothing after its first end of turn: the 5 minutes of quiet are not in it.
    const plain = await c1With(team());
    expect(Math.round(rows[0]!.duration_ms - plain[0]!.duration_ms)).toBe(200_000);
    expect(byVariant["fan-out-max"]!.notes).toContain("capture: 3 agents in 3 sessions");
  });

  test("the wait for quiet is not part of the run, and what follows a real end is not work", async () => {
    // A quota call, a title call and a suggestion call each start a turn of their own: no agent answered a tool.
    const rows = await c1With([...team(), { text: "quota", afterEndMs: 5_000, tools: 0, session: "quota" },
      { text: "[SUGGESTION MODE: suggest what the user might type next]", afterEndMs: 9_000 }]);
    expect(reasons(rows)).toEqual(["valid"]);
    expect(rows.find((row) => row.variant === "tokens-total")!.value).toBe(600);
    expect(rows[0]!.duration_ms).toBeLessThan(QUIET_MS);
    expect(rows.find((row) => row.variant === "time-to-green")!.notes).not.toContain("went on");
  });

  test("C1 that answers a tool again after it was taken as over is invalid: the grade read a half-built repository", async () => {
    // Quiet for 5 minutes, then a worker comes back while the grade runs (a long command with no model call).
    const late: Call = { text: "Worker W1: build work item 1", session: "worker-1", toolAnswer: true, afterEndMs: QUIET_MS + 20_000 };
    const rows = await c1With([...team(), late], "fixture-ade", { gradeMs: 60_000 });
    expect(reasons(rows)).toEqual(["the run went on after the end of turn that ended the test: 1 tool answers after it"]);
    expect(rows.every((row) => row.value === null)).toBe(true);
    expect(c1.needsExtraRun(rows)).toBe(false);
    // A client that continues a thread sends no tool list with a tool answer (Diri, 7 Nov): it is still work.
    const noTools = await c1With([...team(), { ...late, tools: 0 }], "fixture-ade", { gradeMs: 60_000 });
    expect(reasons(noTools)).toEqual(["the run went on after the end of turn that ended the test: 1 tool answers after it"]);
    expectValid(rows);
  });

  test("work after the cap cuts the run at the cap; a run that ended before it is not a cut run", async () => {
    const capMs = loadTask(C1_TASK).time_cap_s * 1000;
    // Tool answers every 250 s, past the cap: never quiet for 5 minutes.
    const busy = Array.from({ length: 14 }, (_, at): Call => ({ text: "Worker W1: build work item 1", session: "worker-1", toolAnswer: true, afterEndMs: (at + 1) * 250_000 }));
    const rows = await c1With([...team(), ...busy]);
    // Cut by rule: the agents still work, and that is not a fault of the run.
    expect(reasons(rows)).toEqual(["valid"]);
    expect(Math.round(rows[0]!.duration_ms)).toBe(capMs);
    // The dry grade is green, so the time is the cap, and the note says the run was cut there.
    expect(rows.find((row) => row.variant === "time-to-green")!.value).toBe(capMs / 60_000);
    expect(rows.find((row) => row.variant === "time-to-green")!.notes).toContain("cut at the cap of 45 minutes");
    // Only the calls that ended before the cap are in the run.
    const plain = await c1With(team());
    const before = Math.floor((capMs - plain[0]!.duration_ms) / 250_000);
    expect(before).toBeGreaterThan(5);
    expect(rows.find((row) => row.variant === "tokens-total")!.value).toBe(600 + before * 150);
    // The same run, quiet from minute 1 on, is not cut: the wait for quiet may pass the cap, the run does not.
    expect(Math.round(plain[0]!.duration_ms)).toBeLessThan(capMs / 4);
    expect(plain.find((row) => row.variant === "time-to-green")!.notes).not.toContain("cut at the cap");
  });

  // The trigger line of bb, Cloudroom and Capy is an estimate, and Orca and super.engineering keep orchestration off
  // until it is switched on. A build one agent did alone is not the app's orchestration.
  test("C1 that one agent did alone is invalid, whatever it shipped", async () => {
    const alone = await c1With(lead());
    expect(reasons(alone)).toEqual(["one agent did the work alone: the trigger did not start orchestration"]);
    expect(alone.every((row) => row.value === null)).toBe(true);
    expect(c1.needsExtraRun(alone)).toBe(false);
    // A title call with the full tool list is not an agent: it never answers a tool (MonoCode, 7 Nov).
    const title = await c1With([...lead(), { text: "Write a title. User message: build it", session: "title" }]);
    expect(reasons(title)).toEqual(["one agent did the work alone: the trigger did not start orchestration"]);
    // A subagent shares the session of its parent and starts a thread of its own: it is a second agent.
    const subagent = await c1With([...lead(), { text: "Subagent: build work item 2" }, { text: "Subagent: build work item 2", toolAnswer: true }]);
    expect(reasons(subagent)).toEqual(["valid"]);
    expect(subagent[2]!.notes).toContain("capture: 2 agents in 1 sessions");
    // The summary that replaces a full conversation and the suggestion call are the same agent.
    const same = await c1With([...lead(), { text: "This session is being continued from a previous conversation that ran out of context." }, { text: "[SUGGESTION MODE: next]" }]);
    expect(reasons(same)).toEqual(["one agent did the work alone: the trigger did not start orchestration"]);
    expectValid(alone);
  });

  // bb, Cloudroom, Orca and super.engineering orchestrate with agents of their own (child threads, chats, terminals).
  test("an ADE whose workers are sessions of their own: subagents inside the lead's session are not its orchestration", async () => {
    const run = async (calls: readonly Call[]) => {
      const { instruments, clock } = virtualInstruments(join(dir, `plan-c1-own-${Math.random().toString(36).slice(2)}.jsonl`));
      const adapter = calibratedAdapter();
      adapter.orchestrationWorkers = "sessions";
      return c1.runRep(makeContext({ adapter, instruments, state: callsCapture(clock, calls) }), 1);
    };
    const subagents = await run([...lead(), { text: "Subagent: build work item 2" }, { text: "Subagent: build work item 2", toolAnswer: true }]);
    expect(reasons(subagents)).toEqual(["the app's own workers did not run: 2 agents in one client session"]);
    expect(subagents.every((row) => row.value === null)).toBe(true);
    expect(reasons(await run(team()))).toEqual(["valid"]);
  });

  test("C1 still alone after 15 minutes stops there, and does not spend the other 30 of the cap", async () => {
    const run = async (calls: readonly Call[]) => {
      const { instruments, clock } = virtualInstruments(join(dir, `plan-c1-alone-${Math.random().toString(36).slice(2)}.jsonl`));
      const adapter = calibratedAdapter();
      const waits: number[] = [];
      // The lead works on and never ends its turn: every wait runs to its limit.
      adapter.waitDone = async (_ctx, timeoutMs) => {
        waits.push(timeoutMs);
        await instruments.sleep(timeoutMs);
        return { done: false, reason: "timeout" };
      };
      const rows = await c1.runRep(makeContext({ adapter, instruments, state: callsCapture(clock, calls) }), 1);
      return { rows, waits };
    };
    const capMs = loadTask(C1_TASK).time_cap_s * 1000;
    const alone = await run(lead());
    expect(reasons(alone.rows)).toEqual([`no second agent in the first ${NO_WORKER_STOP_MS / 60_000} minutes: the trigger did not start orchestration`]);
    expect(alone.waits.length).toBe(1);
    // The chat-lock probe moves the same virtual clock, so the stop is a little after the 15 minutes; far from the cap.
    expect(alone.rows[0]!.duration_ms).toBeLessThan(capMs / 2);
    // With a worker by then, the run goes on to the cap as before.
    const withWorker = await run(team());
    expect(withWorker.waits.length).toBe(2);
    expect(withWorker.rows[0]!.duration_ms).toBeGreaterThanOrEqual(capMs);
    expect(reasons(withWorker.rows)).toEqual(["valid"]);
  });

  test("a run check that breaks makes the rows invalid with the reason: they are neither lost nor passed", async () => {
    const { instruments, clock } = virtualInstruments(join(dir, "plan-c1-broken.jsonl"));
    const state = callsCapture(clock, team());
    const control = state.get("capture") as CaptureControl;
    // A capture row with no `path` breaks the check itself.
    state.set("capture", { ...control, rows: () => control.rows().map((row) => ({ ...row, path: undefined as never })) });
    const rows = await c1.runRep(makeContext({ adapter: calibratedAdapter(), instruments, state }), 1);
    expect(rows.length).toBe(8);
    expect(rows.every((row) => !row.valid && (row.invalid_reason ?? "").startsWith("the run check failed: "))).toBe(true);
  });

  test("C1 token totals are invalid when a call has no usage; the build stays", async () => {
    const rows = await c1With([...lead(), ...worker(1, { usage: null })]);
    const byVariant = Object.fromEntries(rows.map((row) => [row.variant, row]));
    for (const variant of ["tokens-total", "usd-total"]) {
      expect(byVariant[variant]!.valid).toBe(false);
      expect(byVariant[variant]!.invalid_reason).toBe("a call has no usage");
    }
    for (const variant of ["shipped", "time-to-green", "fan-out-max", "handoff"]) expect(byVariant[variant]!.valid).toBe(true);
    expectValid(rows);
  });

  test("C1 finds the main thread when the app turns the trigger line into its own wrapper", async () => {
    const rows = await c1With([...lead(`You are the lead of a team of agents. The goal:\n${c1TaskText()}`), ...worker()]);
    expect(reasons(rows)).toEqual(["valid"]);
  });

  // 2026-11-11, Synara's first real C1: 5 agents built it, and every row said the prompt never reached the model.
  test("C1 finds the lead by the handoff codes when the app sends the prompt in a form no text match finds", async () => {
    const pasted = `<pasted_text>\n${JSON.stringify([{ text: c1Prompt() }])}\n</pasted_text>`;
    expect(pasted).not.toContain(c1TaskText());
    const rows = await c1With([{ text: pasted, tools: 0, session: "title" }, ...lead(pasted), ...worker()]);
    expect(reasons(rows)).toEqual(["valid"]);
    // The model of that lead is checked like any other.
    const fable = await c1With([...lead(pasted, { model: "claude-fable-5" }), ...worker()]);
    expect(reasons(fable)).toEqual(["wrong model: claude-fable-5"]);
    // A text with none of this run's codes is still no prompt.
    const other = await c1With([...lead("<pasted_text>[{\"text\":\"another task\"}]</pasted_text>"), ...worker()]);
    expect(reasons(other)).toEqual(["the prompt never reached the model: no main-thread request captured"]);
  });

  test("C1-solo is checked like C1, and one agent alone is what it measures", async () => {
    const rows = await c1With([...team(), ...lead(soloPrompt(), { session: "solo", model: "claude-sonnet-5" })], "bare-cli");
    expect(reasons(rows.slice(0, 8))).toEqual(["valid"]);
    expect(reasons(rows.slice(8))).toEqual(["wrong model: claude-sonnet-5"]);
    // In a real block the two runs are apart in time; here both read one capture, so the other chat has no code at all.
    const none = await c1With([...lead("an older chat answered something else"), ...worker()], "bare-cli");
    expect(reasons(none.slice(8))).toEqual(["the prompt never reached the model: no main-thread request captured"]);
    // The baseline is one agent: nothing asks it for a second one.
    const solo = await c1With([...team(), ...lead(soloPrompt(), { session: "solo" })], "bare-cli");
    expect(reasons(solo.slice(8))).toEqual(["valid"]);
  });

  test("C2 applied is invalid on an invalid grade; dropped stays", async () => {
    const { instruments } = virtualInstruments(join(dir, "plan-c2-grade.jsonl"));
    const ctx = makeContext({ adapter: calibratedAdapter(), instruments: invalidGrade(instruments) });
    const rows = await c2.runRep(ctx, 1);
    expect(rows[0]!.variant).toBe("dropped");
    expect(rows[0]!.valid).toBe(true);
    expect(rows[1]!.variant).toBe("applied");
    expect(rows[1]!.valid).toBe(false);
    expect(rows[1]!.invalid_reason).toBe("grade invalid: missing hidden tests");
    expectValid(rows);
  });

  test("C4 survival is invalid on an invalid grade, never partial", async () => {
    const { instruments } = virtualInstruments(join(dir, "plan-c4-grade.jsonl"));
    const ctx = makeContext({ adapter: calibratedAdapter(), instruments: invalidGrade(instruments) });
    const rows = await c4.runRep(ctx, 1);
    expect(rows[0]!.variant).toBe("survival");
    expect(rows[0]!.valid).toBe(false);
    expect(rows[0]!.value).toBeNull();
    expect(rows[0]!.invalid_reason).toBe("grade invalid: missing hidden tests");
    expect(rows.slice(1).every((row) => row.valid)).toBe(true);
    expect(c4.needsExtraRun(rows)).toBe(false);
    expectValid(rows);
  });

  test("the Bare CLI runs C1-solo even while its own trigger is not calibrated", async () => {
    const adapter = calibratedAdapter("bare-cli");
    delete adapter.orchestrationTrigger;
    const { instruments, clock } = virtualInstruments(join(dir, "plan-c1-solo-only.jsonl"));
    const ctx = makeContext({ adapter, instruments, state: callsCapture(clock, lead(soloPrompt(), { session: "solo" })) });
    const rows = await c1.runRep(ctx, 1);
    expect(rows.length).toBe(11);
    expect(rows.slice(0, 8).every((row) => row.invalid_reason === "not calibrated: orchestrationTrigger")).toBe(true);
    expect(rows.slice(8).map((row) => row.variant)).toEqual(["solo-shipped", "solo-tokens-total", "solo-usd-total"]);
    expect(rows.slice(8).every((row) => row.valid && row.value !== null)).toBe(true);
    expectValid(rows);
  });

  test("C1-solo is the Claude baseline only", async () => {
    const adapter = calibratedAdapter("bare-cli");
    adapter.orchestrationTrigger = null;
    const { instruments } = virtualInstruments(join(dir, "plan-c1-codex.jsonl"));
    const base = makeContext({ adapter, instruments });
    const ctx = { ...base, options: { ...base.options, agent: "codex" as const } };
    const rows = await c1.runRep(ctx, 1);
    expect(rows.length).toBe(8);
    expect(rows.some((row) => row.variant.startsWith("solo-"))).toBe(false);
  });

  test("a dry run checks C2 and C3 with the planned pid 0; a real run does not accept it", async () => {
    const dry = makeContext({
      adapter: calibratedAdapter(),
      instruments: dryInstruments(join(dir, "plan-c2-dry.jsonl")),
      state: new Map<string, unknown>([["launch_pid", 0]]),
    });
    const c2Rows = await c2.runRep(dry, 1);
    expect(c2Rows.every((row) => row.valid)).toBe(true);
    const c3Rows = await c3.runRep(dry, 1);
    expect(c3Rows.every((row) => row.valid)).toBe(true);
    expect(c3Rows[0]!.notes).toContain("probes");

    const { instruments } = virtualInstruments(join(dir, "plan-c2-pid0.jsonl"));
    const real = makeContext({
      adapter: calibratedAdapter(),
      instruments,
      state: new Map<string, unknown>([["launch_pid", 0]]),
    });
    const rows = await c2.runRep(real, 1);
    expect(rows.every((row) => !row.valid && row.invalid_reason === "no launch pid")).toBe(true);
  });

  test("C6 without a calibrated return is invalid before any model time", async () => {
    const calls: string[] = [];
    const adapter = makeFixtureAdapter({ onCall: (call) => calls.push(call) });
    Object.assign(adapter.calibration, calibratedAdapter().calibration);
    const { instruments } = virtualInstruments(join(dir, "plan-c6-missing.jsonl"));
    const ctx = makeContext({ adapter, instruments });
    const rows = await c6.runRep(ctx, 1);
    expect(rows.length).toBe(3);
    expect(rows.every((row) => !row.valid && row.invalid_reason === "not calibrated: returnToThread")).toBe(true);
    expect(calls).not.toContain("adapter.newThread");
    expect(calls).not.toContain("adapter.send");
    expectValid(rows);
  });

  test("C6 reopens the app, keeps its new pid and returns to the thread before it watches", async () => {
    const calls: string[] = [];
    const adapter = makeFixtureAdapter({ onCall: (call) => calls.push(call) });
    adapter.launch = async () => {
      calls.push("adapter.launch");
      return { pid: 5151 };
    };
    adapter.returnToThread = async () => {
      calls.push("adapter.returnToThread");
    };
    const { instruments } = virtualInstruments(join(dir, "plan-c6-return.jsonl"));
    const traced: Instruments = {
      ...instruments,
      fault: async (fault, options) => {
        calls.push(`fault.${fault.kind}`);
        return instruments.fault(fault, options);
      },
    };
    const state = new Map<string, unknown>();
    const ctx = makeContext({ adapter, instruments: traced, state });
    const rows = await c6.runRep(ctx, 1);
    const order = calls.filter((call) => call !== "adapter.configure");
    expect(order).toEqual([
      "adapter.newThread",
      "adapter.send",
      "fault.restart-app",
      "adapter.launch",
      "adapter.returnToThread",
      // No resume in the window, so the one manual continue goes to the returned thread.
      "adapter.send",
    ]);
    expect(state.get("launch_pid")).toBe(5151);
    expect(rows.every((row) => row.valid)).toBe(true);
    expect(rows[0]!.notes).toContain("returned to the thread");
    expectValid(rows);
  });

  test("C6 never quits a host that stays open by name: it uses the adapter's quit", async () => {
    const calls: string[] = [];
    const adapter = makeFixtureAdapter({ id: "bare-cli", onCall: (call) => calls.push(call) });
    adapter.hostStaysOpen = true;
    adapter.returnToThread = async () => {
      calls.push("adapter.returnToThread");
    };
    const { instruments } = virtualInstruments(join(dir, "plan-c6-host.jsonl"));
    const traced: Instruments = {
      ...instruments,
      fault: async () => {
        throw new Error("the fault injector quits by app name and must not run for a host that stays open");
      },
    };
    const ctx = makeContext({ adapter, instruments: traced });
    const rows = await c6.runRep(ctx, 1);
    const tail = calls.filter((call) => call !== "adapter.configure").slice(2, 5);
    expect(tail).toEqual(["adapter.quit", "adapter.launch", "adapter.returnToThread"]);
    expect(rows.every((row) => row.valid)).toBe(true);
    expect(rows[0]!.notes).toContain("host stays open");
  });
});

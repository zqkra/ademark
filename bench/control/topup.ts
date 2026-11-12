// ADEMARK-47: the top-up pass. After the first pass of every app, a test under its minimum of valid repetitions runs
// again, alone, in a new attempt folder of the same run. The rules are in METHODOLOGY.md ("Top-up inside a run").
import type { ResultRow } from "../core/contracts.ts";
import type { TestContext } from "../run/context.ts";
import { TRACK_ORDER, type TestRunner, type TrackLetter } from "../run/registry.ts";
import { NOT_SUPPORTED } from "../calibrate/pass.ts";
import { ACCEPTED_LIMITS, limitFor, markOf, type AcceptedLimit } from "../night/known-failures.ts";
import { isSetAside } from "../night/set-aside.ts";
import { belongsTo } from "./verdicts.ts";

/**
 * Tests that read the state another test leaves in the same block, so a top-up runs them together. Read from the
 * runners (ctx.state) and the block loop (bench/run/loop.ts runBlock):
 * - A6 compares its covered samples with the front samples of A5 (`A5.samples_csv`): without A5 every A6 row is
 *   "no A5 samples".
 * - A10 reads the resting RAM of A5 (`A5.app_median_b`) as its baseline.
 * - A11 needs its seed threads. runBlock seeds them at the start of every Track A block, before the first test, also
 *   when `--tests` keeps one test, so A11 needs no other test. It builds its long thread itself.
 * Every other test needs only the launch and the seeds of its own block.
 */
export const RUNS_WITH: Readonly<Record<string, readonly string[]>> = {
  A6: ["A5"],
  A10: ["A5"],
  A11: [],
};

export interface Minimum {
  /** The variant the minimum counts: the adaptive variant, or null for every variant of the test. */
  variant: string | null;
  min: number;
}

/** The minimum of each test is in its runner: `adaptive.min`, else `repeats()`. */
export function minimumsOf(runners: ReadonlyMap<string, TestRunner>): Map<string, Minimum> {
  const out = new Map<string, Minimum>();
  for (const [id, runner] of runners) {
    if (runner.adaptive !== undefined) out.set(id, { variant: runner.adaptive.variant, min: runner.adaptive.min });
    // Every runner's repeats() is a constant today; a full run passes no smoke flag.
    else out.set(id, { variant: null, min: Math.max(1, Math.trunc(runner.repeats({ smoke: false } as TestContext))) });
  }
  return out;
}

const keyOf = (row: { ade: string; test_id: string }): string => `${row.ade} ${row.test_id}`;

/**
 * True when the test has fewer valid repetitions than its minimum. An adaptive test counts the valid rows of its
 * variant, as its stop rule does. Any other test counts repetitions whose rows are all valid: A9 writes
 * `sessions-kept` at repetition 1 only, so a count per variant would call a complete A9 short.
 */
export function underMinimum(rows: readonly ResultRow[], minimum: Minimum): boolean {
  if (minimum.variant !== null) return rows.filter((row) => row.variant === minimum.variant && row.valid).length < minimum.min;
  const reps = new Map<number, boolean>();
  for (const row of rows) reps.set(row.rep, (reps.get(row.rep) ?? true) && row.valid);
  return [...reps.values()].filter(Boolean).length < minimum.min;
}

export interface TopUpPlan {
  /** Tests that are short, in the order of the block. */
  short: string[];
  /** What the top-up runs: the short tests and the tests they need (RUNS_WITH). */
  tests: string[];
  /** Short tests that get no top-up, with the reason. */
  skipped: { test: string; reason: string }[];
}

/**
 * The tests of one app that are under their minimum in its first attempt. `expected` adds the tests that wrote no row
 * at all. A test whose invalid reason is an approved accepted limit gets no top-up: it is a fact about the app.
 */
export function planTopUp(
  ade: string,
  rows: readonly ResultRow[],
  minimums: ReadonlyMap<string, Minimum>,
  expected: readonly string[] = [],
  limits: readonly AcceptedLimit[] = ACCEPTED_LIMITS,
): TopUpPlan {
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) {
    if (!belongsTo(row.ade, ade)) continue;
    groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
  }
  const short = new Set<string>();
  const skipped: { test: string; reason: string }[] = [];
  for (const list of groups.values()) {
    const test = list[0]!.test_id;
    const minimum = minimums.get(test);
    if (minimum === undefined) continue;
    // A variant the app does not support never makes a repetition short: on 10 Nov every repetition of Diri's A5 had its
    // RAM rows valid and its `agents` rows "not supported here" (detached sessions), and A5 got a top-up that could not
    // change that (control-2026-11-10T08-31-19Z-diri-topup-1).
    const supported = list.filter((row) => !(row.invalid_reason ?? "").startsWith(NOT_SUPPORTED));
    if (supported.length === 0) continue;
    if (!underMinimum(supported, minimum)) continue;
    const invalid = supported.filter((row) => !row.valid);
    // A test set aside after review is measured again even if its reason text happens to match an accepted limit.
    if (invalid.length > 0 && invalid.every((row) => !isSetAside(row) && markOf(row, limits) === "accepted limit")) {
      skipped.push({ test, reason: `accepted limit: ${limitFor(invalid.at(-1)!, limits)?.evidence ?? ""}` });
      continue;
    }
    short.add(test);
  }
  const seen = new Set<string>([...groups.values()].map((list) => list[0]!.test_id));
  for (const test of expected) if (!seen.has(test) && minimums.has(test)) short.add(test);
  const order = (list: Iterable<string>): string[] => {
    const all: string[] = [...TRACK_ORDER.A, ...TRACK_ORDER.B, ...TRACK_ORDER.C];
    return [...new Set(list)].sort((a, b) => all.indexOf(a) - all.indexOf(b));
  };
  const tests = order([...short].flatMap((test) => [...(RUNS_WITH[test] ?? []), test]));
  return { short: order(short), tests, skipped: skipped.filter((entry) => !short.has(entry.test)) };
}

export function tracksOf(tests: readonly string[], runners: ReadonlyMap<string, TestRunner>): TrackLetter[] {
  const tracks = new Set<TrackLetter>();
  for (const test of tests) {
    const runner = runners.get(test);
    if (runner !== undefined) tracks.add(runner.track);
  }
  return (["A", "B", "C"] as const).filter((track) => tracks.has(track));
}

export interface BuildId {
  machine_id: string | null;
  ade_build_sha256: string | null;
}

/** The machine and build of a first attempt, from its rows. */
export function buildIdOf(ade: string, rows: readonly ResultRow[]): BuildId | null {
  const row = rows.find((entry) => belongsTo(entry.ade, ade));
  return row === undefined ? null : { machine_id: row.machine_id, ade_build_sha256: row.ade_build_sha256 };
}

/**
 * Why a top-up may not run or count: another machine, or an app that updated itself since the first attempt (that app
 * is measured again in full, never mixed). Null when it may.
 */
export function topUpRefusal(first: BuildId | null, now: BuildId | null): string | null {
  if (first === null) return "refused: the first attempt has no rows to compare with";
  if (now === null) return "refused: the top-up has no machine id or build to compare";
  if (first.machine_id !== now.machine_id) return `refused: machine ${now.machine_id ?? "unknown"} is not ${first.machine_id ?? "unknown"} of the first attempt`;
  if (first.ade_build_sha256 !== now.ade_build_sha256) {
    const short = (sha: string | null): string => (sha === null ? "none" : sha.slice(0, 12));
    return `refused: the app build changed since the first attempt (${short(first.ade_build_sha256)} then, ${short(now.ade_build_sha256)} now): measure it again in full`;
  }
  return null;
}

export interface Attempt {
  /** How the report names it: `attempt 2`, `top-up 1`. */
  label: string;
  rows: readonly ResultRow[];
}

export interface Merged {
  rows: ResultRow[];
  /** For each row ade and test (`orca A4`), the attempt its rows come from. */
  source: Map<string, string>;
  /** Each top-up whose rows were not used, with the reason. */
  refused: { label: string; reason: string }[];
}

/**
 * Whether a test was under its minimum with these rows, by the rule of `planTopUp`: rows of a variant the app does not
 * support never count, and a test with only such rows is not short. A test with no row is short.
 */
function shortWith(rows: readonly ResultRow[], minimum: Minimum | undefined): boolean {
  if (rows.length === 0) return true;
  const supported = rows.filter((row) => !(row.invalid_reason ?? "").startsWith(NOT_SUPPORTED));
  return supported.length > 0 && minimum !== undefined && underMinimum(supported, minimum);
}

/**
 * All repetitions of one test come from one attempt. A later attempt replaces a test's rows only when the test was
 * under its minimum before that attempt ran; a complete test keeps its attempt, also when a top-up ran it as a companion
 * (RUNS_WITH). The choice depends only on the state before the top-up, never on its rows, so the merge never picks the
 * better result. `topUps` are in the order they ran. A top-up of another machine or build is refused whole. Rows of
 * another run never enter (rule of 9 Nov: that run stays a comparison set).
 */
export function mergeAttempts(ade: string, runId: string, first: Attempt, topUps: readonly Attempt[], minimums: ReadonlyMap<string, Minimum>): Merged {
  const own = (rows: readonly ResultRow[]): ResultRow[] => rows.filter((row) => belongsTo(row.ade, ade));
  const firstRows = own(first.rows);
  const foreign = [...firstRows, ...topUps.flatMap((topUp) => own(topUp.rows))].find((row) => !row.run_id.startsWith(`${runId}-`));
  if (foreign !== undefined) throw new Error(`merge: a row of run ${foreign.run_id} is not of ${runId}`);
  const groups = (rows: readonly ResultRow[]): Map<string, ResultRow[]> => {
    const map = new Map<string, ResultRow[]>();
    for (const row of rows) map.set(keyOf(row), [...(map.get(keyOf(row)) ?? []), row]);
    return map;
  };
  const chosen = new Map<string, { label: string; rows: ResultRow[] }>();
  for (const [key, rows] of groups(firstRows)) chosen.set(key, { label: first.label, rows });
  const firstId = buildIdOf(ade, firstRows);
  const refused: { label: string; reason: string }[] = [];
  for (const topUp of topUps) {
    const extra = own(topUp.rows);
    // A top-up refused before it ran wrote no row: there is nothing to use or to refuse.
    if (extra.length === 0) continue;
    const reason = topUpRefusal(firstId, buildIdOf(ade, extra));
    if (reason !== null) {
      refused.push({ label: topUp.label, reason });
      continue;
    }
    // Review R1, 2026-11-10: A5 runs again only because A6 needs it. If it fails there, a complete A5 must not be lost.
    for (const [key, rows] of groups(extra)) {
      if (shortWith(chosen.get(key)?.rows ?? [], minimums.get(rows[0]!.test_id))) chosen.set(key, { label: topUp.label, rows });
    }
  }
  const source = new Map<string, string>();
  const rows: ResultRow[] = [];
  for (const [key, entry] of chosen) {
    rows.push(...entry.rows);
    source.set(key, entry.label);
  }
  return { rows, source, refused };
}

/** One app of a run, as `missing` reads it. */
export interface MissingApp {
  ade: string;
  /** The measure step is done: false for a measure that is pending, failed or skipped. */
  measured: boolean;
  /** The measure folder, then each top-up in the order they ran. Empty when nothing was measured. */
  attempts: readonly Attempt[];
  /** The tests this app runs in the tracks of its measure, so a test with no row counts as short. */
  expected: readonly string[];
  /**
   * ADEMARK-49: whether each late step has a finished (done) attempt. `orchestration` is null for an app that gets no
   * such step (no trigger: its C1 is not supported). Absent for an app the caller does not plan late steps for.
   */
  late?: { tokens: boolean; orchestration: boolean | null };
}

export interface Missing {
  /** Apps with no measured attempt: measured again in full. */
  measure: string[];
  /** Measured apps with tests under their minimum after every attempt so far: one more top-up each. */
  topUps: { ade: string; short: string[]; tests: string[] }[];
  /** Apps with no finished tokens attempt (ADEMARK-49): one tokens step each, after the measures and top-ups. */
  tokens: string[];
  /** Apps that need an orchestration step and have no finished attempt: one each, after every tokens step. */
  orchestration: string[];
}

/**
 * ADEMARK-51: what a pass that measures only what is missing would do. A test is short after merging the first attempt
 * and every top-up, with the rules of `planTopUp`: no top-up for `not supported` rows nor for an approved accepted limit,
 * and companions through RUNS_WITH. Throws when rows of another run are in a folder (as the merge does).
 */
export function missing(runId: string, apps: readonly MissingApp[], minimums: ReadonlyMap<string, Minimum>, limits: readonly AcceptedLimit[] = ACCEPTED_LIMITS): Missing {
  const out: Missing = { measure: [], topUps: [], tokens: [], orchestration: [] };
  for (const app of apps) {
    // A late step is independent of Track A: an app measured again in full still needs its tokens.
    if (app.late !== undefined && !app.late.tokens) out.tokens.push(app.ade);
    if (app.late !== undefined && app.late.orchestration === false) out.orchestration.push(app.ade);
    const [first, ...topUps] = app.attempts;
    if (!app.measured || first === undefined) {
      out.measure.push(app.ade);
      continue;
    }
    const merged = mergeAttempts(app.ade, runId, first, topUps, minimums);
    const plan = planTopUp(app.ade, merged.rows, minimums, app.expected, limits);
    if (plan.tests.length > 0) out.topUps.push({ ade: app.ade, short: plan.short, tests: plan.tests });
  }
  return out;
}

/**
 * The line under the button: `Conductor, Cloudroom: all tests. Emdash: A7. Tokens: Bare CLI, Orca. Orchestration: Bare
 * CLI.` Empty when nothing is missing.
 */
export function missingLine(plan: Missing, label: (ade: string) => string = (ade) => ade): string {
  const parts: string[] = [];
  if (plan.measure.length > 0) parts.push(`${plan.measure.map(label).join(", ")}: all tests.`);
  for (const entry of plan.topUps) parts.push(`${label(entry.ade)}: ${entry.short.join(", ")}.`);
  if ((plan.tokens ?? []).length > 0) parts.push(`Tokens: ${plan.tokens.map(label).join(", ")}.`);
  if ((plan.orchestration ?? []).length > 0) parts.push(`Orchestration: ${plan.orchestration.map(label).join(", ")}.`);
  return parts.join(" ");
}

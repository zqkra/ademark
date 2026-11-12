// report.md of a Control night: the morning report. For each app and test it names the attempt the rows come from
// (ADEMARK-47), marks each invalid row `accepted limit` or NEW (ADEMARK-45), and adds the QA verdict of each folder
// (ADEMARK-46). Its first line is the count of NEW rows: zero is the goal.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isRehearsalId } from "./folders.ts";
import { readVerdict, rowsIn } from "./qa.ts";
import { entriesFor, isSetAside, SET_ASIDE, unusedEntries, type SetAside } from "../night/set-aside.ts";
import { mergeAttempts, type Minimum } from "./topup.ts";
import { freshCount, lineText, testLines } from "./verdicts.ts";

/**
 * Smoke rows never count as a measurement: a rehearsal run, a `-smoke` folder or a smoke manifest is refused by the
 * report and by anything that publishes. Throws with the reason.
 */
export function refuseRehearsal(runId: string, dirs: readonly string[] = []): void {
  if (isRehearsalId(runId)) throw new Error(`${runId} is a rehearsal: smoke rows are never a measurement`);
  for (const dir of dirs) {
    if (/-smoke$/.test(basename(dir))) throw new Error(`${dir} is a smoke folder: smoke rows are never a measurement`);
    const manifest = join(dir, "manifest.json");
    if (!existsSync(manifest)) continue;
    try {
      if ((JSON.parse(readFileSync(manifest, "utf8")) as { mode?: string }).mode === "smoke") throw new Error("smoke");
    } catch (error) {
      if (error instanceof Error && error.message === "smoke") throw new Error(`${dir} holds a smoke run: smoke rows are never a measurement`);
    }
  }
}

/** ADEMARK-49: one late step of an app: the folder of its newest done attempt, or null with the reason. */
export interface LatePart {
  folder: { attempt: number; dir: string } | null;
  note: string;
}

/** The C1 values the report shows, in this order (TESTS.md section 4, C1). */
export const C1_SHOWN = ["shipped", "time-to-green", "fan-out-max", "fan-out-total", "handoff"] as const;

export interface ReportApp {
  ade: string;
  label: string;
  /** The measure folder that holds the app's rows (adopted or last), or null when none finished. */
  first: { attempt: number; dir: string } | null;
  /** Every top-up that ran, in the order it ran: a later one exists only after the owner's pass (ADEMARK-51). */
  topUps: readonly { attempt: number; dir: string }[];
  expected: readonly string[];
  /** What the queue says, for an app with no folder. */
  note: string;
  /** Where `ademark qa` wrote its verdicts when it could not write beside the rows. */
  qaDir?: (dir: string) => string;
  /** Track B, from its own tokens step (ADEMARK-49). Absent in a report from before that step. */
  tokens?: LatePart;
  /** The B tests this app runs, so a B test with no row shows as missing. */
  tokensExpected?: readonly string[];
  /** Track C1, from its own orchestration step. */
  orchestration?: LatePart;
}

type Rows = ReturnType<typeof rowsIn>;
const valueOf = (rows: Rows, variant: string, rep?: number): number | null => {
  const row = rows.find((entry) => entry.test_id === "C1" && entry.variant === variant && entry.valid && entry.value !== null && (rep === undefined || entry.rep === rep));
  return row?.value ?? null;
};

/**
 * `orchestration-tax` (TESTS.md section 4): the tokens and $ of the app's C1 run over those of Bare CLI's solo run of the
 * C1 goal. The solo run is the one of Bare CLI's lowest repetition with a valid value. Only valid rows with a value
 * count: anything else gives no tax, with the reason, never a number.
 */
export function orchestrationTax(rows: Rows, rep: number, solo: Rows | null): { tokens: string; usd: string } {
  const none = (why: string) => ({ tokens: `no value: ${why}`, usd: `no value: ${why}` });
  if (solo === null) return none("Bare CLI has no finished orchestration attempt");
  const soloRep = solo.filter((row) => row.test_id === "C1" && row.variant === "solo-tokens-total" && row.valid && row.value !== null).map((row) => row.rep).sort((a, b) => a - b)[0];
  if (soloRep === undefined) return none("Bare CLI's solo run has no valid tokens row");
  const ratio = (variant: string, soloVariant: string): string => {
    const own = valueOf(rows, variant, rep);
    const base = valueOf(solo, soloVariant, soloRep);
    if (own === null) return `no value: no valid ${variant} row`;
    if (base === null || base === 0) return `no value: no valid ${soloVariant} row of Bare CLI`;
    return `${(own / base).toFixed(2)}x`;
  };
  return { tokens: ratio("tokens-total", "solo-tokens-total"), usd: ratio("usd-total", "solo-usd-total") };
}

/**
 * `setAside` is the reviewed list (bench/night/set-aside.ts). `root` is the results folder: with it, an entry of a run
 * that has no folder there is named in the notes.
 */
export function buildRunReport(o: {
  runId: string;
  ended: boolean;
  apps: readonly ReportApp[];
  minimums: ReadonlyMap<string, Minimum>;
  setAside?: readonly SetAside[];
  root?: string;
}): string {
  const entries = o.setAside ?? SET_ASIDE;
  const read: { dir: string; rows: ReturnType<typeof rowsIn> }[] = [];
  const rowsOf = (dir: string): ReturnType<typeof rowsIn> => {
    const rows = rowsIn(dir, entries);
    read.push({ dir, rows });
    return rows;
  };
  // ADEMARK-56: an attempt keeps saying which of its tests a review set aside, also after a top-up replaced them.
  const asideLines = (label: string, dir: string, rows: ReturnType<typeof rowsIn>): string[] =>
    entriesFor(dir, entries).filter((entry) => rows.some((row) => row.test_id === entry.test && isSetAside(row)))
      .map((entry) => `  - ${entry.test} of ${label}: set aside after review (${entry.date}): ${entry.reason}. Evidence: ${entry.evidence}`);
  refuseRehearsal(o.runId, o.apps.flatMap((app) => [app.first?.dir, ...app.topUps.map((topUp) => topUp.dir)].filter((dir): dir is string => dir !== undefined)));
  let fresh = 0;
  const body: string[] = [];
  const escape = (text: string): string => text.replaceAll("|", "\\|");
  const bareCli = o.apps.find((app) => app.ade === "bare-cli")?.orchestration?.folder ?? null;
  // Read once: every app's tax divides by it.
  const solo = bareCli === null ? null : rowsIn(bareCli.dir, entries);
  // ADEMARK-49: Track B and Track C1 come from their own steps. Each part names its attempt; its rows never mix with the
  // measure, and a set-aside entry (`attempt: "tokens-1"`) or an accepted limit works as for Track A.
  const late = (app: ReportApp): void => {
    if (app.tokens !== undefined) {
      body.push("### Track B (tokens)", "");
      if (app.tokens.folder === null) {
        const lines = testLines(app.ade, [], app.tokensExpected ?? []);
        if ((app.tokensExpected ?? []).length > 0) fresh += freshCount(lines);
        body.push(`No tokens attempt finished. ${app.tokens.note}`.trim(), "");
      } else {
        const label = `tokens ${app.tokens.folder.attempt}`;
        const rows = rowsOf(app.tokens.folder.dir);
        const lines = testLines(app.ade, rows, app.tokensExpected ?? []);
        fresh += freshCount(lines);
        body.push(`- ${label}: ${basename(app.tokens.folder.dir)}`, ...asideLines(label, app.tokens.folder.dir, rows), "", "| test | attempt | result |", "| --- | --- | --- |");
        for (const line of lines) body.push(`| ${line.rowAde === app.ade ? line.test : `${line.test} (${line.rowAde})`} | ${label} | ${escape(lineText(line))} |`);
        body.push("");
      }
    }
    if (app.orchestration !== undefined) {
      body.push("### Track C (orchestration, C1)", "");
      if (app.orchestration.folder === null) {
        body.push(`${app.orchestration.note || "No orchestration attempt finished."}`, "");
        return;
      }
      const label = `orchestration ${app.orchestration.folder.attempt}`;
      const rows = rowsOf(app.orchestration.folder.dir);
      const lines = testLines(app.ade, rows.filter((row) => row.test_id === "C1"), ["C1"]);
      fresh += freshCount(lines);
      body.push(`- ${label}: ${basename(app.orchestration.folder.dir)}`, ...asideLines(label, app.orchestration.folder.dir, rows));
      for (const line of lines) body.push(`- C1${line.rowAde === app.ade ? "" : ` (${line.rowAde})`}: ${lineText(line)}`);
      body.push("", "| rep | value | result |", "| --- | --- | --- |");
      const own = rows.filter((row) => row.test_id === "C1" && row.ade === app.ade);
      for (const rep of [...new Set(own.map((row) => row.rep))].sort((a, b) => a - b)) {
        for (const variant of C1_SHOWN) {
          const row = own.find((entry) => entry.rep === rep && entry.variant === variant);
          const result = row === undefined ? "no row" : !row.valid ? `invalid: ${row.invalid_reason ?? ""}` : row.value === null ? `no value${row.notes ? `: ${row.notes}` : ""}` : `${row.value} ${row.unit}`;
          body.push(`| ${rep} | ${variant} | ${escape(result)} |`);
        }
        const tax = orchestrationTax(own, rep, solo);
        body.push(`| ${rep} | orchestration-tax (tokens) | ${escape(tax.tokens)} |`, `| ${rep} | orchestration-tax ($) | ${escape(tax.usd)} |`);
      }
      body.push("");
    }
  };
  for (const app of o.apps) {
    body.push(`## ${app.label} (${app.ade})`, "");
    if (app.first === null) {
      const lines = testLines(app.ade, [], app.expected);
      fresh += freshCount(lines);
      body.push(`No measured folder. ${app.note}`.trim(), "");
      late(app);
      continue;
    }
    const first = { label: `attempt ${app.first.attempt}`, rows: rowsOf(app.first.dir) };
    const topUps = app.topUps.map((topUp) => ({ label: `top-up ${topUp.attempt}`, rows: rowsOf(topUp.dir), dir: topUp.dir }));
    const merged = mergeAttempts(app.ade, o.runId, first, topUps, o.minimums);
    const lines = testLines(app.ade, merged.rows, app.expected);
    fresh += freshCount(lines);
    const qaOf = (dir: string): string => {
      const verdict = readVerdict(app.qaDir?.(dir) ?? dir);
      return verdict === null ? "not run yet (`ademark qa`)" : verdict.ok ? "pass" : `fail: ${verdict.note}`;
    };
    body.push(`- ${first.label}: ${basename(app.first.dir)}, QA ${qaOf(app.first.dir)}`, ...asideLines(first.label, app.first.dir, first.rows));
    for (const topUp of topUps) body.push(`- ${topUp.label}: ${basename(topUp.dir)}, QA ${qaOf(topUp.dir)}`, ...asideLines(topUp.label, topUp.dir, topUp.rows));
    for (const refused of merged.refused) body.push(`- ${refused.label} not used: ${refused.reason}`);
    body.push("", "| test | attempt | result |", "| --- | --- | --- |");
    for (const line of lines) {
      const name = line.rowAde === app.ade ? line.test : `${line.test} (${line.rowAde})`;
      const source = merged.source.get(`${line.rowAde} ${line.test}`) ?? "-";
      body.push(`| ${name} | ${source} | ${lineText(line).replaceAll("|", "\\|")} |`);
    }
    body.push("");
    late(app);
  }
  return [
    `${fresh} invalid rows that are not accepted limits (NEW)`,
    "",
    `# Night ${o.runId}`,
    "",
    `- status: ${o.ended ? "finished" : "running"}`,
    "- every repetition of one test comes from one attempt: a later one only for a test that was short before it; the attempt column names it (METHODOLOGY.md, top-up).",
    "- a QA verdict is a finding for this report: it never starts a measurement.",
    "- Track B and C1 come from their own steps (tokens, orchestration), after every measure: a failed one never changes a Track A result (METHODOLOGY.md).",
    "- a test set aside after review (bench/night/set-aside.ts) is not valid in that attempt and is measured again; its rows on disk stay as they are.",
    ...unusedEntries({ runId: o.runId, read, root: o.root, entries })
      .map(({ entry, why }) => `- set-aside entry ${entry.run} ${entry.ade} ${entry.test} attempt ${entry.attempt} changed nothing: ${why}.`),
    "",
    ...body,
  ].join("\n").replace(/\n+$/, "\n");
}

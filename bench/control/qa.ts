// QA of a finished attempt: code gathers the evidence, and a reviewer decides if the block measured what its rows say.
// Since 2026-11-10 it runs by day (`ademark qa --run <id>`), from any account, and never inside the night: it only reads
// files, and 15 checks of up to 10 minutes took 2.5 h of the night (ADEMARK-46). A verdict goes to the report and
// never starts a measurement.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentCodexHome } from "../agent/eyes.ts";
import type { ResultRow } from "../core/contracts.ts";
import { repoRoot } from "../core/paths.ts";
import { failuresOf } from "../night/repair.ts";
import { applySetAside, SET_ASIDE, type SetAside } from "../night/set-aside.ts";
import { MODEL_PINS } from "../run/models.ts";
import type { TrackLetter } from "../run/registry.ts";
import { everyBlockDone, rowCount } from "./adopt.ts";
import { foldersOf } from "./folders.ts";

const OCR_SAMPLE = 40;

export function promptTemplate(): string {
  return readFileSync(join(dirname(new URL(import.meta.url).pathname), "qa-prompt.md"), "utf8");
}

function files(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    // Superseded attempts and repair logs are not what this block's rows came from.
    if (name === "repairs" || /\.attempt-\d+$/.test(name)) continue;
    if (statSync(path).isDirectory()) files(path, found);
    else found.push(path);
  }
  return found;
}

function ocrOf(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { frames?: { ocr?: string[] }[] };
    return (parsed.frames ?? []).flatMap((frame) => frame.ocr ?? []);
  } catch {
    return [];
  }
}

export function evidence(runDir: string, ade: string, rows: readonly ResultRow[]): string {
  const mine = rows.filter((row) => row.ade === ade || row.ade.startsWith(`${ade}-`));
  const lines = [`Rows: ${mine.length}, valid ${mine.filter((row) => row.valid).length}.`];
  const failures = failuresOf(ade, [], mine);
  lines.push(failures.length === 0 ? "Code found no failed output." : `Failed outputs:\n- ${failures.join("\n- ")}`);
  const values = mine.filter((row) => row.valid && row.value !== null).slice(0, 30);
  lines.push("Sample values:", ...values.map((row) => `- ${row.test_id} ${row.variant}: ${row.value} ${row.unit}`));
  const all = files(runDir);
  const replay = all.filter((path) => path.endsWith("-replay.jsonl"));
  for (const path of replay) {
    const sessions = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { session?: string | null }).session ?? "none");
    const counts = new Map<string, number>();
    for (const session of sessions) counts.set(session, (counts.get(session) ?? 0) + 1);
    lines.push(`Replay log requests by session: ${[...counts].map(([name, n]) => `${name} ${n}`).join(", ")}`);
  }
  const ocr = [...new Set(all.filter((path) => /frames.*\.json$/.test(path)).flatMap(ocrOf))].slice(0, OCR_SAMPLE);
  lines.push("Screen text seen (OCR):", ...ocr.map((text) => `- ${text}`));
  const images = all.filter((path) => /\.(png|jpg)$/.test(path)).slice(0, 6);
  if (images.length > 0) lines.push("Images:", ...images.map((path) => `- ${path}`));
  return lines.join("\n");
}

export function parseVerdict(text: string): { ok: boolean; note: string } {
  const line = text.split("\n").map((entry) => entry.trim()).filter((entry) => entry.startsWith("VERDICT:")).at(-1);
  if (line === undefined) return { ok: false, note: "QA gave no verdict" };
  const verdict = line.slice("VERDICT:".length).trim();
  if (verdict === "pass") return { ok: true, note: "" };
  return { ok: false, note: verdict.replace(/^fail:?\s*/, "") || "QA failed the block" };
}

export const QA_TIMEOUT_MS = 10 * 60_000;
/** At most this many reviewers at once: each is one Codex or Claude session on the owner's plan. */
export const QA_PARALLEL = 4;

export interface QaVerdict {
  ade: string;
  dir: string;
  ok: boolean;
  note: string;
  at: string;
}

/**
 * The rows of one attempt folder as Control counts them. Every reader of Control (the pass plan, the merge, the report,
 * the panel's counts and QA) reads here, so a test set aside after review (bench/night/set-aside.ts) is not valid for
 * all of them alike. The file is only read.
 */
export function rowsIn(dir: string, setAside: readonly SetAside[] = SET_ASIDE): ResultRow[] {
  const path = join(dir, "rows.jsonl");
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as ResultRow);
  return applySetAside(dir, rows, setAside);
}

/** The verdict beside the rows, for the morning report. */
export function verdictFile(dir: string): string {
  return join(dir, "qa-verdict.json");
}

export function readVerdict(dir: string): QaVerdict | null {
  try {
    return JSON.parse(readFileSync(verdictFile(dir), "utf8")) as QaVerdict;
  } catch {
    return null;
  }
}

interface MeasureRow {
  attempts: number;
  adopted_attempt: number | null;
  status: string;
}

/** What the queue says about one app of a run: its measure, and the folder numbers of the top-ups that ran to an end. */
export interface QueueView {
  measure: MeasureRow;
  topUps: number[];
}

// The queue is read only. From another account its WAL files may not open: then the folders on disk decide.
export function queueView(database: string, runId: string, ade: string): QueueView | null {
  if (!existsSync(database)) return null;
  try {
    const db = new Database(database, { readonly: true });
    try {
      const measure = db.query<MeasureRow, [string, string]>("SELECT attempts, adopted_attempt, status FROM tasks WHERE run_id = ? AND ade = ? AND step = 'measure'").get(runId, ade);
      if (measure === null) return null;
      // A top-up that waits after a crash has a cut folder: the next attempt writes a new one (bench/control/real.ts runFolders).
      const topUps = db.query<{ attempts: number }, [string, string]>(
        "SELECT attempts FROM tasks WHERE run_id = ? AND ade = ? AND step = 'top-up' AND attempts > 0 AND status IN ('done', 'failed') ORDER BY attempts",
      ).all(runId, ade).map((task) => task.attempts);
      return { measure, topUps };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** A folder that finished: rows, and the marker of every block its rows belong to (the rule of bench/control/adopt.ts). */
export function finishedFolder(dir: string, ade: string, agents: readonly ("claude" | "codex" | "own")[]): boolean {
  return rowCount(dir) > 0 && everyBlockDone(dir, ade, tracksOfRows(rowsIn(dir)), agents);
}

function tracksOfRows(rows: readonly ResultRow[]): TrackLetter[] {
  const letters = new Set(rows.map((row) => row.test_id[0]).filter((letter): letter is TrackLetter => letter === "A" || letter === "B" || letter === "C"));
  return [...letters];
}

/**
 * The measure folder that holds an app's rows: the adopted attempt when Continue adopted one, else the last attempt of
 * the queue, only for a measure that is done. Without the queue, the newest folder with rows whose blocks all wrote their
 * marker (bench/control/adopt.ts).
 */
export function measuredFolder(o: { root: string; database: string; runId: string; ade: string; agents: readonly ("claude" | "codex" | "own")[] }):
  { attempt: number; dir: string; from: "queue" | "disk" } | null {
  const found = foldersOf(o.root, o.runId, o.ade).attempts;
  const queued = queueView(o.database, o.runId, o.ade)?.measure ?? null;
  if (queued !== null) {
    // Review R2, 2026-11-10: Conductor's measure was pending at 2 attempts, and `conductor-2` counted as measured.
    if (queued.status !== "done") return null;
    const attempt = queued.adopted_attempt ?? queued.attempts;
    const dir = found.get(attempt);
    return dir === undefined ? null : { attempt, dir, from: "queue" };
  }
  for (const attempt of [...found.keys()].sort((a, b) => b - a)) {
    const dir = found.get(attempt)!;
    if (finishedFolder(dir, o.ade, o.agents)) return { attempt, dir, from: "disk" };
  }
  return null;
}

export type Spawn = (argv: readonly string[], timeoutMs: number, stdoutPath: string) => Promise<number>;

/** The reviewer's command line. QA runs on the owner's ChatGPT plan through Codex; ADEMARK_QA=claude uses Claude. */
export function qaArgv(prompt: string, answer: string): string[] {
  const pin = MODEL_PINS.claude;
  return process.env.ADEMARK_QA === "claude"
    ? [join(homedir(), ".local/bin/claude"), "-p", prompt, "--model", pin.model!, "--effort", pin.effort!]
    : ["/usr/bin/env", `CODEX_HOME=${agentCodexHome()}`, join(homedir(), ".local/bin/codex"), "exec", "--skip-git-repo-check",
      "--ephemeral", "-s", "read-only", "-C", repoRoot, "-o", answer, prompt];
}

/**
 * One QA check of one folder. It writes qa.txt, the reviewer's answer and qa-verdict.json beside the rows, or in `outDir`
 * when the folder belongs to an account this one cannot write to.
 */
export async function qaFolder(ade: string, dir: string, spawn: Spawn, outDir: string = dir, now: () => string = () => new Date().toISOString()): Promise<QaVerdict> {
  const rows = rowsIn(dir);
  let result: { ok: boolean; note: string };
  if (rows.length === 0) result = { ok: false, note: "no rows to check" };
  else {
    const prompt = promptTemplate()
      .replaceAll("{{ADE}}", ade)
      .replaceAll("{{RUN_DIR}}", dir)
      .replaceAll("{{EVIDENCE}}", evidence(dir, ade, rows));
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, "qa.txt");
    const answer = join(outDir, "qa-answer.txt");
    const code = await spawn(qaArgv(prompt, answer), QA_TIMEOUT_MS, out);
    if (code !== 0) result = { ok: false, note: code === 124 ? "QA ran out of time" : `QA exited with code ${code}` };
    else result = parseVerdict(readFileSync(existsSync(answer) ? answer : out, "utf8"));
  }
  const verdict: QaVerdict = { ade, dir, ...result, at: now() };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(verdictFile(outDir), `${JSON.stringify(verdict, null, 2)}\n`);
  return verdict;
}

/** Runs `work` on every item, at most `limit` at once, and keeps the order of the items in the result. */
export async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

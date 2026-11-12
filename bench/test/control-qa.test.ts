// ADEMARK-46: QA by day. It reads the adopted attempt of each app, runs at most 4 reviewers at once, and writes its
// verdict beside the rows. It never starts a measurement and refuses a rehearsal.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayFolders, runQa } from "../control/day.ts";
import { controlFiles } from "../control/files.ts";
import { measuredFolder, pool, readVerdict } from "../control/qa.ts";
import { Store } from "../control/store.ts";
import { row } from "./control-rows.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ademark-qa-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const RUN = "control-2026-11-10T01-00-00Z";

// What a finished bare-cli attempt leaves: its rows and the marker of its Track A block.
function attempt(ade: string, n: number | string, o: { rows: number; marker: boolean }): string {
  const dir = join(root, `${RUN}-${ade}-${n}`);
  const block = ade === "bare-cli" ? "bare-cli-claude" : ade;
  mkdirSync(join(dir, block), { recursive: true });
  const rows = Array.from({ length: o.rows }, (_, i) => JSON.stringify(row({ ade: block, run_id: `${RUN}-${ade}-${n}`, test_id: "A5", variant: "app", rep: i + 1 })));
  writeFileSync(join(dir, "rows.jsonl"), rows.map((line) => `${line}\n`).join(""));
  if (o.marker) writeFileSync(join(dir, block, "A-claude.done"), "");
  return dir;
}

function queue(adopted: number | null, attempts: number): void {
  const store = new Store(controlFiles(false, root).database);
  store.createRun(RUN, RUN, ["bare-cli"], false, "2026-11-10T01:00:00.000Z");
  const measure = store.tasks(RUN).find((task) => task.step === "measure")!;
  for (let i = 0; i < attempts; i++) store.start(measure.id, "t");
  if (adopted !== null) store.adopt(measure.id, adopted, "adopted", "t");
  else store.finish(measure.id, "done", "", "t");
  store.close();
}

describe("which folder QA reads", () => {
  test("the adopted attempt from the queue, not the newest folder", () => {
    const first = attempt("bare-cli", 1, { rows: 89, marker: true });
    attempt("bare-cli", 2, { rows: 3, marker: true });
    queue(1, 2);
    expect(measuredFolder({ root, database: controlFiles(false, root).database, runId: RUN, ade: "bare-cli", agents: ["claude", "own"] }))
      .toEqual({ attempt: 1, dir: first, from: "queue" });
  });

  test("without an adoption, the last attempt of the queue", () => {
    attempt("bare-cli", 1, { rows: 89, marker: true });
    const second = attempt("bare-cli", 2, { rows: 3, marker: true });
    queue(null, 2);
    expect(dayFolders(root, RUN, ["bare-cli"])[0]).toMatchObject({ attempt: 2, dir: second, from: "queue" });
  });

  test("from an account that cannot read the queue: the newest folder with rows and every marker", () => {
    const first = attempt("bare-cli", 1, { rows: 89, marker: true });
    attempt("bare-cli", 2, { rows: 0, marker: false });
    expect(dayFolders(root, RUN, ["bare-cli"])).toEqual([{ ade: "bare-cli", kind: "attempt", attempt: 1, dir: first, from: "disk" }]);
  });

  test("a top-up folder is checked too", () => {
    attempt("bare-cli", 1, { rows: 89, marker: true });
    const topUp = attempt("bare-cli", "topup-1", { rows: 6, marker: true });
    expect(dayFolders(root, RUN, ["bare-cli"]).map((entry) => `${entry.kind} ${entry.dir}`)).toContain(`top-up ${topUp}`);
  });

  // Review R2, 2026-11-10: Conductor's measure was pending at 2 attempts, and `conductor-2` counted as measured.
  test("a measure the queue has not finished is no measured folder, and the disk does not overrule the queue", () => {
    attempt("bare-cli", 1, { rows: 89, marker: true });
    attempt("bare-cli", 2, { rows: 3, marker: true });
    const store = new Store(controlFiles(false, root).database);
    store.createRun(RUN, RUN, ["bare-cli"], false, "2026-11-10T01:00:00.000Z");
    const measure = store.tasks(RUN).find((task) => task.step === "measure")!;
    store.start(measure.id, "t");
    store.start(measure.id, "t");
    store.finish(measure.id, "failed", "exit 1", "t");
    store.retry(RUN, "bare-cli");
    store.close();
    expect(measuredFolder({ root, database: controlFiles(false, root).database, runId: RUN, ade: "bare-cli", agents: ["claude", "own"] })).toBeNull();
    expect(dayFolders(root, RUN, ["bare-cli"])).toEqual([]);
  });

  // Review R3, 2026-11-10: a top-up cut by a crash leaves a folder that is not moved aside.
  test("from disk, a top-up counts only with rows and every block marker", () => {
    attempt("bare-cli", 1, { rows: 89, marker: true });
    const done = attempt("bare-cli", "topup-1", { rows: 6, marker: true });
    attempt("bare-cli", "topup-2", { rows: 2, marker: false });
    attempt("bare-cli", "topup-3", { rows: 0, marker: true });
    expect(dayFolders(root, RUN, ["bare-cli"]).filter((entry) => entry.kind === "top-up").map((entry) => entry.dir)).toEqual([done]);
  });

  test("from the queue, only the top-ups that ran to an end", () => {
    attempt("bare-cli", 1, { rows: 89, marker: true });
    attempt("bare-cli", "topup-1", { rows: 2, marker: false });
    const second = attempt("bare-cli", "topup-2", { rows: 6, marker: true });
    queue(null, 1);
    const store = new Store(controlFiles(false, root).database);
    store.addTopUp(RUN, "bare-cli", ["A5"]);
    const topUp = store.tasks(RUN).find((task) => task.step === "top-up")!;
    // Attempt 1 was cut by a crash, attempt 2 finished.
    store.start(topUp.id, "t");
    store.recover(RUN);
    store.start(topUp.id, "t");
    store.finish(topUp.id, "done", "", "t");
    store.close();
    expect(dayFolders(root, RUN, ["bare-cli"]).filter((entry) => entry.kind === "top-up").map((entry) => `${entry.attempt} ${entry.dir} ${entry.from}`))
      .toEqual([`2 ${second} queue`]);
  });

  test("a rehearsal is refused", () => {
    expect(() => dayFolders(root, "rehearsal-2026-11-10T01-00-00Z", ["bare-cli"])).toThrow("rehearsal");
  });
});

describe("qa", () => {
  test("writes qa.txt and the verdict beside the rows of the adopted attempt", async () => {
    const first = attempt("bare-cli", 1, { rows: 89, marker: true });
    const other = attempt("bare-cli", 2, { rows: 3, marker: true });
    queue(1, 2);
    const asked: string[] = [];
    const verdicts = await runQa({
      root,
      runId: RUN,
      ades: ["bare-cli"],
      dryRun: false,
      print: () => {},
      spawn: async (argv, _ms, stdoutPath) => {
        asked.push(argv.join(" "));
        writeFileSync(stdoutPath, "looked at the rows\nVERDICT: fail: A5 rows show another app\n");
        return 0;
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(first);
    expect(verdicts).toMatchObject([{ ade: "bare-cli", ok: false, note: "A5 rows show another app" }]);
    expect(readFileSync(join(first, "qa.txt"), "utf8")).toContain("VERDICT");
    expect(readVerdict(first)).toMatchObject({ ok: false, note: "A5 rows show another app" });
    expect(existsSync(join(other, "qa.txt"))).toBe(false);
    // A verdict never starts a measurement: the queue is as it was.
    const store = new Store(controlFiles(false, root).database);
    expect(store.tasks(RUN).map((task) => `${task.step} ${task.status}`)).toEqual(["prove pending", "measure done"]);
    store.close();
  });

  test("--out holds the verdicts when the folders are not this account's", async () => {
    const first = attempt("bare-cli", 1, { rows: 5, marker: true });
    const out = join(root, "out");
    await runQa({ root, runId: RUN, ades: ["bare-cli"], dryRun: false, out, print: () => {}, spawn: async (_argv, _ms, path) => {
      writeFileSync(path, "VERDICT: pass\n");
      return 0;
    } });
    expect(readVerdict(join(out, `${RUN}-bare-cli-1`))?.ok).toBe(true);
    expect(existsSync(join(first, "qa.txt"))).toBe(false);
  });

  test("a dry run lists the folders and starts no reviewer", async () => {
    attempt("bare-cli", 1, { rows: 5, marker: true });
    const lines: string[] = [];
    let spawned = 0;
    await runQa({ root, runId: RUN, ades: ["bare-cli"], dryRun: true, print: (line) => lines.push(line), spawn: async () => ++spawned });
    expect(spawned).toBe(0);
    expect(lines.join("\n")).toContain(`${RUN}-bare-cli-1`);
  });

  test("at most 4 reviewers at once, and the order of the results is kept", async () => {
    let now = 0;
    let most = 0;
    const out = await pool([1, 2, 3, 4, 5, 6, 7], 4, async (item) => {
      now += 1;
      most = Math.max(most, now);
      await Bun.sleep(5);
      now -= 1;
      return item * 10;
    });
    expect(most).toBe(4);
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });
});

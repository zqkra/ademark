import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CaptureRow } from "../core/contracts.ts";
import type { PriceFile } from "../capture/tokens.ts";
import { rescoreBlock } from "../tracks/b/rescore.ts";

const TASKS = resolve(import.meta.dir, "..", "..", "tasks");
const PRICES: PriceFile = {
  date: "2026-10-19",
  currency: "USD",
  unit: "per_million_tokens",
  models: {
    "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write_5m: 5, cache_write_1h: 8 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5, cache_read: 0.01, cache_write_5m: 0.125, cache_write_1h: 0.2 },
  },
};
const MAIN = { input: 2, cache_write: 1000, cache_write_1h: 1000, cache_read: 5000, output: 26 };
const SIDE = { input: 1205, cache_write: 0, cache_write_1h: 0, cache_read: 0, output: 23 };

let root: string;
let previousTasks: string | undefined;

function row(partial: Partial<CaptureRow>): CaptureRow {
  return {
    t_ns: 0,
    request_id: null,
    host: "api.anthropic.com",
    path: "/v1/messages?beta=true",
    pid: null,
    process: null,
    model: "claude-opus-5-5",
    user_agent: "claude-cli/2.1.303 (external, cli)",
    req_bytes: 100,
    status: 200,
    usage: null,
    main_thread: null,
    user_text_sha256: [],
    chunk_t_ns: [],
    body_file: null,
    ...partial,
  };
}

// One B1 rep as the harness leaves it: proxy rows, bodies, notes with the window, and the six result rows.
function writeBlock(values: Record<string, number | null>, options: { mainModel?: string } = {}): string {
  const block = join(root, "run");
  const capture = join(block, "ade", "capture-B-1");
  mkdirSync(join(capture, "bodies"), { recursive: true });
  mkdirSync(join(block, "ade", "B1", "claude", "rep-01"), { recursive: true });
  writeFileSync(join(capture, "bodies", "0001.json"), JSON.stringify({ model: "claude-opus-5-5", tools: [{ name: "Read" }], messages: [{ role: "user", content: "hi" }] }));
  writeFileSync(join(capture, "bodies", "0002.json"), JSON.stringify({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "Name this thread: hi" }] }));
  const rows = [
    row({ t_ns: 1100, model: options.mainModel ?? "claude-opus-5-5", usage: MAIN, body_file: "bodies/0001.json", request_id: "req_1" }),
    row({ t_ns: 1200, model: "claude-haiku-5-5", usage: SIDE, body_file: "bodies/0002.json", request_id: "req_2" }),
    row({ t_ns: 1300, path: "/v1/messages/count_tokens", body_file: null }),
  ];
  writeFileSync(join(capture, "capture.jsonl"), rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  writeFileSync(join(block, "ade", "B1", "claude", "rep-01", "notes.md"), "# B1 rep 1\nwindow: 1000 -> 2000 ns\n");
  const prices = join(root, "prices.json");
  writeFileSync(prices, JSON.stringify(PRICES));
  process.env.ADEMARK_PRICES = prices;
  writeFileSync(join(block, "manifest.json"), JSON.stringify({ price_file_sha256: createHash("sha256").update(readFileSync(prices)).digest("hex") }));
  const result = Object.entries(values).map(([variant, value]) => ({
    ade: "fixture-ade",
    test_id: "B1",
    variant,
    rep: 1,
    model: "claude-opus-5-5",
    value,
    valid: true,
    notes: "",
    receipts: { samples: null, video: null, frames: null, capture: "ade/capture-B-1/capture.jsonl", log: "ade/B1/claude/rep-01/notes.md" },
  }));
  writeFileSync(join(block, "rows.jsonl"), result.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return block;
}

const TRUE_VALUES = {
  "fresh-input": 2,
  "cache-write": 1000,
  "cache-read": 5000,
  output: 26,
  "side-tokens": 1228,
  usd: (2 * 4 + 1000 * 8 + 5000 * 0.2 + 26 * 20 + 1205 * 0.1 + 23 * 0.5) / 1_000_000,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ademark-rescore-"));
  previousTasks = process.env.ADEMARK_TASKS;
  process.env.ADEMARK_TASKS = TASKS;
});

afterEach(() => {
  if (previousTasks === undefined) delete process.env.ADEMARK_TASKS;
  else process.env.ADEMARK_TASKS = previousTasks;
  delete process.env.ADEMARK_PRICES;
  rmSync(root, { recursive: true, force: true });
});

test("a block whose rows the capture gives again is reproduced", () => {
  const result = rescoreBlock(writeBlock(TRUE_VALUES), PRICES);
  expect(result.notes).toEqual([]);
  expect(result.reps).toEqual([{ ade: "fixture-ade", test: "B1", rep: 1, valid: true, main: 1, side: 1, differences: [] }]);
});

// 2026-11-06: B3 rows of Bare CLI, Paseo and Orca were valid at about 2.5 times what their own capture holds.
test("a valid row that claims more than its capture is not reproduced", () => {
  const result = rescoreBlock(writeBlock({ ...TRUE_VALUES, "cache-read": 12_500 }), PRICES);
  expect(result.reps[0]!.differences).toEqual(["cache-read: row 12500, capture 5000"]);
});

test("a valid row with no value, or a main thread on another model, is not reproduced", () => {
  const result = rescoreBlock(writeBlock({ ...TRUE_VALUES, usd: null }, { mainModel: "claude-sonnet-5" }), PRICES);
  expect(result.reps[0]!.differences).toContain("usd: valid with no value");
  expect(result.reps[0]!.differences).toContain("main model claude-sonnet-5, row model claude-opus-5-5");
});

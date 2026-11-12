// Writes the fixed Track A sessions (hi, seed, long-2000) and the scripted stand-ins for
// stream-1 to stream-5. Deterministic: the same bytes on every run, so `--check` can prove
// the files on disk are current. Usage: bun bench/replay/build-sessions.ts [--check]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_ROOT = "/private/tmp/ademark-recording/arena";
export const SESSIONS_DIR = join(import.meta.dir, "sessions");
export const STREAM_CHARS = 57_600;

export interface BuiltSession {
  file: string;
  content: string;
  stream: number | null;
}

interface SessionHeader {
  type: "session";
  name: string;
  api: "anthropic";
  match: string;
  root: string;
  pacing?: "none";
  stand_in?: true;
}

interface SessionTurn {
  type: "turn";
  index: number;
  blocks: unknown[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

export const STREAM_FILES: Record<number, string> = {
  1: "src/paginate.ts",
  2: "src/dates.ts",
  3: "src/api.ts",
  4: "src/invoices.ts",
  5: "src/server.ts",
};

export const RECORDED_STREAMS = [1, 2, 3, 4, 5] as const;

function header(
  name: string,
  extra: { pacing?: "none"; stand_in?: true } = {},
): SessionHeader {
  const value: SessionHeader = {
    type: "session",
    name,
    api: "anthropic",
    match: `replay:${name}`,
    root: SESSION_ROOT,
  };
  if (extra.pacing) value.pacing = extra.pacing;
  if (extra.stand_in) value.stand_in = true;
  return value;
}

function turn(
  index: number,
  blocks: unknown[],
  stopReason: string,
  input: number,
  output: number,
): SessionTurn {
  return {
    type: "turn",
    index,
    blocks,
    stop_reason: stopReason,
    usage: { input_tokens: input, output_tokens: output },
  };
}

function render(fileHeader: SessionHeader, turns: SessionTurn[]): string {
  return `${[fileHeader, ...turns].map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function hiSession(): string {
  return render(header("hi"), [
    turn(
      0,
      [{ type: "text", text: "LEDGERMARK. Hi! How can I help you with Ledger?" }],
      "end_turn",
      12,
      14,
    ),
  ]);
}

function seedSession(): string {
  return render(header("seed"), [
    turn(
      0,
      [{ type: "text", text: "Seeded. This thread is open and the repository is unchanged." }],
      "end_turn",
      11,
      13,
    ),
  ]);
}

// Plain sentences about reading the same file, picked by index so the build never drifts.
// Every text keeps the LONGTHREAD-END and Seeded markers out of the thread on purpose: A11
// watches for "THREAD-END" and "unchanged", and both must appear only where they belong.
const LONG_SENTENCES: readonly string[] = [
  "I opened src/invoices.ts and read it from the imports down to the last export.",
  "I read every line of src/invoices.ts before I touched anything, because the totals are computed in three places.",
  "The first pass over src/invoices.ts showed me that the rounding helper lives at the bottom of the file.",
  "I read src/invoices.ts twice: once for the exported functions and once for the helpers they call.",
  "Reading src/invoices.ts, I wrote down the four callers of totalsFor and what each one does with the result.",
  "I started with the imports of src/invoices.ts, since they already say which date helpers the module needs.",
  "I read src/invoices.ts and noted that the tax rate is stored per line, not per invoice.",
  "The comments in src/invoices.ts are short, so I read the tests next to confirm what each function promises.",
  "I read src/invoices.ts and found the guard that silently turns a negative quantity into zero.",
  "I went through src/invoices.ts line by line and marked the two spots where the total is rounded.",
  "I read the export list of src/invoices.ts first, then the body of each function in the order it appears.",
  "I read src/invoices.ts and noticed that the due date is computed from the issue date plus the net days.",
  "I read src/invoices.ts and saw that the currency is fixed, which removes one whole branch from the change.",
  "I read the top half of src/invoices.ts, where the types are, and the bottom half, where the arithmetic is.",
  "I read src/invoices.ts and counted five places that build an invoice total, three of them in tests.",
  "I read src/invoices.ts and found the status field is derived, never stored, so nothing has to be migrated.",
  "I read src/invoices.ts and saw that every exported function takes a plain object, which keeps the tests simple.",
  "I read src/invoices.ts and confirmed that the page size is a parameter and not a constant in this module.",
  "I read src/invoices.ts and found the one place where a missing tax rate is treated as zero.",
  "I read src/invoices.ts and traced what happens to an invoice whose items list is empty.",
  "I read src/invoices.ts and checked that the totals are integers in cents, so no floating point leaks out.",
  "I read src/invoices.ts and saw the sort by issue date happens before anything is sliced into a page.",
  "I read src/invoices.ts and noted that the helper for the due date is used by two other modules.",
  "I read src/invoices.ts and wrote a short list of the functions the change has to keep stable.",
];

// Invoice-module snippets, six to ten lines each, for the every-fifth step that shows code.
const LONG_CODE: readonly string[] = [
  `export function lineTotal(item: InvoiceItem): number {
  const net = Math.round(item.quantity * item.unitPriceCents);
  const tax = Math.round(net * item.taxRate);
  return net + tax;
}

export function invoiceTotal(invoice: Invoice): number {
  return invoice.items.reduce((sum, item) => sum + lineTotal(item), 0);
}`,
  `export function parseAmount(raw: string): number {
  const value = Number(raw.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(value)) {
    throw new RangeError("not an amount: " + raw);
  }
  return Math.round(value * 100);
}`,
  `export function dueDate(invoice: Pick<Invoice, "issued" | "netDays">): string {
  const issued = new Date(invoice.issued + "T00:00:00Z");
  issued.setUTCDate(issued.getUTCDate() + invoice.netDays);
  return issued.toISOString().slice(0, 10);
}

export function isOverdue(invoice: Invoice, today: string): boolean {
  return dueDate(invoice) < today;
}`,
  `export interface InvoiceItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRate: number;
}`,
  `function summarize(invoice: Invoice): InvoiceSummary {
  const total = invoiceTotal(invoice);
  const due = dueDate(invoice);
  return {
    id: invoice.id,
    totalCents: total,
    due,
    overdue: due < todayISO(),
  };
}`,
  `export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const rest = String(absolute % 100).padStart(2, "0");
  return sign + whole + "." + rest;
}`,
  `function parseInvoice(row: Record<string, string>): Invoice | null {
  const id = row.id;
  if (!id) return null;
  const issued = row.issued ?? todayISO();
  const netDays = Number(row.netDays ?? "30");
  const items = row.items === undefined ? [] : JSON.parse(row.items);
  return { id, issued, netDays, items };
}`,
  `export function pageInvoices(invoices: Invoice[], page: number, size: number): Invoice[] {
  const start = Math.max(0, (page - 1) * size);
  const end = Math.min(invoices.length, start + size);
  const sorted = [...invoices].sort((a, b) => a.issued.localeCompare(b.issued));
  return sorted.slice(start, end);
}

export const MAX_PAGE_SIZE = 100;`,
];

// One visible step: the counter, one plain sentence, and every fifth step a TypeScript fence.
function longText(index: number): string {
  const sentence = LONG_SENTENCES[index % LONG_SENTENCES.length] as string;
  const text = `Step ${index + 1} of 1000. ${sentence}`;
  if (index % 5 !== 4) return text;
  const snippet = LONG_CODE[index % LONG_CODE.length] as string;
  return `${text}\n\n\`\`\`ts\n${snippet}\n\`\`\``;
}

function longSession(): string {
  const turns: SessionTurn[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    const text = longText(index);
    turns.push(
      turn(
        index,
        [
          { type: "text", text },
          {
            type: "tool_use",
            id: `toolu_long_${String(index + 1).padStart(4, "0")}`,
            name: "Read",
            input: { file_path: `${SESSION_ROOT}/src/invoices.ts` },
          },
        ],
        "tool_use",
        1_800 + index * 12,
        Math.ceil(text.length / 4),
      ),
    );
  }
  turns.push(
    turn(
      1_000,
      [
        {
          type: "text",
          text: "LONGTHREAD-END. That is every line of src/invoices.ts, and the totals add up.",
        },
      ],
      "end_turn",
      13_800,
      19,
    ),
  );
  return render(header("long-2000", { pacing: "none" }), turns);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Next = () => number;

function pick<T>(rng: Next, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

const PROSE: readonly ((file: string) => string)[] = [
  (file) => `I read ${file} top to bottom and wrote down every caller before changing anything.`,
  (file) => `The part of ${file} that matters for this change is the boundary handling, not the happy path.`,
  () => "Nothing here needs a new dependency, so the change stays inside the module.",
  () => "I kept the exported signature so the callers and the existing tests keep working.",
  () => "The failure I am fixing is the kind that only shows up on the second page, which is why the tests missed it.",
  () => "I traced the path a request takes and found the value clamped in two places with two different rules.",
  () => "The simplest fix is to compute the rule once, in a helper, and let both call sites use it.",
  () => "I did not touch the response shape, because the client already depends on every field in it.",
  () => "The empty list is the case to check first: it must produce an empty page and a null cursor, not a crash.",
  () => "The arithmetic is small, but it runs on every request, so I moved it out of the loop.",
  () => "There is one more caller in the export path that repeats the same three lines, so it gets the helper too.",
  () => "I ran the tests after each step, and they stayed green except for the two cases I expected to change.",
  () => "The diff is deliberately small: one branch disappears, one helper appears, and the call sites stay readable.",
  () => "I left the comments that explain why the code is shaped this way, and dropped the one that repeated the code.",
  () => "The tests I am adding cover the first page, the last page and a page past the end.",
  () => "A single item and an exact multiple of the page size are the two edges worth pinning down.",
  () => "The type checker is strict here, so the helper returns a plain object and the caller narrows it.",
  () => "I kept the error messages as they were, because the API test asserts on the message body.",
  () => "The order of the items is the thing that makes the cursor stable, so the sort stays before the slice.",
  () => "If the stored total shrinks between two requests, the cursor should still return the next page instead of throwing.",
  () => "I avoided a second pass over the list; the index is enough to find where the page starts.",
  () => "The old code copied the whole array on every call; the new one copies only the page.",
  () => "I checked the behaviour with an empty string, a null value and a number before settling on the guard.",
  () => "The status codes stay the same, so no client has to change how it reads the error.",
  () => "One subtle point: the comparison has to be on the parsed date, not on the string, or a leap year breaks it.",
  () => "I moved the magic number into a named constant so the next reader does not have to guess its unit.",
  () => "The rounding happens once, at the end, so the per-line totals still add up to the invoice total.",
  () => "Every branch is covered by a test now, including the one that returns the empty page.",
];

const CODE: readonly string[] = [
  `export function pageBounds(total: number, page: number, size: number): { start: number; end: number } {
  const pages = Math.max(1, Math.ceil(total / size));
  const capped = Math.min(Math.max(page, 1), pages);
  return { start: (capped - 1) * size, end: Math.min(total, capped * size) };
}`,
  `function encodeCursor(id: string): string {
  return Buffer.from(\`v1:\${id}\`, "utf8").toString("base64url");
}

function decodeCursor(raw: string): string | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  return text.startsWith("v1:") ? text.slice(3) : null;
}`,
  `export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}`,
  `function parseLimit(raw: string | null, fallback = 20): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError(\`limit must be an integer from 1 to 100, got \${raw}\`);
  }
  return value;
}`,
  `export function totalCents(invoice: Invoice): number {
  return invoice.items.reduce(
    (sum, item) => sum + Math.round(item.quantity * item.unitPriceCents * (1 + item.taxRate)),
    0,
  );
}`,
  `createServer((incoming, outgoing) => {
  const response = app.handle({
    method: incoming.method ?? "GET",
    path: incoming.url ?? "/",
    headers: normalizeHeaders(incoming.headers),
  });
  outgoing.writeHead(response.status, response.headers);
  outgoing.end(JSON.stringify(response.body));
});`,
  `export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  limit: number;
}

export function toPage<T>(items: T[], decode: (item: T) => string, limit: number): Page<T> {
  const next = items.length > limit ? decode(items[limit] as T) : null;
  return { items: items.slice(0, limit), nextCursor: next, limit };
}`,
  `export function isOverdue(invoice: Pick<Invoice, "issued" | "netDays">, today: string): boolean {
  return daysOverdue(invoice, today) > 0;
}

export function daysOverdue(invoice: Pick<Invoice, "issued" | "netDays">, today: string): number {
  const difference = Date.parse(today) - Date.parse(dueDate(invoice));
  return Math.max(0, Math.round(difference / DAY_MS));
}`,
];

const DIFFS: readonly string[] = [
  `-  const end = start + pageSize + 1;
-  items: all.slice(start, end),
+  const end = Math.min(totalItems, start + pageSize);
+  items: all.slice(start, end),`,
  `-const date = new Date(day);
+const date = new Date(\`\${day}T00:00:00Z\`);`,
  `-  const page = Number(url.searchParams.get("page") ?? "1");
-  const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
+  const limit = parseLimit(url.searchParams.get("limit"));
+  const cursor = url.searchParams.get("cursor");`,
  `-  hasNext: page <= totalPages,
+  hasNext: page < totalPages,
+  nextCursor: page < totalPages ? encodeCursor(page + 1) : null,`,
  `-    return json(400, { error: "bad_request" });
+    return json(400, { error: "bad_cursor" });`,
  `-  return items.slice(start, end).map(toSummary);
+  return items.slice(start, end).map(toSummary).filter((item) => item.id !== last);`,
  `-  const total = subtotalCents(invoice) + taxCents(invoice);
+  const total = Math.round(subtotalCents(invoice) * (1 + invoice.items[0]!.taxRate));`,
];

function prose(rng: Next, file: string): string {
  const count = 2 + Math.floor(rng() * 4);
  const sentences: string[] = [];
  let previous = -1;
  for (let index = 0; index < count; index += 1) {
    let chosen = Math.floor(rng() * PROSE.length);
    if (chosen === previous) chosen = (chosen + 1) % PROSE.length;
    previous = chosen;
    sentences.push((PROSE[chosen] as (file: string) => string)(file));
  }
  return sentences.join(" ");
}

function pickDifferent<T>(rng: Next, items: readonly T[], previous: number): number {
  let index = Math.floor(rng() * items.length);
  if (items.length > 1 && index === previous) index = (index + 1) % items.length;
  return index;
}

const CODE_CAPTIONS: readonly string[] = [
  "For reference, the shape I am after:",
  "The helper I would add:",
  "The module after the change:",
  "This is the part I want to keep:",
];

const DIFF_CAPTIONS: readonly string[] = [
  "The change itself:",
  "The diff for that step:",
  "Here is the edit:",
  "The smallest change that fixes it:",
];

function fenced(rng: Next, fence: "ts" | "diff", body: string, caption: string): string {
  const lead = rng() < 0.5 ? "" : `${caption}\n\n`;
  return `${lead}\`\`\`${fence}\n${body}\n\`\`\``;
}

// Every stream gets the same shape of answer (prose, code, diffs) with its own seeded choices,
// so the five files differ from each other and never change between builds.
export function streamAnswer(stream: number, file: string): string {
  const rng = mulberry32(0x5eed_0000 + stream * 7919);
  const sections: string[] = [];
  let length = 0;
  let diffs = 0;
  let lastCode = -1;
  let lastDiff = -1;

  const push = (section: string): void => {
    sections.push(section);
    length += section.length + 2;
  };

  push(`I will go through ${file} in the order a request hits it and change one thing at a time.`);
  while (length < STREAM_CHARS) {
    const roll = rng();
    if (roll < 0.45) {
      push(prose(rng, file));
    } else if (roll < 0.7) {
      lastCode = pickDifferent(rng, CODE, lastCode);
      push(fenced(rng, "ts", CODE[lastCode] as string, pick(rng, CODE_CAPTIONS)));
    } else {
      lastDiff = pickDifferent(rng, DIFFS, lastDiff);
      push(fenced(rng, "diff", DIFFS[lastDiff] as string, pick(rng, DIFF_CAPTIONS)));
      diffs += 1;
    }
  }
  if (diffs === 0) push(fenced(rng, "diff", pick(rng, DIFFS), pick(rng, DIFF_CAPTIONS)));
  push(`That is the whole change. Do you want me to apply it and run npm test before I go on?`);
  return sections.join("\n\n");
}

function streamSession(stream: number): string {
  const file = STREAM_FILES[stream] as string;
  const answer = streamAnswer(stream, file);
  return render(header(`stream-${stream}`, { stand_in: true }), [
    turn(
      0,
      [
        {
          type: "text",
          text: `I will start with ${file} so the change matches the code that is already there.`,
        },
        {
          type: "tool_use",
          id: `toolu_stream_${stream}_0001`,
          name: "Read",
          input: { file_path: `${SESSION_ROOT}/${file}` },
        },
      ],
      "tool_use",
      1_870,
      65,
    ),
    turn(
      1,
      [{ type: "text", text: answer }],
      "end_turn",
      4_380,
      Math.ceil(answer.length / 4),
    ),
  ]);
}

export function buildSessions(): BuiltSession[] {
  const files: BuiltSession[] = [
    { file: "hi.jsonl", content: hiSession(), stream: null },
    { file: "seed.jsonl", content: seedSession(), stream: null },
    { file: "long-2000.jsonl", content: longSession(), stream: null },
  ];
  for (const stream of RECORDED_STREAMS) {
    files.push({ file: `stream-${stream}.jsonl`, content: streamSession(stream), stream });
  }
  return files;
}

function readHeader(path: string): Record<string, unknown> | null {
  try {
    const line = readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? "";
    const value = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// A stream file belongs to the builder only while it is missing or still marked stand_in.
// Anything else in that slot is a pilot recording and must never be overwritten by a rebuild.
export function mayReplace(path: string): boolean {
  if (!existsSync(path)) return true;
  return readHeader(path)?.stand_in === true;
}

export interface SessionPlan {
  managed: BuiltSession[];
  kept: string[];
}

export function planSessions(dir: string, files: BuiltSession[] = buildSessions()): SessionPlan {
  const managed: BuiltSession[] = [];
  const kept: string[] = [];
  for (const file of files) {
    if (file.stream === null || mayReplace(join(dir, file.file))) managed.push(file);
    else kept.push(file.file);
  }
  return { managed, kept };
}

export interface WriteResult {
  written: string[];
  kept: string[];
}

export function writeSessions(dir: string, files: BuiltSession[] = buildSessions()): WriteResult {
  mkdirSync(dir, { recursive: true });
  const plan = planSessions(dir, files);
  for (const file of plan.managed) writeFileSync(join(dir, file.file), file.content);
  return { written: plan.managed.map((file) => join(dir, file.file)), kept: plan.kept };
}

// Only managed files are checked: a recording in a stream slot is not the builder's to report.
export function staleSessions(dir: string, files: BuiltSession[] = buildSessions()): string[] {
  const stale: string[] = [];
  for (const file of planSessions(dir, files).managed) {
    const path = join(dir, file.file);
    if (!existsSync(path) || readFileSync(path, "utf8") !== file.content) stale.push(file.file);
  }
  return stale;
}

function streamName(file: string): string {
  return file.replace(/\.jsonl$/, "");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error("usage: bun bench/replay/build-sessions.ts [--check]");
    process.exit(2);
  }
  const plan = planSessions(SESSIONS_DIR);
  if (args[0] === "--check") {
    for (const file of plan.kept) console.log(`kept recording ${streamName(file)}`);
    const stale = staleSessions(SESSIONS_DIR);
    if (stale.length > 0) {
      console.error(`sessions differ: ${stale.join(", ")}`);
      process.exit(1);
    }
    console.log(`sessions current in ${SESSIONS_DIR}`);
  } else {
    const result = writeSessions(SESSIONS_DIR);
    for (const path of result.written) console.log(`wrote ${path}`);
    for (const file of result.kept) console.log(`kept recording ${streamName(file)}`);
  }
}

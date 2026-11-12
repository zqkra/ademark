// Token totals for captured model requests and $ pricing from a dated price file.

import { createHash } from "node:crypto";
import type { CapturedUsage, CaptureRow } from "../core/contracts";
import { userTextCandidates } from "../replay/session.ts";

export interface UsageWithCalls extends CapturedUsage {
  calls: number;
}

export interface UsageSplit {
  main: UsageWithCalls;
  side: UsageWithCalls;
}

export interface PriceRates {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write_5m: number | null;
  cache_write_1h: number | null;
}

export interface PriceModel extends PriceRates {
  /** Rates for one request with more input than `above`, counting cache reads and writes. */
  long_context?: PriceRates & { above: number };
  source?: string;
}

export interface PriceFile {
  date: string;
  currency: string;
  unit: string;
  models: Record<string, PriceModel>;
}

function emptyTotals(): UsageWithCalls {
  return { input: 0, cache_write: 0, cache_read: 0, output: 0, calls: 0 };
}

function addUsage(totals: UsageWithCalls, usage: CapturedUsage | null): void {
  if (!usage) return;
  totals.input += usage.input;
  totals.cache_write += usage.cache_write;
  totals.cache_read += usage.cache_read;
  totals.output += usage.output;
}

export function sumUsage(rows: CaptureRow[]): UsageWithCalls {
  const totals = emptyTotals();
  for (const row of rows) {
    totals.calls += 1;
    addUsage(totals, row.usage);
  }
  return totals;
}

export function splitUsage(rows: CaptureRow[]): UsageSplit {
  const main = emptyTotals();
  const side = emptyTotals();
  for (const row of rows) {
    const totals = row.main_thread === true ? main : side;
    totals.calls += 1;
    addUsage(totals, row.usage);
  }
  return { main, side };
}

// Only a completion spends tokens. `/v1/messages/count_tokens`, model lists and plugin lists never carry usage.
export function isCompletion(row: Pick<CaptureRow, "path">): boolean {
  const path = row.path.split("?")[0]!.replace(/\/+$/, "");
  return path.endsWith("/v1/messages") || path.endsWith("/responses") || path.endsWith("/chat/completions");
}

// A refused request (401, 429) spends nothing, so its missing usage is not an unknown.
export function lacksUsage(row: Pick<CaptureRow, "usage" | "status">): boolean {
  return row.usage === null && row.status < 400;
}

export interface ThreadShape {
  /** Hashes and text of the task: the last user message that does not answer a tool. */
  taskHashes: string[];
  taskText: string;
  /** The last user message is the task itself, not a tool answer: this request starts a turn. */
  startsTurn: boolean;
  /** Claude Code's `cc_turn_origin`. An SDK host also gives it to the title calls it makes itself. */
  userTurn: boolean;
  /** How many tools the model was given. A title call has few or none, and the working thread has them all. */
  tools: number;
  /** The request follows the answer with this id (`thread`), or this request (Claude Code's `cc_prev_req`). */
  continuation: boolean;
  previousMessage: string | null;
  previousRequest: string | null;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => (block as { type?: unknown } | null)?.type === "tool_result");
}

function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((block) => (block as { text?: unknown } | null)?.text).filter((text) => typeof text === "string").join("\n");
}

const TOOL_OUTPUT_ITEMS = new Set(["function_call_output", "custom_tool_call_output"]);

export function threadShape(body: unknown): ThreadShape | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as {
    messages?: unknown;
    input?: unknown;
    system?: unknown;
    tools?: unknown;
    thread?: { type?: unknown; previous_message_id?: unknown } | null;
  };
  const header = systemText(record.system);
  const previousMessage = record.thread?.previous_message_id;
  const common = {
    continuation: record.thread?.type === "continue",
    previousMessage: typeof previousMessage === "string" ? previousMessage : null,
    previousRequest: header.match(/cc_prev_req=(req_\w+)/)?.[1] ?? null,
    userTurn: /cc_turn_origin=(human|sdk)\b/.test(header),
    tools: Array.isArray(record.tools) ? record.tools.length : 0,
  };
  let texts: string[];
  let startsTurn = true;
  if (Array.isArray(record.messages)) {
    const users = record.messages.filter((message) => (message as { role?: unknown } | null)?.role === "user") as { content?: unknown }[];
    const task = [...users].reverse().find((entry) => !hasToolResult(entry.content));
    texts = task === undefined ? [] : userTextCandidates({ messages: [task] });
    startsTurn = users.length > 0 && !hasToolResult(users.at(-1)!.content);
  } else if (typeof record.input === "string") {
    texts = userTextCandidates({ input: record.input });
  } else if (Array.isArray(record.input)) {
    const items = record.input as { role?: unknown; type?: unknown }[];
    const last = items.map((item) => item?.role).lastIndexOf("user");
    texts = last < 0 ? [] : userTextCandidates({ input: [items[last]] });
    startsTurn = !items.slice(last + 1).some((item) => TOOL_OUTPUT_ITEMS.has(String(item?.type)));
  } else {
    return null;
  }
  return { ...common, taskHashes: texts.map(hashText), taskText: texts.join("\n"), startsTurn };
}

// A request is on the main thread if its task is the prompt, or if it continues a request that is. A fork such as a
// suggestion call, or a subagent, has a task of its own even with the prompt in its history. An app can wrap the prompt in
// its own text, and so does a title call, so only when no request has the prompt alone does the wrapped request with the most
// tools start the thread. A continuation of something this capture never saw stays unresolved: its rep is invalid, because
// a guess would be a wrong number that looks right.
export function classifyMainThread(
  rows: CaptureRow[],
  promptText: string,
  shapeOf: (row: CaptureRow) => ThreadShape | null = () => null,
): CaptureRow[] {
  const prompt = promptText.trim();
  const wanted = hashText(prompt);
  const ordered = [...rows].sort((a, b) => a.t_ns - b.t_ns);
  const messages = new Set(ordered.flatMap((row) => (row.message_id == null ? [] : [row.message_id])));
  const requests = new Set(ordered.flatMap((row) => (row.request_id == null ? [] : [row.request_id])));
  const mainIds = new Set<string>();
  const decided = new Map<CaptureRow, CaptureRow>();
  const shapes = new Map(ordered.map((row) => [row, row.main_thread === null ? shapeOf(row) : null]));
  const exact = ordered.some((row) => shapes.get(row)?.taskHashes.includes(wanted) === true);
  const wrapped = exact
    ? undefined
    : ordered
        .filter((row) => shapes.get(row)?.userTurn === true && shapes.get(row)!.taskText.includes(prompt))
        .reduce<CaptureRow | undefined>((best, row) => (best === undefined || shapes.get(row)!.tools > shapes.get(best)!.tools ? row : best), undefined);
  // A full-history client repeats the same task and the same tools on every tool answer. A title call can repeat the task,
  // but it has fewer tools.
  const wrappedShape = wrapped === undefined ? null : shapes.get(wrapped)!;
  for (const row of ordered) {
    const shape = shapes.get(row) ?? null;
    let main = row.main_thread ?? row.user_text_sha256.includes(wanted);
    let unresolved = false;
    let starts = false;
    if (shape !== null) {
      const isTask = shape.taskHashes.includes(wanted) || (shape.taskText === wrappedShape?.taskText && shape.tools === wrappedShape.tools);
      const link = shape.previousMessage !== null && messages.has(shape.previousMessage)
        ? shape.previousMessage
        : shape.previousRequest !== null && requests.has(shape.previousRequest)
          ? shape.previousRequest
          : null;
      main = isTask || (shape.continuation && link !== null && mainIds.has(link));
      unresolved = !isTask && shape.continuation && link === null;
      starts = isTask && shape.startsTurn && row.status < 400;
    }
    if (main) {
      if (row.request_id != null) mainIds.add(row.request_id);
      if (row.message_id != null) mainIds.add(row.message_id);
    }
    decided.set(row, row.main_thread !== null ? row : { ...row, main_thread: main, ...(unresolved ? { thread_unresolved: true } : {}), ...(starts ? { starts_turn: true } : {}) });
  }
  return rows.map((row) => decided.get(row)!);
}

function priceOrNull(tokens: number, price: number | null | undefined): number | null {
  if (tokens === 0) return 0;
  return price ?? null;
}

const OPENAI_HOSTS = new Set(["api.openai.com", "chatgpt.com"]);

export function isOpenAiHost(host: string): boolean {
  return OPENAI_HOSTS.has(host);
}

// TESTS.md §3: OpenAI counts cached tokens inside input_tokens, Anthropic does not.
export function freshInput(usage: CapturedUsage, host: string): number {
  return isOpenAiHost(host) ? Math.max(0, usage.input - usage.cache_read) : usage.input;
}

// Pricing applies to fresh input, so the cached part is not charged twice on OpenAI hosts.
export function pricedUsage(usage: CapturedUsage, host: string): CapturedUsage {
  return {
    input: freshInput(usage, host),
    cache_write: usage.cache_write,
    ...(usage.cache_write_1h === undefined ? {} : { cache_write_1h: usage.cache_write_1h }),
    cache_read: usage.cache_read,
    output: usage.output,
  };
}

function addComponents(totals: UsageWithCalls, row: CaptureRow): void {
  if (!row.usage) return;
  totals.input += freshInput(row.usage, row.host);
  totals.cache_write += row.usage.cache_write;
  totals.cache_read += row.usage.cache_read;
  totals.output += row.usage.output;
}

// Like splitUsage, with the per-host fresh-input rule of TESTS.md §3 applied to every row.
export function splitComponents(rows: CaptureRow[]): UsageSplit {
  const main = emptyTotals();
  const side = emptyTotals();
  for (const row of rows) {
    const totals = row.main_thread === true ? main : side;
    totals.calls += 1;
    addComponents(totals, row);
  }
  return { main, side };
}

export function totalComponents(usage: CapturedUsage): number {
  return usage.input + usage.cache_write + usage.cache_read + usage.output;
}

export interface RowPrice {
  usd: number | null;
  missingModel: string | null;
}

// Each request is priced with its own model: side calls can run on a different one than the main thread.
export function priceRows(rows: CaptureRow[], prices: PriceFile): RowPrice {
  let usd = 0;
  for (const row of rows) {
    if (!row.usage) continue;
    const priced = priceUsd(pricedUsage(row.usage, row.host), row.model ?? "", prices);
    if (priced === null) return { usd: null, missingModel: row.model ?? "unknown" };
    usd += priced;
  }
  return { usd, missingModel: null };
}

export function priceUsd(usage: CapturedUsage, model: string, prices: PriceFile): number | null {
  const base = prices.models[model];
  if (!base) return null;
  const promptTokens = usage.input + usage.cache_write + usage.cache_read;
  const price: PriceRates = base.long_context !== undefined && promptTokens > base.long_context.above ? base.long_context : base;
  // Without the TTL split the cost of a cache write is unknown, not the cheap one.
  if (usage.cache_write > 0 && usage.cache_write_1h === undefined) return null;
  const writes1h = usage.cache_write_1h ?? 0;
  const writes5m = usage.cache_write - writes1h;
  const input = priceOrNull(usage.input, price.input);
  const output = priceOrNull(usage.output, price.output);
  const cacheRead = priceOrNull(usage.cache_read, price.cache_read);
  const write5m = priceOrNull(writes5m, price.cache_write_5m);
  const write1h = priceOrNull(writes1h, price.cache_write_1h);
  if (input === null || output === null || cacheRead === null || write5m === null || write1h === null) return null;
  return (
    (usage.input * input + usage.output * output + usage.cache_read * cacheRead + writes5m * write5m + writes1h * write1h) /
    1_000_000
  );
}

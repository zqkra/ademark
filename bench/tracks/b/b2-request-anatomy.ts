// B2 Request Anatomy: split the first B1 request into segments and count each one (TESTS.md §3).
import { writeFileSync } from "node:fs";
import { loadTask } from "../../core/tasks.ts";
import { invalidRow, receipt } from "../../run/kit.ts";
import type { TestContext } from "../../run/context.ts";
import type { TestRunner } from "../../run/registry.ts";
import { captureFor, captureReceipt, readBodyText, repProblem, repsFor, soundReps } from "./shared.ts";

export type SegmentName = "system" | "tools" | "mcp-tools" | "injected" | "params";

export interface AnatomySegment {
  name: SegmentName;
  text: string;
  chars: number;
  bytes: number;
}

export interface Anatomy {
  segments: AnatomySegment[];
  system: string;
  injected: string;
  tools: unknown[];
  mcpTools: unknown[];
  params: Record<string, unknown>;
  toolNames: string[];
  mcpToolNames: string[];
  paramsKeys: string[];
}

export const SEGMENT_NAMES: readonly SegmentName[] = ["system", "tools", "mcp-tools", "injected", "params"];
const CONVERSATION_KEYS = new Set(["messages", "input", "system", "instructions", "tools"]);
const ANTHROPIC_COUNT_URL = "https://api.anthropic.com/v1/messages/count_tokens";

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function blockTexts(content: unknown): string[] {
  if (typeof content === "string") return content.length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part.length > 0) texts.push(part);
      continue;
    }
    const block = asObject(part);
    if (block === null) continue;
    const kind = textOf(block.type);
    if (kind !== null && kind !== "text" && kind !== "input_text" && kind !== "output_text") continue;
    const text = textOf(block.text);
    if (text !== null) texts.push(text);
  }
  return texts;
}

function systemText(body: Record<string, unknown>): string {
  const system = body.system;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return blockTexts(system).join("\n\n");
  return typeof body.instructions === "string" ? body.instructions : "";
}

function firstUserTexts(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const entry = asObject(message);
      if (entry !== null && entry.role === "user") return blockTexts(entry.content);
    }
  }
  if (typeof body.input === "string") return [body.input];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      const entry = asObject(item);
      if (entry !== null && entry.role === "user") return blockTexts(entry.content);
    }
  }
  return [];
}

// The first user message holds the prompt plus whatever the ADE injected around it.
export function injectedText(texts: readonly string[], prompt: string): string {
  const wanted = prompt.trim();
  const parts: string[] = [];
  for (const raw of texts) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed === wanted) continue;
    if (wanted.length > 0 && trimmed.endsWith(wanted)) {
      const rest = trimmed.slice(0, trimmed.length - wanted.length).trim();
      if (rest.length > 0) parts.push(rest);
      continue;
    }
    parts.push(raw);
  }
  return parts.join("\n\n");
}

function toolName(tool: unknown): string | null {
  return textOf(asObject(tool)?.name);
}

export function anatomyOf(body: unknown, prompt: string): Anatomy {
  const record = asObject(body) ?? {};
  const tools = Array.isArray(record.tools) ? record.tools : [];
  const mcpTools = tools.filter((tool) => toolName(tool)?.startsWith("mcp__") === true);
  const builtinTools = tools.filter((tool) => toolName(tool)?.startsWith("mcp__") !== true);
  const system = systemText(record);
  const injected = injectedText(firstUserTexts(record), prompt);
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!CONVERSATION_KEYS.has(key)) params[key] = value;
  }
  const paramsKeys = Object.keys(params);
  const segment = (name: SegmentName, text: string): AnatomySegment => ({
    name,
    text,
    chars: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
  });
  return {
    segments: [
      segment("system", system),
      segment("tools", builtinTools.length === 0 ? "" : JSON.stringify(builtinTools)),
      segment("mcp-tools", mcpTools.length === 0 ? "" : JSON.stringify(mcpTools)),
      segment("injected", injected),
      segment("params", paramsKeys.length === 0 ? "" : JSON.stringify(params)),
    ],
    system,
    injected,
    tools: builtinTools,
    mcpTools,
    params,
    toolNames: builtinTools.map(toolName).filter((name): name is string => name !== null),
    mcpToolNames: mcpTools.map(toolName).filter((name): name is string => name !== null),
    paramsKeys,
  };
}

export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

export interface SegmentCount {
  tokens: number;
  estimated: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CountOptions {
  dryRun: boolean;
  host: string;
  model: string;
  apiKey: string | undefined;
  log(message: string): void;
}

// One request shape for every segment, so the API count and the chars / 4 estimate measure the same text.
async function countSegment(segment: AnatomySegment, options: CountOptions): Promise<SegmentCount> {
  if (segment.text.length === 0) return { tokens: 0, estimated: false };
  const usable = !options.dryRun && options.host === "api.anthropic.com" && options.apiKey !== undefined;
  if (!usable || options.model.length === 0) return { tokens: estimateTokens(segment.text), estimated: true };
  try {
    const response = await fetch(ANTHROPIC_COUNT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: options.model, messages: [{ role: "user", content: segment.text }] }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = (await response.json()) as { input_tokens?: unknown };
    if (typeof parsed.input_tokens !== "number") throw new Error("no input_tokens in the response");
    return { tokens: parsed.input_tokens, estimated: false };
  } catch (error) {
    options.log(`B2 count_tokens failed: ${messageOf(error)}`);
    return { tokens: estimateTokens(segment.text), estimated: true };
  }
}

function writeNotes(ctx: TestContext, rep: number, lines: string[]): string {
  const file = receipt(ctx, "B2", rep, "notes.md");
  writeFileSync(file.abs, `${lines.join("\n")}\n`);
  return file.rel;
}

export const b2RequestAnatomy: TestRunner = {
  id: "B2",
  track: "B",
  repeats: () => 1,
  maxExtraRuns: 0,
  needsExtraRun: () => false,
  runRep: async (ctx, rep) => {
    const startedNs = Number(ctx.instruments.now());
    const capture = captureFor(ctx);
    // TESTS.md B2: the first main-thread request of a B1 repetition that passed its checks, so the anatomy is the
    // request of the pinned model and effort.
    const b1 = repsFor(ctx, "B1");
    const first = soundReps(b1).find((entry) => entry.firstBodyFile !== null && entry.firstMainRow !== null);
    const bodyFile = first?.firstBodyFile ?? null;
    const row = first?.firstMainRow ?? null;
    const receipts = (log: string | null) => ({
      samples: null,
      video: null,
      frames: null,
      capture: captureReceipt(ctx, capture),
      log,
    });
    if (first === undefined || bodyFile === null || row === null) {
      const faults = b1.map((entry) => repProblem(entry)).filter((problem): problem is string => problem !== null);
      const reason = faults.length > 0 ? `no valid B1 repetition: ${faults[0]}` : "no B1 capture";
      const log = writeNotes(ctx, rep, ["# B2", reason === "no B1 capture" ? "no B1 capture with a main-thread body" : reason]);
      return SEGMENT_NAMES.map((variant) =>
        invalidRow(
          ctx,
          { test_id: "B2", variant, rep, server: "live", unit: "tokens", duration_ms: 0, receipts: receipts(log), notes: "" },
          reason,
        ),
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(readBodyText(capture, bodyFile));
    } catch {
      const log = writeNotes(ctx, rep, ["# B2", `cannot parse ${bodyFile}`]);
      return SEGMENT_NAMES.map((variant) =>
        invalidRow(
          ctx,
          { test_id: "B2", variant, rep, server: "live", unit: "tokens", duration_ms: 0, receipts: receipts(log), notes: "" },
          "B1 body is not JSON",
        ),
      );
    }
    if (asObject(body) === null) {
      const log = writeNotes(ctx, rep, ["# B2", `${bodyFile} is not a JSON object`]);
      return SEGMENT_NAMES.map((variant) =>
        invalidRow(
          ctx,
          { test_id: "B2", variant, rep, server: "live", unit: "tokens", duration_ms: 0, receipts: receipts(log), notes: "" },
          "B1 body is not a JSON object",
        ),
      );
    }

    const prompt = loadTask("B1-hello").prompt;
    const anatomy = anatomyOf(body, prompt);
    const options: CountOptions = {
      dryRun: ctx.instruments.dryRun,
      host: row.host,
      model: row.model ?? ctx.options.model ?? "",
      apiKey: process.env.ANTHROPIC_API_KEY,
      log: (message) => ctx.log(message),
    };
    const counts: SegmentCount[] = [];
    for (const segment of anatomy.segments) counts.push(await countSegment(segment, options));

    const anatomyFile = receipt(ctx, "B2", rep, "anatomy.json");
    writeFileSync(
      anatomyFile.abs,
      `${JSON.stringify(
        {
          model: row.model,
          user_agent: row.user_agent,
          method: counts.some((count) => count.estimated) ? "estimate" : "count_tokens",
          segments: anatomy.segments.map((segment, index) => ({
            name: segment.name,
            chars: segment.chars,
            bytes: segment.bytes,
            tokens: counts[index]!.tokens,
            estimate: counts[index]!.estimated,
          })),
          tool_names: anatomy.toolNames,
          mcp_tool_names: anatomy.mcpToolNames,
          params_keys: anatomy.paramsKeys,
        },
        null,
        2,
      )}\n`,
    );
    const log = writeNotes(ctx, rep, [
      "# B2",
      `body: ${bodyFile} (B1 rep ${first.rep})`,
      `model: ${row.model ?? "unknown"}`,
      `user agent: ${row.user_agent ?? "unknown"}`,
      `method: ${counts.some((count) => count.estimated) ? "estimate" : "count_tokens"}`,
      ...anatomy.segments.map(
        (segment, index) => `${segment.name}: ${segment.chars} chars, ${counts[index]!.tokens} tokens`,
      ),
    ]);

    return anatomy.segments.map((segment, index) => {
      const count = counts[index]!;
      return ctx.row({
        test_id: "B2",
        variant: segment.name,
        rep,
        server: "live",
        value: count.tokens,
        unit: "tokens",
        duration_ms: Math.max(0, Math.round((Number(ctx.instruments.now()) - startedNs) / 1_000_000)),
        valid: true,
        invalid_reason: null,
        receipts: receipts(log),
        notes: count.estimated ? "estimate" : "",
      });
    });
  },
};

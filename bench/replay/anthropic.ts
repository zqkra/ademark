// Anthropic Messages API replay: SSE events in the real API's order and field names.

import { randomBytes } from "node:crypto";
import type { ReplayPacing, SessionBlock, SessionTurn } from "./session";

export const CHUNK_CHARS = 16;
export const CHUNK_MS = 50;

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

export function encodeSse(event: SseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += CHUNK_CHARS) {
    chunks.push(text.slice(offset, offset + CHUNK_CHARS));
  }
  return chunks;
}

export interface AnthropicContext {
  model: string;
  inputTokens: number;
  pacing?: ReplayPacing;
}

export type AnthropicStep =
  | { kind: "event"; sse: SseEvent }
  | { kind: "delta"; makeSse: (chunk: string) => SseEvent; chunks: string[] };

function id(prefix: string): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

export function estimateOutputTokens(blocks: SessionBlock[]): number {
  let chars = 0;
  for (const block of blocks) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking") chars += block.thinking.length;
    else chars += JSON.stringify(block.input).length;
  }
  return Math.ceil(chars / 4);
}

function startUsage(turn: SessionTurn, ctx: AnthropicContext): Record<string, unknown> {
  const usage: Record<string, unknown> = { input_tokens: ctx.inputTokens, output_tokens: 0 };
  if (typeof turn.usage.cache_creation_input_tokens === "number") {
    usage.cache_creation_input_tokens = turn.usage.cache_creation_input_tokens;
  }
  if (typeof turn.usage.cache_read_input_tokens === "number") {
    usage.cache_read_input_tokens = turn.usage.cache_read_input_tokens;
  }
  return usage;
}

export function planAnthropicStream(turn: SessionTurn, ctx: AnthropicContext): AnthropicStep[] {
  const steps: AnthropicStep[] = [];
  steps.push({
    kind: "event",
    sse: {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: id("msg_"),
          type: "message",
          role: "assistant",
          model: ctx.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: startUsage(turn, ctx),
        },
      },
    },
  });

  turn.blocks.forEach((block, index) => {
    if (block.type === "text") {
      steps.push({
        kind: "event",
        sse: {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          },
        },
      });
      const chunks = chunkText(block.text);
      if (chunks.length > 0) {
        steps.push({
          kind: "delta",
          chunks,
          makeSse: (chunk) => ({
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: chunk },
            },
          }),
        });
      }
    } else if (block.type === "tool_use") {
      steps.push({
        kind: "event",
        sse: {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
          },
        },
      });
      const chunks = chunkText(JSON.stringify(block.input));
      if (chunks.length > 0) {
        steps.push({
          kind: "delta",
          chunks,
          makeSse: (chunk) => ({
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: chunk },
            },
          }),
        });
      }
    } else {
      steps.push({
        kind: "event",
        sse: {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "" },
          },
        },
      });
      const chunks = chunkText(block.thinking);
      if (chunks.length > 0) {
        steps.push({
          kind: "delta",
          chunks,
          makeSse: (chunk) => ({
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: chunk },
            },
          }),
        });
      }
    }
    steps.push({
      kind: "event",
      sse: { event: "content_block_stop", data: { type: "content_block_stop", index } },
    });
  });

  const outputTokens = turn.usage.output_tokens ?? estimateOutputTokens(turn.blocks);
  steps.push({
    kind: "event",
    sse: {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: turn.stop_reason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      },
    },
  });
  steps.push({ kind: "event", sse: { event: "message_stop", data: { type: "message_stop" } } });
  return steps;
}

export function expandAnthropicSteps(steps: AnthropicStep[]): SseEvent[] {
  const events: SseEvent[] = [];
  for (const step of steps) {
    if (step.kind === "event") events.push(step.sse);
    else for (const chunk of step.chunks) events.push(step.makeSse(chunk));
  }
  return events;
}

export async function streamAnthropic(
  turn: SessionTurn,
  ctx: AnthropicContext,
  write: (payload: string) => void | Promise<void>,
): Promise<void> {
  await pumpSteps(planAnthropicStream(turn, ctx), ctx.pacing ?? "fixed", write);
}

// Shared by both emitters: one chunk per CHUNK_MS, or every chunk at once when pacing is "none".
export async function pumpSteps(
  steps: AnthropicStep[],
  pacing: ReplayPacing,
  write: (payload: string) => void | Promise<void>,
): Promise<void> {
  let lastDeltaAt = 0;
  for (const step of steps) {
    if (step.kind === "event") {
      await write(encodeSse(step.sse));
      continue;
    }
    for (const chunk of step.chunks) {
      if (pacing === "fixed" && lastDeltaAt !== 0) {
        const now = performance.now();
        const target = lastDeltaAt + CHUNK_MS;
        if (now < target) await Bun.sleep(target - now + 0.5);
      }
      await write(encodeSse(step.makeSse(chunk)));
      if (pacing === "fixed") lastDeltaAt = performance.now();
    }
  }
}

export function anthropicMessage(turn: SessionTurn, ctx: AnthropicContext): Record<string, unknown> {
  const content = turn.blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool_use") {
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    }
    return { type: "thinking", thinking: block.thinking };
  });
  const usage: Record<string, unknown> = {
    input_tokens: ctx.inputTokens,
    output_tokens: turn.usage.output_tokens ?? estimateOutputTokens(turn.blocks),
  };
  if (typeof turn.usage.cache_creation_input_tokens === "number") {
    usage.cache_creation_input_tokens = turn.usage.cache_creation_input_tokens;
  }
  if (typeof turn.usage.cache_read_input_tokens === "number") {
    usage.cache_read_input_tokens = turn.usage.cache_read_input_tokens;
  }
  return {
    id: id("msg_"),
    type: "message",
    role: "assistant",
    model: ctx.model,
    content,
    stop_reason: turn.stop_reason,
    stop_sequence: null,
    usage,
  };
}

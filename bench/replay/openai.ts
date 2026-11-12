// OpenAI Responses API replay. Text blocks become output_text items, tool_use blocks become
// function_call items. Thinking blocks have no Responses equivalent and are dropped.

import { randomBytes } from "node:crypto";
import { pumpSteps, chunkText, encodeSse, estimateOutputTokens, type SseEvent } from "./anthropic";
import type { ReplayPacing, SessionBlock, SessionTurn } from "./session";

export interface OpenAiContext {
  model: string;
  inputTokens: number;
  pacing?: ReplayPacing;
}

export type OpenAiStep =
  | { kind: "event"; sse: SseEvent }
  | { kind: "delta"; makeSse: (chunk: string) => SseEvent; chunks: string[] };

function id(prefix: string): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

function usageOf(turn: SessionTurn, ctx: OpenAiContext): Record<string, unknown> {
  const output = turn.usage.output_tokens ?? estimateOutputTokens(turn.blocks);
  const cached = turn.usage.cache_read_input_tokens ?? 0;
  return {
    input_tokens: ctx.inputTokens,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    total_tokens: ctx.inputTokens + output,
  };
}

function itemFor(
  block: SessionBlock,
  state: { messageId?: string; callId?: string },
): Record<string, unknown> | null {
  if (block.type === "text") {
    state.messageId = id("msg_");
    return {
      id: state.messageId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
  }
  if (block.type === "tool_use") {
    state.callId = id("call_");
    return {
      id: id("fc_"),
      type: "function_call",
      status: "in_progress",
      call_id: state.callId,
      name: block.name,
      arguments: "",
    };
  }
  return null;
}

export function planOpenAiStream(turn: SessionTurn, ctx: OpenAiContext): OpenAiStep[] {
  const steps: OpenAiStep[] = [];
  const responseId = id("resp_");
  const createdAt = Math.floor(Date.now() / 1000);
  const baseResponse = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model: ctx.model,
    output: [] as unknown[],
  };
  steps.push({
    kind: "event",
    sse: { event: "response.created", data: { type: "response.created", response: baseResponse } },
  });

  const completedItems: Record<string, unknown>[] = [];
  turn.blocks.forEach((block, outputIndex) => {
    const state: { messageId?: string; callId?: string } = {};
    const item = itemFor(block, state);
    if (!item) return;

    steps.push({
      kind: "event",
      sse: {
        event: "response.output_item.added",
        data: { type: "response.output_item.added", output_index: outputIndex, item },
      },
    });

    if (block.type === "text") {
      const chunks = chunkText(block.text);
      if (chunks.length > 0) {
        steps.push({
          kind: "delta",
          chunks,
          makeSse: (chunk) => ({
            event: "response.output_text.delta",
            data: {
              type: "response.output_text.delta",
              item_id: state.messageId,
              output_index: outputIndex,
              content_index: 0,
              delta: chunk,
            },
          }),
        });
      }
      steps.push({
        kind: "event",
        sse: {
          event: "response.output_text.done",
          data: {
            type: "response.output_text.done",
            item_id: state.messageId,
            output_index: outputIndex,
            content_index: 0,
            text: block.text,
          },
        },
      });
      completedItems.push({
        id: state.messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: block.text, annotations: [] }],
      });
    } else if (block.type === "tool_use") {
      const args = JSON.stringify(block.input);
      const chunks = chunkText(args);
      if (chunks.length > 0) {
        steps.push({
          kind: "delta",
          chunks,
          makeSse: (chunk) => ({
            event: "response.function_call_arguments.delta",
            data: {
              type: "response.function_call_arguments.delta",
              item_id: item.id,
              output_index: outputIndex,
              delta: chunk,
            },
          }),
        });
      }
      steps.push({
        kind: "event",
        sse: {
          event: "response.function_call_arguments.done",
          data: {
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: outputIndex,
            arguments: args,
          },
        },
      });
      completedItems.push({
        id: item.id,
        type: "function_call",
        status: "completed",
        call_id: state.callId,
        name: block.name,
        arguments: args,
      });
    }

    const completed = completedItems[completedItems.length - 1];
    steps.push({
      kind: "event",
      sse: {
        event: "response.output_item.done",
        data: { type: "response.output_item.done", output_index: outputIndex, item: completed },
      },
    });
  });

  steps.push({
    kind: "event",
    sse: {
      event: "response.completed",
      data: {
        type: "response.completed",
        response: {
          id: responseId,
          object: "response",
          created_at: createdAt,
          status: "completed",
          model: ctx.model,
          output: completedItems,
          usage: usageOf(turn, ctx),
        },
      },
    },
  });
  return steps;
}

export async function streamOpenAi(
  turn: SessionTurn,
  ctx: OpenAiContext,
  write: (payload: string) => void | Promise<void>,
): Promise<void> {
  await pumpSteps(planOpenAiStream(turn, ctx), ctx.pacing ?? "fixed", write);
}

export function openAiResponse(turn: SessionTurn, ctx: OpenAiContext): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  for (const block of turn.blocks) {
    if (block.type === "text") {
      output.push({
        id: id("msg_"),
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: block.text, annotations: [] }],
      });
    } else if (block.type === "tool_use") {
      output.push({
        id: id("fc_"),
        type: "function_call",
        status: "completed",
        call_id: id("call_"),
        name: block.name,
        arguments: JSON.stringify(block.input),
      });
    }
  }
  return {
    id: id("resp_"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: ctx.model,
    output,
    usage: usageOf(turn, ctx),
  };
}

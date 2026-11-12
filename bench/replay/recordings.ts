// The five recording prompts for the pilot. The text is read from the task files at run time;
// this module only cuts out the part each stream needs and drops the handoff placeholder.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../core/paths";

export const RECORDING_STREAMS = [1, 2, 3, 4, 5] as const;

const C1_PROMPT = ["tasks", "C1-orchestrated-build", "prompt.md"] as const;
const B3_PROMPT = ["tasks", "B3-real-prompt", "prompt.md"] as const;

export interface Recording {
  stream: number;
  name: string;
  match: string;
  source: string;
  prompt: string;
}

function readTaskFile(root: string, parts: readonly string[]): string {
  return readFileSync(join(root, ...parts), "utf8");
}

export function firstParagraph(markdown: string): string {
  const paragraphs = markdown.split(/\r?\n[ \t]*\r?\n/);
  return (paragraphs[0] ?? "").trim();
}

export function workItem(markdown: string, item: number): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^W${item}\\.`).test(line));
  if (start < 0) throw new Error(`the C1 prompt has no W${item} item`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^W\d+\./.test(lines[index] as string)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

export function withoutHandoff(text: string, item: number): string {
  return text.replace(new RegExp(`[ \\t]*Handoff code \\{\\{W${item}_CODE\\}\\}\\.`), "");
}

export function recordingPrompt(stream: number, root = repoRoot): string {
  if (stream === 5) return readTaskFile(root, B3_PROMPT).trim();
  if (stream < 1 || stream > 4) throw new Error(`no recording prompt for stream ${stream}`);
  const c1 = readTaskFile(root, C1_PROMPT);
  const item = withoutHandoff(workItem(c1, stream), stream);
  return `${firstParagraph(c1)}\n\n${item}`;
}

export function recordingSource(stream: number): string {
  return stream === 5 ? B3_PROMPT.join("/") : `${C1_PROMPT.join("/")} (W${stream})`;
}

export function recordings(root = repoRoot): Recording[] {
  return RECORDING_STREAMS.map((stream) => ({
    stream,
    name: `stream-${stream}`,
    match: `replay:stream-${stream}`,
    source: recordingSource(stream),
    prompt: recordingPrompt(stream, root),
  }));
}

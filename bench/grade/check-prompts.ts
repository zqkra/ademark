import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ExpectedPrompt {
  path: string;
  content: string;
}

export interface PromptCheck {
  path: string;
  ok: boolean;
  reason: string;
}

function oneTrailingNewline(text: string): string {
  return `${text.replace(/\n+$/u, "")}\n`;
}

function section(markdown: string, headingPrefix: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (start === -1) throw new Error(`heading not found: ${headingPrefix}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{2,3} /.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const pattern = /```text\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) blocks.push(match[1]!);
  return blocks;
}

export function extractPromptFiles(markdown: string): ExpectedPrompt[] {
  const b1 = fencedBlocks(section(markdown, "### B1."));
  const b3 = fencedBlocks(section(markdown, "### B3."));
  const c1 = fencedBlocks(section(markdown, "### C1."));
  const c1Solo = fencedBlocks(section(markdown, "### C1-solo."));
  const c2 = fencedBlocks(section(markdown, "### C2."));
  const faults = fencedBlocks(section(markdown, "### C4, C5, C6."));

  if (b1.length < 1 || b3.length < 1 || c1.length < 1 || c1Solo.length < 1 || c2.length < 4 || faults.length < 1) {
    throw new Error("TASKS.md does not have the expected fenced blocks");
  }

  const c1Text = oneTrailingNewline(c1[0]!);
  const soloParagraph = c1Solo[0]!.replace(/\n+$/u, "");
  const paragraphStart = c1Text.indexOf("Ship the four work items below.");
  const paragraphEnd = c1Text.indexOf("\n\n", paragraphStart);
  if (paragraphStart === -1 || paragraphEnd === -1) {
    throw new Error("C1 prompt paragraph not found");
  }
  const c1SoloText = `${c1Text.slice(0, paragraphStart)}${soloParagraph}${c1Text.slice(paragraphEnd)}`;
  const faultPrompt = oneTrailingNewline(faults[0]!);

  return [
    { path: "tasks/B1-hello/prompt.md", content: oneTrailingNewline(b1[0]!) },
    { path: "tasks/B3-real-prompt/prompt.md", content: oneTrailingNewline(b3[0]!) },
    { path: "tasks/C1-orchestrated-build/prompt.md", content: c1Text },
    { path: "tasks/C1-solo/prompt.md", content: c1SoloText },
    { path: "tasks/C2-message-delivery/prompt.md", content: oneTrailingNewline(c2[0]!) },
    { path: "tasks/C2-message-delivery/followups/F1.md", content: oneTrailingNewline(c2[1]!) },
    { path: "tasks/C2-message-delivery/followups/F2.md", content: oneTrailingNewline(c2[2]!) },
    { path: "tasks/C2-message-delivery/followups/F3.md", content: oneTrailingNewline(c2[3]!) },
    { path: "tasks/C4-agent-killed/prompt.md", content: faultPrompt },
    { path: "tasks/C5-network-cut/prompt.md", content: faultPrompt },
    { path: "tasks/C6-app-restart/prompt.md", content: faultPrompt },
  ];
}

function firstDifference(expected: string, actual: string): string {
  const length = Math.min(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    if (expected[index] !== actual[index]) {
      return `first difference at byte ${index}: expected ${JSON.stringify(expected.slice(index, index + 40))}, got ${JSON.stringify(actual.slice(index, index + 40))}`;
    }
  }
  return `length differs: expected ${expected.length} bytes, got ${actual.length}`;
}

export function checkPrompts(root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")): PromptCheck[] {
  const markdown = readFileSync(join(root, "TASKS.md"), "utf8");
  return extractPromptFiles(markdown).map((expected) => {
    const full = join(root, expected.path);
    if (!existsSync(full)) return { path: expected.path, ok: false, reason: "file missing" };
    const actual = readFileSync(full, "utf8");
    return actual === expected.content
      ? { path: expected.path, ok: true, reason: "" }
      : { path: expected.path, ok: false, reason: firstDifference(expected.content, actual) };
  });
}

function main(): void {
  let failures = 0;
  for (const check of checkPrompts()) {
    if (check.ok) console.log(`ok   ${check.path}`);
    else {
      failures += 1;
      console.log(`FAIL ${check.path}: ${check.reason}`);
    }
  }
  if (failures > 0) process.exitCode = 1;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) main();

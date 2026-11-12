import { describe, expect, test } from "bun:test";
import { loadProfile } from "../adapters/profile.ts";
import { SESSIONS_DIR } from "../replay/build-sessions.ts";
import { loadSessions, type ReplaySession, type TextBlock } from "../replay/session.ts";
import { LONG_MARKERS } from "../tracks/a-timing/a11-long-thread.ts";

// bb 0.49.0 opens a thread from its search palette at the matched message: the palette row carries messageSeq, and the
// thread view scrolls to it (ThreadSearchPaletteMode, searchMessageSeq). The server picks, for each thread, the matching
// segment with the lowest source_seq (start-server.js, listThreadSearchMatchRows). On 10 Nov the query "long-2000" matched
// the first user message, so all 28 A11 rows of bb opened the thread at "Step 1 of 1000" and timed out
// (control-2026-11-10T08-31-19Z-bb-1/bb/A11/rep-01/frames-open.json, from 1,367 ms to the end).
// This model of bb's rule is broad on purpose: a query token matches any word it starts (FTS prefix). If no earlier
// message matches under that rule, none matches under bb's exact rule either.
function words(text: string): string[] {
  return text.normalize("NFD").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function matches(query: string, text: string): boolean {
  const have = words(text);
  return words(query).every((token) => have.some((word) => word.startsWith(token)));
}

function textOf(session: ReplaySession, index: number): string {
  return (session.turns[index]?.blocks ?? [])
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// The messages of the long thread in bb, in order: the prompt the harness sends, then the replayed turns.
function longThreadMessages(): string[] {
  const long = loadSessions(SESSIONS_DIR).find((session) => session.name === "long-2000") as ReplaySession;
  return [long.match, ...long.turns.map((_, index) => textOf(long, index))];
}

function firstMatch(query: string): number {
  return longThreadMessages().findIndex((text) => matches(query, text));
}

function typedQuery(trigger: "longThread" | "shortThread"): string {
  const steps = loadProfile("bb")?.timed[trigger] ?? [];
  const typed = steps.find((step) => step.kind === "type") as { text: string } | undefined;
  return typed?.text ?? "";
}

describe("bb A11 opens the long thread at its end", () => {
  test("the model reproduces the night of 10 Nov: long-2000 lands on the first message", () => {
    expect(firstMatch("long-2000")).toBe(0);
  });

  test("the longThread query matches only the last turn, and that turn holds the end marker", () => {
    const query = typedQuery("longThread");
    const messages = longThreadMessages();
    expect(query).not.toBe("");
    expect(firstMatch(query)).toBe(messages.length - 1);
    expect(matches(query, messages[0] as string)).toBe(false);
    expect(LONG_MARKERS.some((marker) => (messages.at(-1) as string).includes(marker))).toBe(true);
  });

  test("the query does not match the seed thread, so the search cannot offer it first", () => {
    const query = typedQuery("longThread");
    const seed = loadSessions(SESSIONS_DIR).find((session) => session.name === "seed") as ReplaySession;
    expect(matches(query, seed.match)).toBe(false);
    expect(matches(query, textOf(seed, 0))).toBe(false);
  });
});

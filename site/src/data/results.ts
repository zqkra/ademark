// The first results: run control-2026-11-10T08-31-19Z, the last complete run, which ended on 12 November 2026.
// Numbers come only from results.json (scripts/results.ts) and orchestration.json (scripts/orchestration.ts).
// This file adds names, families, chart titles and the reason for every missing number. Nothing here is a measurement.

import raw from "./results.json";
import type { Unit } from "./format";

export const PASS = {
  run: raw.run,
  dates: "measured up to 12 November 2026",
  started: "18 October 2026",
  published: "12 November 2026",
  machine: "Mac mini M4, 16 GB, macOS 27",
  model: "Claude Opus 5.5, effort high",
};

export type Family = "control" | "sdk" | "pty" | "native" | "own" | "first";

export interface App {
  id: string;
  name: string;
  mark: string | null;
  family: Family;
  version: string;
}

export const BARE = "bare-cli";

export const APPS: App[] = [
  { id: "bare-cli", name: "Bare CLI", mark: null, family: "control", version: "Claude Code 2.1.303 in Ghostty 1.4.0" },
  { id: "bb", name: "bb", mark: "/marks/bb.svg", family: "sdk", version: "0.49.0" },
  { id: "capy", name: "Capy", mark: "/marks/capy.svg", family: "own", version: "0.8.0" },
  { id: "claude-desktop", name: "Claude desktop", mark: "/marks/claude.svg", family: "first", version: "4.23118.0" },
  { id: "cloudroom", name: "Cloudroom", mark: "/marks/cloudroom.png", family: "sdk", version: "129.0.0 for tokens, 150.0.0 for C1" },
  { id: "conductor", name: "Conductor", mark: "/marks/conductor.svg", family: "native", version: "0.91.2" },
  { id: "diri", name: "Diri", mark: "/marks/diri.png", family: "native", version: "0.11.2" },
  { id: "emdash", name: "Emdash", mark: "/marks/emdash.svg", family: "pty", version: "1.2.10" },
  { id: "monocode", name: "MonoCode", mark: "/marks/monocode.png", family: "native", version: "0.16.0" },
  { id: "orca", name: "Orca", mark: "/marks/orca.svg", family: "pty", version: "1.4.249" },
  { id: "paseo", name: "Paseo", mark: "/marks/paseo.svg", family: "sdk", version: "0.15.0" },
  { id: "super-engineering", name: "super.engineering", mark: "/marks/super-engineering.png", family: "native", version: "build 15aae8f8" },
  { id: "superset", name: "Superset", mark: "/marks/superset.png", family: "pty", version: "2.0.8, now named Paradev" },
  { id: "synara", name: "Synara", mark: "/marks/synara.svg", family: "sdk", version: "1.1.0" },
  { id: "t3code", name: "T3 Code", mark: "/marks/t3code.svg", family: "sdk", version: "0.1.8 beta" },
  { id: "traycer", name: "Traycer", mark: "/marks/traycer.svg", family: "sdk", version: "1.5.3" },
  { id: "zeron", name: "Zeron", mark: "/marks/zeron.png", family: "native", version: "0.2.136" },
];

export const ADES = APPS.filter((a) => a.id !== BARE);
export const app = (id: string) => APPS.find((a) => a.id === id)!;

export const FAMILIES: { id: string; label: string }[] = [
  { id: "all", label: `All ${ADES.length}` },
  { id: "sdk", label: `Electron, SDK (${ADES.filter((a) => a.family === "sdk").length})` },
  { id: "pty", label: `Electron, terminal (${ADES.filter((a) => a.family === "pty").length})` },
  { id: "native", label: `Native (${ADES.filter((a) => a.family === "native").length})` },
];

export const FAMILY_NAME: Record<Family, string> = {
  control: "Control",
  sdk: "Electron, SDK",
  pty: "Electron, terminal",
  native: "Native",
  own: "Own agent",
  first: "First-party",
};

// Every number the site leaves out, and why. Two labels, never mixed (owner, 12 Nov 2026):
// "did not finish" is a result about the app, "not measured" is about our harness.
// Both stay out of every rank.
export type GapKind = "dnf" | "nm";
export interface Gap {
  kind: GapKind;
  why: string;
}

const TRACK_A = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11"];
const TRACK_B = ["B1", "B2", "B3", "B4"];
const NO_REPLAY = ["A3", "A4", "A7", "A8", "A10", "A11"];

const nm = (why: string): Gap => ({ kind: "nm", why });
const dnf = (why: string): Gap => ({ kind: "dnf", why });
const each = (tests: string[], gap: Gap) => Object.fromEntries(tests.map((t) => [t, gap]));

const REPLAY_GAP =
  nm("it talks only to its maker's cloud, so our local replay server cannot answer it");
const supersetGap = dnf(
  "no turn finished in 4 tries on 2.0.5 and 2.0.8. We have not proven whether the app or our steps cause it",
);

const GAPS: Record<string, Record<string, Gap>> = {
  cloudroom: each(TRACK_A, nm("our harness failed in the middle of every speed and weight block on 150.0.0, and none of them counts yet")),
  superset: { ...each(TRACK_A, supersetGap), ...each(TRACK_B, supersetGap) },
  orca: {
    A1: nm("our probe keystroke reached its shell before its own restore command"),
    A3: nm("its new-thread shortcut opens a shell tab, which our probe cannot time"),
    A9: nm("our count of the processes left after quit is under review"),
    C1: dnf("its own workers never started. Claude Code's subagents did the work and passed 5 of 5"),
  },
  zeron: { A9: nm("our count of the processes left after quit is under review") },
  traycer: { A9: nm("our count of the processes left after quit is under review") },
  conductor: {
    A1: nm("timed out in 3 runs, cause not found yet"),
    A2: nm("1 valid run, fewer than the test needs"),
    ...each(["A3", "A4", "A11"], nm("version 0.91.2 drew no chat messages, so the text this test waits for never showed")),
    A7: nm("the 5 streams never reached our replay server"),
    "B4/obeyed": nm("it keeps no session log we can read"),
  },
  capy: {
    A2: dnf("still running 45 s after quit, in every run"),
    ...each(NO_REPLAY, REPLAY_GAP),
    ...each(TRACK_B, nm("it updated itself to 0.8.0 and our step that picks Opus 5.5 broke, so no prompt was sent")),
    C1: nm("it updated itself to 0.8.0 and our step that picks Opus 5.5 broke, so no prompt was sent"),
  },
  "claude-desktop": each(NO_REPLAY, REPLAY_GAP),
  diri: each(["A5", "A7"], nm("it starts its agents detached, so we cannot yet tell them from other Claude processes")),
  t3code: { "B4/obeyed": nm("it keeps no session log we can read") },
};

const TEST_NAME: Record<string, string> = {
  A1: "cold start",
  A2: "relaunch",
  A3: "new thread",
  A4: "first word",
  A5: "memory at rest",
  A6: "idle CPU",
  A7: "memory under load",
  A8: "typing lag",
  A9: "memory after quit",
  A10: "memory per thread",
  A11: "long thread",
  B1: "hello tokens",
  B2: "request anatomy",
  B3: "real prompt tokens",
  B4: "repo rules",
  "B4/obeyed": "whether it obeyed the repo rules",
  C1: "the orchestrated build",
};

/** Every gap of one app, grouped by cause, with the tests in plain words. */
export function gapsOf(appId: string) {
  const groups = new Map<Gap, string[]>();
  for (const [test, g] of Object.entries(GAPS[appId] ?? {})) groups.set(g, [...(groups.get(g) ?? []), test]);
  return [...groups.entries()].map(([g, list]) => {
    const all = (track: string[]) => track.every((t) => list.includes(t));
    const words = all(TRACK_A) && all(TRACK_B)
      ? ["every speed, weight and token test"]
      : all(TRACK_A)
        ? ["every speed and weight test"]
        : all(TRACK_B)
          ? ["every token test", ...list.filter((t) => !TRACK_B.includes(t)).map((t) => TEST_NAME[t])]
          : list.map((t) => TEST_NAME[t]);
    const text = words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0];
    return { kind: g.kind, tests: text.charAt(0).toUpperCase() + text.slice(1), why: g.why.charAt(0).toUpperCase() + g.why.slice(1) };
  });
}

/** The gap of a whole test ("A1") or of one value ("B4/obeyed"). */
export function gap(appId: string, test: string): Gap | null {
  return GAPS[appId]?.[test] ?? null;
}

export interface Stat {
  m: number;
  lo: number;
  hi: number;
  n: number;
}

const tests = raw.apps as Record<string, { version: string; tests: Record<string, Partial<Stat> & { why?: string }> }>;

/** A published value, or null when the cell is missing or has a gap. */
export function stat(appId: string, key: string): Stat | null {
  if (gap(appId, key.split("/")[0]) || gap(appId, key)) return null;
  const t = tests[appId]?.tests[key];
  return t && typeof t.m === "number" ? (t as Stat) : null;
}

export type Category = "speed" | "weight" | "tokens";

export interface Metric {
  test: string;
  key: string;
  name: string;
  short: string;
  unit: Unit;
  category: Category;
  /** Shown under the name in the grid and in Compare. */
  what: string;
}

export const METRICS: Metric[] = [
  { test: "A1", key: "A1/cold", name: "Cold Start", short: "Cold start", unit: "s", category: "speed", what: "launch to typing" },
  { test: "A2", key: "A2/relaunch", name: "Relaunch", short: "Relaunch", unit: "s", category: "speed", what: "after a normal quit" },
  { test: "A3", key: "A3/default-mode", name: "Thread Open", short: "New thread", unit: "ms", category: "speed", what: "to typing" },
  { test: "A4", key: "A4/total", name: "First Word", short: "First word", unit: "ms", category: "speed", what: "Enter to first word" },
  { test: "A8", key: "A8/p95", name: "Typing Lag", short: "Typing lag", unit: "ms", category: "speed", what: "p95, 5 agents streaming" },
  { test: "A11", key: "A11/open", name: "Long Thread", short: "Long thread", unit: "ms", category: "speed", what: "open 2,000 messages" },
  { test: "A5", key: "A5/total", name: "Weigh-in", short: "At rest", unit: "MB", category: "weight", what: "5 idle threads" },
  { test: "A6", key: "A6/front", name: "Idle Burn", short: "Idle CPU", unit: "%", category: "weight", what: "window in front" },
  { test: "A7", key: "A7/total-p95", name: "Fight Weight", short: "Under load", unit: "MB", category: "weight", what: "p95, 5 agents streaming" },
  { test: "A10", key: "A10/mb-per-thread", name: "Scale", short: "Per thread", unit: "MB", category: "weight", what: "each thread from 5 to 20" },
  { test: "B1", key: "B1/total", name: "Hello Tax", short: "Hello", unit: "tokens", category: "tokens", what: "tokens sent for \"hi\"" },
  { test: "B3", key: "B3/total", name: "Real Prompt Tax", short: "Real prompt", unit: "tokens", category: "tokens", what: "one read-only question" },
];

export const metric = (test: string) => METRICS.find((m) => m.test === test)!;

export interface Row {
  app: App;
  stat: Stat;
  rank: number;
}

/** ADEs with a value for this key, best first. Equal medians share a rank. The Bare CLI is never ranked. */
export function ranked(key: string): Row[] {
  const rows = ADES.map((a) => ({ app: a, stat: stat(a.id, key) }))
    .filter((r): r is { app: App; stat: Stat } => r.stat !== null)
    .sort((x, y) => x.stat.m - y.stat.m || x.app.name.localeCompare(y.app.name));
  return rows.map((r, i) => ({
    ...r,
    rank: rows.findIndex((o) => o.stat.m === r.stat.m) + 1 || i + 1,
  }));
}

/** ADEs left out of a test, with the reason. ADEs never run on C1 are not listed here. */
export function missing(test: string): { app: App; gap: Gap }[] {
  return ADES.flatMap((a) => {
    const g = gap(a.id, test);
    return g ? [{ app: a, gap: g }] : [];
  });
}

export interface Chart {
  test: string;
  title: string;
  /** Muted text after each value: the change against the Bare CLI, or the price. */
  side: "delta" | "usd";
  usdKey?: string;
}

// Results show charts only. What each test means and why an app is missing is told in the Report.
export const CHARTS: Record<Category, Chart[]> = {
  speed: [
    { test: "A1", title: "Cold start", side: "delta" },
    { test: "A2", title: "Relaunch after a normal quit", side: "delta" },
    { test: "A3", title: "New thread, ready to type", side: "delta" },
    { test: "A4", title: "Enter to the first word on screen", side: "delta" },
    { test: "A8", title: "Typing lag while 5 agents stream", side: "delta" },
    { test: "A11", title: "Opening a 2,000-message thread", side: "delta" },
  ],
  weight: [
    { test: "A5", title: "Memory with 5 idle threads", side: "delta" },
    { test: "A6", title: "CPU at rest, window in front", side: "delta" },
    { test: "A7", title: "Memory while 5 agents stream", side: "delta" },
    { test: "A10", title: "Memory each extra thread adds", side: "delta" },
  ],
  tokens: [
    { test: "B1", title: "Tokens sent for \u201chi\u201d", side: "usd", usdKey: "B1/usd" },
    { test: "B3", title: "Tokens for one real question", side: "usd", usdKey: "B3/usd" },
  ],
};

// B2 is drawn as a stack of the parts of the first request.
export const ANATOMY = {
  test: "B2",
  title: "What the first request carries",
  parts: [
    { key: "B2/system", label: "System prompt", tone: "ink" },
    { key: "B2/tools", label: "Tools", tone: "ash" },
    { key: "B2/mcp-tools", label: "MCP tools", tone: "signal" },
    { key: "B2/other", label: "Injected text and settings", tone: "dim" },
  ],
};

export function anatomy(appId: string) {
  const part = (k: string) => stat(appId, k)?.m ?? null;
  const system = part("B2/system");
  const tools = part("B2/tools");
  const mcp = part("B2/mcp-tools");
  const injected = part("B2/injected");
  const params = part("B2/params");
  if ([system, tools, mcp, injected, params].some((v) => v === null)) return null;
  const parts = [system!, tools!, mcp!, injected! + params!];
  return { parts, total: parts.reduce((a, b) => a + b, 0) };
}

// C1, Orchestrated Build. One run each. Values from results.json; the order is shipped, then time to green.
export interface BuildRow {
  app: App;
  shipped: number;
  minutes: number | null;
  tokens: number;
}

const SOLO = tests[BARE].tests["C1/solo-tokens-total"] as Stat;
export const SOLO_TOKENS = SOLO.m;

const c1 = (id: string): BuildRow => ({
  app: app(id),
  shipped: stat(id, "C1/shipped")!.m,
  minutes: stat(id, "C1/time-to-green")?.m ?? null,
  tokens: stat(id, "C1/tokens-total")!.m,
});

export const BUILD = {
  title: "Tokens for the whole build",
  rows: [c1("synara"), c1("super-engineering"), c1("cloudroom"), c1("bb")],
};

// What each app offers for orchestration (ADES.md) and what happened to it in this pass
// (the trigger in its adapter, then the C1 rows).
export const ORCHESTRATION: { id: string; offers: string; pass: string }[] = [
  { id: "bare-cli", offers: "Claude Code's own subagents", pass: "Ran the goal alone as the baseline: 5 of 5 in 7.3 min" },
  { id: "bb", offers: "Manager threads that own child threads", pass: "Ran with /bb-cli: 0 of 5" },
  { id: "capy", offers: "Subagents, and Captains (experimental)", pass: "Not measured: our model step broke on 0.8.0" },
  { id: "claude-desktop", offers: "Subagents and messages between sessions", pass: "No start command decided yet" },
  { id: "cloudroom", offers: "A lead agent that spawns subagents", pass: "Ran with /cloudroom: 0 of 5" },
  { id: "conductor", offers: "None (its MCP is opt-in)", pass: "Not supported" },
  { id: "diri", offers: "The dirijor MCP, when configured", pass: "No start command proven yet" },
  { id: "emdash", offers: "None", pass: "Not supported" },
  { id: "monocode", offers: "/orchestrator, a lead with workers", pass: "Waits for a Confirm & start click we have not calibrated" },
  { id: "orca", offers: "Runs, tasks and workers (experimental)", pass: "Ran with /orchestration, but its own workers never started" },
  { id: "paseo", offers: "Agents that launch agents through Paseo tools", pass: "Needs a setting that ships turned off" },
  { id: "super-engineering", offers: "A lead plus roles through the sc CLI (experimental)", pass: "Ran: 5 of 5 in 7.1 min" },
  { id: "superset", offers: "The superset:orchestrate skill", pass: "No start command proven, and no turn finished on 2.0.8" },
  { id: "synara", offers: "Worker subagents", pass: "Ran: 5 of 5 in 5.2 min" },
  { id: "t3code", offers: "Orchestrator V2 (delegate_task)", pass: "No start command proven yet" },
  { id: "traycer", offers: "Child agents with agent-to-agent messages", pass: "No start command proven yet" },
  { id: "zeron", offers: "Chats that open chats through its MCP, one level deep", pass: "No start command proven yet" },
];

export const RELIABILITY = [
  { test: "C2", name: "Message Delivery", text: "Do messages sent while the agent works reach it and get applied." },
  { test: "C3", name: "Chat Lock", text: "Does the composer refuse typing for more than 2 s while agents work." },
  { test: "C4", name: "Agent Killed", text: "The agent process is killed at 90 s. Does the app show it, and does the task finish." },
  { test: "C5", name: "Network Cut", text: "The model API is blocked for 30 s at 90 s. Does the task carry on." },
  { test: "C6", name: "App Restart", text: "The app is quit and reopened at 90 s. Do its threads come back and finish." },
];

// What each app has, for the coverage table in Method.
export function coverage(a: App) {
  const aKeys = [...METRICS.filter((m) => m.test.startsWith("A")).map((m) => m.key), "A9/no-sessions"];
  const bKeys = ["B1/total", "B2/system", "B3/total", "B4/in-request"];
  const count = (keys: string[]) => keys.filter((k) => stat(a.id, k) !== null).length;
  const firstGap = (list: string[]) => list.map((t) => gap(a.id, t)).find(Boolean) ?? null;
  const built = BUILD.rows.find((r) => r.app.id === a.id);
  const c1 =
    a.id === BARE
      ? "Solo, 5 of 5"
      : built
        ? `${built.shipped} of 5`
        : gap(a.id, "C1")?.kind === "dnf"
          ? "Did not finish"
          : gap(a.id, "C1")
            ? "Not measured"
            : "Not queued";
  return {
    a: count(aKeys),
    aOf: aKeys.length,
    aGap: firstGap(TRACK_A),
    b: count(bKeys),
    bOf: bKeys.length,
    bGap: firstGap(TRACK_B),
    c1,
  };
}

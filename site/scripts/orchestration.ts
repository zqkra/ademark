// Writes src/data/orchestration.json: who worked when in each C1 run, rebuilt from the network capture.
//
// Every request Claude Code sends names the request before it (`cc_prev_req`). Following those links joins the
// requests of one agent into one thread, whether the app runs its workers as separate sessions or as subagents
// inside one session. Threads of one request (titles, side calls) are left out.
//
// Input: data/v1/runs/<folder>/requests.jsonl (time, request id, previous request id, subagent flag, model, usage)
// and c1.json (grade and end of the run). Run: bun scripts/orchestration.ts   (ADEMARK_RESULTS defaults to data/v1/runs)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RESULTS = process.env.ADEMARK_RESULTS ?? new URL("../../data/v1/runs", import.meta.url).pathname;
const RUN = "control-2026-11-10T08-31-19Z";
const OUT = new URL("../src/data/orchestration.json", import.meta.url).pathname;

// The repetition each chart shows ends before the next one starts: a later thread is left out.
const RUNS = [
  { app: "bare-cli", folder: `${RUN}-bare-cli-orchestration-1`, ade: "bare-cli-claude", until: 60 },
  { app: "synara", folder: `${RUN}-synara-orchestration-2`, ade: "synara", until: 60 },
  { app: "super-engineering", folder: `${RUN}-super-engineering-orchestration-1`, ade: "super-engineering", until: 60 },
  { app: "cloudroom", folder: `${RUN}-cloudroom-orchestration-1`, ade: "cloudroom", until: 10 },
  { app: "bb", folder: `${RUN}-bb-orchestration-2`, ade: "bb", until: 45.2 },
];

interface Req {
  id: string;
  t: number;
  prev: string | null;
  sub: boolean;
  model: string;
}

function lanes(file: string, until: number) {
  const reqs: Req[] = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((r) => ({ id: r.request_id, t: r.t_ns / 6e10, prev: r.prev_request_id, sub: r.subagent, model: r.model }));
  const byId = new Map(reqs.map((r) => [r.id, r]));
  const root = (r: Req): string => {
    let cur = r;
    while (cur.prev && byId.has(cur.prev)) cur = byId.get(cur.prev)!;
    return cur.id;
  };
  const threads = new Map<string, Req[]>();
  for (const r of reqs) threads.set(root(r), [...(threads.get(root(r)) ?? []), r]);
  const kept = [...threads.values()]
    .filter((t) => t.length >= 2 && t[0].t < until)
    .sort((a, b) => a[0].t - b[0].t);
  // Minute 0 is the lead's first request, so every run starts at the same place.
  const zero = kept[0][0].t;
  return kept.map((t, i) => {
    const models = [...new Set(t.map((r) => r.model))];
    return {
      role: i === 0 ? "lead" : "worker",
      model: models.find((m) => m.includes("sonnet")) ? "Sonnet 5.5" : "Opus 5.5",
      t: t.map((r) => Math.round((r.t - zero) * 100) / 100),
    };
  });
}

function grade(dir: string) {
  const c1 = JSON.parse(readFileSync(join(dir, "c1.json"), "utf8"));
  return { emptyDiff: Boolean(c1.empty_diff), end: String(c1.end), minutes: Number(c1.duration_ms) / 60000 };
}

const out = RUNS.map((run) => {
  const dir = join(RESULTS, run.folder);
  return { app: run.app, ...grade(dir), lanes: lanes(join(dir, "requests.jsonl"), run.until) };
});

writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${OUT}`);
for (const r of out) console.log(r.app, r.lanes.length, "agents", r.end, r.minutes.toFixed(1), "min", r.emptyDiff ? "main unchanged" : "");

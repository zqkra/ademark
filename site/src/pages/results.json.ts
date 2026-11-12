// /results.json: exactly the numbers this page publishes, with the cause of every gap.
import { APPS, PASS, gap, stat } from "../data/results";

const KEYS: Record<string, string> = {
  "A1/cold": "s",
  "A2/relaunch": "s",
  "A3/default-mode": "ms",
  "A4/total": "ms",
  "A4/before-request": "ms",
  "A4/on-screen": "ms",
  "A5/total": "MB",
  "A5/app": "MB",
  "A6/front": "% CPU",
  "A6/covered": "% CPU",
  "A7/total-p95": "MB",
  "A8/p95": "ms",
  "A8/missed": "keystrokes of 60",
  "A9/no-sessions": "MB",
  "A10/mb-per-thread": "MB",
  "A11/open": "ms",
  "A11/scroll-gaps": "frames over 33 ms",
  "B1/total": "tokens",
  "B1/usd": "USD",
  "B2/system": "tokens",
  "B2/tools": "tokens",
  "B2/mcp-tools": "tokens",
  "B2/injected": "tokens",
  "B2/params": "tokens",
  "B3/total": "tokens",
  "B3/usd": "USD",
  "B4/in-request": "1 = yes",
  "B4/obeyed": "1 = yes",
  "C1/shipped": "hidden test groups of 5",
  "C1/time-to-green": "min",
  "C1/handoff": "codes of 4",
  "C1/tokens-total": "tokens",
  "C1/solo-tokens-total": "tokens",
};

const LABEL = { dnf: "did not finish", nm: "not measured" } as const;

export function GET() {
  const apps = APPS.map((a) => {
    const tests: Record<string, unknown> = {};
    for (const [key, unit] of Object.entries(KEYS)) {
      const g = gap(a.id, key.split("/")[0]) ?? gap(a.id, key);
      // bb and Cloudroom C1: handoff reads 0 while the capture shows 5 agents, so it is not published.
      if (key === "C1/handoff" && (a.id === "bb" || a.id === "cloudroom")) continue;
      const s = stat(a.id, key);
      if (s) tests[key] = { median: s.m, min: s.lo, max: s.hi, runs: s.n, unit };
      else if (g) tests[key] = { result: LABEL[g.kind], cause: g.why };
    }
    return { id: a.id, name: a.name, version: a.version, tests };
  });
  const body = {
    run: PASS.run,
    measured: PASS.dates,
    machine: PASS.machine,
    model: PASS.model,
    rule: "median of the valid runs of one attempt; gaps are never ranked",
    license: "CC BY 4.0",
    apps,
  };
  return new Response(JSON.stringify(body, null, 1), { headers: { "Content-Type": "application/json" } });
}

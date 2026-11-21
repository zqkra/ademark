// Track R runner (TESTS.md §6): two machines, one ADE, every path it offers, the same request on each.
// `bun bench/cli.ts remote run --ade <id> --peer <name>` writes rows.jsonl, receipts and summary.json like Tracks A to C.
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import type { Family, ResultRow, TestId } from "../core/contracts.ts";
import { defaultMachineId, parseHardware } from "../core/manifest.ts";
import { RunWriter } from "../core/results.ts";
import { quantile } from "../core/stats.ts";
import { summarizeRun } from "../core/summarize.ts";
import { Http1Connection } from "./http1.ts";
import type { OpenPath, PathId, RemoteAdapter, RemoteContext, RemotePath } from "./contracts.ts";
import type { Freeze } from "./cut.ts";

export const R_TESTS = ["R2", "R3", "R5", "R4", "R6"] as const;
export type RTest = (typeof R_TESTS)[number];

export interface RemoteRunOptions {
  adapter: RemoteAdapter;
  peer: string;
  /** The peer's OS, ADE version, and how both machines reach the internet, for the manifest. */
  peerDescription?: string;
  runId: string;
  tests: RTest[];
  paths: PathId[] | null;
  /** Rounds: each round runs every path once, in order, so time-of-day drift hits every path alike. */
  rounds: number;
  /** R2 requests per path per round. */
  warmSamples: number;
  /** R3 connections per path per round. */
  coldSamples: number;
  /** R5: the peer port where `peer-server.mjs` listens. */
  previewPort: number;
  /** R4: how the client side of each path is dropped. Missing = R4 is written as not measured. */
  freeze?: Freeze;
  freezeSeconds: number;
  /** R4, for a peer on the client machine (a test instance): its processes, stopped with the client side. */
  freezePeerPids?: number[];
  /** R4: how many drops. Each drop measures every open path at once. */
  freezeRounds: number;
  writer?: RunWriter;
  log?(message: string): void;
}

const GAP_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function machineId(): string {
  const hw = Bun.spawnSync(["sysctl", "-n", "hw.model", "hw.memsize", "machdep.cpu.brand_string"]).stdout.toString().split("\n");
  try {
    return defaultMachineId(parseHardware(hw[0] ?? "", hw[1] ?? "", hw[2] ?? ""));
  } catch {
    return "unknown-machine";
  }
}

export function percentiles(samples: readonly number[]): { p50: number; p95: number } {
  return { p50: quantile(samples, 0.5), p95: quantile(samples, 0.95) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

class RowMaker {
  constructor(
    private readonly writer: RunWriter,
    private readonly ade: string,
    private readonly family: Family,
    private readonly version: string,
    private readonly machine: string,
  ) {}

  write(test: TestId, variant: string, rep: number, value: number | null, unit: string, started: number, extra: Partial<ResultRow> = {}): void {
    const row: ResultRow = {
      run_id: this.writer.runId,
      machine_id: this.machine,
      ade: this.ade,
      ade_version: this.version,
      ade_build_sha256: null,
      family: this.family,
      test_id: test,
      variant,
      rep,
      model: null,
      effort: null,
      server: "none",
      value: value === null ? null : round1(value),
      unit,
      started_at: new Date(started).toISOString(),
      duration_ms: Date.now() - started,
      valid: value !== null,
      invalid_reason: value === null ? "no value" : null,
      drive: "api",
      receipts: { samples: null, video: null, frames: null, capture: null, log: null },
      notes: "",
      ...extra,
    };
    if (!row.valid && row.invalid_reason === null) row.invalid_reason = "no value";
    this.writer.appendRow(row);
  }

  samples(test: TestId, rep: number, path: PathId, rows: Array<Record<string, string | number | null>>): string {
    const dir = this.writer.receiptDir(this.ade, test, rep);
    const file = join(dir, `${path}.csv`);
    const columns = Object.keys(rows[0] ?? { i: 0 });
    writeFileSync(file, [columns.join(","), ...rows.map((r) => columns.map((c) => r[c] ?? "").join(","))].join("\n") + "\n");
    return file.slice(this.writer.runDir.length + 1);
  }
}

async function timeProbe(conn: Http1Connection, request: Awaited<ReturnType<RemoteAdapter["probe"]>>, status: number): Promise<number> {
  const started = performance.now();
  const response = await conn.send(request);
  const ms = performance.now() - started;
  if (response.status !== status) throw new Error(`probe answered ${response.status}, expected ${status}: ${response.body.slice(0, 160)}`);
  return ms;
}

/** What one test gives for one path in one round: its outputs in ms, and every sample for the receipt. */
interface Measured {
  values: Record<string, number | null>;
  samples: Array<Record<string, number>>;
}

const PER_PATH = ["R2", "R3", "R5"] as const;

/** R2: warm round trips on one kept-alive connection, after 10 untimed ones. */
async function r2(open: OpenPath, opts: RemoteRunOptions, ctx: RemoteContext): Promise<Measured> {
  const request = await opts.adapter.probe(ctx);
  const conn = await Http1Connection.open(open.endpoint);
  const samples: number[] = [];
  const floor: number[] = [];
  try {
    for (let i = 0; i < 10; i++) await timeProbe(conn, request, opts.adapter.probeStatus);
    for (let i = 0; i < opts.warmSamples; i++) {
      samples.push(await timeProbe(conn, request, opts.adapter.probeStatus));
      if (i % 10 === 0 && open.floorMs) {
        const f = await open.floorMs();
        if (f !== null) floor.push(f);
      }
      await sleep(GAP_MS);
    }
  } finally {
    conn.close();
  }
  return {
    values: { ...percentiles(samples), floor: floor.length ? quantile(floor, 0.5) : null },
    samples: samples.map((ms, i) => ({ i, ms: round1(ms) })),
  };
}

/** R3: a new connection for each probe: TCP (or the helper's stream), TLS, then the first answer. */
async function r3(open: OpenPath, opts: RemoteRunOptions, ctx: RemoteContext): Promise<Measured> {
  const request = await opts.adapter.probe(ctx);
  const samples: Array<{ ms: number; connectedMs: number }> = [];
  for (let i = 0; i < opts.coldSamples; i++) {
    const started = performance.now();
    const conn = await Http1Connection.open(open.endpoint);
    // Connected: TCP (or the helper's stream) and TLS done. The rest is the first request.
    const connectedMs = performance.now() - started;
    try {
      const response = await conn.send(request);
      if (response.status !== opts.adapter.probeStatus) throw new Error(`probe answered ${response.status}`);
      samples.push({ ms: performance.now() - started, connectedMs });
    } finally {
      conn.close();
    }
    await sleep(GAP_MS * 3);
  }
  return {
    values: percentiles(samples.map((s) => s.ms)),
    samples: samples.map((s, i) => ({ i, ms: round1(s.ms), connected_ms: round1(s.connectedMs) })),
  };
}

const PREVIEW_REQUEST = (port: number) => Buffer.from(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: keep-alive\r\n\r\n`);
const PREVIEW_BODY = "ademark-r5\n";
const previewDone = (bytes: Buffer) => bytes.toString("latin1").endsWith(PREVIEW_BODY);

/** R5: open a forward to the peer's dev server, time the first page, then warm pages on the same stream. */
async function r5(open: OpenPath, opts: RemoteRunOptions, ctx: RemoteContext): Promise<Measured> {
  const forward = opts.adapter.forwardPort!;
  const started = performance.now();
  const tunnel = await forward(ctx, open, opts.previewPort);
  try {
    tunnel.send(PREVIEW_REQUEST(opts.previewPort));
    const first = await tunnel.receive(previewDone);
    if (!first.toString("latin1").startsWith("HTTP/1.1 200")) throw new Error(`peer server answered ${first.toString("latin1").split("\r\n")[0]}`);
    const firstMs = performance.now() - started;
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      tunnel.send(PREVIEW_REQUEST(opts.previewPort));
      await tunnel.receive(previewDone);
      samples.push(performance.now() - t);
      await sleep(GAP_MS);
    }
    return { values: { first: firstMs, ...percentiles(samples) }, samples: samples.map((ms, i) => ({ i, ms: round1(ms) })) };
  } finally {
    tunnel.close();
  }
}

const MEASURE: Record<(typeof PER_PATH)[number], (open: OpenPath, opts: RemoteRunOptions, ctx: RemoteContext) => Promise<Measured>> = { R2: r2, R3: r3, R5: r5 };

/** Resolves with the result of `work`, or false after `ms`. */
function within(work: Promise<boolean>, ms: number): Promise<boolean> {
  return Promise.race([work.catch(() => false), sleep(ms).then(() => false)]);
}

/** One probe on a new connection, given up after 2 s. */
async function answers(open: OpenPath, request: Awaited<ReturnType<RemoteAdapter["probe"]>>, status: number): Promise<boolean> {
  return await within(Http1Connection.open(open.endpoint).then(async (conn) => {
    try {
      return (await conn.send(request)).status === status;
    } finally {
      conn.close();
    }
  }), 2000);
}

const R4_LIMIT_MS = 120_000;

/**
 * R4: one process-level drop serves every open path. Each path keeps one connection open through the drop; after it,
 * the kept connection is tried once, then new connections every 250 ms until one answers.
 */
async function runR4(opts: RemoteRunOptions, ctx: RemoteContext, rows: RowMaker, opened: Map<PathId, OpenPath>): Promise<void> {
  if (!opts.freeze) {
    for (const id of opened.keys()) rows.write("R4", id, 1, null, "s", Date.now(), { valid: false, invalid_reason: "not measured: no --freeze given" });
    return;
  }
  const request = await opts.adapter.probe(ctx);
  const status = opts.adapter.probeStatus;
  for (let rep = 1; rep <= opts.freezeRounds; rep++) {
    const started = Date.now();
    const live = [...opened.entries()];
    const kept = await Promise.all(live.map(async ([, open]) => {
      try {
        const conn = await Http1Connection.open(open.endpoint);
        return (await conn.send(request)).status === status ? conn : (conn.close(), null);
      } catch {
        return null;
      }
    }));
    const pids = [...live.flatMap(([, open]) => open.clientPids?.() ?? []), ...(opts.freezePeerPids ?? [])];
    await opts.freeze.apply(pids, opts.freezeSeconds);
    const resumed = performance.now();
    await Promise.all(live.map(async ([id, open], index) => {
      const conn = kept[index];
      if (!conn) {
        rows.write("R4", id, rep, null, "s", started, { valid: false, invalid_reason: "the path did not answer before the drop" });
        return;
      }
      const keptAnswered = await within(conn.send(request).then((r) => r.status === status), 2000);
      conn.close();
      let attempts = 1;
      let seconds: number | null = keptAnswered ? (performance.now() - resumed) / 1000 : null;
      while (seconds === null && performance.now() - resumed < R4_LIMIT_MS) {
        attempts++;
        if (await answers(open, request, status)) seconds = (performance.now() - resumed) / 1000;
        else await sleep(250);
      }
      const peer = opts.freezePeerPids?.length ? ", and the peer's processes" : "";
      const notes = `process-level drop for ${opts.freezeSeconds} s (the client side${peer}); ${attempts} attempts; path observed: ${open.observed() ?? "unknown"}`;
      if (seconds === null) rows.write("R4", id, rep, null, "s", started, { valid: false, invalid_reason: "did not answer within 120 s", notes });
      else rows.write("R4", id, rep, seconds, "s", started, { notes });
      rows.write("R4", `${id}:kept`, rep, keptAnswered ? 1 : 0, "0/1", started, { notes: "1 = the connection open through the drop still answered" });
      rows.write("R4", `${id}:recovered`, rep, seconds === null ? 0 : 1, "0/1", started, { notes: "1 = answered within 120 s with no user action" });
      ctx.log(`R4 ${id} drop ${rep}: ${seconds === null ? "no answer within 120 s" : `answered ${round1(seconds)} s after resume${keptAnswered ? " on the kept connection" : " on a new connection"}`}`);
    }));
    await sleep(15_000);
  }
}

export async function runRemote(opts: RemoteRunOptions): Promise<string> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const ctx: RemoteContext = { peer: opts.peer, log };
  const writer = (opts.writer ?? new RunWriter()).open(opts.runId);
  const rows = new RowMaker(writer, opts.adapter.id, opts.adapter.family, await opts.adapter.version(), machineId());
  // Load on the client changes TLS and timer jitter; the manifest records it at the start and the end.
  const loadAtStart = loadavg().map(round1);
  const all = await opts.adapter.paths(ctx);
  const chosen: RemotePath[] = opts.paths ? all.filter((p) => opts.paths!.includes(p.id)) : all;

  // A path that cannot open is written as not measured, with the reason, for every test it would run.
  const notMeasured = (path: RemotePath, reason: string, tests: RTest[]) => {
    for (const test of tests.filter((t) => t !== "R6")) {
      rows.write(test, path.id, 1, null, test === "R4" ? "s" : "ms", Date.now(), { valid: false, invalid_reason: `not measured: ${reason}` });
    }
  };

  const opened = new Map<PathId, OpenPath>();
  for (const path of chosen) {
    try {
      opened.set(path.id, await path.open());
      log(`${opts.adapter.id} ${path.id}: open (${path.label})`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`${opts.adapter.id} ${path.id}: not measured: ${reason}`);
      notMeasured(path, reason, opts.tests);
    }
  }

  try {
    for (let round = 1; round <= opts.rounds; round++) {
      for (const path of chosen) {
        const open = opened.get(path.id);
        if (!open) continue;
        for (const test of PER_PATH.filter((t) => opts.tests.includes(t))) {
          const started = Date.now();
          if (test === "R5" && !opts.adapter.forwardPort) {
            if (round === 1) rows.write("R5", `${path.id}:first`, 1, null, "ms", started, { valid: false, invalid_reason: "not supported" });
            continue;
          }
          try {
            const measured = await MEASURE[test](open, opts, ctx);
            const receipts = { samples: rows.samples(test, round, path.id, measured.samples), video: null, frames: null, capture: null, log: null };
            const notes = `path observed: ${open.observed() ?? "unknown"}`;
            for (const [name, value] of Object.entries(measured.values)) {
              const missing = value === null ? { valid: false, invalid_reason: `not measured: no ${name} for this path` } : {};
              rows.write(test, `${path.id}:${name}`, round, value, "ms", started, { receipts, notes, ...missing });
            }
            log(`${test} ${path.id} round ${round}: ${Object.entries(measured.values).map(([n, v]) => `${n} ${v === null ? "none" : `${round1(v)} ms`}`).join(", ")} (${notes})`);
          } catch (error) {
            rows.write(test, `${path.id}:p50`, round, null, "ms", started, { valid: false, invalid_reason: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    }
    if (opts.tests.includes("R4")) await runR4(opts, ctx, rows, opened);
    if (opts.tests.includes("R6")) {
      writeFileSync(join(writer.runDir, "remote-fit.json"), `${JSON.stringify({ [opts.adapter.id]: opts.adapter.facts }, null, 2)}\n`);
    }
  } finally {
    for (const open of opened.values()) await open.close();
  }
  writeFileSync(join(writer.runDir, "manifest.json"), `${JSON.stringify({
    run_id: opts.runId,
    machine_id: machineId(),
    verified: false,
    track: "R",
    ade: opts.adapter.id,
    peer: opts.peer,
    peer_description: opts.peerDescription ?? null,
    probe: await opts.adapter.probe(ctx).then((r) => `${r.method} ${r.path}`, () => null),
    paths: chosen.map((p) => ({ id: p.id, label: p.label, opened: opened.has(p.id) })),
    tests: opts.tests,
    rounds: opts.rounds,
    warm_samples: opts.warmSamples,
    cold_samples: opts.coldSamples,
    client_load_avg: { start: loadAtStart, end: loadavg().map(round1) },
    drop: opts.freeze ? { kind: opts.freeze.kind, seconds: opts.freezeSeconds, rounds: opts.freezeRounds, peer_stopped: (opts.freezePeerPids?.length ?? 0) > 0 } : null,
    started_at: opts.runId,
  }, null, 2)}\n`);
  return summarizeRun(writer.runDir).path;
}

// The macOS implementation of Instruments. Measuring is only allowed in the dedicated `ademark` user.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { reconcile, startTelemetryCapture } from "../capture/telemetry.ts";
import { nowNs } from "../core/clock.ts";
import type { CaptureRow, Fault, ReplayRequestLog, Trigger } from "../core/contracts.ts";
import { checkGates } from "../core/gates.ts";
import * as native from "../core/native.ts";
import { benchRoot } from "../core/paths.ts";
import { MACHINE_BIN } from "../ops/machine-state.ts";
import { startReplay } from "../core/replay.ts";
import { cutNetwork } from "../fault/cut-network.ts";
import { killAgent } from "../fault/kill-agent.ts";
import { restartApp } from "../fault/restart-app.ts";
import { gradeTask } from "../grade/grade.ts";
import { prepareArena } from "./arena.ts";
import type {
  CaptureControl,
  ContaminationResult,
  FaultOutcome,
  GradeResult,
  Instruments,
  ReplayControl,
  SampleHandle,
} from "./instruments.ts";

// Only the model APIs are opened. Everything else passes untouched: opening an app's login traffic made T3 Code fail its TLS
// handshake with Clerk and quit, on 2026-11-07.
export const PROXY_HOSTS = ["^api\\.anthropic\\.com", "^api\\.openai\\.com", "^chatgpt\\.com"];

export const APPLY_USER = "ademark";
export const REPLAY_PORT = 8787;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function runCommand(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<string> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed (exit ${exitCode}): ${stderr.trim().slice(0, 500)}`);
  }
  return stdout;
}

// The proxy appends a row when an answer ends. Since 2026-11-11 a C1 run reads the file while its agents still work, so
// the last line can be half written (a long stream has thousands of chunk times, and a row of that size is written in
// several pieces). A last line with no newline yet is left for the next read. Any other bad line is still an error.
export function parseCaptureRows(text: string): CaptureRow[] {
  const lines = text.split("\n");
  const rows: CaptureRow[] = [];
  lines.forEach((line, index) => {
    const entry = line.trim();
    if (entry.length === 0) return;
    try {
      rows.push(JSON.parse(entry) as CaptureRow);
    } catch (error) {
      if (index !== lines.length - 1) throw error;
    }
  });
  return rows;
}

function captureRows(outPath: string): CaptureRow[] {
  if (!existsSync(outPath)) return [];
  return parseCaptureRows(readFileSync(outPath, "utf8"));
}

// `footprint -j` already de-duplicates shared memory, so its top-level "total footprint" is the number to report.
// Summing every field named footprint counted shared pages once per process (pilot A5: about 4 times too high).
export function sumFootprint(json: unknown): number {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("footprint: no total footprint in the JSON output");
  }
  const value = (json as Record<string, unknown>)["total footprint"];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("footprint: no total footprint in the JSON output");
  }
  return Math.round(value);
}

// Untimed setup keys (A4 types its prompt before the timed Enter): when another app took the front, bring the ADE back
// once and retry, as the adapters do (bench/adapters/macos.ts postKeys). Timed triggers never take this path.
async function keysToFront(o: Parameters<typeof native.keys>[0]): ReturnType<typeof native.keys> {
  try {
    return await native.keys(o);
  } catch (error) {
    if (!(error instanceof Error && error.message.includes("not_frontmost"))) throw error;
    Bun.spawnSync([
      "osascript",
      "-e",
      `tell application "System Events" to set frontmost of (first process whose unix id is ${o.pid}) to true`,
    ]);
    await Bun.sleep(400);
    return native.keys(o);
  }
}

// Timed runs refuse to post keys while another app is in front (trigger_skipped, not_frontmost), so nothing was timed.
// Pilot 2026-10-20 run 10: someone typing in Terminal for a minute turned all 13 A3 rows invalid. Bring the ADE back
// and run again, a few seconds apart. Never for an open trigger: a second launch would time a warm app.
const FRONT_RETRIES = 10;
const FRONT_RETRY_WAIT_MS = 3_000;

async function timedAtFront<T>(pid: number, triggers: readonly Trigger[], work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const lost = error instanceof Error && /trigger_skipped|not_frontmost/.test(error.message);
      if (!lost || attempt > FRONT_RETRIES || pid <= 0 || triggers.some((t) => t.kind === "open")) throw error;
      console.log(`front lost during a timed run (pid ${pid}); retry ${attempt}/${FRONT_RETRIES}`);
      Bun.spawnSync([
        "osascript",
        "-e",
        `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
      ]);
      await Bun.sleep(FRONT_RETRY_WAIT_MS);
    }
  }
}

export function realInstruments(): Instruments {
  const username = userInfo().username;
  if (username !== APPLY_USER) {
    throw new Error(
      `realInstruments() refuses to measure as "${username}": measuring runs only in the dedicated ` +
        `"${APPLY_USER}" macOS user (METHODOLOGY.md §5). Use --dry-run to exercise the loop without measuring.`,
    );
  }

  let replayLogPath: string | null = null;

  // Both run at once. The proxy sees every call, also those that skip the Claude CLI. Telemetry adds any CLI call the
  // proxy missed, and `<out>.source` says how many rows each one saw.
  const startCapture = async ({ out }: { out: string }): Promise<CaptureControl> => {
    const telemetry = startTelemetryCapture(`${out}.telemetry.jsonl`, () => Number(nowNs()));
    let proxy: CaptureControl;
    try {
      proxy = await startProxyCapture(out);
    } catch (error) {
      await telemetry.stop().catch(() => {});
      throw error;
    }
    return {
      outPath: proxy.outPath,
      env: telemetry.env,
      rows: () => reconcile(proxy.rows(), telemetry.rows()),
      requestsSince: (sinceNs) => proxy.requestsSince?.(sinceNs) ?? 0,
      startsSince: (sinceNs, taskHash) => proxy.startsSince?.(sinceNs, taskHash) ?? 0,
      stop: async () => {
        // Each one stops even if the other fails: a live mitmdump would sit under the next block.
        const results = await Promise.allSettled([telemetry.stop(), proxy.stop()]);
        writeFileSync(`${out}.source`, `proxy ${proxy.rows().length}, telemetry ${telemetry.rows().length}\n`);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      },
    };
  };

  // One line per model call, written by the addon as it leaves: its time and the hash of its task.
  const requestMarks = (out: string, sinceNs: number): string[] => {
    const path = `${resolve(out)}.requests`;
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").flatMap((line) => {
      const [time, hash] = line.split(" ");
      return line.length > 0 && Number(time) >= sinceNs ? [hash ?? "-"] : [];
    });
  };

  const startProxyCapture = async (out: string): Promise<CaptureControl> => {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    const proc = Bun.spawn(["mitmdump", "--mode", "local", ...PROXY_HOSTS.flatMap((host) => ["--allow-hosts", host]), "-s", join(benchRoot, "capture", "addon.py")], {
      env: { ...process.env, ADEMARK_CAPTURE_OUT: resolve(out) },
      // Nothing reads these, and a full pipe would stall mitmdump and every request behind it.
      stdout: "ignore",
      stderr: Bun.file(`${resolve(out)}.mitmdump.log`),
    });
    let stopped = false;
    return {
      outPath: resolve(out),
      rows: () => captureRows(out),
      requestsSince: (sinceNs) => requestMarks(out, sinceNs).length,
      startsSince: (sinceNs, taskHash) => requestMarks(out, sinceNs).filter((hash) => hash === taskHash).length,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        proc.kill("SIGTERM");
        const exited = await Promise.race([proc.exited.then(() => true), sleep(5000).then(() => false)]);
        if (!exited) {
          proc.kill("SIGKILL");
          await proc.exited;
        }
      },
    };
  };

  const startReplayControl = async (o: { sessions: string; log: string; port: number }): Promise<ReplayControl> => {
    const handle = await startReplay({ port: o.port, sessions: o.sessions, log: o.log });
    replayLogPath = o.log;
    const base = `http://127.0.0.1:${handle.port}`;
    return {
      port: handle.port,
      logPath: o.log,
      stats: () => handle.stats(),
      reset: async () => {
        const response = await fetch(`${base}/_ademark/reset`, { method: "POST" });
        if (!response.ok) throw new Error(`replay reset failed: HTTP ${response.status}`);
      },
      stop: () => handle.stop(),
    };
  };

  const fault = async (
    f: Fault,
    o: { worktree: string; appName: string; agentExecutables: string[] },
  ): Promise<FaultOutcome> => {
    const started = nowNs();
    let applied = false;
    let detail = "";
    if (f.kind === "kill-agent") {
      const result = killAgent({ worktree: o.worktree, apply: true, agentExecutables: o.agentExecutables });
      applied = result.applied;
      detail = `pids=${result.pids.join(",") || "none"}`;
    } else if (f.kind === "cut-network") {
      const result = await cutNetwork({ apply: true, durationS: f.duration_s ?? 30 });
      applied = result.applied;
      detail = `anchor=${result.anchor}`;
    } else if (f.kind === "restart-app") {
      const result = await restartApp({ appName: o.appName, apply: true });
      applied = result.applied;
      detail = `restarted=${result.restarted} quit_ms=${result.quit_ms ?? "timeout"}`;
    } else {
      throw new Error(`unknown fault kind ${f.kind}`);
    }
    return { kind: f.kind, applied, started_ns: started, ended_ns: nowNs(), detail };
  };

  const grade = async (o: {
    taskId: string;
    worktree: string;
    out: string;
    handoffSeed: string | null;
  }): Promise<GradeResult> => {
    const previous = process.env.ADEMARK_HANDOFF_SEED;
    if (o.handoffSeed !== null) process.env.ADEMARK_HANDOFF_SEED = o.handoffSeed;
    else delete process.env.ADEMARK_HANDOFF_SEED;
    try {
      return gradeTask({ taskId: o.taskId, worktree: o.worktree, out: o.out });
    } finally {
      if (previous === undefined) delete process.env.ADEMARK_HANDOFF_SEED;
      else process.env.ADEMARK_HANDOFF_SEED = previous;
    }
  };

  const footprint = async (o: { pids: number[]; out: string }): Promise<{ total_b: number }> => {
    mkdirSync(dirname(resolve(o.out)), { recursive: true });
    const stdout = await runCommand(["sudo", "-n", MACHINE_BIN, "footprint", ...o.pids.map(String)]);
    writeFileSync(resolve(o.out), stdout);
    const parsed: unknown = JSON.parse(stdout);
    return { total_b: sumFootprint(parsed) };
  };

  // WindowServer runs as another user, so procs() does not list it; pgrep does match it.
  const pidOf = async (name: string): Promise<number | null> => {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`pidOf: unsafe process name "${name}"`);
    const output = await runCommand(["pgrep", "-x", name]).catch(() => "");
    const first = output.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
    if (first === undefined) return null;
    const pid = Number(first);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  };

  const contamination = async (o: { replayPort: number; workdir: string }): Promise<ContaminationResult> => {
    if (replayLogPath === null) throw new Error("contamination: startReplay() has not been called");
    const base = `http://127.0.0.1:${o.replayPort}`;
    await runCommand(
      ["claude", "--setting-sources", "project", "--no-session-persistence", "-p", "replay:hi", "--max-turns", "1"],
      // 2026-10-24: the account's claude.ai connectors (8 Claude Docs tools) loaded in some sessions and not others, so
      // the control's request flipped between two bodies. Every agent session has them off (snapshots/clean settings).
      { cwd: o.workdir, env: { ...process.env, ANTHROPIC_BASE_URL: base, ENABLE_CLAUDEAI_MCP_SERVERS: "false" } },
    );
    const lines = readFileSync(replayLogPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const last = lines[lines.length - 1];
    if (last === undefined) throw new Error(`contamination: replay log ${replayLogPath} is empty`);
    const entry = JSON.parse(last) as ReplayRequestLog;
    return { bytes: entry.bytes, body_sha256: entry.body_sha256 };
  };

  return {
    dryRun: false,
    now: () => nowNs(),
    sleep,
    procs: () => native.procs(),
    pidOf,
    idle: (o) => native.idle(o),
    sample: (o) => native.sample(o),
    sampleStart: async (o): Promise<SampleHandle> => native.sampleStart(o),
    window: (o) => native.window(o),
    keys: (o) => keysToFront(o),
    echo: (o) => timedAtFront(o.pid, o.triggers, () => native.echo(o)),
    watch: (o) => timedAtFront(o.pid, o.triggers, () => native.watch(o)),
    lag: (o) => native.lag(o),
    scroll: (o) => native.scroll(o),
    cover: (o) => native.cover(o),
    screenshot: (o) => native.screenshot(o),
    ocr: (o) => native.ocr(o),
    prepareArena: (o) => prepareArena(o),
    startReplay: startReplayControl,
    startCapture,
    fault,
    grade,
    footprint,
    purge: async () => {
      await runCommand(["sudo", "-n", MACHINE_BIN, "purge"]);
    },
    gates: async (o) => checkGates(o),
    contamination,
  };
}

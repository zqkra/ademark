// ADEMARK-35 and 36: one Control only, and the files a watchdog reads.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlFiles, readHeartbeat, readLock, releaseLock, takeLock, writeHeartbeat } from "../control/files.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-files-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("control lock", () => {
  test("the first start takes it, a second start sees the first", () => {
    const path = join(dir, "control.lock");
    expect(takeLock(path, { pid: 10, port: 7788, started_at: "t1" }, () => true)).toEqual({ ok: true });
    const second = takeLock(path, { pid: 11, port: 7790, started_at: "t2" }, () => true);
    expect(second).toEqual({ ok: false, holder: { pid: 10, port: 7788, started_at: "t1" } });
  });

  test("a lock whose pid is gone is replaced", () => {
    const path = join(dir, "control.lock");
    writeFileSync(path, JSON.stringify({ pid: 10, port: 7788, started_at: "t1" }));
    expect(takeLock(path, { pid: 11, port: 7788, started_at: "t2" }, () => false)).toEqual({ ok: true });
    expect(readLock(path)?.pid).toBe(11);
  });

  test("a broken lock file is replaced", () => {
    const path = join(dir, "control.lock");
    writeFileSync(path, "{half");
    expect(takeLock(path, { pid: 11, port: 7788, started_at: "t2" }, () => true)).toEqual({ ok: true });
  });

  test("only the holder releases it", () => {
    const path = join(dir, "control.lock");
    takeLock(path, { pid: 10, port: 7788, started_at: "t1" });
    releaseLock(path, 11);
    expect(existsSync(path)).toBe(true);
    releaseLock(path, 10);
    expect(existsSync(path)).toBe(false);
  });

  test("a dry run has its own lock, log and heartbeat", () => {
    const real = controlFiles(false, dir);
    const dry = controlFiles(true, dir);
    for (const key of Object.keys(real) as (keyof typeof real)[]) expect(dry[key]).not.toBe(real[key]);
    expect(real.lock).toBe(join(dir, "control.lock"));
    expect(real.heartbeat).toBe(join(dir, "control-heartbeat.json"));
  });
});

describe("heartbeat", () => {
  test("is written whole, with no temporary file left", () => {
    const path = join(dir, "control-heartbeat.json");
    const beat = {
      pid: 1, port: 2, run_id: "r", state: "working", intent: "running" as const, ade: "orca", step: "measure",
      step_started_at: "t", step_limit_ms: 5, child_group: 7, written_at: "w",
    };
    writeHeartbeat(path, beat);
    expect(readHeartbeat(path)).toEqual(beat);
    expect(readdirSync(dir)).toEqual(["control-heartbeat.json"]);
  });
});

describe("launcher", () => {
  test("opens nothing new when Control already answers", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ state: "idle" }) });
    try {
      const launcher = join(import.meta.dir, "..", "control", "launcher", "run");
      const proc = Bun.spawn(["/bin/zsh", launcher, "--port", String(server.port), "--no-open", "--dry-run"], { stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
});

describe("sync calls on Control's thread", () => {
  test("a call past its limit is ended, logged, and fails only itself", async () => {
    const { run, setChildLog } = await import("../night/repair-real.ts");
    const lines: string[] = [];
    setChildLog((line) => lines.push(line));
    try {
      const started = Date.now();
      const result = run(["sleep", "5"], dir, 200);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(result.code).toBe(124);
      expect(lines[0]).toContain("sleep 5: no answer in 0 s, ended");
    } finally {
      setChildLog((line) => console.error(line));
    }
  });
});

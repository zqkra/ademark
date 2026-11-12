// The files that let a person and the watchdog see Control from outside: one lock, one log, one heartbeat. On
// 2026-11-09 Control stopped at 02:20 and wrote only to its Ghostty tab, so the cause left no trace. A dry run has its
// own set, so it never touches the files of a real night.
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { resultsRoot } from "../core/paths.ts";

export interface ControlFiles {
  lock: string;
  log: string;
  heartbeat: string;
  watchdogLog: string;
  watchdogState: string;
  database: string;
  /** Where a measuring child reports its stage and test for the "Now:" line (bench/run/loop.ts reportProgress). */
  progress: string;
}

export function controlFiles(dry: boolean, root: string = resultsRoot()): ControlFiles {
  const name = dry ? "control-dry" : "control";
  return {
    lock: join(root, `${name}.lock`),
    log: join(root, `${name}.log`),
    heartbeat: join(root, `${name}-heartbeat.json`),
    watchdogLog: join(root, dry ? "watchdog-dry.log" : "watchdog.log"),
    watchdogState: join(root, dry ? "watchdog-dry-state.json" : "watchdog-state.json"),
    database: join(root, `${name}.sqlite`),
    progress: join(root, `${name}-progress.json`),
  };
}

export interface LockInfo {
  pid: number;
  port: number;
  started_at: string;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it lives, in another account.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(path: string): LockInfo | null {
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    return typeof lock.pid === "number" && typeof lock.port === "number" ? lock : null;
  } catch {
    return null;
  }
}

/**
 * Takes the lock, or returns the Control that holds it. A lock whose pid is gone is stale and replaced. `wx` makes the
 * take atomic, so two starts in the same second cannot both win.
 */
export function takeLock(path: string, mine: LockInfo, alive: (pid: number) => boolean = pidAlive): { ok: true } | { ok: false; holder: LockInfo } {
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify(mine));
      closeSync(fd);
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = readLock(path);
    if (holder !== null && holder.pid !== mine.pid && alive(holder.pid)) return { ok: false, holder };
    rmSync(path, { force: true });
  }
  return { ok: false, holder: readLock(path) ?? mine };
}

/** The port is known only after the server listens. */
export function updateLock(path: string, mine: LockInfo): void {
  writeAtomic(path, JSON.stringify(mine));
}

export function releaseLock(path: string, pid: number = process.pid): void {
  if (readLock(path)?.pid === pid) rmSync(path, { force: true });
}

/** A reader never sees half a file: the text goes to a temporary file first, and a rename is atomic. */
export function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

export function appendLine(path: string, line: string, now: Date = new Date()): void {
  try {
    appendFileSync(path, `${now.toISOString()} ${line}\n`);
  } catch {
    // A full disk must not stop the night; the line is still on the console.
  }
}

export type Intent = "running" | "stopped";

export interface Heartbeat {
  pid: number;
  port: number;
  run_id: string | null;
  state: string;
  intent: Intent;
  ade: string | null;
  step: string | null;
  step_started_at: string | null;
  step_limit_ms: number | null;
  child_group: number | null;
  written_at: string;
}

export function readHeartbeat(path: string): Heartbeat | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Heartbeat;
  } catch {
    return null;
  }
}

export function writeHeartbeat(path: string, beat: Heartbeat): void {
  try {
    writeAtomic(path, `${JSON.stringify(beat, null, 2)}\n`);
  } catch {
    // The next beat tries again; a missing beat only makes the watchdog look closer.
  }
}

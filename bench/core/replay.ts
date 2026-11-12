// Starts and stops the replay server (bench/replay, ADEMARK-2) through its control endpoints.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ReplayStats } from "../replay/server.ts";
import { benchRoot } from "./paths.ts";

export interface ReplayOptions {
  port: number;
  sessions: string;
  log: string;
  serverPath?: string;
  timeoutMs?: number;
}

export interface ReplayHandle {
  port: number;
  stop(): Promise<void>;
  stats(): Promise<ReplayStats>;
}

const HEALTH_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function startReplay(options: ReplayOptions): Promise<ReplayHandle> {
  const serverPath = options.serverPath ?? resolve(benchRoot, "replay", "server.ts");
  if (!existsSync(serverPath)) {
    throw new Error(`replay server not found at ${serverPath}; build it first (ADEMARK-2, bench/replay/server.ts)`);
  }
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const base = `http://127.0.0.1:${options.port}`;

  const proc = Bun.spawn(
    [
      process.execPath,
      serverPath,
      "--port",
      String(options.port),
      "--sessions",
      options.sessions,
      "--log",
      options.log,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    proc.kill();
    const exited = await Promise.race([proc.exited.then(() => true), sleep(5000).then(() => false)]);
    if (!exited) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  };

  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    if (proc.exitCode !== null) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`replay server exited early (${proc.exitCode}): ${stderr.trim().slice(0, 500)}`);
    }
    try {
      const response = await fetch(`${base}/_ademark/health`);
      if (response.ok) {
        const body = (await response.json()) as { ok?: boolean };
        if (body.ok === true) {
          return {
            port: options.port,
            stop,
            stats: async () => {
              const stats = await fetch(`${base}/_ademark/stats`);
              if (!stats.ok) throw new Error(`replay stats failed: HTTP ${stats.status}`);
              return (await stats.json()) as ReplayStats;
            },
          };
        }
        lastError = "health returned ok != true";
      } else {
        lastError = `health HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }

  await stop();
  throw new Error(`replay server did not become healthy on ${base} within ${timeoutMs} ms: ${lastError}`);
}

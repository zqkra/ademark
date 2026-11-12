// The one place ops commands touch the machine. Tests replace it, so no check needs a real Mac.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";

export interface OpsRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface OpsRunner {
  username(): string;
  uid(): number;
  home(): string;
  env(name: string): string | undefined;
  envWithPrefix(prefix: string): string[];
  run(argv: readonly string[]): OpsRun;
  exists(path: string): boolean;
  readFile(path: string): string | null;
  writeFile(path: string, text: string): void;
  mkdirp(path: string): void;
  signal(pid: number, signal: "SIGSTOP" | "SIGCONT"): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const OPS_TIMEOUT_MS = 5 * 60_000;

export const defaultOpsRunner: OpsRunner = {
  username: () => userInfo().username,
  uid: () => (typeof process.getuid === "function" ? process.getuid() : 501),
  home: () => homedir(),
  env: (name) => process.env[name],
  envWithPrefix(prefix) {
    return Object.keys(process.env)
      .filter((name) => name.startsWith(prefix))
      .sort();
  },
  run(argv) {
    try {
      // Control calls `machine on` and `machine off` on its panel's thread (2026-11-09: a sync call with no limit is a
      // suspect for the 6 frozen hours). The root script's slowest step takes seconds, so 5 minutes means it hangs.
      const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe", timeout: OPS_TIMEOUT_MS });
      if (result.exitedDueToTimeout === true) {
        return { code: 124, stdout: "", stderr: `${argv.slice(0, 3).join(" ")}: no answer in ${OPS_TIMEOUT_MS / 1000} s, ended` };
      }
      return {
        code: result.exitCode ?? 1,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    } catch (error) {
      return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
  },
  exists: (path) => existsSync(path),
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  writeFile(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  signal(pid, signal) {
    process.kill(pid, signal);
  },
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: () => Date.now(),
};

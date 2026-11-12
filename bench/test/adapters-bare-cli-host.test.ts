// ADEMARK-35: reset never quits the Ghostty that hosts the harness, and quits the others by pid, never by name.
import { afterEach, describe, expect, test } from "bun:test";
import { freshGhostty, hostingGhostty, state } from "../adapters/bare-cli.ts";
import { resetMacosRunner, setMacosRunner } from "../adapters/macos.ts";
import type { NativeProc } from "../core/contracts.ts";
import { captureContext, fakeRunner } from "./adapters-fake.ts";

const GHOSTTY = "/Applications/Ghostty.app/Contents/MacOS/ghostty";
const SELF = 9_000;

function proc(pid: number): NativeProc {
  return { pid, ppid: 1, path: GHOSTTY, name: "ghostty", responsible_pid: null } as NativeProc;
}

// Ghostty -> login (root) -> zsh -> bun bench/cli.ts control -> bun bench/cli.ts run (this process).
function psTable(host: number | null, other: number | null): string {
  const lines: string[] = [];
  if (host !== null) {
    lines.push(`${host} 1 ${GHOSTTY}`, "501 " + host + " /usr/bin/login -flp ademark", "502 501 -zsh");
    lines.push(`503 502 bun bench/cli.ts control`, `${SELF} 503 bun bench/cli.ts run --ade bare-cli`);
  }
  if (other !== null) lines.push(`${other} 1 ${GHOSTTY}`, `601 ${other} /usr/bin/login -flp ademark`, "602 601 -zsh", "603 602 claude");
  return lines.join("\n");
}

function setup(ghostty: number[], ps: string) {
  let clock = 0;
  const runner = fakeRunner("ademark", {
    now: () => (clock += 1_000),
    procs: async () => ghostty.map(proc),
    run: (argv) => {
      runner.commands.push(argv);
      if (argv[0] === "ps" && argv.includes("pid=,ppid=,command=")) return { code: 0, stdout: ps, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  setMacosRunner(runner);
  return runner;
}

afterEach(() => {
  resetMacosRunner();
  state.pid = null;
});

describe("hostingGhostty", () => {
  test("one instance that hosts", () => {
    expect(hostingGhostty([100], psTable(100, null), SELF)).toEqual([100]);
  });
  test("two instances in both pid orders: only the host", () => {
    expect(hostingGhostty([100, 200], psTable(100, 200), SELF)).toEqual([100]);
    expect(hostingGhostty([200, 100], psTable(200, 100), SELF)).toEqual([200]);
    expect(hostingGhostty([100, 200], psTable(200, 100), SELF)).toEqual([200]);
  });
  test("a harness process that is not this one also makes a host", () => {
    const ps = `${psTable(null, 200)}\n100 1 ${GHOSTTY}\n701 100 /usr/bin/login\n702 701 bun bench/cli.ts control`;
    expect(hostingGhostty([100, 200], ps, SELF)).toEqual([100]);
  });
  test("no hosting instance", () => {
    expect(hostingGhostty([100, 200], psTable(null, 200) + `\n100 1 ${GHOSTTY}`, SELF)).toEqual([]);
  });
});

describe("freshGhostty", () => {
  const realPid = process.pid;
  // The harness under test is SELF in the fake ps table.
  const asSelf = <T>(work: () => Promise<T>): Promise<T> => {
    Object.defineProperty(process, "pid", { value: SELF, configurable: true });
    return work().finally(() => Object.defineProperty(process, "pid", { value: realPid, configurable: true }));
  };

  for (const order of [[100, 200], [200, 100]]) {
    test(`two instances (${order.join(", ")}): the host stays, the other is ended by pid`, async () => {
      const runner = setup(order, psTable(100, 200));
      const { ctx } = captureContext({ dryRun: false });
      expect(await asSelf(() => freshGhostty(ctx))).toBe(100);
      const flat = runner.commands.map((argv) => argv.join(" "));
      expect(flat).toContain("kill -TERM 200");
      expect(flat.some((line) => line.includes("100") && line.startsWith("kill"))).toBe(false);
      expect(flat.some((line) => line.startsWith("osascript") || line.startsWith("open"))).toBe(false);
      expect(state.pid).toBe(100);
    });
  }

  test("one hosting instance: nothing is quit", async () => {
    const runner = setup([100], psTable(100, null));
    const { ctx } = captureContext({ dryRun: false });
    expect(await asSelf(() => freshGhostty(ctx))).toBe(100);
    expect(runner.commands.some((argv) => argv[0] === "kill" || argv[0] === "osascript")).toBe(false);
  });

  test("no hosting instance: quit by pid and open a fresh one", async () => {
    let alive = [200];
    const runner = setup([], "");
    runner.procs = async () => alive.map(proc);
    const base = runner.run;
    runner.run = (argv, input) => {
      const result = base(argv, input);
      if (argv[0] === "ps" && argv.includes("pid=,ppid=,command=")) return { ...result, stdout: psTable(null, 200) };
      if (argv[0] === "kill") alive = [];
      if (argv[0] === "open") alive = [300];
      return result;
    };
    setMacosRunner(runner);
    const { ctx } = captureContext({ dryRun: false });
    expect(await asSelf(() => freshGhostty(ctx))).toBe(300);
    const flat = runner.commands.map((argv) => argv.join(" "));
    expect(flat).toContain("kill -TERM 200");
    expect(flat).toContain("open -b com.mitchellh.ghostty");
    expect(flat.some((line) => line.startsWith("osascript"))).toBe(false);
  });
});

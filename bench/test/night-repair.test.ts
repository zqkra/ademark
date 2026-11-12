import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultRow } from "../core/contracts.ts";
import {
  AGENT_TIMEOUT_MS,
  allowedPaths,
  buildRepairPrompt,
  failuresOf,
  MAX_ATTEMPTS,
  PUBLIC_REPAIR_FILES,
  repairNight,
  unfinishedBlocks,
  repairTemplate,
  type RepairDeps,
  type RepairOptions,
} from "../night/repair.ts";
import { runAgent, stopChildren, supervised } from "../night/repair-real.ts";
import type { BlockResult } from "../run/loop.ts";

const RECEIPTS = { samples: null, video: null, frames: "orca/A5/frames.json", capture: null, log: null };

function row(ade: string, valid: boolean, reason: string | null = null, test_id = "A5", variant = ""): ResultRow {
  return { ade, test_id, variant, valid, invalid_reason: reason, receipts: RECEIPTS, notes: "" } as unknown as ResultRow;
}

function stopped(ade: string, error = "A5 rep 1: window not found"): BlockResult {
  return { ade, track: "A", finished: false, rows: 0, error };
}

let runDir: string;
let log: string[];

interface Fake {
  rows: ResultRow[];
  changed: string[];
  /** Each agent run moves HEAD unless `noCommit`. */
  noCommit: boolean;
  alive: string[];
  outcome: string;
  /** Rows after each measurement. */
  afterMeasure: ResultRow[][];
  measureOk: boolean;
  head: number;
  clock: number;
  agentMinutes: number;
  dirty: string[];
  broken: string | null;
  tamper: boolean;
  fingerprints: number;
  exit: { ok: boolean; note: string };
  logText: string;
}

function fake(overrides: Partial<Fake> = {}): Fake {
  return {
    rows: [row("orca", false, "window not found")],
    changed: [],
    noCommit: false,
    alive: [],
    outcome: "fixed",
    afterMeasure: [[row("orca", true)]],
    measureOk: true,
    head: 0,
    clock: 0,
    agentMinutes: 5,
    dirty: [],
    broken: null,
    tamper: false,
    fingerprints: 0,
    exit: { ok: true, note: "" },
    logText: "",
    ...overrides,
  };
}

function deps(f: Fake): RepairDeps {
  return {
    now: () => f.clock,
    out: () => {},
    head: () => `commit${f.head}`,
    dirty: () => f.dirty,
    changedPaths: () => f.changed,
    validate: () => f.broken,
    measuringInputs: () => {
      f.fingerprints += 1;
      return f.tamper && f.fingerprints > 1 ? "changed" : "same";
    },
    revert: (before) => {
      log.push(`revert ${before}`);
    },
    commit: () => {},
    writeDiff: (_before, path) => writeFileSync(path, "diff"),
    quitAde: async (ade) => {
      log.push(`quit ${ade}`);
    },
    clearHarnessEnv: () => {
      log.push("clear env");
    },
    runAgent: async ({ prompt, logPath, timeoutMs }) => {
      log.push("agent");
      expect(timeoutMs).toBe(AGENT_TIMEOUT_MS);
      expect(logPath).toContain("agent.jsonl");
      f.clock += f.agentMinutes * 60_000;
      if (!f.noCommit) f.head += 1;
      const file = /`([^`]*outcome\.txt)`/.exec(prompt)?.[1];
      if (file !== undefined && f.outcome.length > 0) writeFileSync(file, f.outcome);
      if (f.logText.length > 0) writeFileSync(logPath, f.logText);
      return f.exit;
    },
    cleanUp: async () => {
      log.push("clean up");
      return f.alive;
    },
    waitQuiet: async () => {
      log.push("quiet");
    },
    supersede: ({ tracks }) => {
      log.push(`supersede ${tracks.join(",")}`);
      f.rows = [];
    },
    remeasure: async ({ tracks }) => {
      log.push(`measure ${tracks.join(",")}`);
      f.rows = f.afterMeasure.shift() ?? f.rows;
      return f.measureOk;
    },
    readRows: () => f.rows,
  };
}

function options(f: Fake, overrides: Partial<RepairOptions> = {}): RepairOptions {
  return {
    runDir,
    runId: "night-1",
    seed: "seed",
    tracks: ["A", "B"],
    agents: ["claude"],
    order: ["orca"],
    blocks: [stopped("orca")],
    deadline: null,
    budgetMs: 180 * 60_000,
    template: repairTemplate(),
    deps: deps(f),
    ...overrides,
  };
}

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "ademark-repair-"));
  log = [];
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe("failuresOf", () => {
  test("a stopped last block fails, a block that finished on retry does not", () => {
    expect(failuresOf("orca", [stopped("orca")], [])).toHaveLength(1);
    const retried: BlockResult = { ade: "orca", track: "A", finished: true, rows: 5, error: null };
    expect(failuresOf("orca", [stopped("orca"), retried], [])).toEqual([]);
  });

  test("a gate or a version mismatch is not repairable", () => {
    expect(failuresOf("orca", [stopped("orca", "gates: swap used 40 MB")], [])).toEqual([]);
    expect(failuresOf("orca", [stopped("orca", "install check: version moved")], [])).toEqual([]);
  });

  test("not supported rows are ignored", () => {
    expect(failuresOf("orca", [], [row("orca", false, "not supported: no fork")])).toEqual([]);
  });

  test("a test output with one valid row passes, one with none fails", () => {
    expect(failuresOf("orca", [], [row("orca", false, "timeout"), row("orca", true)])).toEqual([]);
    expect(failuresOf("orca", [], [row("orca", false, "timeout")])).toEqual(["orca A5: timeout"]);
  });

  test("one lucky repetition does not pass, and each model counts alone", () => {
    const rows = [row("orca", true), ...Array.from({ length: 5 }, () => row("orca", false, "timed_out"))];
    expect(failuresOf("orca", [], rows)).toEqual(["orca A5: timed_out (1 of 6 valid)"]);
    const claude = { ...row("orca", true), model: "claude-opus-5-5" } as ResultRow;
    const codex = { ...row("orca", false, "timed_out"), model: "gpt-6.1-sol" } as ResultRow;
    expect(failuresOf("orca", [], [claude, codex])).toEqual(["orca A5 (gpt-6.1-sol): timed_out"]);
  });

  test("a stopped block is unfinished even when repair cannot touch it", () => {
    const retried: BlockResult = { ade: "orca", track: "A", finished: true, rows: 5, error: null };
    expect(unfinishedBlocks([stopped("orca", "gates: swap used 40 MB")])).toHaveLength(1);
    expect(unfinishedBlocks([stopped("orca"), retried])).toEqual([]);
  });

  test("rows of an agent variant belong to the ADE, rows of another ADE do not", () => {
    expect(failuresOf("orca", [], [row("orca-own", false, "timeout")])).toHaveLength(1);
    expect(failuresOf("orca", [], [row("bb", false, "timeout")])).toEqual([]);
  });
});

describe("repairNight", () => {
  test("only failing ADEs are repaired", async () => {
    const f = fake();
    const attempts = await repairNight(options(f, { order: ["bb", "orca"] }));
    expect(attempts.map((entry) => entry.ade)).toEqual(["orca"]);
    expect(log.filter((line) => line === "agent")).toHaveLength(1);
  });

  test("a repaired ADE supersedes its rows and is measured in full, after the agent has gone", async () => {
    const f = fake();
    const attempts = await repairNight(options(f));
    expect(attempts[0]).toMatchObject({ result: "repaired", commit: "commit1" });
    expect(log).toEqual(["quit orca", "clear env", "agent", "clean up", "quiet", "supersede A,B", "measure A,B"]);
  });

  test("the diff and the result are written", async () => {
    await repairNight(options(fake()));
    const dir = join(runDir, "repairs", "orca", "attempt-1");
    expect(existsSync(join(dir, "diff.patch"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).result).toBe("repaired");
  });

  test("two attempts at most", async () => {
    const f = fake({ afterMeasure: [], measureOk: false });
    const attempts = await repairNight(options(f));
    expect(attempts.map((entry) => entry.result)).toEqual(["still failing", "still failing"]);
    expect(attempts).toHaveLength(MAX_ATTEMPTS);
  });

  test("the budget stops the loop, and a running attempt finishes first", async () => {
    const f = fake({ agentMinutes: 60, afterMeasure: [], measureOk: false });
    const attempts = await repairNight(options(f, { budgetMs: 30 * 60_000 }));
    expect(attempts).toHaveLength(1);
  });

  test("the deadline stops the loop", async () => {
    const f = fake({ clock: 1_000 });
    expect(await repairNight(options(f, { deadline: 500 }))).toEqual([]);
    expect(log).toEqual([]);
  });

  test("a change outside the allowed paths is reverted and rejected, and nothing is measured", async () => {
    const f = fake({ changed: ["bench/adapters/profiles/orca.json", "bench/core/gates.ts"] });
    const attempts = await repairNight(options(f));
    expect(attempts[0]).toMatchObject({ result: "rejected", commit: null });
    expect(log).toContain("revert commit0");
    expect(log.some((line) => line.startsWith("measure"))).toBe(false);
  });

  test("another ADE's profile is outside the allowed paths", async () => {
    const f = fake({ changed: ["bench/adapters/profiles/bb.json"] });
    expect((await repairNight(options(f)))[0]?.result).toBe("rejected");
  });

  test("no change skips measuring and goes to the next attempt", async () => {
    const f = fake({ noCommit: true, outcome: "" });
    const attempts = await repairNight(options(f));
    expect(attempts.map((entry) => entry.result)).toEqual(["no change", "no change"]);
    expect(log.some((line) => line.startsWith("measure"))).toBe(false);
  });

  test("measuring refuses to start while an agent-desktop, repair claude or ADE process is alive", async () => {
    const f = fake({ alive: ["4242"] });
    const attempts = await repairNight(options(f));
    expect(attempts[0]?.result).toBe("not clean");
    expect(log.some((line) => line.startsWith("supersede") || line.startsWith("measure"))).toBe(false);
  });

  test("needs a human ends the loop of that ADE, and its notes commit stays", async () => {
    const f = fake({ outcome: "needs a human: the sign-in asks for a code" });
    const attempts = await repairNight(options(f));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ result: "needs a human", note: "the sign-in asks for a code", commit: "commit1" });
    expect(log.some((line) => line.startsWith("measure"))).toBe(false);
  });

  test("a second attempt can repair what the first did not", async () => {
    const f = fake({ afterMeasure: [[row("orca", false, "timeout")], [row("orca", true)]] });
    const attempts = await repairNight(options(f));
    expect(attempts.map((entry) => entry.result)).toEqual(["still failing", "repaired"]);
  });

  test("an adaptive output needs six valid runs, not only half", () => {
    const rows = [
      ...Array.from({ length: 3 }, () => row("orca", true, null, "A3", "default-mode")),
      ...Array.from({ length: 3 }, () => row("orca", false, "timed_out", "A3", "default-mode")),
    ];
    expect(failuresOf("orca", [], rows)).toEqual(["orca A3 default-mode: timed_out (3 of 6 valid)"]);
  });

  test("a change to the ignored measuring files is rejected", async () => {
    const f = fake({ tamper: true });
    const attempts = await repairNight(options(f));
    expect(attempts.map((entry) => entry.result)).toEqual(["tampered"]);
    expect(log.some((line) => line.startsWith("measure"))).toBe(false);
  });

  test("fixed does not count when the agent failed", async () => {
    const f = fake({ exit: { ok: false, note: "time limit of 45 minutes" } });
    const attempts = await repairNight(options(f));
    expect(attempts[0]).toMatchObject({ result: "agent failed", note: "time limit of 45 minutes" });
    expect(log.some((line) => line.startsWith("measure"))).toBe(false);
  });

  test("the deadline counts after the quiet wait too", async () => {
    const f = fake();
    const real = deps(f);
    real.waitQuiet = async () => {
      f.clock += 10 * 60_000;
    };
    const attempts = await repairNight(options(f, { deps: real, deadline: 8 * 60_000 }));
    expect(attempts[0]?.note).toBe("no time left to measure again");
  });

  test("a throw after the agent stops leftovers and restores the baseline", async () => {
    const f = fake();
    const real = deps(f);
    real.commit = () => {
      throw new Error("index.lock");
    };
    const attempts = await repairNight(options(f, { deps: real }));
    expect(attempts[0]?.result).toBe("agent failed");
    expect(log.filter((line) => line === "clean up").length).toBeGreaterThan(1);
    expect(log.some((line) => line.startsWith("revert"))).toBe(true);
  });

  test("a repair never starts on a dirty tree", async () => {
    const f = fake({ dirty: ["bench/core/gates.ts"] });
    const attempts = await repairNight(options(f));
    expect(attempts[0]?.result).toBe("not clean");
    expect(log).not.toContain("agent");
  });

  test("a commit that breaks the harness is reverted", async () => {
    const f = fake({ broken: "SyntaxError in adapters/orca.ts" });
    const attempts = await repairNight(options(f));
    expect(attempts[0]?.result).toBe("rejected");
    expect(log).toContain("revert commit0");
    expect(log.some((line) => line.startsWith("measure"))).toBe(false);
  });

  test("a commit with no outcome file is unfinished, and nothing is measured", async () => {
    const f = fake({ outcome: "" });
    const attempts = await repairNight(options(f));
    expect(attempts[0]?.result).toBe("unfinished");
    expect(log.some((line) => line.startsWith("measure"))).toBe(false);
  });

  test("a seed-only fix leaves HEAD alone and is still measured again", async () => {
    const f = fake({ noCommit: true });
    expect((await repairNight(options(f)))[0]?.result).toBe("repaired");
    expect(log).toContain("measure A,B");
  });

  test("a plan limit stops every repair of the night", async () => {
    const f = fake({ logText: "API Error: usage limit reached", outcome: "" });
    const attempts = await repairNight(options(f, { order: ["orca", "bb"], blocks: [stopped("orca"), stopped("bb")] }));
    expect(attempts.map((entry) => entry.result)).toEqual(["plan limit"]);
  });

  test("the deadline is checked again before measuring", async () => {
    const f = fake({ agentMinutes: 60 });
    const attempts = await repairNight(options(f, { deadline: 30 * 60_000 }));
    expect(attempts[0]).toMatchObject({ result: "still failing", note: "no time left to measure again" });
    expect(log.some((line) => line.startsWith("measure"))).toBe(false);
  });

  test("a repair that leaves no rows is not repaired", async () => {
    const f = fake({ afterMeasure: [[], []], outcome: "fixed" });
    const attempts = await repairNight(options(f));
    expect(attempts[0]?.result).toBe("still failing");
  });

  test("an attempt that throws is recorded and the next ADE still runs", async () => {
    const f = fake();
    const real = deps(f);
    let calls = 0;
    const quitAde = real.quitAde;
    real.quitAde = async (ade) => {
      calls += 1;
      if (calls <= 2) throw new Error("disk full");
      await quitAde(ade);
    };
    const attempts = await repairNight(options(f, { deps: real, order: ["bb", "orca"], blocks: [stopped("orca"), stopped("bb")] }));
    expect(attempts.filter((entry) => entry.result === "agent failed").length).toBeGreaterThan(0);
  });

  test("the rows of a repaired ADE carry the commit", async () => {
    const path = join(runDir, "rows.jsonl");
    const f = fake();
    const real = deps(f);
    const remeasure = real.remeasure;
    real.remeasure = async (o) => {
      const finished = await remeasure(o);
      writeFileSync(path, `${JSON.stringify(row("orca", true))}\n${JSON.stringify(row("bb", true))}\n`);
      return finished;
    };
    await repairNight(options(f, { deps: real }));
    const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ResultRow);
    expect(rows[0]?.notes).toBe("repaired commit1");
    expect(rows[1]?.notes).toBe("");
  });
});

describe("runAgent", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("the time cap kills the whole process tree, and the log stays", async () => {
    const bin = join(runDir, "fake-claude");
    const pidFile = join(runDir, "child.pid");
    writeFileSync(bin, `#!/bin/sh\nsleep 60 &\necho $! > "${pidFile}"\necho started\nwait\n`);
    chmodSync(bin, 0o755);
    const logPath = join(runDir, "repairs", "agent.jsonl");
    await runAgent({ prompt: "x", logPath, timeoutMs: 500, bin });
    await Bun.sleep(100);
    expect(readFileSync(logPath, "utf8")).toContain("started");
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  test("a process the agent leaves behind dies when the agent exits", async () => {
    const bin = join(runDir, "fake-claude");
    const pidFile = join(runDir, "left.pid");
    writeFileSync(bin, `#!/bin/sh\nsleep 60 &\necho $! > "${pidFile}"\nexit 0\n`);
    chmodSync(bin, 0o755);
    await runAgent({ prompt: "x", logPath: join(runDir, "agent.jsonl"), timeoutMs: 5_000, bin });
    await Bun.sleep(100);
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  test("a missing binary ends the attempt without throwing", async () => {
    expect((await runAgent({ prompt: "x", logPath: join(runDir, "agent.jsonl"), timeoutMs: 1_000, bin: join(runDir, "nothing") })).ok).toBe(false);
  });
});

describe("prompt and files", () => {
  const prompt = (): string =>
    buildRepairPrompt({
      template: repairTemplate(),
      ade: "orca",
      tracks: ["A"],
      failures: ["orca A5: window not found"],
      receipts: ["/results/orca/A5/frames.json"],
      outcomeFile: "/results/repairs/orca/attempt-1/outcome.txt",
    });

  test("the prompt names the ADE, the failures, the receipts and the allowed paths", () => {
    const text = prompt();
    expect(text).toContain("orca A5: window not found");
    expect(text).toContain("/results/orca/A5/frames.json");
    for (const path of allowedPaths("orca")) expect(text).toContain(path);
    expect(text).not.toContain("{{");
  });

  test("the prompt holds the human steps lists", () => {
    const text = prompt();
    expect(text).toContain("Human steps");
    expect(text).toContain("Decline every update offer");
    expect(text).toContain("Type a password, a 2FA or email code, an API key or a recovery code.");
    expect(text).toContain("use `sudo`");
    expect(text).toContain("Create an account, buy, upgrade a plan");
  });

  test("the prompt permits physical input only on this ADE", () => {
    expect(prompt()).toContain("use the global `--headed` flag. Use it only on\n   this ADE");
  });

  test("the prompt keeps the agents of this night in its gate command", () => {
    const text = buildRepairPrompt({
      template: repairTemplate(),
      ade: "bare-cli",
      tracks: ["A"],
      agents: ["claude"],
      failures: [],
      receipts: [],
      outcomeFile: "/x/outcome.txt",
    });
    expect(text).toContain("calibrate gate --ade bare-cli --runs 1 --scratch --agent claude`");
  });

  test("the prompt carries what the last night showed for this ADE", () => {
    expect(prompt()).toContain("A3 said new thread did not appear");
  });

  test("the prompt forbids background jobs, which ended the repairs of 2026-11-05", () => {
    expect(prompt()).toContain("Never start a background job");
  });

  test("the agent log is not in the published file list", () => {
    expect(PUBLIC_REPAIR_FILES as readonly string[]).not.toContain("agent.jsonl");
  });

  test("the allowed paths are only the driving files of that ADE", () => {
    expect(allowedPaths("orca")).toEqual([
      "bench/adapters/profiles/orca.json",
      "bench/adapters/gates/orca.json",
      "bench/adapters/orca.ts",
    ]);
  });
});

describe("stopChildren", () => {
  test("a child that ignores TERM dies at the short deadline, not at its time limit", async () => {
    const started = Date.now();
    const running = supervised(["sh", "-c", "trap '' TERM; while :; do sleep 1; done"], 60_000, tmpdir());
    await Bun.sleep(300);
    stopChildren();
    await running;
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);
});

describe("supervised", () => {
  test("a helper in the group is gone when it returns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-sup-"));
    const pidFile = join(dir, "pid");
    const code = await supervised(["sh", "-c", `sleep 60 & echo $! > "${pidFile}"; exit 0`], 5_000, dir);
    expect(code).toBe(0);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  test("the time limit ends the whole group and returns 124", async () => {
    expect(await supervised(["sh", "-c", "sleep 60"], 200, tmpdir())).toBe(124);
  }, 20_000);
});

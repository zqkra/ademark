import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAll, prepareReport, type PrepareDeps, type PrepareOptions } from "../night/prepare.ts";
import { repairTemplate, type RepairDeps } from "../night/repair.ts";

let dir: string;
let log: string[];

interface Script {
  /** Failures per check call, in order. */
  checks: string[][];
  outcome?: string;
  changed?: string[];
  noCommit?: boolean;
}

function deps(s: Script): PrepareDeps {
  let head = 0;
  const repair: RepairDeps = {
    now: () => 0,
    out: () => {},
    head: () => `commit${head}`,
    dirty: () => [],
    changedPaths: () => s.changed ?? [],
    validate: () => null,
    measuringInputs: () => "same",
    revert: () => {
      log.push("revert");
    },
    commit: () => {},
    writeDiff: (_before, path) => writeFileSync(path, "diff"),
    quitAde: async () => {},
    clearHarnessEnv: () => {},
    runAgent: async ({ prompt }) => {
      log.push("agent");
      if (s.noCommit !== true) head += 1;
      const file = /`([^`]*outcome\.txt)`/.exec(prompt)?.[1];
      if (file !== undefined) writeFileSync(file, s.outcome ?? "fixed");
      return { ok: true, note: "" };
    },
    cleanUp: async () => [],
    waitQuiet: async () => {},
    supersede: () => {
      throw new Error("prepare never supersedes");
    },
    remeasure: async () => {
      throw new Error("prepare never measures");
    },
    readRows: () => [],
  };
  return {
    repair,
    commitGate: (ade) => {
      log.push(`commit gate ${ade}`);
    },
    revokeGate: (ade) => {
      log.push(`revoke gate ${ade}`);
    },
    check: async ({ ade, track }) => {
      log.push(`check ${ade} ${track}`);
      return s.checks.shift() ?? [];
    },
  };
}

function options(s: Script, over: Partial<PrepareOptions> = {}): PrepareOptions {
  return {
    ades: ["orca"],
    tracks: ["A", "B"],
    agents: ["claude"],
    runId: "prepare-1",
    runDir: dir,
    template: repairTemplate(),
    deps: deps(s),
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-prepare-"));
  log = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("prepareAll", () => {
  test("an ADE that passes starts no agent", async () => {
    const results = await prepareAll(options({ checks: [] }));
    expect(results).toEqual([{ ade: "orca", ready: true, rounds: 1, reason: "" }]);
    expect(log).toEqual(["revoke gate orca", "check orca B", "check orca A", "commit gate orca"]);
  });

  test("a failure starts the agent and the next round proves the fix", async () => {
    const results = await prepareAll(options({ checks: [["orca A4: timed_out"], [], []] }));
    expect(results[0]).toMatchObject({ ready: true, rounds: 2 });
    expect(log.filter((line) => line === "agent")).toHaveLength(1);
  });

  test("a failed track stops the round before the later tracks", async () => {
    await prepareAll(options({ checks: [["orca B1: timed_out"]] }, { rounds: 1 }));
    expect(log).toEqual(["revoke gate orca", "check orca B", "revoke gate orca"]);
  });

  test("the gate is revoked first and passes last, so an interruption leaves nothing eligible", async () => {
    await prepareAll(options({ checks: [[], ["A4: timed_out"]] }, { rounds: 1 }));
    expect(log).toEqual(["revoke gate orca", "check orca B", "check orca A", "commit gate orca", "revoke gate orca"]);
  });

  test("changed measuring files stop the whole preparation", async () => {
    const base = deps({ checks: [["x"]] });
    let fingerprint = 0;
    const repair = { ...base.repair, measuringInputs: () => String((fingerprint += 1)) };
    const results = await prepareAll(options({ checks: [] }, { deps: { ...base, repair }, ades: ["orca", "bb"] }));
    expect(results).toHaveLength(1);
    expect(results[0]?.reason).toContain("tampered");
  });

  test("a repair cannot leave the gate open before the next round proves it", async () => {
    await prepareAll(options({ checks: [["B1: timed_out"], [], []] }));
    const agent = log.indexOf("agent");
    expect(log[agent + 1]).toBe("revoke gate orca");
  });

  test("a Stop between tracks starts no other proof", async () => {
    let stopped = false;
    const base = deps({ checks: [] });
    const check: PrepareDeps["check"] = async (input) => {
      stopped = true;
      return base.check(input);
    };
    await prepareAll(options({ checks: [] }, { deps: { ...base, check }, cancelled: () => stopped }));
    expect(log.filter((line) => line.startsWith("check"))).toEqual(["check orca B"]);
  });

  test("a Stop after the app quit starts no agent", async () => {
    let stopped = false;
    const base = deps({ checks: [["x"]] });
    const repair = { ...base.repair, quitAde: async () => { stopped = true; } };
    await prepareAll(options({ checks: [] }, { deps: { ...base, repair }, cancelled: () => stopped }));
    expect(log).not.toContain("agent");
  });

  test("a proof that throws counts as failed, and the next ADE still runs", async () => {
    const base = deps({ checks: [] });
    let calls = 0;
    const check: PrepareDeps["check"] = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("malformed rows");
      return base.check(input);
    };
    const results = await prepareAll(options({ checks: [] }, { deps: { ...base, check }, ades: ["orca", "bb"], rounds: 1 }));
    expect(results[0]).toMatchObject({ ready: false });
    expect(results[0]?.reason).toContain("malformed rows");
    expect(results[1]).toMatchObject({ ade: "bb", ready: true });
  });

  test("a Track C preparation leaves the Track A gate alone until it fails", async () => {
    await prepareAll(options({ checks: [] }, { tracks: ["C"] }));
    expect(log).toEqual(["check orca C"]);
  });

  test("the last round ends with the reason and no agent", async () => {
    const results = await prepareAll(options({ checks: [["one"], ["two"], ["three"]] }));
    expect(results[0]).toMatchObject({ ready: false, rounds: 3, reason: "three" });
    expect(log.filter((line) => line === "agent")).toHaveLength(2);
  });

  test("needs a human ends that ADE, and the next ADE still runs", async () => {
    const results = await prepareAll(
      options({ checks: [["sign-in"]], outcome: "needs a human: the app asks for a code" }, { ades: ["orca", "bb"] }),
    );
    expect(results[0]).toMatchObject({ ready: false, reason: "needs a human: the app asks for a code" });
    expect(results[1]).toMatchObject({ ade: "bb", ready: true });
  });

  test("a change outside the allowed paths is reverted", async () => {
    const results = await prepareAll(options({ checks: [["x"], ["x"], ["x"]], changed: ["bench/core/gates.ts"] }));
    expect(log).toContain("revert");
    expect(results[0]?.ready).toBe(false);
  });

  test("the report is written after each ADE and says what is ready", async () => {
    await prepareAll(options({ checks: [] }, { ades: ["orca", "bb"] }));
    const report = readFileSync(join(dir, "prepare.md"), "utf8");
    expect(report).toContain("- ready: 2 of 2");
    expect(report).toContain("| orca | yes | 1 |  |");
    expect(existsSync(join(dir, "prepare.md"))).toBe(true);
  });

  test("the report keeps a reason with a pipe inside its table", () => {
    const report = prepareReport("r", ["A"], [{ ade: "a", ready: false, rounds: 3, reason: "x | y" }]);
    expect(report).toContain("| a | no | 3 | x / y |");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instructions, parseAction, type AgentAction, type Decide } from "../agent/eyes.ts";
import { achieveGoal, clearBlockers, pngSize, type Hands } from "../agent/goal.ts";
import type { AdapterContext } from "../core/contracts.ts";

// A valid 8-byte signature and IHDR chunk header for a 1600 x 1000 image; the loop reads only the size.
function fakePng(width = 1600, height = 1000): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-agent-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function context(dryRun = false): { ctx: AdapterContext; lines: string[] } {
  const lines: string[] = [];
  return {
    ctx: { runDir: dir, arenaPath: "", worktree: "", home: "", env: {}, dryRun, log: (line) => lines.push(line) },
    lines,
  };
}

function fakeHands(): { hands: Hands; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hands: {
      screenshot: async (_pid, out) => {
        writeFileSync(out, fakePng());
        calls.push("look");
      },
      click: async (pid, point, count) => void calls.push(`click ${pid} ${point.x},${point.y} x${count}`),
      keys: async (_pid, combo) => void calls.push(`keys ${combo}`),
      type: async (_pid, text) => void calls.push(`type ${text}`),
      sleep: async () => {},
    },
  };
}

function scripted(actions: AgentAction[]): { decide: Decide; seen: string[][] } {
  const seen: string[][] = [];
  let index = 0;
  return {
    seen,
    decide: async (look) => {
      seen.push([...look.history]);
      return actions[Math.min(index++, actions.length - 1)]!;
    },
  };
}

describe("parseAction", () => {
  test("reads a click inside the window and rounds it", () => {
    expect(parseAction('ok {"action":"click","x":10.4,"y":20.6,"reason":"send"}', 100, 100)).toEqual({
      action: "click", x: 10, y: 21, reason: "send",
    });
  });

  test("a point outside the window is a fail, never a click", () => {
    expect(parseAction('{"action":"click","x":120,"y":5}', 100, 100).action).toBe("fail");
    expect(parseAction('{"action":"click","x":-1,"y":5}', 100, 100).action).toBe("fail");
  });

  test("malformed answers fail", () => {
    expect(parseAction("I would click Send", 100, 100).action).toBe("fail");
    expect(parseAction("{not json}", 100, 100).action).toBe("fail");
    expect(parseAction('{"action":"drag"}', 100, 100).action).toBe("fail");
    expect(parseAction('{"action":"keys"}', 100, 100).action).toBe("fail");
  });

  test("keys are lower case and waits are bounded", () => {
    expect(parseAction('{"action":"keys","combo":"CMD+N"}', 100, 100)).toMatchObject({ combo: "cmd+n" });
    expect(parseAction('{"action":"wait","ms":999999}', 100, 100)).toMatchObject({ ms: 10_000 });
  });

  test("the instructions forbid updates and sign-outs and carry the history", () => {
    const text = instructions({ goal: "Open a chat", png: fakePng(), width: 1600, height: 1000, history: ["keys cmd+n: new"] });
    expect(text).toContain("Never update or install anything, never sign out");
    expect(text).toContain("1600 x 1000");
    expect(text).toContain("1. keys cmd+n: new");
  });
});

describe("achieveGoal", () => {
  test("acts until the model says done, and keeps every look", async () => {
    const { ctx } = context();
    const { hands, calls } = fakeHands();
    const { decide, seen } = scripted([
      { action: "click", x: 800, y: 600, reason: "close" },
      { action: "keys", combo: "escape", reason: "dialog" },
      { action: "done", reason: "clear" },
    ]);
    const result = await achieveGoal(ctx, 42, { goal: "clear", dir: join(dir, "a"), decide, hands, scale: 2 });
    expect(result).toMatchObject({ done: true, actions: 2, reason: "clear" });
    // Screenshot pixels become window points.
    expect(calls).toEqual(["look", "click 42 400,300 x1", "look", "keys escape", "look"]);
    expect(seen[2]).toEqual(["click 800,600: close", "keys escape: dialog"]);
    const log = readFileSync(result.log, "utf8").trim().split("\n");
    expect(log).toHaveLength(4);
  });

  test("stops at the action limit", async () => {
    const { ctx } = context();
    const { hands, calls } = fakeHands();
    const { decide } = scripted([{ action: "keys", combo: "escape", reason: "again" }]);
    const result = await achieveGoal(ctx, 1, { goal: "x", dir: join(dir, "b"), decide, hands, maxActions: 2 });
    expect(result.done).toBe(false);
    expect(result.reason).toBe("not done after 2 actions");
    expect(calls.filter((call) => call.startsWith("keys"))).toHaveLength(2);
  });

  test("a fail from the model ends the loop without acting", async () => {
    const { ctx } = context();
    const { hands, calls } = fakeHands();
    const { decide } = scripted([{ action: "fail", reason: "no such button" }]);
    const result = await achieveGoal(ctx, 1, { goal: "x", dir: join(dir, "c"), decide, hands });
    expect(result).toMatchObject({ done: false, actions: 0, reason: "no such button" });
    expect(calls).toEqual(["look"]);
  });

  test("a dry run only plans", async () => {
    const { ctx, lines } = context(true);
    const result = await achieveGoal(ctx, 0, { goal: "clear", dir: join(dir, "d") });
    expect(result.done).toBe(true);
    expect(lines).toEqual(["plan: goal pid=0 goal=clear"]);
  });

  test("clearing never throws and can be turned off", async () => {
    const { ctx } = context();
    const broken: Hands = { ...fakeHands().hands, screenshot: async () => { throw new Error("no window"); } };
    expect(await clearBlockers(ctx, 1, "Demo", join(dir, "e"), { hands: broken })).toBeNull();
    process.env.ADEMARK_AGENT = "off";
    try {
      expect(await clearBlockers(ctx, 1, "Demo", join(dir, "f"), { hands: fakeHands().hands })).toBeNull();
    } finally {
      delete process.env.ADEMARK_AGENT;
    }
  });

  test("pngSize reads the header", () => {
    expect(pngSize(fakePng(857, 878))).toEqual({ width: 857, height: 878 });
    expect(() => pngSize(new Uint8Array(10))).toThrow("not a PNG");
  });
});

describe("A7 stream overlap", () => {
  test("five streams that start 10 s apart ran together 140 s; before the window does not count", async () => {
    const { streamOverlapSeconds } = await import("../tracks/a-weight/shared.ts");
    const s = 1_000_000_000;
    const lines = [
      { t_ns: 5 * s, session: "stream-1" },
      ...[1, 2, 3, 4, 5].map((n, index) => ({ t_ns: (100 + index * 10) * s, session: `stream-${n}` })),
      { t_ns: 141 * s, session: "stream-1" },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    expect(streamOverlapSeconds(lines, 50 * s)).toBe(140);
    expect(streamOverlapSeconds(lines.split("\n").slice(0, 3).join("\n"), 50 * s)).toBeNull();
  });
});

// 2026-11-11, Capy 0.7.2: its folder step is a path field that holds the last folder, typed over only after select-all.
describe("a key a goal may allow", () => {
  test("cmd+a is refused, unless the goal allows it; delete is refused for every goal", async () => {
    const { parseAction, instructions, ALLOWABLE_KEYS } = await import("../agent/eyes.ts");
    const key = (combo: string) => JSON.stringify({ action: "keys", combo, reason: "replace the path" });
    expect(parseAction(key("cmd+a"), 100, 100)).toMatchObject({ action: "fail" });
    expect(parseAction(key("cmd+a"), 100, 100, ["cmd+a"])).toMatchObject({ action: "keys", combo: "cmd+a" });
    expect(parseAction(key("delete"), 100, 100, ["cmd+a", "delete"])).toMatchObject({ action: "fail" });
    expect(parseAction(key("cmd+q"), 100, 100, ["cmd+q"])).toMatchObject({ action: "fail" });
    expect(ALLOWABLE_KEYS).toEqual(["cmd+a"]);
    const look = { goal: "g", png: new Uint8Array(), width: 100, height: 100, history: [] };
    expect(instructions(look)).toContain("never select all");
    expect(instructions({ ...look, allowKeys: ["cmd+a"] })).toContain("cmd+a is allowed");
  });
});

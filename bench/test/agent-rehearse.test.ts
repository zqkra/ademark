import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask } from "../agent/eyes.ts";
import { PROBE, readsProbe, rehearse, triggerFrom, type RehearsalHands } from "../agent/rehearse.ts";
import type { AdapterContext, Trigger } from "../core/contracts.ts";

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
  dir = mkdtempSync(join(tmpdir(), "ademark-rehearse-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (): AdapterContext => ({ runDir: dir, arenaPath: "", worktree: "", home: "", env: {}, dryRun: false, log: () => {} });

/** A fake app: one composer draft; "new thread" empties it when the action is one the app knows. */
function fakeApp(o: { newThreadKeys: string[]; newThreadClick?: { x: number; y: number } }): { hands: RehearsalHands; typed: string[] } {
  let draft = "";
  const typed: string[] = [];
  return {
    typed,
    hands: {
      screenshot: async (_pid, out) => writeFileSync(out, fakePng()),
      click: async (_pid, point) => {
        if (o.newThreadClick !== undefined && point.x === o.newThreadClick.x && point.y === o.newThreadClick.y) draft = "";
      },
      keys: async (_pid, combo) => {
        if (combo === "cmd+a" || combo === "delete" || o.newThreadKeys.includes(combo)) draft = "";
      },
      type: async (_pid, text) => {
        typed.push(text);
        draft += text;
      },
      sleep: async () => {},
      ocr: async () => (draft.length > 0 ? [draft] : []),
    },
  };
}

/** Answers by prompt kind: locate, judge, or one agent action from a script. */
function fakeAsk(o: { composer: object | null; actions?: object[] }): Ask {
  let next = 0;
  return async (prompt) => {
    if (prompt.includes("Find these elements")) return JSON.stringify({ composer: o.composer, answers: { x: 300, y: 50, w: 900, h: 800 } });
    if (prompt.includes("Question:")) return '{"answer":true,"reason":"agent chat"}';
    const actions = o.actions ?? [{ action: "done", reason: "clear" }];
    return JSON.stringify(actions[Math.min(next++, actions.length - 1)]);
  };
}

const base = {
  pid: 7,
  appName: "Demo",
  guide: "",
  scale: 1,
  threadRect: null,
  clearKeys: ["cmd+a", "delete"],
};

describe("rehearse", () => {
  test("the agent's composer replaces a profile position that moved, and typing is read back", async () => {
    const app = fakeApp({ newThreadKeys: ["cmd+n"] });
    const result = await rehearse(ctx(), {
      ...base,
      dir: join(dir, "a"),
      composerRect: { x: 40, y: 300, w: 300, h: 30 },
      newThread: [{ kind: "keys", combo: "cmd+n" }],
      ask: fakeAsk({ composer: { x: 590, y: 880, w: 720, h: 60 } }),
      hands: app.hands,
    });
    expect(result.composerSource).toBe("agent");
    expect(result.composerRect).toEqual({ x: 590, y: 880, w: 720, h: 60 });
    expect(result.focusClick).toEqual({ x: 950, y: 910 });
    expect(result.typingWorks).toBe(true);
    expect(result.newThreadSource).toBe("profile");
  });

  test("a broken new-thread shortcut is found by the draft, and what the agent did becomes the trigger", async () => {
    const app = fakeApp({ newThreadKeys: [], newThreadClick: { x: 120, y: 105 } });
    const result = await rehearse(ctx(), {
      ...base,
      dir: join(dir, "b"),
      composerRect: { x: 590, y: 880, w: 720, h: 60 },
      newThread: [{ kind: "keys", combo: "cmd+shift+9" }],
      ask: fakeAsk({
        composer: { x: 590, y: 880, w: 720, h: 60 },
        actions: [
          { action: "done", reason: "nothing covers it" },
          { action: "click", x: 120, y: 105, reason: "New thread" },
          { action: "done", reason: "empty thread" },
        ],
      }),
      hands: app.hands,
    });
    expect(result.newThreadSource).toBe("agent");
    // One action, no waits: nothing of ours runs inside the stopwatch.
    expect(result.newThread).toEqual([{ kind: "click", point: { x: 120, y: 105 } }]);
    expect(result.notes.join(" ")).toContain("did not open a new conversation");
  });

  test("with no message box in sight nothing is typed", async () => {
    const app = fakeApp({ newThreadKeys: ["cmd+n"] });
    const result = await rehearse(ctx(), {
      ...base,
      dir: join(dir, "c"),
      composerRect: { x: 40, y: 300, w: 300, h: 30 },
      newThread: [{ kind: "keys", combo: "cmd+n" }],
      ask: fakeAsk({ composer: null }),
      hands: app.hands,
    });
    expect(result.composerSource).toBe("none");
    expect(result.typingWorks).toBe(false);
    expect(app.typed).toEqual([]);
  });

  test("the new-thread check closes what it opened and clears its draft before it returns (Conductor, 8 Nov)", async () => {
    // cmd+n opens a modal over the composer; the draft stays behind it until it is cleared.
    let draft = "";
    let modal = false;
    const keys: string[] = [];
    const hands: RehearsalHands = {
      screenshot: async (_pid, out) => writeFileSync(out, fakePng()),
      click: async () => {},
      keys: async (_pid, combo) => {
        keys.push(combo);
        if (combo === "cmd+n") modal = true;
        else if (combo === "escape") modal = false;
        else if (!modal && (combo === "cmd+a" || combo === "delete")) draft = "";
      },
      type: async (_pid, text) => {
        if (!modal) draft += text;
      },
      sleep: async () => {},
      ocr: async () => [...(modal ? ["What do you want to work on?", "Create"] : []), ...(draft.length > 0 ? [draft] : [])],
    };
    const result = await rehearse(ctx(), {
      ...base,
      dir: join(dir, "e"),
      composerRect: { x: 590, y: 880, w: 720, h: 60 },
      newThread: [{ kind: "keys", combo: "cmd+n" }],
      ask: fakeAsk({ composer: { x: 590, y: 880, w: 720, h: 60 }, actions: [{ action: "done", reason: "clear" }] }),
      hands,
    });
    expect(modal).toBe(false);
    expect(draft).toBe("");
    expect(result.probeLeft).toBe(false);
    expect(keys.lastIndexOf("escape")).toBeGreaterThan(keys.lastIndexOf("cmd+n"));
  });

  test("a draft that stays after Escape and clearing marks the probe as left", async () => {
    let draft = "";
    let clears = 0;
    const hands: RehearsalHands = {
      screenshot: async (_pid, out) => writeFileSync(out, fakePng()),
      click: async () => {},
      // The first clear works, so the typing check passes; the new-thread draft never clears.
      keys: async (_pid, combo) => {
        if (combo === "cmd+a" && clears++ === 0) draft = "";
      },
      type: async (_pid, text) => {
        draft += text;
      },
      sleep: async () => {},
      ocr: async () => (draft.length > 0 ? [draft] : []),
    };
    const result = await rehearse(ctx(), {
      ...base,
      dir: join(dir, "f"),
      composerRect: { x: 590, y: 880, w: 720, h: 60 },
      newThread: [{ kind: "keys", combo: "cmd+n" }],
      ask: fakeAsk({ composer: { x: 590, y: 880, w: 720, h: 60 }, actions: [{ action: "done", reason: "clear" }] }),
      hands,
    });
    expect(result.probeLeft).toBe(true);
    expect(result.notes.join(" ")).toContain("still on screen after Escape and clearing");
  });

  test("probe reading tolerates a hidden last letter, typing never becomes a trigger", () => {
    expect(readsProbe(["LEDGERMAR"])).toBe(true);
    expect(readsProbe(["ledger"])).toBe(false);
    expect(PROBE).toBe("LEDGERMARK");
    expect(triggerFrom({ action: "type" }, 1)).toBeNull();
    const keys: Trigger | null = triggerFrom({ action: "keys", combo: "cmd+n" }, 2);
    expect(keys).toEqual({ kind: "keys", combo: "cmd+n" });
    expect(triggerFrom({ action: "click", x: 200, y: 100 }, 2)).toEqual({ kind: "click", point: { x: 100, y: 50 } });
  });

  test("a path of several steps is never used as a timed trigger", async () => {
    const app = fakeApp({ newThreadKeys: [], newThreadClick: { x: 300, y: 200 } });
    const result = await rehearse(ctx(), {
      ...base,
      dir: join(dir, "d"),
      composerRect: { x: 590, y: 880, w: 720, h: 60 },
      newThread: [{ kind: "keys", combo: "cmd+shift+9" }],
      ask: fakeAsk({
        composer: { x: 590, y: 880, w: 720, h: 60 },
        actions: [
          { action: "done", reason: "nothing covers it" },
          { action: "click", x: 120, y: 20, reason: "plus" },
          { action: "click", x: 300, y: 200, reason: "menu item" },
          { action: "done", reason: "empty thread" },
        ],
      }),
      hands: app.hands,
    });
    expect(result.newThreadSource).toBe("failed");
    expect(result.notes.join(" ")).toContain("2 steps");
  });
});

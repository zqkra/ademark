import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetMacosRunner, setMacosRunner } from "../adapters/macos.ts";
import { profilesDir } from "../adapters/profile.ts";
import { orchestratorInc, projectConfigFor, projectIdFor } from "../adapters/orchestrator-inc.ts";
import { captureContext, fakeRunner } from "./adapters-fake.ts";

afterEach(() => resetMacosRunner());

// The shipped profile has no composerRect and threadRect until calibration, and the base methods refuse an invalid
// profile. These tests read a copy with stand-in rects; they test the adapter code, not the calibration.
let folder = "";
const before = process.env.ADEMARK_PROFILES;
beforeAll(() => {
  const profile = JSON.parse(readFileSync(join(profilesDir(), "orchestrator-inc.json"), "utf8"));
  profile.calibration.composerRect ??= { x: 400, y: 860, w: 800, h: 80 };
  profile.calibration.threadRect ??= { x: 400, y: 100, w: 800, h: 700 };
  folder = mkdtempSync(join(tmpdir(), "ademark-orchestrator-inc-"));
  writeFileSync(join(folder, "orchestrator-inc.json"), JSON.stringify(profile));
  process.env.ADEMARK_PROFILES = folder;
});
afterAll(() => {
  if (before === undefined) delete process.env.ADEMARK_PROFILES;
  else process.env.ADEMARK_PROFILES = before;
  rmSync(folder, { recursive: true, force: true });
});

const AO = "/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao";
const OPTIONS = { agent: "claude", model: "claude-opus-5-5", effort: "high" } as const;

describe("Orchestrator project per arena", () => {
  test("the id is the arena folder name, so every Track C arena gets its own project", () => {
    expect(projectIdFor("/Users/ademark/arena/orchestrator-inc")).toBe("orchestrator-inc");
    expect(projectIdFor("/Users/ademark/arena/orchestrator-inc-C1-1")).toBe("orchestrator-inc-c1-1");
    expect(projectIdFor("/tmp/A b..c/")).toBe("a-b-c");
    expect(projectIdFor("/")).toBe("arena");
  });

  test("the project config pins the role agents, model, effort and full access", () => {
    expect(projectConfigFor(OPTIONS)).toEqual({
      agentConfig: { model: "claude-opus-5-5", effort: "high", permissions: "bypass-permissions" },
      worker: { agent: "claude-code" },
      orchestrator: { agent: "claude-code" },
    });
    expect(projectConfigFor({ ...OPTIONS, agent: "codex", model: "gpt-6.1-sol" })).toMatchObject({
      worker: { agent: "codex" },
      orchestrator: { agent: "codex" },
    });
  });

  test("configure registers the arena, writes its config and opens it, in that order", async () => {
    setMacosRunner(fakeRunner("ademark"));
    const { ctx, lines } = captureContext({ dryRun: true, worktree: "/Users/ademark/arena/orchestrator-inc-C2-1" });
    await orchestratorInc.configure(ctx, { ...OPTIONS } as never);
    const get = lines.findIndex((line) => line.includes(`${AO} project get orchestrator-inc-c2-1`));
    const add = lines.findIndex((line) =>
      line.includes(`${AO} project add --path /Users/ademark/arena/orchestrator-inc-C2-1 --id orchestrator-inc-c2-1`),
    );
    const config = lines.findIndex((line) => line.includes(`${AO} project set-config orchestrator-inc-c2-1 --config-json`));
    const open = lines.findIndex((line) => line.includes("Open the project named 'orchestrator-inc-c2-1'"));
    expect([get, add, config, open].every((index) => index >= 0)).toBe(true);
    expect(get).toBeLessThan(add);
    expect(add).toBeLessThan(config);
    expect(config).toBeLessThan(open);
    expect(lines[config]).toContain('"permissions":"bypass-permissions"');
  });
});

describe("C1 goes to the orchestrator session", () => {
  const trigger = "Orchestrate this.";
  const withTrigger = async (run: () => Promise<void>): Promise<void> => {
    Object.defineProperty(orchestratorInc, "orchestrationTrigger", { configurable: true, get: () => trigger });
    try {
      await run();
    } finally {
      delete (orchestratorInc as { orchestrationTrigger?: unknown }).orchestrationTrigger;
    }
  };

  test("a prompt that starts with the trigger line opens the orchestrator before the paste", async () => {
    setMacosRunner(fakeRunner("ademark"));
    const { ctx, lines } = captureContext({ dryRun: true });
    await withTrigger(() => orchestratorInc.send(ctx, `${trigger}\nShip the four work items.`));
    const orchestrator = lines.findIndex((line) => line.includes("combo=cmd+shift+o"));
    const paste = lines.findIndex((line) => line.includes("paste"));
    expect(orchestrator).toBeGreaterThanOrEqual(0);
    expect(paste).toBeGreaterThan(orchestrator);
  });

  test("every other prompt stays in the New Task composer", async () => {
    setMacosRunner(fakeRunner("ademark"));
    const { ctx, lines } = captureContext({ dryRun: true });
    await withTrigger(() => orchestratorInc.send(ctx, "In the Ledger repository, add rate limiting."));
    expect(lines.some((line) => line.includes("cmd+shift+o"))).toBe(false);
    expect(lines.some((line) => line.includes("paste"))).toBe(true);
  });
});

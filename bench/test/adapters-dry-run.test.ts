import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bareCli,
  calibration as bareCliCalibration,
  cliCommand,
  cliStartCommand,
  state as bareCliState,
} from "../adapters/bare-cli.ts";
import { calibration as t3CodeCalibration, serverSettings, state as t3CodeState, t3code } from "../adapters/t3code.ts";
import { procsUnder, resetMacosRunner, setMacosRunner, trustClaudeFolder } from "../adapters/macos.ts";
import { projectSteps, state as zeronState, zeron } from "../adapters/zeron.ts";
import { CLAUDE_NATIVE_DIR } from "../core/agents.ts";
import type { Adapter, AdapterContext, RunOptions } from "../core/contracts.ts";
import { captureContext, fakeRunner } from "./adapters-fake.ts";

const OPTIONS: RunOptions = { model: "claude-opus-5-5", effort: "high", server: "replay", agent: "claude" };
const ENV = { OPENAI_BASE_URL: "http://127.0.0.1:8787/v1", ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" };
const SNAPSHOT = "/snapshots/clean";

const BARE_CLI = "claude --model claude-opus-5-5 --effort high --dangerously-skip-permissions";
const BARE_COMMAND =
  "cd /tmp/work && ANTHROPIC_BASE_URL='http://127.0.0.1:8787' OPENAI_BASE_URL='http://127.0.0.1:8787/v1' " + BARE_CLI;

// The pilot-calibrated values the adapter ships with; tests that need a gap null one field explicitly.
const SHIPPED_BARE_CLI = { ...bareCliCalibration };
const SHIPPED_T3CODE = { ...t3CodeCalibration };

let savedSnapshot: string | undefined;

beforeEach(() => {
  savedSnapshot = process.env.ADEMARK_SNAPSHOT;
  process.env.ADEMARK_SNAPSHOT = SNAPSHOT;
  Object.assign(bareCliState, {
    agent: "claude",
    model: null,
    effort: null,
    cliCommand: null,
    command: null,
    env: null,
    pid: null,
    since: 0,
  });
  Object.assign(t3CodeState, { agent: "claude", model: null, effort: null, pid: null, since: 0 });
  Object.assign(bareCliCalibration, SHIPPED_BARE_CLI);
  Object.assign(t3CodeCalibration, SHIPPED_T3CODE);
  resetMacosRunner();
});

afterEach(() => {
  if (savedSnapshot === undefined) delete process.env.ADEMARK_SNAPSHOT;
  else process.env.ADEMARK_SNAPSHOT = savedSnapshot;
});

describe("bare-cli dry run", () => {
  test("configure builds the CLI command with the pilot effort flag without typing it yet", async () => {
    const runner = fakeRunner("owner");
    setMacosRunner(runner);
    const { ctx, lines } = captureContext({ env: ENV });

    await bareCli.configure(ctx, OPTIONS);

    expect(lines).toEqual(["plan: trustClaudeFolder /tmp/work"]);
    expect(bareCliState.cliCommand).toBe(BARE_CLI);
    expect(bareCliState.command).toBeNull();
    expect(runner.commands).toEqual([]);
  });

  test("configure builds the Codex command with the pilot effort override", async () => {
    const { ctx, lines } = captureContext({ env: {} });
    await bareCli.configure(ctx, { ...OPTIONS, agent: "codex" });
    expect(lines).toEqual([]);
    expect(bareCliState.cliCommand).toBe(
      "codex --model claude-opus-5-5 -c model_reasoning_effort=high --dangerously-bypass-approvals-and-sandbox",
    );
  });

  test("an uncalibrated field still plans its gap instead of guessing", async () => {
    Object.assign(bareCliCalibration, {
      claudeEffortFlag: null,
      codexEffortFlag: null,
      newTabCombo: null,
      closeOldTabs: null,
    });
    const { ctx, lines } = captureContext({ env: {} });
    await bareCli.configure(ctx, OPTIONS);
    await bareCli.configure(ctx, { ...OPTIONS, agent: "codex" });
    await bareCli.reset(ctx);
    await bareCli.launch(ctx);
    await bareCli.newThread(ctx);
    await bareCli.quit(ctx);
    expect(lines.filter((line) => line.startsWith("plan: MISSING"))).toEqual([
      "plan: MISSING claudeEffortFlag (ADES.md 3.0: effort setting: find in pilot)",
      "plan: MISSING codexEffortFlag (ADES.md 3.0: model and effort settings (find in pilot))",
      'plan: MISSING closeOldTabs (ADES.md 3.0: "close every Ghostty tab except the harness tab")',
      'plan: MISSING newTabCombo (ADES.md 3.0: "Ghostty\'s new-tab shortcut: verify in pilot")',
      "plan: MISSING codexReadyText (pilot: the Codex TUI's ready line is not calibrated (Codex not signed in))",
      'plan: MISSING closeOldTabs (ADES.md 3.0: "close every Ghostty tab except the harness tab")',
    ]);
    expect(bareCliState.cliCommand).toBe("codex --model claude-opus-5-5 --dangerously-bypass-approvals-and-sandbox");
  });

  test("launch without block variables types the plain arena command", async () => {
    const { ctx, lines } = captureContext({ env: {} });
    await bareCli.configure(ctx, OPTIONS);
    lines.length = 0;
    await bareCli.launch(ctx);
    expect(lines[0]).toBe(`plan: command cd /tmp/work && ${BARE_CLI}`);
    expect(bareCliState.command).toBe(`cd /tmp/work && ${BARE_CLI}`);
  });

  test("reset, launch, newThread, send, waitDone and quit plan every step", async () => {
    const runner = fakeRunner("owner");
    setMacosRunner(runner);
    const { ctx, lines } = captureContext({ env: ENV });
    await bareCli.configure(ctx, OPTIONS);
    lines.length = 0;

    await bareCli.reset(ctx);
    expect(lines).toEqual([
      "plan: pidsFor bundlePaths=/Applications/Ghostty.app names=ghostty",
      "plan: waitGone pids=- timeoutMs=10000",
      "plan: killPids pids=-",
      "plan: openBundle com.mitchellh.ghostty",
      "plan: waitForPid bundlePaths=/Applications/Ghostty.app names=ghostty timeoutMs=30000",
      "plan: run ps -E -ww -o command= -p 0",
      "plan: window pid=0 size=1600x1000",
      "plan: press pid=0 combo=cmd+1",
      "plan: press pid=0 combo=cmd+alt+shift+o",
      `plan: procsUnder root=0 bundlePaths=${CLAUDE_NATIVE_DIR} names=claude,codex`,
      "plan: killPids pids=-",
      `plan: restoreSnapshot ${SNAPSHOT} (apply)`,
    ]);

    lines.length = 0;
    expect(await bareCli.launch(ctx)).toEqual({ pid: 0 });
    expect(lines).toEqual([
      `plan: command ${BARE_COMMAND}`,
      "plan: pidsFor bundlePaths=/Applications/Ghostty.app names=ghostty",
    ]);
    expect(bareCliState.command).toBe(BARE_COMMAND);

    lines.length = 0;
    await bareCli.newThread(ctx);
    expect(lines).toEqual([
      "plan: press pid=0 combo=cmd+t",
      "plan: pause ms=400",
      `plan: typeText pid=0 text=${BARE_COMMAND}`,
      "plan: press pid=0 combo=enter",
      "plan: waitForText pid=0 text=bypass",
    ]);

    lines.length = 0;
    await bareCli.send(ctx, "hi there");
    expect(lines).toEqual(["plan: paste pid=0 text=hi there", "plan: press pid=0 combo=enter"]);

    lines.length = 0;
    expect(await bareCli.waitDone(ctx, 60_000)).toEqual({ done: true, reason: "dry run" });
    expect(lines).toEqual(["plan: waitForEndOfTurn agent=claude cwd=/tmp/work timeoutMs=60000"]);

    lines.length = 0;
    await bareCli.quit(ctx);
    expect(lines).toEqual([
      "plan: pidsFor bundlePaths=/Applications/Ghostty.app names=ghostty",
      `plan: procsUnder root=0 bundlePaths=${CLAUDE_NATIVE_DIR} names=claude,codex`,
      "plan: press pid=0 combo=cmd+1",
      "plan: press pid=0 combo=cmd+alt+shift+o",
      "plan: waitGone pids=- timeoutMs=10000",
    ]);
    expect(runner.commands).toEqual([]);
    expect(runner.keysCalls).toEqual([]);
  });

  test("timed stays a plain getter: it carries the command launch built", async () => {
    expect(bareCli.timed).toEqual({
      launch: [],
      newThread: [],
      send: [{ kind: "enter" }],
      longThread: [{ kind: "keys", combo: "cmd+9" }],
      shortThread: [{ kind: "keys", combo: "cmd+2" }],
    });

    const { ctx } = captureContext({ env: ENV });
    bareCliCalibration.newTabCombo = "cmd+t";
    await bareCli.configure(ctx, OPTIONS);
    // The block's environment only exists at launch, so configure alone cannot fill the typed trigger.
    expect(bareCli.timed.newThread).toEqual([]);

    await bareCli.launch(ctx);
    expect(bareCli.timed.launch).toEqual([
      { kind: "keys", combo: "cmd+t" },
      { kind: "wait", ms: 400 },
      { kind: "type", text: BARE_COMMAND },
      { kind: "enter" },
    ]);
    expect(bareCli.timed.newThread[2]).toEqual({ kind: "type", text: BARE_COMMAND });
  });

  test("configure after launch rebuilds the typed command for a new arena", async () => {
    const { ctx } = captureContext({ env: ENV });
    bareCliCalibration.newTabCombo = "cmd+t";
    await bareCli.configure(ctx, OPTIONS);
    await bareCli.launch(ctx);
    expect(bareCliState.command).toBe(BARE_COMMAND);

    ctx.worktree = "/tmp/work-2";
    await bareCli.configure(ctx, OPTIONS);

    const rebuilt =
      "cd /tmp/work-2 && ANTHROPIC_BASE_URL='http://127.0.0.1:8787' OPENAI_BASE_URL='http://127.0.0.1:8787/v1' " +
      BARE_CLI;
    expect(bareCliState.command).toBe(rebuilt);
    expect(bareCli.timed.newThread[2]).toEqual({ kind: "type", text: rebuilt });
  });

  test("orchestrationTrigger is null for Codex and a pilot item for Claude", async () => {
    expect(bareCli.orchestrationTrigger).toBeUndefined();
    const { ctx } = captureContext({ env: {} });
    await bareCli.configure(ctx, { ...OPTIONS, agent: "codex" });
    expect(bareCli.orchestrationTrigger).toBeNull();
    await bareCli.configure(ctx, OPTIONS);
    expect(bareCli.orchestrationTrigger).toBeUndefined();
  });

  test("C6 returns to the thread with claude --continue in the same arena; Codex has no return", async () => {
    const { ctx, lines } = captureContext({ env: ENV });
    bareCliCalibration.newTabCombo = "cmd+t";
    await bareCli.configure(ctx, OPTIONS);
    await bareCli.launch(ctx);
    const back = bareCli.returnToThread;
    expect(back).toBeDefined();
    lines.length = 0;
    await back!(ctx);
    expect(lines.some((line) => line.includes(`typeText pid=0 text=${BARE_COMMAND} --continue`))).toBe(true);
    expect(lines.some((line) => line.includes("waitForText"))).toBe(true);

    await bareCli.configure(ctx, { ...OPTIONS, agent: "codex" });
    expect(bareCli.returnToThread).toBeUndefined();
  });

  test("the typed command carries the arena cwd and the block environment", () => {
    expect(cliStartCommand("/tmp/work", {}, "claude")).toBe("cd /tmp/work && claude");
    expect(cliStartCommand("/tmp/two words", {}, "claude")).toBe("cd '/tmp/two words' && claude");
    expect(
      cliStartCommand("/tmp/work", { OPENAI_BASE_URL: "http://h/v1", ANTHROPIC_BASE_URL: "http://h" }, "claude"),
    ).toBe("cd /tmp/work && ANTHROPIC_BASE_URL='http://h' OPENAI_BASE_URL='http://h/v1' claude");
    expect(cliCommand("claude", null, null)).toBe("claude --dangerously-skip-permissions");
  });
});

describe("t3code dry run", () => {
  test("configure plans telemetry, the missing project step and the settings gaps", async () => {
    const runner = fakeRunner("owner");
    setMacosRunner(runner);
    const { ctx, lines } = captureContext({ env: ENV });

    await t3code.configure(ctx, OPTIONS);

    expect(lines).toEqual([
      "plan: setenv T3CODE_TELEMETRY_ENABLED=false",
      `plan: writeFile /tmp/home/.t3/userdata/settings.json ${serverSettings("claude", "claude-opus-5-5", "high")}`,
      "plan: run ~/.t3/bin/t3 project add --title arena /tmp/work",
      "plan: pidsFor bundlePaths=/Applications/T3 Code (Beta).app names=T3 Code (Beta)",
    ]);
    expect(t3CodeState.agent).toBe("claude");
    expect(runner.commands).toEqual([]);
  });

  test("reset, launch, newThread, send, waitDone and quit plan every step", async () => {
    const runner = fakeRunner("owner");
    setMacosRunner(runner);
    const { ctx, lines } = captureContext({ env: ENV });
    await t3code.configure(ctx, OPTIONS);
    lines.length = 0;

    await t3code.reset(ctx);
    expect(lines).toEqual([
      "plan: pidsFor bundlePaths=/Applications/T3 Code (Beta).app names=T3 Code (Beta)",
      "plan: quitApp T3 Code (Beta)",
      "plan: waitGone pids=- timeoutMs=10000",
      "plan: killPids pids=-",
      "plan: pidsFor bundlePaths=- names=t3",
      "plan: moveAside ~/.t3/userdata -> /tmp/home/ademark-aside/t3code/2026-10-19T03-04-05-123Z/userdata",
      "plan: restoreSeed /tmp/home/ademark-private/seeds/t3code/home/.t3/userdata -> /tmp/home/.t3/userdata",
      'plan: setJsonKeys /tmp/home/.t3/userdata/client-settings.json {"sidebarThreadSortOrder":"created_at"}',
      `plan: restoreSnapshot ${SNAPSHOT} (apply)`,
    ]);

    lines.length = 0;
    expect(await t3code.launch(ctx)).toEqual({ pid: 0 });
    expect(lines).toEqual([
      "plan: setenv ANTHROPIC_BASE_URL=http://127.0.0.1:8787",
      "plan: setenv OPENAI_BASE_URL=http://127.0.0.1:8787/v1",
      "plan: setenv T3CODE_TELEMETRY_ENABLED=false",
      "plan: openBundle com.t3tools.t3code",
      "plan: waitForPid bundlePaths=/Applications/T3 Code (Beta).app names=T3 Code (Beta) timeoutMs=30000",
      "plan: window pid=0 size=1600x1000",
      "plan: pause ms=8000",
      "plan: run ~/.t3/bin/t3 app /tmp/work",
      "plan: pause ms=3000",
    ]);

    lines.length = 0;
    await t3code.newThread(ctx);
    expect(lines).toEqual(["plan: press pid=0 combo=cmd+n"]);

    lines.length = 0;
    await t3code.send(ctx, "hi there");
    expect(lines).toEqual(["plan: paste pid=0 text=hi there", "plan: press pid=0 combo=enter"]);

    lines.length = 0;
    expect(await t3code.waitDone(ctx, 120_000)).toEqual({ done: true, reason: "dry run" });
    expect(lines).toEqual(["plan: waitForEndOfTurn agent=claude cwd=/tmp/work timeoutMs=120000"]);

    lines.length = 0;
    await t3code.quit(ctx);
    expect(lines).toEqual([
      "plan: pidsFor bundlePaths=/Applications/T3 Code (Beta).app names=T3 Code (Beta)",
      "plan: quitApp T3 Code (Beta)",
      "plan: waitGone pids=- timeoutMs=10000",
    ]);
    expect(runner.commands).toEqual([]);
    expect(runner.keysCalls).toEqual([]);
    expect(runner.windowCalls).toEqual([]);
  });

  test("timed declares the launch, send and A11 triggers; A3 waits for the pilot's shortcut", () => {
    t3CodeCalibration.newThreadShortcut = null;
    expect(t3code.timed).toEqual({
      launch: [{ kind: "open", bundleId: "com.t3tools.t3code" }],
      newThread: [],
      send: [{ kind: "enter" }],
      longThread: [{ kind: "keys", combo: "cmd+1" }],
      shortThread: [{ kind: "keys", combo: "cmd+2" }],
    });
    t3CodeCalibration.newThreadShortcut = "cmd+n";
    expect(t3code.timed.newThread).toEqual([{ kind: "keys", combo: "cmd+n" }]);
  });
});

describe("real mode guards both adapters", () => {
  const calls: Array<[string, (adapter: Adapter, ctx: AdapterContext) => Promise<unknown>]> = [
    ["reset", (adapter, ctx) => adapter.reset(ctx)],
    ["configure", (adapter, ctx) => adapter.configure(ctx, OPTIONS)],
    ["launch", (adapter, ctx) => adapter.launch(ctx)],
    ["newThread", (adapter, ctx) => adapter.newThread(ctx)],
    ["send", (adapter, ctx) => adapter.send(ctx, "hi")],
    ["waitDone", (adapter, ctx) => adapter.waitDone(ctx, 60_000)],
    ["quit", (adapter, ctx) => adapter.quit(ctx)],
  ];

  for (const adapter of [bareCli, t3code]) {
    test(`${adapter.id} throws for the owner's user before any side effect`, async () => {
      const runner = fakeRunner("owner");
      setMacosRunner(runner);
      const { ctx } = captureContext({ dryRun: false, env: ENV });

      for (const [name, call] of calls) {
        const outcome = await call(adapter, ctx).then(
          () => "resolved",
          (error: Error) => error.message,
        );
        expect({ name, refused: /only the dedicated "ademark" user/.test(outcome) }).toEqual({ name, refused: true });
      }
      expect(runner.commands).toEqual([]);
      expect(runner.keysCalls).toEqual([]);
      expect(runner.windowCalls).toEqual([]);
    });
  }
});

describe("t3code server settings", () => {
  test("pin the model, effort, full access and a worktree from the local branch", () => {
    expect(JSON.parse(serverSettings("claude", "claude-opus-5-5", "high"))).toEqual({
      defaultModelSelection: {
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      },
      defaultRuntimeMode: "full-access",
      defaultThreadEnvMode: "worktree",
      newWorktreesStartFromOrigin: false,
      enableProviderUpdateChecks: false,
      // Titles and branch names on the pinned agent, not the factory Codex that has no account (2026-11-08).
      textGenerationModelSelection: {
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      },
    });
  });

  test("use Codex's instance and effort option for Codex runs", () => {
    const settings = JSON.parse(serverSettings("codex", "gpt-6.1-sol", "high"));
    expect(settings.defaultModelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });
});

describe("zeron dry run", () => {
  test("walks the project path from Home", () => {
    expect(projectSteps("/Users/ademark", "/Users/ademark/arena/zeron")).toEqual(["arena", "zeron"]);
    expect(() => projectSteps("/Users/ademark", "/tmp/arena")).toThrow(/outside it/);
  });

  test("reset, launch with the project, newThread and send plan every step", async () => {
    const runner = fakeRunner("owner");
    setMacosRunner(runner);
    zeronState.project = null;
    const { ctx, lines } = captureContext({ env: ENV, worktree: "/tmp/home/arena/zeron" });

    await zeron.reset(ctx);
    expect(lines).toContain("plan: restoreSeed /tmp/home/ademark-private/seeds/zeron/home/.zeron/profiles/local -> /tmp/home/.zeron/profiles/local");
    expect(lines).toContain('plan: setJsonKeys /tmp/home/.zeron/ui-settings.json {"sidebarSort":"created"}');

    lines.length = 0;
    await zeron.configure(ctx, OPTIONS);
    expect(lines).toEqual(["plan: pidsFor bundlePaths=/Applications/Zeron.app names=zeron"]);

    lines.length = 0;
    await zeron.launch(ctx);
    expect(lines.filter((line) => !line.startsWith("plan: pause"))).toEqual([
      "plan: setenv ANTHROPIC_BASE_URL=http://127.0.0.1:8787",
      "plan: setenv OPENAI_BASE_URL=http://127.0.0.1:8787/v1",
      "plan: openBundle sh.zeron.app",
      "plan: waitForPid bundlePaths=/Applications/Zeron.app names=zeron timeoutMs=30000",
      "plan: window pid=0 size=1600x1000",
      "plan: press pid=0 combo=cmd+shift+n",
      "plan: press pid=0 combo=enter",
      "plan: press pid=0 combo=enter",
      "plan: typeText pid=0 text=arena",
      "plan: press pid=0 combo=enter",
      "plan: typeText pid=0 text=zeron",
      "plan: press pid=0 combo=enter",
      "plan: press pid=0 combo=cmd+enter",
    ]);

    lines.length = 0;
    await zeron.launch(ctx);
    expect(lines.some((line) => line.includes("cmd+shift+n"))).toBe(false);

    lines.length = 0;
    await zeron.newThread(ctx);
    await zeron.send(ctx, "hi");
    expect(lines).toEqual([
      "plan: press pid=0 combo=cmd+n",
      "plan: paste pid=0 text=hi",
      "plan: press pid=0 combo=enter",
    ]);
    expect(runner.commands).toEqual([]);
    expect(runner.keysCalls).toEqual([]);
  });

  test("Codex is a named gap until the model picker is calibrated", async () => {
    const { ctx, lines } = captureContext({ env: {} });
    await zeron.configure(ctx, { ...OPTIONS, agent: "codex" });
    expect(lines[0]).toBe(
      "plan: MISSING codexModel (ADES.md 3.10: Codex model and effort in the model picker; Codex is not signed in yet)",
    );
  });
});

describe("trustClaudeFolder", () => {
  test("marks the folder trusted and keeps the rest of ~/.claude.json", () => {
    setMacosRunner(fakeRunner("ademark"));
    const home = mkdtempSync(join(tmpdir(), "ademark-trust-"));
    try {
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ theme: "dark", projects: { "/a": { x: 1 } } }));
      const { ctx } = captureContext({ dryRun: false, home });
      trustClaudeFolder(ctx, "/Users/ademark/arena/bare-cli-claude");
      trustClaudeFolder(ctx, "/a");
      expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({
        theme: "dark",
        projects: {
          "/a": { x: 1, hasTrustDialogAccepted: true },
          "/Users/ademark/arena/bare-cli-claude": { hasTrustDialogAccepted: true },
        },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("procsUnder", () => {
  test("keeps only matching processes below the root, never the agent session elsewhere", async () => {
    const procs = [
      { pid: 100, ppid: 1, path: "/Applications/Ghostty.app/Contents/MacOS/ghostty", name: "ghostty", responsible_pid: null },
      { pid: 110, ppid: 100, path: "/bin/zsh", name: "zsh", responsible_pid: null },
      { pid: 111, ppid: 110, path: `${CLAUDE_NATIVE_DIR}/2.1.303`, name: "2.1.303", responsible_pid: null },
      { pid: 200, ppid: 1, path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", name: "Terminal", responsible_pid: null },
      { pid: 210, ppid: 200, path: `${CLAUDE_NATIVE_DIR}/2.1.303`, name: "2.1.303", responsible_pid: null },
    ];
    setMacosRunner(fakeRunner("ademark", { procs: async () => procs }));
    const { ctx } = captureContext({ dryRun: false });
    const found = await procsUnder(ctx, 100, { names: ["claude"], bundlePaths: [CLAUDE_NATIVE_DIR] });
    expect(found.map((proc) => proc.pid)).toEqual([111]);
  });
});

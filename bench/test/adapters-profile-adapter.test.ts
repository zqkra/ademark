import { clearGoal } from "../agent/goal.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProfileAdapter, profileAdapter, profileFile, type AdapterBase } from "../adapters/profile.ts";
import { checkAdapter } from "../adapters/check.ts";
import { resetMacosRunner, setMacosRunner } from "../adapters/macos.ts";
import type { RunOptions } from "../core/contracts.ts";
import { validProfile } from "./adapters-profile-fixture.ts";
import { captureContext, fakeRunner } from "./adapters-fake.ts";
import { AGENT_EXECUTABLES } from "../core/agents.ts";

const OPTIONS: RunOptions = { model: "claude-opus-5-5", effort: "high", server: "replay", agent: "claude" };
const SNAPSHOT = "/snapshots/clean";

const BASE: AdapterBase = {
  id: "demo-ade",
  name: "Demo",
  family: "EL-SDK",
  agents: ["claude", "codex"],
  appName: "Demo",
  bundleId: "dev.demo.app",
  drive: "keys",
  dataDirs: ["~/.demo"],
  launchAgents: ["dev.demo.ShipIt"],
  vendorDirs: ["~/.demo"],
};

let dir = "";
let savedProfiles: string | undefined;
let savedSnapshot: string | undefined;

beforeEach(() => {
  savedProfiles = process.env.ADEMARK_PROFILES;
  savedSnapshot = process.env.ADEMARK_SNAPSHOT;
  dir = mkdtempSync(join(tmpdir(), "ademark-profile-adapter-"));
  process.env.ADEMARK_PROFILES = dir;
  process.env.ADEMARK_SNAPSHOT = SNAPSHOT;
  resetMacosRunner();
  setMacosRunner(fakeRunner("owner"));
});

afterEach(() => {
  if (savedProfiles === undefined) delete process.env.ADEMARK_PROFILES;
  else process.env.ADEMARK_PROFILES = savedProfiles;
  if (savedSnapshot === undefined) delete process.env.ADEMARK_SNAPSHOT;
  else process.env.ADEMARK_SNAPSHOT = savedSnapshot;
  rmSync(dir, { recursive: true, force: true });
});

function writeProfile(): void {
  const profile = validProfile();
  profile.app.path = "/Applications/Demo Pro.app";
  writeFileSync(profileFile(BASE.id), JSON.stringify(profile));
}

describe("profileAdapter without a profile", () => {
  test("behaves like the old stub and has no login", async () => {
    const adapter = profileAdapter(BASE);
    expect(isProfileAdapter(adapter)).toBe(true);
    expect(adapter.id).toBe("demo-ade");
    expect(adapter.calibration).toEqual({
      appName: "Demo",
      bundleId: "dev.demo.app",
      composerRect: null,
      threadRect: null,
      focusClick: null,
      masks: [],
      drive: "keys",
      dataDirs: ["~/.demo"],
      launchAgents: ["dev.demo.ShipIt"],
    });
    expect(adapter.login).toBeUndefined();
    expect(adapter.timed).toEqual({ launch: [], newThread: [], send: [] });
    expect(adapter.processes()).toEqual({
      bundlePaths: ["/Applications/Demo.app"],
      vendorDirs: ["~/.demo"],
      launchAgentLabels: ["dev.demo.ShipIt"],
      teamId: null,
      agentExecutables: [...AGENT_EXECUTABLES],
    });

    const { ctx } = captureContext();
    await expect(adapter.reset(ctx)).rejects.toThrow("not calibrated: reset");
    await expect(adapter.configure(ctx, OPTIONS)).rejects.toThrow("not calibrated: configure");
    await expect(adapter.launch(ctx)).rejects.toThrow("not calibrated: launch");
    await expect(adapter.newThread(ctx)).rejects.toThrow("not calibrated: newThread");
    await expect(adapter.send(ctx, "hi")).rejects.toThrow("not calibrated: send");
    await expect(adapter.waitDone(ctx, 1000)).rejects.toThrow("not calibrated: waitDone");
    await expect(adapter.quit(ctx)).rejects.toThrow("not calibrated: quit");
  });
});

describe("profileAdapter with a profile, dry run", () => {
  test("calibration, login, timed, orchestration and processes come from the profile", () => {
    writeProfile();
    const adapter = profileAdapter(BASE);
    expect(adapter.calibration.composerRect).toEqual({ x: 600, y: 800, w: 400, h: 100 });
    expect(adapter.login).toEqual({
      kind: "app",
      files: ["~/.demo/login.json"],
      signIn: "Sign in with the demo account",
    });
    expect(adapter.timed.send).toEqual([{ kind: "enter" }]);
    expect(adapter.orchestrationTrigger).toBeNull();
    expect(adapter.processes().bundlePaths).toEqual(["/Applications/Demo Pro.app"]);
    expect(adapter.processes().vendorDirs).toEqual(["~/.demo"]);
  });

  test("an orchestration trigger that is not calibrated is undefined, never null", () => {
    const profile = validProfile();
    profile.orchestrationTrigger = { notCalibrated: "ADES.md says it orchestrates; no trigger line proven" };
    writeFileSync(profileFile(BASE.id), JSON.stringify(profile));
    const adapter = profileAdapter(BASE);
    // The profile loaded (the calibration is its own), so undefined comes from the object, not from a rejected file.
    expect(adapter.calibration.composerRect).toEqual({ x: 600, y: 800, w: 400, h: 100 });
    expect(adapter.orchestrationTrigger).toBeUndefined();
  });

  test("returnToThread exists only with calibrated steps, and runs them", async () => {
    writeProfile();
    expect(profileAdapter(BASE).returnToThread).toBeUndefined();
    const profile = validProfile();
    profile.steps.returnToThread = [{ kind: "keys", combo: "cmd+1" }];
    writeFileSync(profileFile(BASE.id), JSON.stringify(profile));
    const adapter = profileAdapter(BASE);
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/demo" });
    await adapter.returnToThread!(ctx);
    expect(lines.some((line) => line.includes("combo=cmd+1"))).toBe(true);
  });

  // 2026-11-11: super.engineering ships its orchestration switched off, and its seed restores that before every block.
  test("prepareOrchestration exists only with settings, and sets each one; workers come from the profile", async () => {
    writeProfile();
    expect(profileAdapter(BASE).prepareOrchestration).toBeUndefined();
    expect(profileAdapter(BASE).orchestrationWorkers).toBeUndefined();
    const profile = validProfile();
    profile.orchestration = { settings: [{ file: "~/.demo/settings.json", path: ["experimental", "agent_orchestration"], value: true }], workers: "sessions" };
    writeFileSync(profileFile(BASE.id), JSON.stringify(profile));
    const adapter = profileAdapter(BASE);
    expect(adapter.orchestrationWorkers).toBe("sessions");
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/demo" });
    await adapter.prepareOrchestration!(ctx);
    expect(lines).toEqual(["plan: setJsonPath /tmp/home/.demo/settings.json experimental.agent_orchestration true"]);
  });

  test("the real profiles: super.engineering switches Agent orchestration on, and four ADEs need workers of their own", () => {
    const real = (id: string) => JSON.parse(readFileSync(join(import.meta.dir, "..", "adapters", "profiles", `${id}.json`), "utf8")) as { orchestration?: unknown };
    expect(real("super-engineering").orchestration).toEqual({
      settings: [{ file: "~/.super.engineering/settings.json", path: ["experimental", "agent_orchestration"], value: true }],
      workers: "sessions",
    });
    for (const id of ["bb", "cloudroom", "orca"]) expect(real(id).orchestration).toEqual({ workers: "sessions" });
    // Synara's workers are subagents and threads, and Capy's are its own: no such rule there.
    for (const id of ["synara", "capy"]) expect(real(id).orchestration).toBeUndefined();
  });

  test("reset quits, keeps the login files, moves data aside and restores the login", async () => {
    writeProfile();
    const adapter = profileAdapter(BASE);
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/demo" });

    await adapter.reset(ctx);

    expect(lines).toEqual([
      "plan: pidsFor bundlePaths=/Applications/Demo Pro.app names=Demo",
      "plan: quitApp Demo",
      "plan: waitGone pids=- timeoutMs=10000",
      "plan: killPids pids=-",
      "plan: keepLogin ~/.demo/login.json",
      "plan: moveAside ~/.demo -> /tmp/home/ademark-aside/demo-ade/2026-10-19T03-04-05-123Z/.demo",
      "plan: restoreLogin ~/.demo/login.json",
      "plan: restoreSeed /tmp/home/ademark-private/seeds/demo-ade/home/.demo -> /tmp/home/.demo",
      'plan: setJsonKeys /tmp/home/.demo/settings.json {"sidebarSort":"created"}',
      "plan: bootout gui/501/dev.demo.ShipIt",
      "plan: restoreSnapshot /snapshots/clean (apply)",
    ]);
    expect(lines.indexOf("plan: keepLogin ~/.demo/login.json")).toBeLessThan(
      lines.indexOf("plan: moveAside ~/.demo -> /tmp/home/ademark-aside/demo-ade/2026-10-19T03-04-05-123Z/.demo"),
    );
    expect(lines.indexOf("plan: restoreLogin ~/.demo/login.json")).toBeGreaterThan(
      lines.indexOf("plan: moveAside ~/.demo -> /tmp/home/ademark-aside/demo-ade/2026-10-19T03-04-05-123Z/.demo"),
    );
  });

  test("configure with the app closed waits for launch", async () => {
    writeProfile();
    const adapter = profileAdapter(BASE);
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/demo" });

    await adapter.configure(ctx, OPTIONS);
    expect(lines).toEqual(["plan: pidsFor bundlePaths=/Applications/Demo Pro.app names=Demo"]);

    lines.length = 0;
    await adapter.launch(ctx);
    expect(lines).toEqual([
      "plan: openBundle dev.demo.app",
      "plan: waitForPid bundlePaths=/Applications/Demo Pro.app names=Demo timeoutMs=30000",
      "plan: window pid=0 size=1600x1000",
      "plan: press pid=0 combo=enter",
      `plan: goal pid=0 goal=${clearGoal("Demo")}`,
      "plan: run demo config --model claude-opus-5-5 timeoutMs=30000",
      "plan: press pid=0 combo=cmd+shift+p",
      "plan: press pid=0 combo=cmd+shift+n",
      "plan: typeText pid=0 text=/tmp/home/arena/demo",
      "plan: press pid=0 combo=enter",
    ]);
  });

  test("configure with the app open runs the agent's steps at once", async () => {
    writeProfile();
    const adapter = profileAdapter(BASE);
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/demo" });

    await adapter.launch(ctx);
    lines.length = 0;
    await adapter.configure(ctx, OPTIONS);

    expect(lines).toEqual([
      "plan: pidsFor bundlePaths=/Applications/Demo Pro.app names=Demo",
      "plan: run demo config --model claude-opus-5-5 timeoutMs=30000",
      "plan: press pid=0 combo=cmd+shift+p",
    ]);
  });

  test("configure rejects an agent the adapter does not run", async () => {
    writeProfile();
    const adapter = profileAdapter(BASE);
    const { ctx } = captureContext();
    await expect(adapter.configure(ctx, { ...OPTIONS, agent: "own" })).rejects.toThrow(
      "Demo runs claude and codex only",
    );
  });

  test("launch opens the bundle, resizes and adds the project", async () => {
    writeProfile();
    const adapter = profileAdapter(BASE);
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/demo" });

    expect(await adapter.launch(ctx)).toEqual({ pid: 0 });

    expect(lines).toEqual([
      "plan: openBundle dev.demo.app",
      "plan: waitForPid bundlePaths=/Applications/Demo Pro.app names=Demo timeoutMs=30000",
      "plan: window pid=0 size=1600x1000",
      "plan: press pid=0 combo=enter",
      `plan: goal pid=0 goal=${clearGoal("Demo")}`,
      "plan: press pid=0 combo=cmd+shift+n",
      "plan: typeText pid=0 text=/tmp/home/arena/demo",
      "plan: press pid=0 combo=enter",
    ]);

    // Every launch clears the window; the full rehearsal runs only with ADEMARK_AGENT_REHEARSE=on.
    lines.length = 0;
    await adapter.launch(ctx);
    expect(lines).toContain(`plan: goal pid=0 goal=${clearGoal("Demo")}`);
    expect(lines.some((line) => line.startsWith("plan: rehearse"))).toBe(false);

    lines.length = 0;
    await adapter.launch(ctx);
    expect(lines.some((line) => line.includes("cmd+shift+n"))).toBe(false);
  });

  test("a relaunch after quit keeps the open project", async () => {
    writeProfile();
    const adapter = profileAdapter(BASE);
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/demo" });

    await adapter.launch(ctx);
    await adapter.quit(ctx);
    await adapter.launch(ctx);

    expect(lines.filter((line) => line.includes("cmd+shift+n"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("typeText pid=0 text=/tmp/home/arena/demo"))).toHaveLength(1);
  });

  test("newThread, send, waitDone and quit plan their steps", async () => {
    writeProfile();
    const adapter = profileAdapter(BASE);
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/demo" });

    await adapter.newThread(ctx);
    // The 1.5 s settle after a new thread is setup only: the stopwatch runs the triggers itself.
    expect(lines).toEqual(["plan: press pid=0 combo=cmd+n", "plan: pause ms=200", "plan: pause ms=1500"]);

    lines.length = 0;
    await adapter.send(ctx, "hi there");
    expect(lines).toEqual(["plan: paste pid=0 text=hi there", "plan: press pid=0 combo=enter"]);

    lines.length = 0;
    expect(await adapter.waitDone(ctx, 60_000)).toEqual({ done: true, reason: "dry run" });
    expect(lines).toEqual(["plan: waitForEndOfTurn agent=claude cwd=/tmp/home/arena/demo timeoutMs=60000"]);

    lines.length = 0;
    await adapter.quit(ctx);
    expect(lines).toEqual([
      "plan: pidsFor bundlePaths=/Applications/Demo Pro.app names=Demo",
      "plan: quitApp Demo",
      "plan: waitGone pids=- timeoutMs=10000",
    ]);
  });

  test("beforeQuit runs the profile's list for A2 or A1, and nothing when the list is missing", async () => {
    const profile = validProfile();
    profile.app.path = "/Applications/Demo Pro.app";
    profile.steps.beforeRelaunchQuit = [{ kind: "run", argv: ["/Applications/Demo.app/bin/demo", "close", "${worktree}"], timeoutMs: 1000 }];
    profile.steps.beforeColdQuit = [{ kind: "keys", combo: "cmd+alt+t" }];
    writeFileSync(profileFile(BASE.id), JSON.stringify(profile));
    const adapter = profileAdapter(BASE);
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/demo" });
    await adapter.beforeQuit!(ctx, "relaunch");
    expect(lines).toEqual(["plan: run /Applications/Demo.app/bin/demo close /tmp/home/arena/demo timeoutMs=1000"]);
    lines.length = 0;
    await adapter.beforeQuit!(ctx, "cold");
    expect(lines).toEqual(["plan: press pid=0 combo=cmd+alt+t"]);

    writeProfile();
    lines.length = 0;
    const plain = profileAdapter(BASE);
    await plain.beforeQuit!(ctx, "relaunch");
    await plain.beforeQuit!(ctx, "cold");
    expect(lines).toEqual([]);
  });

  test("blankRelaunchMs plans one window read after the resize, and a profile without it reads nothing", async () => {
    const profile = validProfile();
    profile.app.path = "/Applications/Demo Pro.app";
    profile.blankRelaunchMs = 5000;
    writeFileSync(profileFile(BASE.id), JSON.stringify(profile));
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/demo" });
    await profileAdapter(BASE).launch(ctx);
    const resize = lines.indexOf("plan: window pid=0 size=1600x1000");
    expect(lines.slice(resize + 1, resize + 3)).toEqual(["plan: pause ms=5000", "plan: windowText pid=0 label=blank-check-demo-ade"]);

    writeProfile();
    const plain = captureContext({ worktree: "/tmp/home/arena/demo" });
    await profileAdapter(BASE).launch(plain.ctx);
    expect(plain.lines.some((line) => line.includes("windowText"))).toBe(false);
  });

  test("a whole client block runs through every method in a dry run", async () => {
    writeProfile();
    const adapter = profileAdapter(BASE);
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/demo" });

    await adapter.reset(ctx);
    await adapter.configure(ctx, OPTIONS);
    expect(await adapter.launch(ctx)).toEqual({ pid: 0 });
    await adapter.newThread(ctx);
    await adapter.send(ctx, "hi there");
    expect(await adapter.waitDone(ctx, 60_000)).toEqual({ done: true, reason: "dry run" });
    await adapter.quit(ctx);

    expect(lines.filter((line) => line.includes("keepLogin"))).toEqual(["plan: keepLogin ~/.demo/login.json"]);
    expect(lines.filter((line) => line.includes("restoreLogin"))).toEqual(["plan: restoreLogin ~/.demo/login.json"]);
    expect(lines.filter((line) => line.includes("cmd+shift+n"))).toHaveLength(1);
    expect(lines).toContain("plan: press pid=0 combo=cmd+n");
    expect(lines).toContain("plan: paste pid=0 text=hi there");
    expect(lines).toContain("plan: waitForEndOfTurn agent=claude cwd=/tmp/home/arena/demo timeoutMs=60000");
    expect(lines.at(-1)).toBe("plan: waitGone pids=- timeoutMs=10000");
  });

  test("adapter check counts the profile's calibration fields", async () => {
    writeProfile();
    const result = await checkAdapter(BASE.id, profileAdapter(BASE));
    expect(result.errors).toEqual([]);
    expect(result.filled).toBe(12);
    expect(result.fields.find((field) => field.key === "composerRect")?.filled).toBe(true);
  });

  test("adapter check reports a broken profile with its paths", async () => {
    writeFileSync(profileFile(BASE.id), JSON.stringify({ schema: 2, ade: BASE.id }));
    const result = await checkAdapter(BASE.id, profileAdapter(BASE));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("schema: must be 1");
    expect(result.errors).toContain("calibration: must be an object");
  });

  test("a real reset refuses the owner's user", async () => {
    writeProfile();
    const adapter = profileAdapter(BASE);
    const { ctx } = captureContext({ dryRun: false, home: dir });
    await expect(adapter.reset(ctx)).rejects.toThrow('only the dedicated "ademark" user');
  });
});

describe("blankRelaunchMs on a real launch (Conductor, 8 Nov)", () => {
  let savedAgent: string | undefined;
  beforeEach(() => {
    savedAgent = process.env.ADEMARK_AGENT;
    process.env.ADEMARK_AGENT = "off";
  });
  afterEach(() => {
    if (savedAgent === undefined) delete process.env.ADEMARK_AGENT;
    else process.env.ADEMARK_AGENT = savedAgent;
    resetMacosRunner();
  });

  async function launchWith(reads: Array<string[] | Error>): Promise<{ opens: number; log: string[] }> {
    const profile = validProfile();
    profile.app.path = "/Applications/Demo Pro.app";
    profile.blankRelaunchMs = 5000;
    writeFileSync(profileFile(BASE.id), JSON.stringify(profile));
    let alive = false;
    let opens = 0;
    let read = 0;
    setMacosRunner(
      fakeRunner("ademark", {
        run: (argv) => {
          if (argv[0] === "open") {
            alive = true;
            opens += 1;
          }
          if (argv[0] === "osascript") alive = false;
          return { code: 0, stdout: "", stderr: "" };
        },
        procs: async () =>
          alive ? [{ pid: 900, ppid: 1, path: "/Applications/Demo Pro.app/Contents/MacOS/Demo", name: "Demo", responsible_pid: null }] : [],
        ocr: async () => {
          const next = reads[Math.min(read++, reads.length - 1)]!;
          if (next instanceof Error) throw next;
          return { lines: next };
        },
      }),
    );
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/demo", dryRun: false, runDir: dir });
    await profileAdapter(BASE).launch(ctx);
    return { opens, log: lines };
  }

  test("a window with no text is quit and launched once more, and only once", async () => {
    const result = await launchWith([[], []]);
    expect(result.opens).toBe(2);
    expect(result.log.filter((line) => line.includes("showed no text 5000 ms after launch"))).toHaveLength(1);
  });

  test("a window with text is launched once", async () => {
    expect((await launchWith([["Home", "Open project"]])).opens).toBe(1);
  });

  test("a failed read never relaunches", async () => {
    const result = await launchWith([new Error("audio/video capture failure")]);
    expect(result.opens).toBe(1);
    expect(result.log.join(" ")).toContain("blank check not read");
  });
});

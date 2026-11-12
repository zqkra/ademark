import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootout,
  killPids,
  moveAside,
  openBundle,
  paste,
  pickMainProc,
  pidsFor,
  press,
  procsFor,
  quitApp,
  resetMacosRunner,
  resizeWindow,
  runsUnder,
  setMacosRunner,
  setenv,
  typeText,
  unsetenv,
  utcStamp,
  waitForPid,
  waitForText,
  waitGone,
} from "../adapters/macos.ts";
import { captureContext, FIXED_NOW, fakeRunner } from "./adapters-fake.ts";

afterEach(() => {
  resetMacosRunner();
});

describe("process tree", () => {
  const proc = (pid: number, ppid: number, path: string) => ({ pid, ppid, path, name: path.split("/").pop()!, responsible_pid: null });

  test("the main process is the newest launchd child running the bundle's Contents/MacOS executable", () => {
    const hints = { bundlePaths: ["/Applications/Zeron.app"], names: ["zeron"] };
    const procs = [
      proc(100, 1, "/Applications/Traycer.app/Contents/Library/LaunchAgents/Host.app/Contents/MacOS/traycer"),
      proc(200, 150, "/Applications/Zeron.app/Contents/MacOS/zeron"),
      proc(300, 1, "/Applications/Zeron.app/Contents/MacOS/zeron"),
      proc(310, 300, "/Applications/Zeron.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper"),
      proc(400, 1, "/Applications/Zeron.app/Contents/MacOS/zeron"),
    ];
    expect(pickMainProc(procs, hints)?.pid).toBe(400);
    expect(pickMainProc(procs.slice(0, 2), hints)).toBeNull();
  });

  test("runsUnder reads a parent the user cannot list (root /usr/bin/login) with ps", async () => {
    const runner = fakeRunner("ademark", {
      procs: async () => [proc(8401, 1, "/Applications/Ghostty.app/Contents/MacOS/ghostty"), proc(8404, 8403, "/bin/zsh"), proc(9000, 8404, "/opt/homebrew/bin/bun")],
      run: (argv) => ({ code: 0, stdout: argv.join(" ") === "ps -o ppid= -p 8403" ? "  8401\n" : "", stderr: "" }),
    });
    setMacosRunner(runner);
    const { ctx } = captureContext({ dryRun: false });
    expect(await runsUnder(ctx, 8401, 9000)).toBe(true);
    expect(await runsUnder(ctx, 8401, 8401)).toBe(false);
  });
});

describe("macOS side effects, dry run", () => {
  test("every function logs its plan line and runs nothing", async () => {
    const runner = fakeRunner("tester");
    setMacosRunner(runner);
    const { ctx, lines } = captureContext({ home: "/home/ademark" });

    setenv(ctx, "T3CODE_TELEMETRY_ENABLED", "false");
    unsetenv(ctx, "ANTHROPIC_BASE_URL");
    openBundle(ctx, "com.t3tools.t3code");
    quitApp(ctx, "T3 Code (Beta)");
    bootout(ctx, "dev.bb.desktop.ShipIt");
    await waitGone(ctx, [10, 11], 10_000);
    killPids(ctx, [12, 13]);
    moveAside(ctx, "t3code", ["~/.t3/userdata"]);
    await paste(ctx, 42, "hi");
    await press(ctx, 42, "cmd+n");
    await press(ctx, 42, "enter");
    await typeText(ctx, 42, "claude --version");
    await resizeWindow(ctx, 42, { w: 1600, h: 1000 });
    await pidsFor(ctx, { bundlePaths: ["/Applications/Ghostty.app"] });
    await procsFor(ctx, { names: ["claude", "codex"] });
    await waitForPid(ctx, { names: ["T3 Code (Beta)"] }, 30_000);

    expect(lines).toEqual([
      "plan: setenv T3CODE_TELEMETRY_ENABLED=false",
      "plan: unsetenv ANTHROPIC_BASE_URL",
      "plan: openBundle com.t3tools.t3code",
      "plan: quitApp T3 Code (Beta)",
      "plan: bootout gui/501/dev.bb.desktop.ShipIt",
      "plan: waitGone pids=10,11 timeoutMs=10000",
      "plan: killPids pids=12,13",
      `plan: moveAside ~/.t3/userdata -> /home/ademark/ademark-aside/t3code/${utcStamp(FIXED_NOW)}/userdata`,
      "plan: paste pid=42 text=hi",
      "plan: press pid=42 combo=cmd+n",
      "plan: press pid=42 combo=enter",
      "plan: typeText pid=42 text=claude --version",
      "plan: window pid=42 size=1600x1000",
      "plan: pidsFor bundlePaths=/Applications/Ghostty.app names=-",
      "plan: procsFor bundlePaths=- names=claude,codex",
      "plan: waitForPid bundlePaths=- names=T3 Code (Beta) timeoutMs=30000",
    ]);
    expect(runner.commands).toEqual([]);
    expect(runner.keysCalls).toEqual([]);
    expect(runner.windowCalls).toEqual([]);
  });

  test("utcStamp is a sortable UTC folder name", () => {
    expect(utcStamp(FIXED_NOW)).toBe("2026-10-19T03-04-05-123Z");
  });
});

describe("macOS side effects, real mode", () => {
  test("refuses before the first command when the user is not ademark", async () => {
    const runner = fakeRunner("owner");
    setMacosRunner(runner);
    const { ctx } = captureContext({ dryRun: false });

    expect(() => setenv(ctx, "A", "1")).toThrow(/only the dedicated "ademark" user/);
    expect(() => unsetenv(ctx, "A")).toThrow(/ademark/);
    expect(() => openBundle(ctx, "com.t3tools.t3code")).toThrow(/ademark/);
    expect(() => quitApp(ctx, "T3 Code (Beta)")).toThrow(/ademark/);
    expect(() => bootout(ctx, "label")).toThrow(/ademark/);
    expect(() => killPids(ctx, [1])).toThrow(/ademark/);
    expect(() => moveAside(ctx, "t3code", ["~/.t3/userdata"])).toThrow(/ademark/);
    await expect(waitGone(ctx, [1], 10)).rejects.toThrow(/ademark/);
    await expect(paste(ctx, 1, "hi")).rejects.toThrow(/ademark/);
    await expect(press(ctx, 1, "cmd+v")).rejects.toThrow(/ademark/);
    await expect(typeText(ctx, 1, "hi")).rejects.toThrow(/ademark/);
    await expect(resizeWindow(ctx, 1, { w: 1600, h: 1000 })).rejects.toThrow(/ademark/);
    await expect(waitForPid(ctx, { names: ["x"] }, 10)).rejects.toThrow(/ademark/);

    expect(runner.commands).toEqual([]);
    expect(runner.keysCalls).toEqual([]);
    expect(runner.windowCalls).toEqual([]);
  });

  test("runs the documented commands as the ademark user", async () => {
    const runner = fakeRunner("ademark");
    setMacosRunner(runner);
    const { ctx } = captureContext({ dryRun: false });

    setenv(ctx, "T3CODE_TELEMETRY_ENABLED", "false");
    unsetenv(ctx, "ANTHROPIC_BASE_URL");
    openBundle(ctx, "com.t3tools.t3code");
    quitApp(ctx, "T3 Code (Beta)");
    bootout(ctx, "dev.bb.desktop.ShipIt");
    killPids(ctx, [12, 13]);
    await paste(ctx, 42, "hi");
    await press(ctx, 42, "enter");
    await typeText(ctx, 42, "claude");
    await resizeWindow(ctx, 42, { w: 1600, h: 1000 });
    const gone = await waitGone(ctx, [12, 13], 10_000);

    expect(gone).toEqual([]);
    expect(runner.commands).toEqual([
      ["launchctl", "setenv", "T3CODE_TELEMETRY_ENABLED", "false"],
      ["launchctl", "unsetenv", "ANTHROPIC_BASE_URL"],
      ["open", "-b", "com.t3tools.t3code"],
      ["osascript", "-e", "with timeout of 5 seconds", "-e", 'quit app "T3 Code (Beta)"', "-e", "end timeout"],
      ["launchctl", "bootout", "gui/501/dev.bb.desktop.ShipIt"],
      ["kill", "-9", "12"],
      ["kill", "-9", "13"],
      ["pbcopy"],
    ]);
    expect(runner.inputs[7]).toEqual(new TextEncoder().encode("hi"));
    expect(runner.keysCalls).toEqual([{ pid: 42, combo: "cmd+v" }, { pid: 42, enter: true }, { pid: 42, text: "claude" }]);
    expect(runner.windowCalls).toEqual([{ pid: 42, size: { w: 1600, h: 1000 }, front: true }]);
  });

  test("moveAside moves a folder aside and never deletes its data", () => {
    const home = mkdtempSync(join(tmpdir(), "ademark-home-"));
    try {
      const source = join(home, ".t3", "userdata");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "state.sqlite"), "seed");
      setMacosRunner(fakeRunner("ademark"));
      const { ctx } = captureContext({ dryRun: false, home });

      moveAside(ctx, "t3code", ["~/.t3/userdata"]);

      const target = join(home, "ademark-aside", "t3code", utcStamp(FIXED_NOW), "userdata");
      expect(readFileSync(join(target, "state.sqlite"), "utf8")).toBe("seed");
      expect(() => readFileSync(join(source, "state.sqlite"))).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("pidsFor matches a bundle path or an executable name", async () => {
    setMacosRunner(
      fakeRunner("ademark", {
        procs: async () => [
          { pid: 1, ppid: 0, path: "/Applications/Ghostty.app/Contents/MacOS/ghostty", name: "ghostty", responsible_pid: null },
          { pid: 2, ppid: 1, path: "/Users/ademark/.local/bin/claude", name: "claude", responsible_pid: null },
          { pid: 3, ppid: 1, path: "/usr/bin/zsh", name: "zsh", responsible_pid: null },
        ],
      }),
    );
    const { ctx } = captureContext({ dryRun: false });
    expect(await pidsFor(ctx, { bundlePaths: ["/Applications/Ghostty.app"] })).toEqual([1]);
    expect(await pidsFor(ctx, { names: ["claude"] })).toEqual([2]);
    expect(await procsFor(ctx, { names: ["claude", "zsh"] })).toHaveLength(2);
  });
});

describe("waitForText evidence", () => {
  const region = { x: 1, y: 2, w: 3, h: 4 };
  const writer = (seen: boolean, shots: string[], framesSeen: string[]) =>
    fakeRunner("ademark", {
      watch: async (options) => {
        framesSeen.push(options.frames);
        writeFileSync(options.frames, '{"frames":[]}');
        return seen ? { seen_ns: 5, timed_out: false } : { seen_ns: null, timed_out: true };
      },
      screenshot: async (options) => {
        shots.push(options.out);
        writeFileSync(options.out, "png");
        return { path: options.out };
      },
    });

  test("a failed wait moves its frames and a screenshot into <runDir>/waits/ and names both", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "ademark-waits-"));
    const shots: string[] = [];
    const frames: string[] = [];
    setMacosRunner(writer(false, shots, frames));
    const { ctx } = captureContext({ dryRun: false, runDir });
    let message = "";
    try {
      await waitForText(ctx, 42, region, "One-click", 5);
    } catch (error) {
      message = (error as Error).message;
    }
    const stem = `${utcStamp(FIXED_NOW)}-One-click`;
    const kept = join(runDir, "waits", `${stem}-frames.json`);
    const shot = join(runDir, "waits", `${stem}.png`);
    expect(message).toBe(`"One-click" did not show within 5 s (frames ${kept}, screenshot ${shot})`);
    expect(readFileSync(kept, "utf8")).toBe('{"frames":[]}');
    expect(shots).toEqual([shot]);
    expect(() => readFileSync(frames[0]!)).toThrow();
    rmSync(runDir, { recursive: true, force: true });
  });

  test("without a run folder the frames stay in the temp folder and the error says where", async () => {
    const frames: string[] = [];
    setMacosRunner(writer(false, [], frames));
    const { ctx } = captureContext({ dryRun: false, runDir: "" });
    await expect(waitForText(ctx, 42, region, "Full", 5)).rejects.toThrow(`frames kept at ${frames[0]}, no run folder`);
    expect(readFileSync(frames[0]!, "utf8")).toBe('{"frames":[]}');
    rmSync(frames[0]!, { force: true });
  });

  test("a wait that sees its text deletes the frames and takes no screenshot", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "ademark-waits-"));
    const shots: string[] = [];
    const frames: string[] = [];
    setMacosRunner(writer(true, shots, frames));
    const { ctx } = captureContext({ dryRun: false, runDir });
    await waitForText(ctx, 42, region, "One-click", 5);
    expect(() => readFileSync(frames[0]!)).toThrow();
    expect(shots).toEqual([]);
    expect(() => readFileSync(join(runDir, "waits"))).toThrow();
    rmSync(runDir, { recursive: true, force: true });
  });
});

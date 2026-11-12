import { afterEach, describe, expect, test } from "bun:test";
import { resetMacosRunner, setMacosRunner } from "../adapters/macos.ts";
import { synara } from "../adapters/synara.ts";
import type { NativeProc } from "../core/contracts.ts";
import { captureContext, fakeRunner } from "./adapters-fake.ts";

afterEach(() => resetMacosRunner());

function proc(pid: number, ppid: number, path: string): NativeProc {
  return { pid, ppid, path, name: path.split("/").pop()!, responsible_pid: null };
}

// 2026-11-10: the quit event opens Synara's in-app "Quit Synara?" modal, so A2 failed 6 of 6 and A9 found the app alive.
describe("Synara quits with TERM to its main process (ADEMARK-53)", () => {
  test("the TERM goes to the main Synara before the profile quit's quit event", async () => {
    const main = proc(500, 1, "/Applications/Synara.app/Contents/MacOS/Synara");
    const server = proc(501, 500, "/Applications/Synara.app/Contents/MacOS/Synara");
    let alive = [main, server];
    const runner = fakeRunner("ademark", {
      procs: async () => alive,
      run: (argv) => {
        runner.commands.push(argv);
        if (argv[0] === "kill") alive = [];
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    setMacosRunner(runner);
    const { ctx } = captureContext({ dryRun: false });
    await synara.quit(ctx);
    const kill = runner.commands.findIndex((argv) => argv[0] === "kill");
    const quitEvent = runner.commands.findIndex((argv) => argv[0] === "osascript");
    expect(runner.commands[kill]).toEqual(["kill", "-TERM", "500"]);
    expect(kill).toBeGreaterThanOrEqual(0);
    expect(quitEvent).toBeGreaterThan(kill);
    expect(runner.commands.some((argv) => argv.includes("-9"))).toBe(false);
  });

  test("an app already gone gets no signal", async () => {
    const runner = fakeRunner("ademark");
    setMacosRunner(runner);
    const { ctx } = captureContext({ dryRun: false });
    await synara.quit(ctx);
    expect(runner.commands.some((argv) => argv[0] === "kill")).toBe(false);
  });

  test("a main process that exits before the signal is not an error", async () => {
    // Listed once, gone by the time of the kill.
    let listings = 0;
    const runner = fakeRunner("ademark", {
      procs: async () => (listings++ === 0 ? [proc(500, 1, "/Applications/Synara.app/Contents/MacOS/Synara")] : []),
      run: (argv) =>
        argv[0] === "kill"
          ? { code: 1, stdout: "", stderr: "kill: 500: No such process" }
          : { code: 0, stdout: "", stderr: "" },
    });
    setMacosRunner(runner);
    const { ctx } = captureContext({ dryRun: false });
    await expect(synara.quit(ctx)).resolves.toBeUndefined();
  });
});

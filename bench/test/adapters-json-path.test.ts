// setJsonPath: one nested value in an app's JSON settings file (bench/adapters/macos.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "../core/contracts.ts";
import { resetMacosRunner, setJsonPath, setMacosRunner } from "../adapters/macos.ts";
import { fakeRunner } from "./adapters-fake.ts";

let home: string;
let lines: string[];
const ctx = (dryRun = false): AdapterContext => ({ runDir: home, arenaPath: home, worktree: home, home, env: {}, dryRun, log: (line) => lines.push(line) });
// The shape of super.engineering's settings.json (2026-11-11, the seed of the bench account).
const SETTINGS = { default_tool: "claude_code", experimental: { review: false, agent_orchestration: false, automations: false }, telemetry: false };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ademark-json-path-"));
  lines = [];
  mkdirSync(join(home, ".super.engineering"));
  writeFileSync(join(home, ".super.engineering", "settings.json"), JSON.stringify(SETTINGS), { mode: 0o600 });
  setMacosRunner(fakeRunner("ademark"));
});
afterEach(() => {
  resetMacosRunner();
  rmSync(home, { recursive: true, force: true });
});

const read = (): typeof SETTINGS => JSON.parse(readFileSync(join(home, ".super.engineering", "settings.json"), "utf8")) as typeof SETTINGS;

describe("setJsonPath", () => {
  test("sets the nested value and keeps every other key and the file mode", () => {
    setJsonPath(ctx(), "~/.super.engineering/settings.json", ["experimental", "agent_orchestration"], true);
    expect(read()).toEqual({ ...SETTINGS, experimental: { ...SETTINGS.experimental, agent_orchestration: true } });
    expect(statSync(join(home, ".super.engineering", "settings.json")).mode & 0o777).toBe(0o600);
    expect(lines.at(-1)).toContain("experimental.agent_orchestration");
  });

  test("a key the file does not have stops with a reason: a renamed setting is never passed over", () => {
    expect(() => setJsonPath(ctx(), "~/.super.engineering/settings.json", ["experimental", "orchestration"], true)).toThrow("no experimental.orchestration in");
    expect(() => setJsonPath(ctx(), "~/.super.engineering/settings.json", ["labs", "agent_orchestration"], true)).toThrow("no labs.agent_orchestration in");
    expect(() => setJsonPath(ctx(), "~/.super.engineering/missing.json", ["a"], true)).toThrow("cannot be read");
    expect(read()).toEqual(SETTINGS);
  });

  test("a dry run plans it and writes nothing; another account writes nothing", () => {
    setJsonPath(ctx(true), "~/.super.engineering/settings.json", ["experimental", "agent_orchestration"], true);
    expect(lines).toEqual([`plan: setJsonPath ${home}/.super.engineering/settings.json experimental.agent_orchestration true`]);
    setMacosRunner(fakeRunner("owner"));
    expect(() => setJsonPath(ctx(), "~/.super.engineering/settings.json", ["experimental", "agent_orchestration"], true)).toThrow("refusing macOS side effect");
    expect(read()).toEqual(SETTINGS);
  });
});

// 2026-11-11: Cloudroom's relaunch inside A9 failed its first key after one try to bring the app forward, and the
// block lost 86 valid rows of eight finished tests.
describe("keys to an app that is not in front yet", () => {
  test("the app is brought forward up to three times, with a longer wait each time", async () => {
    const { press } = await import("../adapters/macos.ts");
    const sleeps: number[] = [];
    let calls = 0;
    const runner = fakeRunner("ademark", {
      keys: async () => {
        calls += 1;
        if (calls <= 3) throw new Error("ademark-native keys failed (exit 4): not_frontmost: pid 7 is not the frontmost application");
        return { t_ns: 0 };
      },
      run: (argv) => ({ code: 0, stdout: argv[0] === "ps" ? "/Applications/Cloudroom.app/Contents/MacOS/Cloudroom\n" : "", stderr: "" }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    setMacosRunner(runner);
    await press(ctx(), 7, "cmd+n");
    expect(calls).toBe(4);
    expect(sleeps).toEqual([400, 1500, 4000]);
    // Still not in front after the third wait: the error stands.
    calls = -100;
    setMacosRunner(fakeRunner("ademark", {
      keys: async () => {
        throw new Error("ademark-native keys failed (exit 4): not_frontmost: pid 7 is not the frontmost application");
      },
      run: () => ({ code: 0, stdout: "/Applications/Cloudroom.app/Contents/MacOS/Cloudroom\n", stderr: "" }),
      sleep: async () => {},
    }));
    await expect(press(ctx(), 7, "cmd+n")).rejects.toThrow("not_frontmost");
    // Any other failure is never tried again.
    let other = 0;
    setMacosRunner(fakeRunner("ademark", {
      keys: async () => {
        other += 1;
        throw new Error("ademark-native keys failed (exit 3): process_not_found");
      },
    }));
    await expect(press(ctx(), 7, "cmd+n")).rejects.toThrow("process_not_found");
    expect(other).toBe(1);
  });
});

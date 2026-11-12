import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { copyQuarantined, FIRST_LAUNCH_DIR, resetMacosRunner, setMacosRunner } from "../adapters/macos.ts";
import { NativeError, NativeFailure } from "../core/native.ts";
import { captureContext, fakeRunner, FIXED_NOW } from "./adapters-fake.ts";
import {
  adePidHints,
  attempt,
  firstRequestAfter,
  launchNotes,
  parseReplayLog,
  PROBE,
  readReplayLog,
  READY_BOUND_MS,
} from "../tracks/a-timing/shared.ts";
import { makeTimingAdapter } from "./fixtures/tracks-a-timing/adapter.ts";

const REPLAY = resolve(import.meta.dir, "fixtures", "tracks-a-timing", "replay.jsonl");

afterEach(() => {
  resetMacosRunner();
});

describe("timing shared helpers", () => {
  test("the probe string and the ±67 ms bound are the ones of TESTS.md §1.3", () => {
    expect(PROBE).toBe("ademarkqz");
    expect(READY_BOUND_MS).toBe(67);
  });

  test("firstRequestAfter picks the first request of the session at or after t0", () => {
    const entries = readReplayLog(REPLAY);
    expect(entries.length).toBe(4);
    expect(firstRequestAfter(entries, "hi", 0)?.t_ns).toBe(2_000_000);
    expect(firstRequestAfter(entries, "hi", 2_000_001)?.t_ns).toBe(3_000_000);
    expect(firstRequestAfter(entries, "seed", 0)?.t_ns).toBe(1_000_000);
    expect(firstRequestAfter(entries, "missing", 0)).toBeNull();
  });

  test("parseReplayLog keeps every JSON line and skips blank lines", () => {
    const entries = parseReplayLog('{"t_ns":1,"session":"hi"}\n\n{"t_ns":2,"session":"seed"}\n');
    expect(entries.map((entry) => entry.t_ns)).toEqual([1, 2]);
  });

  test("adePidHints adds the vendor dirs with ~ expanded", () => {
    const hints = adePidHints(makeTimingAdapter(), "/tmp/home");
    expect(hints.bundlePaths).toEqual(["/Applications/Fixture Timing.app", "/tmp/home/.fixture-timing"]);
  });

  test("attempt turns a NativeError into a reason and lets other errors propagate", async () => {
    const skipped = await attempt(async () => {
      throw new NativeFailure("ademark-native echo failed (exit 4): trigger_skipped: no window");
    });
    expect(skipped).toEqual({ ok: false, reason: "trigger_skipped" });

    const notFront = await attempt(async () => {
      throw new NativeError("ademark-native keys failed (exit 4): not_frontmost");
    });
    expect(notFront).toEqual({ ok: false, reason: "not_frontmost" });

    const other = await attempt(async () => {
      throw new NativeError("ademark-native echo failed (exit 3): permission missing");
    });
    expect(other).toEqual({ ok: false, reason: "ademark-native echo failed (exit 3): permission missing" });

    await expect(
      attempt(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  test("launchNotes carries settled_ms and reports a window that never settles", () => {
    const echo = { t0_ns: 1, ready_ns: 2, ready_ms: 1200, settled_ms: 1800, frames: 72, timed_out: false };
    expect(JSON.parse(launchNotes(echo))).toEqual({ settled_ms: 1800, frames: 72 });
    expect(JSON.parse(launchNotes({ ...echo, settled_ms: null }))).toEqual({
      settled_ms: "never settled",
      frames: 72,
    });
  });
});

describe("copyQuarantined", () => {
  const APP = "/Applications/Fixture Timing.app";

  test("the dry plan holds ditto and xattr under /private/tmp and runs nothing", () => {
    const runner = fakeRunner("tester");
    setMacosRunner(runner);
    const { ctx, lines } = captureContext({ home: "/tmp/home" });
    const root = "/private/tmp/ademark-fixture-first-launch";

    const copy = copyQuarantined(ctx, APP, "/tmp/ademark-fixture-first-launch");

    expect(copy).toBe(`${root}/Fixture Timing.app`);
    expect(lines).toEqual([
      `plan: ditto ${APP} ${root}/Fixture Timing.app`,
      `plan: xattr -w com.apple.quarantine 0083;<timestamp>;Safari; ${root}/Fixture Timing.app`,
    ]);
    expect(runner.commands).toEqual([]);
    expect(FIRST_LAUNCH_DIR).toBe("/tmp/ademark-first-launch");
  });

  test("refuses a root that is not an ademark- folder under /private/tmp", () => {
    const runner = fakeRunner("tester");
    setMacosRunner(runner);
    const { ctx, lines } = captureContext({ home: "/tmp/home" });

    expect(() => copyQuarantined(ctx, APP, "/tmp/other")).toThrow(/refusing first-launch root/);
    expect(() => copyQuarantined(ctx, APP, join(import.meta.dir, "ademark-outside"))).toThrow(
      /refusing first-launch root/,
    );
    expect(() => copyQuarantined(ctx, APP, "/private/tmp")).toThrow(/refusing first-launch root/);
    expect(lines).toEqual([]);
    expect(runner.commands).toEqual([]);
  });

  test("real mode refuses before the first command when the user is not ademark", () => {
    const runner = fakeRunner("owner");
    setMacosRunner(runner);
    const { ctx } = captureContext({ home: "/tmp/home", dryRun: false });

    expect(() => copyQuarantined(ctx, APP, "/tmp/ademark-fixture-first-launch")).toThrow(
      /only the dedicated "ademark" user/,
    );
    expect(runner.commands).toEqual([]);
  });

  test("real mode dittoes the app and writes com.apple.quarantine as ademark", () => {
    const runner = fakeRunner("ademark");
    setMacosRunner(runner);
    const root = mkdtempSync("/private/tmp/ademark-test-");
    try {
      const { ctx } = captureContext({ home: "/tmp/home", dryRun: false });
      const copy = copyQuarantined(ctx, APP, root);

      expect(copy).toBe(join(root, "Fixture Timing.app"));
      expect(runner.commands).toEqual([
        ["ditto", APP, join(root, "Fixture Timing.app")],
        [
          "xattr",
          "-w",
          "com.apple.quarantine",
          `0083;${Math.floor(FIXED_NOW / 1000)};Safari;`,
          join(root, "Fixture Timing.app"),
        ],
      ]);
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

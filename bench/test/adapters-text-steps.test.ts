// ADEMARK-52: expectText with a list of texts, and the clickIfText step.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetMacosRunner, setMacosRunner, waitForText } from "../adapters/macos.ts";
import { runSteps, type StepVars } from "../adapters/profile-steps.ts";
import type { ProfileStep } from "../core/contracts.ts";
import type { WatchOptions } from "../core/native.ts";
import { captureContext, fakeRunner } from "./adapters-fake.ts";
import { profileFile } from "../adapters/profile.ts";

const VARS: StepVars = { worktree: "/tmp/work/arena", home: "/tmp/home", model: null, effort: null, agent: "claude" };
const REGION = { x: 610, y: 450, w: 220, h: 40 };

// The rule of the native TextMatcher.contains (exact): lower case, letters and digits only, a substring of one line.
function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// A watch that plays OCR frames and stops at the first frame showing any needle, as `ademark-native watch` does.
function framesWatch(frames: string[][], calls: WatchOptions[]) {
  return async (options: WatchOptions) => {
    calls.push(options);
    writeFileSync(options.frames, '{"frames":[]}');
    const needles = (typeof options.text === "string" ? [options.text] : [...options.text]).map(normalized);
    const hit = frames.findIndex((lines) => lines.some((line) => needles.some((n) => normalized(line).includes(n))));
    return hit === -1 ? { seen_ns: null, timed_out: true } : { seen_ns: hit + 1, timed_out: false };
  };
}

afterEach(() => resetMacosRunner());

describe("waitForText with a list of texts", () => {
  // control-2026-11-10T08-31-19Z-conductor-1/waits: OCR read "Open rxoiect" in all 1,007 frames.
  const CONDUCTOR_FRAMES = Array.from({ length: 5 }, () => ["Open rxoiect"]);

  test("the single text \"project\" fails on the frames of 10 Nov", async () => {
    const calls: WatchOptions[] = [];
    setMacosRunner(fakeRunner("ademark", { watch: framesWatch(CONDUCTOR_FRAMES, calls) }));
    const { ctx } = captureContext({ dryRun: false, runDir: "" });
    await expect(waitForText(ctx, 7, REGION, "project", 30)).rejects.toThrow('"project" did not show within 30 s');
    rmSync(calls[0]!.frames, { force: true });
  });

  test("a list ends the wait at the first text read and passes the whole list to the watch", async () => {
    const calls: WatchOptions[] = [];
    setMacosRunner(fakeRunner("ademark", { watch: framesWatch(CONDUCTOR_FRAMES, calls) }));
    const { ctx } = captureContext({ dryRun: false, runDir: "" });
    expect(await waitForText(ctx, 7, REGION, ["Open", "project"], 30)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toEqual(["Open", "project"]);
    expect(existsSync(calls[0]!.frames)).toBe(false);
  });

  test("a list that is never read names every text in the error and keeps the evidence", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "ademark-texts-"));
    setMacosRunner(fakeRunner("ademark", { watch: framesWatch([["nothing"]], []) }));
    const { ctx } = captureContext({ dryRun: false, runDir });
    await expect(waitForText(ctx, 7, REGION, ["Open", "project"], 30)).rejects.toThrow(
      /^"Open" or "project" did not show within 30 s \(frames .*waits\/.*-Open-frames\.json, screenshot /,
    );
    rmSync(runDir, { recursive: true, force: true });
  });

  test("a dry run plans the list", async () => {
    const { ctx, lines } = captureContext();
    const steps: ProfileStep[] = [{ kind: "expectText", region: REGION, texts: ["Open", "project"], timeoutMs: 30_000 }];
    await runSteps(ctx, 0, steps, VARS, "steps.openProject");
    expect(lines).toEqual(["plan: waitForText pid=0 texts=Open|project"]);
  });
});

describe("clickIfText", () => {
  const BANNER = { x: 340, y: 12, w: 520, h: 28 };
  const STEP: ProfileStep = {
    kind: "clickIfText",
    region: BANNER,
    texts: ["new version", "Cloudroom is ready"],
    point: { x: 1566, y: 26 },
    timeoutMs: 2000,
  };
  const clicks = (commands: string[][]) => commands.filter((argv) => argv[1] === "click");

  test("clicks the point when one of the texts is read", async () => {
    const calls: WatchOptions[] = [];
    const runner = fakeRunner("ademark", {
      watch: framesWatch([["A new version of Cloudroom is ready. Restart to update."]], calls),
    });
    setMacosRunner(runner);
    const runDir = mkdtempSync(join(tmpdir(), "ademark-click-if-"));
    const { ctx, lines } = captureContext({ dryRun: false, runDir });
    await runSteps(ctx, 9, [STEP], VARS, "steps.afterLaunch");
    expect(calls[0]!.region).toEqual(BANNER);
    expect(calls[0]!.timeoutS).toBe(2);
    expect(clicks(runner.commands).map((argv) => argv.slice(1))).toEqual([["click", "--pid", "9", "--at", "1566,26", "--count", "1"]]);
    expect(lines.some((line) => line.includes("clickIfText: read one of") && line.includes("click at=1566,26"))).toBe(true);
    rmSync(runDir, { recursive: true, force: true });
  });

  test("does nothing, logs it and keeps no evidence when no text is read", async () => {
    const calls: WatchOptions[] = [];
    const runner = fakeRunner("ademark", { watch: framesWatch([[], []], calls) });
    setMacosRunner(runner);
    const runDir = mkdtempSync(join(tmpdir(), "ademark-click-if-"));
    const { ctx, lines } = captureContext({ dryRun: false, runDir });
    await runSteps(ctx, 9, [STEP], VARS, "steps.afterLaunch");
    expect(clicks(runner.commands)).toEqual([]);
    expect(lines.some((line) => line.includes("clickIfText: none of new version | Cloudroom is ready") && line.includes("no click"))).toBe(true);
    expect(existsSync(join(runDir, "waits"))).toBe(false);
    expect(existsSync(calls[0]!.frames)).toBe(false);
    rmSync(runDir, { recursive: true, force: true });
  });

  test("a failed native watch still fails the step", async () => {
    setMacosRunner(fakeRunner("ademark", { watch: async () => Promise.reject(new Error("screen recording denied")) }));
    const { ctx } = captureContext({ dryRun: false, runDir: "" });
    await expect(runSteps(ctx, 9, [STEP], VARS, "steps.afterLaunch")).rejects.toThrow(
      "step steps.afterLaunch[0] (clickIfText): screen recording denied",
    );
  });

  test("a dry run plans the read and the click on one line and clicks nothing", async () => {
    const { ctx, lines } = captureContext();
    await runSteps(ctx, 0, [STEP], VARS, "steps.afterLaunch");
    expect(lines).toEqual([
      "plan: clickIfText pid=0 texts=new version|Cloudroom is ready region=340,12,520,28 at=1566,26 timeoutMs=2000",
    ]);
  });
});

// Each watch call plays its own frames: the first call is the read before the click, the second the confirmGone read.
function callsWatch(perCall: string[][][], calls: WatchOptions[]) {
  return async (options: WatchOptions) => {
    const frames = perCall[calls.length] ?? [];
    return framesWatch(frames, calls)(options);
  };
}

describe("Cloudroom's banner step (review R1)", () => {
  const profile = JSON.parse(readFileSync(profileFile("cloudroom"), "utf8"));
  const banner = (profile.steps.afterLaunch as ProfileStep[]).find(
    (step) => step.kind === "clickIfText" && step.point.x === 1566 && step.point.y === 26,
  ) as Extract<ProfileStep, { kind: "clickIfText" }>;
  const bannerClicks = (commands: string[][]) => commands.filter((argv) => argv[1] === "click" && argv[5] === "1566,26");

  async function play(perCall: string[][][]) {
    const calls: WatchOptions[] = [];
    const runner = fakeRunner("ademark", { watch: callsWatch(perCall, calls) });
    setMacosRunner(runner);
    const { ctx, lines } = captureContext({ dryRun: false, runDir: "" });
    await runSteps(ctx, 9, [banner], VARS, "steps.afterLaunch");
    return { calls, clicks: bannerClicks(runner.commands), lines };
  }

  test("reads the whole text line of the banner and stays left of Restart to update", () => {
    expect(banner.region).toEqual({ x: 340, y: 12, w: 860, h: 28 });
    expect(banner.region.x + banner.region.w).toBeLessThan(1412);
    expect(banner.confirmGone).toBe(true);
  });

  test("clicks when only Restart is read", async () => {
    const { clicks } = await play([[["A ncw vcrsion of Cloudroom is rcady. Restart to updatc. Enter your Mac passw0rd once"]], []]);
    expect(clicks).toHaveLength(1);
  });

  test("clicks when only version is read", async () => {
    const { clicks } = await play([[["A new version of Cl0udr0om is rcady. Rcstart to updatc"]], []]);
    expect(clicks).toHaveLength(1);
  });

  test("does nothing on an empty strip", async () => {
    const { clicks, calls, lines } = await play([[[], []]]);
    expect(clicks).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(lines.some((line) => line.includes("no click"))).toBe(true);
  });

  test("after the click, a banner word still read is logged once, with no second click and no failure", async () => {
    const still = [["A new version of Cloudroom is ready. Restart to update."]];
    const { clicks, calls, lines } = await play([still, still]);
    expect(clicks).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.region).toEqual(banner.region);
    expect(lines.filter((line) => line.includes("did not close (no second click)"))).toHaveLength(1);
  });

  test("after the click, an empty strip is logged as closed", async () => {
    const { lines } = await play([[["A new version of Cloudroom is ready."]], [[]]]);
    expect(lines.some((line) => line.includes("it closed"))).toBe(true);
    expect(lines.some((line) => line.includes("did not close"))).toBe(false);
  });
});

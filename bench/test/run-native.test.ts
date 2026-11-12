import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadArgs, NativeFailure, cover, sampleStart, scroll } from "../core/native.ts";

// The same fake-binary pattern as native.test.ts, for the wrappers ADEMARK-6 adds.
let dir: string;
let fake: string;
let previous: string | undefined;

function writeFake(body: string): void {
  writeFileSync(fake, `#!/bin/sh\n${body}\n`);
  chmodSync(fake, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-native-run-"));
  fake = join(dir, "ademark-native");
  previous = process.env.ADEMARK_NATIVE;
  process.env.ADEMARK_NATIVE = fake;
});

afterEach(() => {
  if (previous === undefined) delete process.env.ADEMARK_NATIVE;
  else process.env.ADEMARK_NATIVE = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("native scroll, cover and sampleStart", () => {
  test("scroll passes every flag and parses the summary", async () => {
    const frames = join(dir, "frames.json");
    writeFake(
      `case "$*" in *"--pid 7"*"--region 1,2,3,4"*"--count 20"*"--hz 60"*"--lines 3"*"--frames ${frames}"*) ` +
        `echo '{"t0_ns":1,"t_end_ns":334,"posted":20,"frames":21,"gaps_over_33ms":0,"max_gap_ms":0}' ;; ` +
        `*) echo '{"error":"bad_args"}'; exit 2 ;; esac`,
    );
    const result = await scroll({ pid: 7, region: { x: 1, y: 2, w: 3, h: 4 }, count: 20, hz: 60, lines: 3, frames });
    expect(result).toEqual({ t0_ns: 1, t_end_ns: 334, posted: 20, frames: 21, gaps_over_33ms: 0, max_gap_ms: 0 });
  });

  test("cover passes the pid and duration", async () => {
    writeFake(
      `case "$*" in *"--pid 9"*"--duration-s 20"*) ` +
        `echo '{"window_id":4,"frame":{"x":0,"y":0,"w":1600,"h":1000},"shown_ns":1,"closed_ns":2}' ;; ` +
        `*) echo '{"error":"bad_args"}'; exit 2 ;; esac`,
    );
    const result = await cover({ pid: 9, durationS: 20 });
    expect(result.window_id).toBe(4);
    expect(result.frame.w).toBe(1600);
  });

  test("sampleStart runs until SIGTERM and parses the final summary", async () => {
    writeFake(
      `trap "echo '{\\"ticks\\":9,\\"rows\\":18,\\"pids\\":2,\\"app_median_b\\":1,\\"app_p95_b\\":2,\\"agents_median_b\\":3,\\"total_median_b\\":4,\\"total_p95_b\\":5}'; exit 0" TERM\n` +
        `while true; do sleep 0.05; done`,
    );
    const handle = await sampleStart({ rules: join(dir, "rules.json"), hz: 4, csv: join(dir, "samples.csv") });
    expect(handle.pid).toBeGreaterThan(0);
    const result = await handle.stop();
    expect(result.ticks).toBe(9);
    expect(result.agents_median_b).toBe(3);
  });

  test("sampleStart maps a failing process through stop()", async () => {
    writeFake(`echo '{"error":"bad_args","message":"--hz missing"}'; exit 2`);
    const handle = await sampleStart({ rules: join(dir, "rules.json"), hz: 4, csv: join(dir, "samples.csv") });
    const error = (await handle.stop().catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(BadArgs);
    expect(error.message).toContain("--hz missing");
  });

  test("sampleStart reports invalid JSON as NativeFailure", async () => {
    writeFake(`echo not-json; exit 0`);
    const handle = await sampleStart({ rules: join(dir, "rules.json"), hz: 4, csv: join(dir, "samples.csv") });
    const error = (await handle.stop().catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(NativeFailure);
    expect(error.message).toContain("invalid JSON");
  });

  test("sampleStart refuses a second stop()", async () => {
    writeFake(`echo '{"ticks":1,"rows":1,"pids":1,"app_median_b":1,"app_p95_b":1,"agents_median_b":0,"total_median_b":1,"total_p95_b":1}'; exit 0`);
    const handle = await sampleStart({ rules: join(dir, "rules.json"), hz: 4, csv: join(dir, "samples.csv") });
    await handle.stop();
    await expect(handle.stop()).rejects.toThrow("already called");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BadArgs,
  NativeError,
  NativeFailure,
  PermissionMissing,
  echo,
  idle,
  keys,
  lag,
  nativeBinary,
  now,
  ocr,
  procs,
  sample,
  watch,
  window,
} from "../core/native.ts";

// A fake ademark-native: a shell script that prints contract JSON and exits 0, 2 or 3.
let dir: string;
let fake: string;
let previous: string | undefined;

function writeFake(body: string): void {
  writeFileSync(fake, `#!/bin/sh\n${body}\n`);
  chmodSync(fake, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-native-"));
  fake = join(dir, "ademark-native");
  previous = process.env.ADEMARK_NATIVE;
  process.env.ADEMARK_NATIVE = fake;
});

afterEach(() => {
  if (previous === undefined) delete process.env.ADEMARK_NATIVE;
  else process.env.ADEMARK_NATIVE = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("native wrapper", () => {
  test("parses a successful response", async () => {
    writeFake('echo \'{"t_ns": 51245319227500}\'');
    expect(await now()).toEqual({ t_ns: 51245319227500 });
  });

  test("maps exit code 2 to BadArgs with the JSON error", async () => {
    writeFake('echo \'{"error":"bad_args","message":"--combo nonsense"}\'; exit 2');
    const failure = now().catch((error: unknown) => error);
    const error = await failure;
    expect(error).toBeInstanceOf(BadArgs);
    expect((error as Error).message).toContain("bad_args");
  });

  test("maps exit code 3 to PermissionMissing", async () => {
    writeFake('echo \'{"error":"accessibility_not_granted"}\'; exit 3');
    const error = (await keys({ pid: 1, combo: "cmd+n" }).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(PermissionMissing);
    expect(error.message).toContain("accessibility_not_granted");
  });

  test("maps exit code 4 to NativeFailure", async () => {
    writeFake('echo \'{"error":"boom"}\'; exit 4');
    const error = (await procs().catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(NativeFailure);
  });

  test("reports invalid JSON as NativeFailure", async () => {
    writeFake("echo not-json");
    const error = (await procs().catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(NativeFailure);
    expect(error.message).toContain("invalid JSON");
  });

  test("names build.sh when the binary is missing", async () => {
    process.env.ADEMARK_NATIVE = join(dir, "does-not-exist");
    const error = (await now().catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(NativeError);
    expect(error.message).toContain("bench/native/build.sh");
  });

  test("passes sample flags and returns the summary", async () => {
    const rules = join(dir, "rules.json");
    writeFileSync(rules, "{}");
    writeFake(
      `case "$*" in *"--hz 4"*"--duration-s 3"*"--csv ${dir}/s.csv"*) ` +
        `echo '{"ticks":12,"rows":24,"pids":2,"app_median_b":1,"app_p95_b":2,"agents_median_b":3,"total_median_b":4,"total_p95_b":5}' ;; ` +
        `*) echo '{"error":"bad_args"}'; exit 2 ;; esac`,
    );
    const result = await sample({ rules, hz: 4, durationS: 3, csv: join(dir, "s.csv") });
    expect(result.ticks).toBe(12);
  });

  test("serializes a SampleRules object into a temporary file", async () => {
    writeFake(`grep -q '"rootPids":\\[42\\]' "$3" && echo '{"ticks":1,"rows":1,"pids":1,"app_median_b":1,"app_p95_b":1,"agents_median_b":0,"total_median_b":1,"total_p95_b":1}'`);
    const result = await sample({
      rules: { rootPids: [42], bundlePaths: [], vendorDirs: [], agentExecutables: [], excludeNames: [] },
      hz: 4,
      durationS: 1,
      csv: join(dir, "s.csv"),
    });
    expect(result.ticks).toBe(1);
  });

  test("echo passes triggers, region, probe and optional flags", async () => {
    writeFake(
      `case "$*" in *'--triggers [{"kind":"keys","combo":"cmd+n"}]'*'--region 1,2,3,4'*'--probe ademarkqz'*'--focus-click 5,6'*'--masks []'*'--settle-cap-s 3'*) ` +
        `echo '{"t0_ns":1,"ready_ns":2,"ready_ms":1,"settled_ms":null,"frames":3,"timed_out":false}' ;; ` +
        `*) echo '{"error":"bad_args"}'; exit 2 ;; esac`,
    );
    const result = await echo({
      pid: 10,
      triggers: [{ kind: "keys", combo: "cmd+n" }],
      region: { x: 1, y: 2, w: 3, h: 4 },
      focusClick: { x: 5, y: 6 },
      probe: "ademarkqz",
      intervalMs: 50,
      timeoutS: 20,
      frames: join(dir, "frames.json"),
      masks: [],
      settleCapS: 3,
    });
    expect(result.frames).toBe(3);
  });

  test("echo passes the absent marker and its region", async () => {
    writeFake(
      `case "$*" in *"--absent unchanged --absent-region 0,100,1200,600"*) ` +
        `echo '{"t0_ns":1,"ready_ns":2,"ready_ms":1,"settled_ms":null,"frames":3,"timed_out":false,"absent_seen":false,"absent_checked":true}' ;; ` +
        `*) echo '{"error":"bad_args"}'; exit 2 ;; esac`,
    );
    const result = await echo({
      pid: 10,
      triggers: [],
      region: { x: 1, y: 2, w: 3, h: 4 },
      probe: "ademarkqz",
      intervalMs: 50,
      timeoutS: 20,
      frames: join(dir, "frames.json"),
      absent: "unchanged",
      absentRegion: { x: 0, y: 100, w: 1200, h: 600 },
    });
    expect(result.absent_checked).toBe(true);
  });

  test("watch passes --nearly with its list of texts", async () => {
    writeFake(
      `case "$*" in *"--texts [\\"unchanged\\",\\"repository is unchanged\\"]"*"--nearly"*) echo '{"t0_ns":1,"seen_ns":2,"ms":1,"timed_out":false,"seen_text":"unchanged"}' ;; ` +
        `*) echo '{"error":"bad_args"}'; exit 2 ;; esac`,
    );
    const result = await watch({
      pid: 10,
      text: ["unchanged", "repository is unchanged"],
      nearly: true,
      region: { x: 0, y: 100, w: 1200, h: 600 },
      triggers: [],
      timeoutS: 5,
      frames: join(dir, "frames.json"),
    });
    expect(result.seen_text).toBe("unchanged");
  });

  test("echo passes the longer marker line after the region, and only with a region", async () => {
    writeFake(
      `case "$*" in *"--absent unchanged --absent-region 0,100,1200,600 --absent-also repository is unchanged"*) echo '{"with":"also"}' ;; ` +
        `*"--absent-also"*) echo '{"error":"bad_args"}'; exit 2 ;; ` +
        `*) echo '{"with":"none"}' ;; esac`,
    );
    const base = { pid: 10, triggers: [], region: { x: 1, y: 2, w: 3, h: 4 }, probe: "ademarkqz", intervalMs: 50, timeoutS: 20, frames: join(dir, "frames.json") };
    const withRegion = await echo({ ...base, absent: "unchanged", absentRegion: { x: 0, y: 100, w: 1200, h: 600 }, absentAlso: "repository is unchanged" });
    expect(withRegion as unknown).toEqual({ with: "also" });
    // No region: the option is not sent, because the helper refuses it without --absent-region.
    const withoutRegion = await echo({ ...base, absent: "unchanged", absentAlso: "repository is unchanged" });
    expect(withoutRegion as unknown).toEqual({ with: "none" });
  });

  test("idle passes the quiet threshold, the quiet window and the cap", async () => {
    writeFake(
      `case "$*" in *"--cpu-cores 0.1"*"--quiet-ms 2000"*"--cap-s 10"*) ` +
        `echo '{"waited_ms":2040,"quiet":true,"cores_last":0.04}' ;; ` +
        `*) echo '{"error":"bad_args"}'; exit 2 ;; esac`,
    );
    expect(await idle({ cpuCores: 0.1, quietMs: 2000, capS: 10 })).toEqual({
      waited_ms: 2040,
      quiet: true,
      cores_last: 0.04,
    });
  });

  test("window adds --front only when asked", async () => {
    writeFake(`case "$*" in *"--front"*) echo '{"window_id":7,"frame":{"x":0,"y":0,"w":1600,"h":1000}}' ;; *) echo '{"error":"bad_args"}'; exit 2 ;; esac`);
    expect(await window({ pid: 1, size: { w: 1600, h: 1000 }, front: true })).toEqual({
      window_id: 7,
      frame: { x: 0, y: 0, w: 1600, h: 1000 },
    });
  });

  test("watch, lag and ocr parse their shapes", async () => {
    writeFake(
      `case "$1" in watch) echo '{"t0_ns":1,"seen_ns":null,"ms":null,"timed_out":true}' ;; ` +
        `lag) echo '{"samples_ms":[10,20],"p50":10,"p95":20,"lost":0}' ;; ` +
        `ocr) echo '{"lines":["ADEMARK","LEDGERMARK 4821"]}' ;; esac`,
    );
    expect((await watch({ pid: 1, text: "x", region: { x: 0, y: 0, w: 1, h: 1 }, triggers: [], timeoutS: 1, frames: "f" })).timed_out).toBe(true);
    expect((await lag({ pid: 1, region: { x: 0, y: 0, w: 1, h: 1 }, count: 2, intervalMs: 1, frames: "f" })).p95).toBe(20);
    expect((await ocr({ image: "shot.png" })).lines).toContain("LEDGERMARK 4821");
  });

  test("watch sends one text as --text and a list as --texts", async () => {
    writeFake(
      `case "$*" in *"--texts [\\"THREAD-END\\",\\"NGTHREAFEND\\"]"*) echo '{"t0_ns":1,"seen_ns":2,"ms":0,"timed_out":false,"seen_text":"NGTHREAFEND"}' ;; ` +
        `*"--text x "*) echo '{"t0_ns":1,"seen_ns":2,"ms":0,"timed_out":false,"seen_text":"x"}' ;; ` +
        `*) echo '{"error":"bad_args"}'; exit 2 ;; esac`,
    );
    const base = { pid: 1, region: { x: 0, y: 0, w: 1, h: 1 }, triggers: [], timeoutS: 1, frames: "f" };
    expect((await watch({ ...base, text: "x" })).seen_text).toBe("x");
    expect((await watch({ ...base, text: ["THREAD-END", "NGTHREAFEND"] })).seen_text).toBe("NGTHREAFEND");
  });

    test("nativeBinary honors ADEMARK_NATIVE", () => {
    expect(nativeBinary()).toBe(fake);
  });
});

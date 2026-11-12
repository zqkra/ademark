import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// The A3 marker matcher lives in the Swift helper. Its self-test feeds it the OCR strings read on the real screen on
// 2026-11-09 (HOLLOWPINO, HOLLOWPINd, INEHOLLOWPINEHOLLOWPIN, deHOLLOWPIN and Bare CLI's transcript line). The binary is
// not in git: build it with `bash bench/native/build.sh`, or this test is skipped.
const BINARY = resolve(import.meta.dir, "..", "native", "bin", "ademark-native");

describe("ademark-native selftest", () => {
  test.skipIf(!existsSync(BINARY))("every self-test passes, the 9 Nov OCR strings included", () => {
    const result = Bun.spawnSync([BINARY, "selftest"], { stdout: "pipe", stderr: "pipe" });
    const report = JSON.parse(result.stdout.toString()) as { passed: number; failed: number; failures: string[] };
    expect(report.failures).toEqual([]);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(218);
  });
});

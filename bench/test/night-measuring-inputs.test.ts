// The hash of the measuring files must not depend on the locale of the process that reads it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measuringInputsOf } from "../night/repair-real.ts";

let dir = "";
const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-inputs-"));
  mkdirSync(join(dir, "bench", "native", "bin"), { recursive: true });
  mkdirSync(join(dir, "snapshots", "clean"), { recursive: true });
  // Names that C and a UTF-8 locale order differently: upper case, lower case, a dot, an underscore.
  for (const name of ["B", "a", "_x", ".hidden", "Zeta", "alpha"]) writeFileSync(join(dir, "snapshots", "clean", name), name);
  writeFileSync(join(dir, "bench", "native", "bin", "ademark-native"), "binary");
});

afterEach(() => {
  for (const key of ["LC_ALL", "LANG"] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("measuring inputs hash", () => {
  test("is the same under C and under a UTF-8 locale (2026-11-10: Ghostty and launchd disagreed)", () => {
    process.env.LC_ALL = "C";
    process.env.LANG = "C";
    const plain = measuringInputsOf(dir);
    process.env.LC_ALL = "en_US.UTF-8";
    process.env.LANG = "en_US.UTF-8";
    const utf8 = measuringInputsOf(dir);
    expect(plain.length).toBeGreaterThan(40);
    expect(utf8).toBe(plain);
  });

  test("changes when a measuring file changes", () => {
    const before = measuringInputsOf(dir);
    writeFileSync(join(dir, "bench", "native", "bin", "ademark-native"), "another binary");
    expect(measuringInputsOf(dir)).not.toBe(before);
  });
});

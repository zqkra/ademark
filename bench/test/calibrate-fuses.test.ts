import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHUNK_BYTES, findBytes } from "../calibrate/binary.ts";
import { FUSE_NAMES, FUSE_SENTINEL, parseFuses, readFuses } from "../calibrate/fuses.ts";

function fuseBuffer(version: number, states: number[]): Buffer {
  return Buffer.concat([
    Buffer.from(FUSE_SENTINEL, "utf8"),
    Buffer.from([version, states.length]),
    Buffer.from(states),
  ]);
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-fuses-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fuse reader", () => {
  test("reads the version, the count and every fuse state", () => {
    const report = parseFuses(fuseBuffer(1, [0x31, 0x30, 0x72, 0x31, 0x30, 0x31, 0x30, 0x31]));
    expect(report?.version).toBe(1);
    expect(report?.count).toBe(8);
    expect(report?.fuses.map((fuse) => fuse.name)).toEqual([...FUSE_NAMES]);
    expect(report?.fuses.map((fuse) => fuse.state)).toEqual([
      "on",
      "off",
      "removed",
      "on",
      "off",
      "on",
      "off",
      "on",
    ]);
  });

  test("names fuses beyond the known list fuse<n>", () => {
    const report = parseFuses(fuseBuffer(1, [0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x31, 0x30]));
    expect(report?.fuses[8]?.name).toBe("fuse8");
    expect(report?.fuses[8]?.state).toBe("off");
  });

  test("keeps an unknown byte visible", () => {
    const report = parseFuses(fuseBuffer(1, [0x99]));
    expect(report?.fuses[0]?.state).toBe("unknown");
    expect(report?.fuses[0]?.raw).toBe(0x99);
  });

  test("returns null without the sentinel", () => {
    expect(parseFuses(Buffer.from("no fuses in this binary"))).toBeNull();
  });

  test("finds a sentinel that spans a chunk boundary", () => {
    const path = join(dir, "big-binary");
    const sentinel = Buffer.from(FUSE_SENTINEL, "utf8");
    const offset = CHUNK_BYTES - 10;
    const buffer = Buffer.alloc(offset + sentinel.length + 100);
    sentinel.copy(buffer, offset);
    writeFileSync(path, buffer);
    expect(findBytes(path, sentinel)).toBe(offset);
  });

  test("returns null when the needle is not in the file", () => {
    const path = join(dir, "plain");
    writeFileSync(path, "nothing to see here");
    expect(findBytes(path, Buffer.from("absent"))).toBeNull();
  });

  test("reads fuses from a file, not just a buffer", () => {
    const path = join(dir, "Electron Framework");
    writeFileSync(path, Buffer.concat([Buffer.from("prefix"), fuseBuffer(1, [0x31, 0x30]), Buffer.from("suffix")]));
    const report = readFuses(path);
    expect(report?.count).toBe(2);
    expect(report?.fuses[0]?.state).toBe("on");
    expect(report?.fuses[1]?.state).toBe("off");
  });
});

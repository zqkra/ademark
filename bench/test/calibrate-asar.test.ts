import { describe, expect, test } from "bun:test";
import {
  asarHeaderLength,
  isJavaScript,
  listAsarFiles,
  parseAsarHeader,
  scanShortcuts,
} from "../calibrate/asar.ts";

const HEADER = {
  files: {
    "index.js": { size: 10, offset: "0" },
    src: {
      files: {
        "app.js": { size: 7, offset: "10" },
        "app.js.map": { size: 0, offset: "17" },
      },
    },
    "addon.node": { size: 3, offset: "17", unpacked: true },
  },
};

function buildAsar(header: unknown, contents = "0123456789abcdefghij"): { buffer: Buffer; baseOffset: number } {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);
  const headerSize = 8 + padded.length;
  const outer = Buffer.alloc(8);
  outer.writeUInt32LE(4, 0);
  outer.writeUInt32LE(headerSize, 4);
  const pickle = Buffer.alloc(8);
  pickle.writeUInt32LE(headerSize - 4, 0);
  pickle.writeUInt32LE(json.length, 4);
  return {
    buffer: Buffer.concat([outer, pickle, padded, Buffer.from(contents)]),
    baseOffset: 8 + headerSize,
  };
}

describe("asar header", () => {
  test("parses the pickles and the JSON header", () => {
    const { buffer, baseOffset } = buildAsar(HEADER);
    const header = parseAsarHeader(buffer);
    expect(header.header).toEqual(HEADER);
    expect(header.baseOffset).toBe(baseOffset);
    expect(asarHeaderLength(buffer)).toBe(16 + Buffer.byteLength(JSON.stringify(HEADER)));
  });

  test("lists files with their offsets and unpacked flag", () => {
    const { buffer } = buildAsar(HEADER);
    const entries = listAsarFiles(parseAsarHeader(buffer));
    expect(entries).toEqual([
      { path: "index.js", offset: 0, size: 10, unpacked: false },
      { path: "src/app.js", offset: 10, size: 7, unpacked: false },
      { path: "src/app.js.map", offset: 17, size: 0, unpacked: false },
      { path: "addon.node", offset: 17, size: 3, unpacked: true },
    ]);
    expect(entries.filter((entry) => isJavaScript(entry.path)).map((entry) => entry.path)).toEqual([
      "index.js",
      "src/app.js",
    ]);
  });

  test("rejects a truncated header", () => {
    const { buffer } = buildAsar(HEADER);
    expect(() => parseAsarHeader(buffer.subarray(0, 20))).toThrow(/truncated/);
  });

  test("rejects mismatched pickle sizes", () => {
    const { buffer } = buildAsar(HEADER);
    const broken = Buffer.from(buffer);
    broken.writeUInt32LE(1, 8);
    expect(() => parseAsarHeader(broken)).toThrow(/does not match pickle size/);
  });
});

describe("shortcut scanner", () => {
  const SOURCE = [
    'registerCommand("workspace.newThread", { accelerator: "CmdOrCtrl+N" });',
    'const other = "CommandOrControl+Shift+P";',
    'const local = "mod+k";',
    'const legacy = "cmd+alt+t";',
  ].join("\n");

  test("finds Electron accelerators and mod/cmd/meta key strings", () => {
    const found = scanShortcuts(SOURCE, "index.js");
    expect(found.map((candidate) => candidate.match)).toEqual([
      "CmdOrCtrl+N",
      "CommandOrControl+Shift+P",
      "mod+k",
      "cmd+alt+t",
    ]);
    expect(found.every((candidate) => candidate.file === "index.js")).toBe(true);
  });

  test("names the command id near the accelerator and keeps 80 characters of context", () => {
    const [first] = scanShortcuts(SOURCE, "index.js");
    expect(first?.commandId).toBe("workspace.newThread");
    expect(first?.context).toContain("CmdOrCtrl+N");
    expect((first?.context.length ?? 0)).toBeLessThanOrEqual(80 + "CmdOrCtrl+N".length + 80);
  });

  test("finds nothing in a file without shortcuts", () => {
    expect(scanShortcuts("console.log('nothing here');", "a.js")).toEqual([]);
  });
});

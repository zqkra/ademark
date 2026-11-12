// Review of 2026-11-10: Control deletes moved-aside copies in a child, so its thread keeps writing the heartbeat.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asideToPrune, pruneAsideInChild } from "../night/deps.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ademark-aside-"));
  for (const adapter of ["traycer", "paseo"]) {
    for (const stamp of ["2026-11-08T01", "2026-11-09T01", "2026-11-10T01"]) {
      mkdirSync(join(root, adapter, stamp, "data"), { recursive: true });
      writeFileSync(join(root, adapter, stamp, "data", "blob"), "x".repeat(1024));
    }
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("keeps the newest copy of each ADE and deletes the rest in a child, while the thread goes on", async () => {
  expect(asideToPrune(root).length).toBe(4);
  const lines: string[] = [];
  let ticked = false;
  setTimeout(() => {
    ticked = true;
  }, 0);
  await pruneAsideInChild((line) => lines.push(line), root);
  // A sync delete would return before any timer could run.
  expect(ticked).toBe(true);
  expect(readdirSync(join(root, "traycer"))).toEqual(["2026-11-10T01"]);
  expect(readdirSync(join(root, "paseo"))).toEqual(["2026-11-10T01"]);
  expect(lines.length).toBe(4);
});

test("nothing to delete starts no child", async () => {
  rmSync(root, { recursive: true, force: true });
  const lines: string[] = [];
  await pruneAsideInChild((line) => lines.push(line), root);
  expect(lines).toEqual([]);
});

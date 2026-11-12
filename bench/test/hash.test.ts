import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile, hashFolder } from "../core/hash.ts";

// Pinned from the algorithm the tasks/*/SHA256 files already use: write path, NUL, bytes, NUL for every
// file in UTF-16 order, skipping .DS_Store, .git, node_modules and symlinks.
const PINNED_FOLDER_HASH = "d5f7238bf6a160d4b4c058c4d6726ad3d1db61a41edc6a48aee380b252a598fb";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ademark-hash-"));
}

describe("hashFolder", () => {
  test("pins the algorithm: POSIX paths, UTF-16 order, skipped names and symlinks", () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, "nested"), { recursive: true });
      mkdirSync(join(dir, ".git"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(dir, "B.txt"), "bee");
      writeFileSync(join(dir, "a.txt"), "ay");
      writeFileSync(join(dir, "nested", "b.txt"), "nested");
      writeFileSync(join(dir, "target.txt"), "linked");
      writeFileSync(join(dir, ".DS_Store"), "junk");
      writeFileSync(join(dir, ".git", "config"), "git");
      writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "mod");
      symlinkSync(join(dir, "target.txt"), join(dir, "link.txt"));
      expect(hashFolder(dir)).toBe(PINNED_FOLDER_HASH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is stable across creation order and changes with content", () => {
    const root = tempDir();
    try {
      const first = join(root, "first");
      const second = join(root, "second");
      mkdirSync(join(first, "nested"), { recursive: true });
      mkdirSync(join(second, "nested"), { recursive: true });
      writeFileSync(join(first, "a.txt"), "a");
      writeFileSync(join(first, "nested", "b.txt"), "b");
      writeFileSync(join(second, "nested", "b.txt"), "b");
      writeFileSync(join(second, "a.txt"), "a");
      expect(hashFolder(first)).toBe(hashFolder(second));
      writeFileSync(join(second, "nested", "b.txt"), "c");
      expect(hashFolder(first)).not.toBe(hashFolder(second));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an absent folder hashes as empty input", () => {
    const root = tempDir();
    try {
      expect(hashFolder(join(root, "missing"))).toBe(createHash("sha256").digest("hex"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hashFile", () => {
  test("hashes bytes", () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, "p.json"), "{}");
      expect(hashFile(join(dir, "p.json"))).toBe(
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// build.sh --if-stale: the launcher runs it after each pull, so Control never starts with a helper older than its sources.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
let fakeBin = "";

// A copy of build.sh beside made sources, with a fake `swift` that writes the product and counts its calls.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ademark-build-"));
  fakeBin = join(dir, "fake-bin");
  mkdirSync(join(dir, "Sources", "ademark-native"), { recursive: true });
  mkdirSync(fakeBin);
  writeFileSync(join(dir, "Package.swift"), "// package\n");
  writeFileSync(join(dir, "Sources", "ademark-native", "main.swift"), "print(1)\n");
  copyFileSync(join(import.meta.dir, "..", "native", "build.sh"), join(dir, "build.sh"));
  const swift = join(fakeBin, "swift");
  writeFileSync(
    swift,
    `#!/bin/bash\necho call >> "${dir}/swift-calls"\nmkdir -p "${dir}/.build/release"\nprintf '#!/bin/bash\\nexit 0\\n' > "${dir}/.build/release/ademark-native"\nchmod +x "${dir}/.build/release/ademark-native"\n`,
  );
  chmodSync(swift, 0o755);
  const codesign = join(fakeBin, "codesign");
  writeFileSync(codesign, "#!/bin/bash\nexit 0\n");
  chmodSync(codesign, 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function build(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["/bin/bash", join(dir, "build.sh"), ...args], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
}

const calls = (): number => (existsSync(join(dir, "swift-calls")) ? readFileSync(join(dir, "swift-calls"), "utf8").trim().split("\n").length : 0);

describe("build.sh --if-stale", () => {
  test("builds when there is no helper, then not again while the sources stay the same", async () => {
    expect((await build("--if-stale")).code).toBe(0);
    expect(calls()).toBe(1);
    expect(existsSync(join(dir, "bin", "sources.sha256"))).toBe(true);
    const again = await build("--if-stale");
    expect(again.code).toBe(0);
    expect(again.out).toContain("up to date");
    expect(calls()).toBe(1);
  });

  test("builds again when a source changed, and when the stamp is missing", async () => {
    await build("--if-stale");
    writeFileSync(join(dir, "Sources", "ademark-native", "main.swift"), "print(2)\n");
    await build("--if-stale");
    expect(calls()).toBe(2);
    rmSync(join(dir, "bin", "sources.sha256"));
    await build("--if-stale");
    expect(calls()).toBe(3);
  });

  test("with no flag it always builds", async () => {
    await build();
    await build();
    expect(calls()).toBe(2);
  });
});

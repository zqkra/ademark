import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ZONES = ["America/Los_Angeles", "UTC", "Asia/Tokyo"] as const;
const files = (process.env.ADEMARK_TZ_FILES ?? "").split("\n").filter((file) => file !== "");

if (files.length === 0) {
  test("W2 time zone runner received files", () => {
    assert.fail("ADEMARK_TZ_FILES is empty");
  });
}

for (const zone of ZONES) {
  test(`W2 dates under TZ=${zone}`, () => {
    const env: NodeJS.ProcessEnv = { ...process.env, TZ: zone };
    delete env.NODE_TEST_CONTEXT;
    const spawned = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 100_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (spawned.error || spawned.status !== 0) {
      const output = `${spawned.stdout ?? ""}${spawned.stderr ?? ""}`;
      assert.fail(`TZ=${zone} failed (exit ${spawned.status ?? "none"}):\n${output.slice(-8000)}`);
    }
  });
}

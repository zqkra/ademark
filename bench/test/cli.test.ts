import { describe, expect, test } from "bun:test";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { main } from "../cli.ts";

const cli = resolve(import.meta.dir, "..", "cli.ts");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("cli", () => {
  test("adapter list prints the 18 adapter IDs", async () => {
    const { code, stdout } = await runCli(["adapter", "list"]);
    expect(code).toBe(0);
    const ids = stdout.trim().split("\n").map((line) => line.split(/\s+/)[0]!);
    expect(ids.length).toBe(18);
    expect(ids).toContain("t3code");
    expect(ids).toContain("bare-cli");
  }, 30000);

  test("adapter check passes for t3code and bare-cli", async () => {
    for (const id of ["t3code", "bare-cli"]) {
      const { code, stdout } = await runCli(["adapter", "check", id]);
      expect({ id, code }).toEqual({ id, code: 0 });
      expect(stdout).toContain("conforms");
      expect(stdout).toContain("missing");
    }
  }, 60000);

  test("adapter check rejects an unknown id", async () => {
    const { code, stderr } = await runCli(["adapter", "check", "no-such-ade"]);
    expect(code).toBe(2);
    expect(stderr).toContain("adapter file not found");
  }, 30000);

  test("order is stable for a seed", async () => {
    const first = await runCli(["order", "--seed", "test"]);
    const second = await runCli(["order", "--seed", "test"]);
    expect(first.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    const parsed = JSON.parse(first.stdout) as { seed: string; order: string[] };
    expect(parsed.seed).toBe("test");
    expect(parsed.order.length).toBe(18);
  }, 30000);

  test("order needs a seed", async () => {
    const { code, stderr } = await runCli(["order"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--seed");
  }, 30000);

  test("gates prints the JSON shape", async () => {
    const { code, stdout } = await runCli(["gates"]);
    expect(code).toBe(0);
    const gates = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(gates).sort()).toEqual([
      "cpu_cores_used", "cpu_quiet_ok", "cpu_samples", "cpu_top", "swap_ok", "swap_used_mb", "thermal_ok",
    ]);
    expect(typeof gates.swap_ok).toBe("boolean");
  }, 60000);

  test("run without --dry-run is refused outside the ademark user", async () => {
    if (userInfo().username === "ademark") return;
    const { code, stderr } = await runCli(["run", "--ade", "t3code", "--tracks", "A"]);
    expect(code).toBe(2);
    expect(stderr).toContain("refusing to measure");
    expect(stderr).toContain("ademark");
  }, 30000);

  test("run refuses --smoke outside --tracks A", async () => {
    for (const tracks of ["A,B", "B", "C"]) {
      const { code, stderr } = await runCli(["run", "--ade", "t3code", "--tracks", tracks, "--dry-run", "--smoke"]);
      expect({ tracks, code }).toEqual({ tracks, code: 2 });
      expect(stderr).toContain("--smoke is only allowed with --tracks A");
    }
    const defaultTracks = await runCli(["run", "--ade", "t3code", "--dry-run", "--smoke"]);
    expect(defaultTracks.code).toBe(2);
    expect(defaultTracks.stderr).toContain("--smoke is only allowed with --tracks A");
  }, 30000);

  test("run refuses --reference together with --dry-run", async () => {
    const { code, stderr } = await runCli(["run", "--ade", "t3code", "--dry-run", "--reference"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--reference cannot be combined with --dry-run");
  }, 30000);

  test("calibrate gate rejects an unknown ade and a bad --runs", async () => {
    const unknown = await runCli(["calibrate", "gate", "--ade", "no-such-ade", "--dry-run"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown adapter");
    for (const runs of ["0", "two"]) {
      const bad = await runCli(["calibrate", "gate", "--ade", "t3code", "--runs", runs, "--dry-run"]);
      expect({ runs, code: bad.code }).toEqual({ runs, code: 2 });
      expect(bad.stderr).toContain("--runs must be a positive integer");
    }
  }, 30000);

  test("night rejects tracks outside A,B,C and a --until that is not HH:MM", async () => {
    const tracks = await runCli(["night", "--tracks", "A,Z", "--dry-run"]);
    expect(tracks.code).toBe(2);
    expect(tracks.stderr).toContain("subset of A,B,C");
    const until = await runCli(["night", "--until", "25:00", "--dry-run"]);
    expect(until.code).toBe(2);
    expect(until.stderr).toContain("HH:MM");
  }, 30000);

  test("night without --dry-run is refused outside the ademark user", async () => {
    if (userInfo().username === "ademark") return;
    const { code, stderr } = await runCli(["night", "--tracks", "A"]);
    expect(code).toBe(2);
    expect(stderr).toContain("refusing to measure");
    expect(stderr).toContain("ademark");
  }, 30000);

  test("an unknown command prints help and exits 2", async () => {
    const { code, stderr } = await runCli(["frobnicate"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown command: frobnicate");
    expect(stderr).toContain("Usage:");
  }, 30000);

  test("no command prints help", async () => {
    const { code, stdout } = await runCli([]);
    expect(code).toBe(2);
    expect(stdout).toContain("Usage:");
  }, 30000);

  test("main() is callable in process", async () => {
    expect(await main(["help"])).toBe(0);
    expect(await main(["run"])).toBe(2);
  }, 30000);
});

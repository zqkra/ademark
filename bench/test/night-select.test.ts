import { describe, expect, test } from "bun:test";
import type { Adapter, CalibrationGate, InstallInfo } from "../core/contracts.ts";
import { loginPath, selectAdes } from "../night/select.ts";
import { makeFixtureAdapter } from "./fixtures/run/adapter.ts";

const HOME = "/Users/ademark";
const INSTALLED: InstallInfo = { installed: true, version: "1.0.0", path: "/Applications/A.app", binarySha256: "a".repeat(64) };

function gate(patch: Partial<CalibrationGate> = {}): CalibrationGate {
  return {
    ade: "ade",
    runs: 5,
    passed: 5,
    at: "2026-10-21T00:00:00.000Z",
    harnessCommit: "abc1234",
    version: "1.0.0",
    bundleSha256: "a".repeat(64),
    failures: [],
    ...patch,
  };
}

function adapter(
  id: string,
  options: { installed?: boolean; login?: Adapter["login"] } = {},
): Adapter {
  const base = makeFixtureAdapter({ id });
  const info: InstallInfo = options.installed === false
    ? { installed: false, version: null, path: null, binarySha256: null }
    : INSTALLED;
  return {
    ...base,
    installCheck: async () => info,
    login: "login" in options ? options.login : { kind: "app", files: ["~/session.json"], signIn: "Sign in" },
  };
}

async function select(
  adapters: Adapter[],
  options: { gates?: Record<string, CalibrationGate>; files?: string[]; unreadable?: string } = {},
) {
  return await selectAdes({
    adapters,
    readGate: (id) => {
      if (options.unreadable === id) throw new Error(`${id}.json: not valid JSON`);
      return options.gates?.[id] ?? null;
    },
    exists: (path) => (options.files ?? [`${HOME}/session.json`]).includes(path),
    home: HOME,
  });
}

describe("night ADE selection", () => {
  test("a good ADE is chosen", async () => {
    const result = await select([adapter("good")], { gates: { good: gate() } });
    expect(result.chosen.map((entry) => entry.id)).toEqual(["good"]);
    expect(result.skipped).toEqual([]);
  });

  test("ungated chooses an ADE without a passed gate but still needs its install and login", async () => {
    const result = await selectAdes({
      adapters: [adapter("nogate"), adapter("failed"), adapter("gone", { installed: false }), adapter("nologin")],
      ungated: true,
      readGate: (id) => (id === "failed" ? gate({ passed: 0 }) : null),
      exists: (path) => path === `${HOME}/session.json`,
      home: HOME,
    });
    expect(result.chosen.map((entry) => entry.id)).toEqual(["nogate", "failed", "nologin"]);
    expect(result.skipped).toEqual([{ ade: "gone", reason: "not installed" }]);
  });

  test("a missing install is skipped", async () => {
    const result = await select([adapter("missing", { installed: false })]);
    expect(result.skipped).toEqual([{ ade: "missing", reason: "not installed" }]);
  });

  test("a missing gate is skipped with the command that fixes it", async () => {
    const result = await select([adapter("ungated")]);
    expect(result.skipped).toEqual([
      { ade: "ungated", reason: "no gate: ademark calibrate gate --ade ungated" },
    ]);
  });

  test("a failed gate is skipped with its count", async () => {
    const result = await select([adapter("broken")], { gates: { broken: gate({ passed: 3 }) } });
    expect(result.skipped).toEqual([{ ade: "broken", reason: "gate failed: 3 of 5 smoke runs passed" }]);
  });

  test("a stale gate is skipped with both versions", async () => {
    const result = await select([adapter("old")], { gates: { old: gate({ version: "0.9.0" }) } });
    expect(result.skipped).toEqual([
      { ade: "old", reason: "gate stale: it measured 0.9.0, installed 1.0.0" },
    ]);
  });

  test("a gate record that cannot be read is skipped", async () => {
    const result = await select([adapter("json")], { unreadable: "json" });
    expect(result.skipped[0]!.ade).toBe("json");
    expect(result.skipped[0]!.reason).toContain("gate unreadable: json.json: not valid JSON");
  });

  test("a missing login spec is skipped", async () => {
    const result = await select([adapter("nologin", { login: undefined })], { gates: { nologin: gate() } });
    expect(result.skipped).toEqual([{ ade: "nologin", reason: "login not calibrated" }]);
  });

  test("a login file that does not exist is skipped", async () => {
    const result = await select([adapter("signed")], {
      gates: { signed: gate() },
      files: [],
    });
    expect(result.skipped).toEqual([{ ade: "signed", reason: "login file missing: ~/session.json" }]);
  });

  test("every adapter gets the same rule, the code adapters included", async () => {
    const result = await select(
      [adapter("bare-cli"), adapter("t3code", { installed: false }), adapter("zeron")],
      { gates: { "bare-cli": gate(), zeron: gate({ passed: 4 }) } },
    );
    expect(result.chosen.map((entry) => entry.id)).toEqual(["bare-cli"]);
    expect(result.skipped.map((entry) => entry.ade)).toEqual(["t3code", "zeron"]);
  });

  test("login paths expand only a leading tilde", () => {
    expect(loginPath("~", HOME)).toBe(HOME);
    expect(loginPath("~/.t3/userdata", HOME)).toBe(`${HOME}/.t3/userdata`);
    expect(loginPath("/tmp/x", HOME)).toBe("/tmp/x");
    expect(loginPath("~x/y", HOME)).toBe("~x/y");
  });
});

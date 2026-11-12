import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OPS = resolve(import.meta.dir, "..", "ops");
const MACHINE = join(OPS, "machine.zsh");
const INSTALLER = join(OPS, "install-machine.zsh");
const VALIDATION = /# >>> argument validation[^\n]*\n([\s\S]*?)# <<< argument validation <<</;

function extractValidation(): string {
  const text = readFileSync(MACHINE, "utf8");
  const match = text.match(VALIDATION);
  if (match === null) throw new Error("machine.zsh has no argument validation markers");
  return match[1]!;
}

function zshSyntax(path: string): { code: number; stderr: string } {
  const result = Bun.spawnSync(["zsh", "-n", path], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode ?? 1, stderr: result.stderr.toString() };
}

describe("machine.zsh syntax", () => {
  test("the root script parses", () => {
    expect(zshSyntax(MACHINE)).toEqual({ code: 0, stderr: "" });
  });

  test("the installer parses", () => {
    expect(zshSyntax(INSTALLER)).toEqual({ code: 0, stderr: "" });
  });

  test("the root script fixes PATH and starts with errexit, nounset and pipefail", () => {
    const text = readFileSync(MACHINE, "utf8");
    expect(text).toContain("set -euo pipefail");
    expect(text).toContain("PATH=/usr/bin:/bin:/usr/sbin:/sbin");
    expect(text).toContain("readonly ANCHOR=com.apple/ademark");
  });

  test("pf-block keeps the enable token and pf-clear releases it", () => {
    const text = readFileSync(MACHINE, "utf8");
    expect(text).toContain("readonly PF_TOKEN_FILE=$STATE_DIR/pf.token");
    expect(text).toContain("-a \"$ANCHOR\" -F all");
    expect(text).toContain("/sbin/pfctl -X \"$token\"");
    expect(text).toContain("'^[0-9]{1,20}$'");
  });
});

describe("machine.zsh argument whitelist", () => {
  const dir = mkdtempSync(join(tmpdir(), "ademark-machine-args-"));
  const validation = join(dir, "validation.zsh");
  writeFileSync(validation, extractValidation());

  function validate(args: readonly string[]): number {
    const command = `source ${JSON.stringify(validation)}; validate_machine_args "$@"`;
    const result = Bun.spawnSync(["zsh", "-f", "-c", command, "zsh", ...args], { stdout: "pipe", stderr: "pipe" });
    return result.exitCode ?? 1;
  }

  test("accepts the fixed subcommands with no arguments", () => {
    for (const command of ["on", "off", "status", "purge", "pf-clear"]) expect(validate([command])).toBe(0);
  });

  test("accepts 1 to 64 pids", () => {
    expect(validate(["footprint", "1"])).toBe(0);
    expect(validate(["footprint", "0", "42", "9999999"])).toBe(0);
    const sixtyFour = Array.from({ length: 64 }, (_, index) => String(index + 1));
    expect(validate(["footprint", ...sixtyFour])).toBe(0);
    expect(validate(["footprint", ...sixtyFour, "65"])).toBe(2);
  });

  test("rejects a bad pid", () => {
    expect(validate(["footprint"])).toBe(2);
    expect(validate(["footprint", "abc"])).toBe(2);
    expect(validate(["footprint", "-1"])).toBe(2);
    expect(validate(["footprint", "12345678"])).toBe(2);
    expect(validate(["footprint", "1 2"])).toBe(2);
  });

  test("accepts strict IPv4 and IPv6 literals", () => {
    for (const address of [
      "1.2.3.4", "0.0.0.0", "255.255.255.255", "::1", "::", "fe80::1", "2001:db8::1", "::ffff:192.168.0.1", "::1.2.3.4",
      "1:2:3:4:5:6:1.2.3.4",
    ]) {
      expect({ address, code: validate(["pf-block", address]) }).toEqual({ address, code: 0 });
    }
    const thirtyTwo = [...Array.from({ length: 29 }, (_, index) => `10.0.0.${index + 1}`), "2001:db8::1", "::1", "::"];
    expect(validate(["pf-block", ...thirtyTwo])).toBe(0);
    expect(validate(["pf-block", ...thirtyTwo, "10.0.0.99"])).toBe(2);
  });

  test("rejects anything that is not a literal address", () => {
    for (const address of [
      "999.1.1.1",
      "1.2.3",
      "1.2.3.4.5",
      "01.2.3.4",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9",
      "2001:db8:::1",
      "1::2::3",
      "::ffff:999.1.1.1",
      "1.2.3.4::",
      "1.2.3.4::1",
      "1:2:1.2.3.4:3:4:5:6",
      "1.2.3.4;rm",
      "$(id)",
      "example.com",
      "",
    ]) {
      expect({ address, code: validate(["pf-block", address]) }).toEqual({ address, code: 2 });
    }
  });

  test("rejects unknown or overlong argument lists", () => {
    expect(validate([])).toBe(2);
    expect(validate(["unknown"])).toBe(2);
    expect(validate(["on", "extra"])).toBe(2);
    expect(validate(["status", "--apply"])).toBe(2);
    expect(validate(["pf-block"])).toBe(2);
    expect(validate(["pf-block", "1.2.3.4", "5.6.7.8"])).toBe(0);
  });

  test("cleans up", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

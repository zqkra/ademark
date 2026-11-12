// `ademark doctor`: about 25 checks before a night. Every command goes through a fake-able runner.
import { basename, join } from "node:path";
import { listAdapters } from "../adapters/registry.ts";
import { gateStatus, readGate } from "../adapters/gates.ts";
import { parseVersionOutput } from "../adapters/support.ts";
import type { Adapter, Agent, CalibrationGate, InstallInfo } from "../core/contracts.ts";
import type { Gates } from "../core/gates.ts";
import { checkGates } from "../core/gates.ts";
import { parseDisplay } from "../core/manifest.ts";
import { nativeBinary } from "../core/native.ts";
import { privateRoot, repoRoot, resultsRoot } from "../core/paths.ts";
import { cleanSnapshotDir } from "../adapters/support.ts";
import { ADEMARK_USER, DISPLAYPLACER, parseDisplayplacerMode } from "./machine.ts";
import { MACHINE_BIN, parseKeyValue, statusMatchesOn } from "./machine-state.ts";
import { checkAccount, type AccountItem } from "./account.ts";
import { defaultOpsRunner, type OpsRunner } from "./runner.ts";

export type CheckStatus = "ok" | "fail" | "warn" | "skip";

export interface CheckOutcome {
  status: CheckStatus;
  detail: string;
  fix: string;
}

export interface DoctorCheck {
  name: string;
  blocking: boolean;
  run: (ctx: DoctorContext) => CheckOutcome | Promise<CheckOutcome>;
}

export interface CheckResult extends CheckOutcome {
  name: string;
  blocking: boolean;
}

export interface DoctorAdapter {
  id: string;
  adapter: Adapter;
}

/** Free space a night needs on the results volume, with room for receipts and moved-aside app data. */
export const MIN_FREE_GB = 8;

export interface DoctorContext {
  runner: OpsRunner;
  username: string;
  isAdemark: boolean;
  home: string;
  privateRoot: string;
  repoRoot: string;
  resultsRoot: string;
  nativePath: string;
  adapters: DoctorAdapter[];
  agents: readonly Agent[] | null;
  ignoreSwap: boolean;
  gates: () => Promise<Gates> | Gates;
  account: (runner: OpsRunner) => AccountItem[];
}

export interface Pin {
  version?: string;
  binary_sha256?: string;
  bundle_id?: string;
}

export interface PinsFile {
  apps?: Record<string, Pin>;
  clis?: Record<string, Pin>;
  agents?: Record<string, Pin>;
  [key: string]: unknown;
}

export function readPins(runner: OpsRunner, privateRootPath: string): PinsFile | null {
  const text = runner.readFile(join(privateRootPath, "pins", "versions.json"));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as PinsFile;
  } catch {
    return null;
  }
}

export function pinFor(pins: PinsFile | null, id: string): Pin | null {
  if (pins === null) return null;
  return pins.clis?.[id] ?? pins.agents?.[id] ?? pins.apps?.[id] ?? null;
}

export function parseForegroundApps(text: string): string[] {
  const names = new Set<string>();
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^\s*\d+\)\s+"([^"]+)"\s+ASN:/);
    if (head) {
      current = head[1]!;
      continue;
    }
    if (current !== null && /type="Foreground"/.test(line)) names.add(current);
  }
  return [...names];
}

export function parseGhosttyRssMb(text: string): number {
  let kb = 0;
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s+(\d+)\s*$/);
    if (!match) continue;
    if (basename(match[2]!).toLowerCase() === "ghostty") kb += Number(match[3]);
  }
  return kb / 1024;
}

export function dfAvailableKb(text: string): number | null {
  const lines = text.trim().split("\n");
  const last = lines[lines.length - 1]?.trim();
  if (last === undefined) return null;
  const available = Number(last.split(/\s+/)[3]);
  return Number.isFinite(available) ? available : null;
}

export function parseLowPowerMode(text: string): number | null {
  const match = text.match(/^[ \t]*lowpowermode[ \t]+(\d+)/m);
  return match ? Number(match[1]) : null;
}

function ok(detail: string): CheckOutcome {
  return { status: "ok", detail, fix: "" };
}

function fail(detail: string, fix: string): CheckOutcome {
  return { status: "fail", detail, fix };
}

function warn(detail: string, fix: string): CheckOutcome {
  return { status: "warn", detail, fix };
}

function skip(): CheckOutcome {
  return { status: "skip", detail: "not the ademark user", fix: "" };
}

function firstLines(values: readonly string[], limit = 6): string {
  if (values.length <= limit) return values.join("; ");
  return `${values.slice(0, limit).join("; ")}; ... ${values.length - limit} more`;
}

interface DisplayReading {
  hz: number;
  detail: string;
}

function profilerDisplay(runner: OpsRunner): DisplayReading | { error: string } {
  const result = runner.run(["system_profiler", "SPDisplaysDataType", "-json"]);
  if (result.code !== 0) return { error: result.stderr.trim() || "system_profiler failed" };
  try {
    const display = parseDisplay(result.stdout);
    return { hz: display.refresh_hz, detail: `${display.width}x${display.height}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function displayplacerDisplay(runner: OpsRunner): DisplayReading | { error: string } {
  const result = runner.run([DISPLAYPLACER, "list"]);
  if (result.code !== 0) return { error: result.stderr.trim() || "displayplacer list failed" };
  const mode = parseDisplayplacerMode(result.stdout);
  if (mode === null) return { error: "displayplacer list printed no current mode" };
  const hz = mode.match(/\bhz:(\d+(?:\.\d+)?)\b/);
  if (hz === null) return { error: "displayplacer list printed no refresh rate" };
  const resolution = mode.match(/\bres:(\S+)/);
  return { hz: Number(hz[1]), detail: resolution ? resolution[1]! : "main display" };
}

function runStatus(runner: OpsRunner): { ok: boolean; output: string; detail: string } {
  const result = runner.run(["sudo", "-n", MACHINE_BIN, "status"]);
  if (result.code !== 0) {
    return { ok: false, output: "", detail: result.stderr.trim() || result.stdout.trim() || `exit ${result.code}` };
  }
  return { ok: true, output: result.stdout, detail: "" };
}

function envKeys(runner: OpsRunner): string[] {
  const keys = new Set<string>();
  for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) {
    const value = runner.env(name);
    if (value !== undefined && value.length > 0) keys.add(name);
  }
  for (const name of runner.envWithPrefix("CODEX_")) keys.add(name);
  return [...keys].sort();
}

const SEED_ADAPTERS: Record<string, readonly string[]> = {
  t3code: [".t3/userdata"],
  zeron: [".zeron/profiles/local"],
};

export const CHECKS: readonly DoctorCheck[] = [
  {
    name: "running as ademark",
    blocking: true,
    run: (ctx) =>
      ctx.username === ADEMARK_USER
        ? ok(`user ${ctx.username}`)
        : fail(
            `current user: ${ctx.username}`,
            "Log out and log in as the ademark user (RUNBOOK.md 4.1).",
          ),
  },
  {
    name: "not inside an agent session",
    blocking: true,
    run: (ctx) => {
      const keys = envKeys(ctx.runner);
      if (keys.length === 0) return ok("no CLAUDECODE, CLAUDE_CODE_ENTRYPOINT or CODEX_* variable");
      return fail(`set: ${keys.join(", ")}`, "Quit Ghostty and open it from the Dock (RUNBOOK.md 4.10).");
    },
  },
  {
    name: "root script installed and allowed",
    blocking: true,
    run: (ctx) => {
      if (!ctx.isAdemark) return skip();
      const status = runStatus(ctx.runner);
      if (status.ok) return ok("sudo -n /usr/local/libexec/ademark-machine status works");
      return fail(status.detail, "sudo zsh bench/ops/install-machine.zsh");
    },
  },
  {
    name: "machine state on",
    blocking: true,
    run: (ctx) => {
      if (!ctx.isAdemark) return skip();
      const status = runStatus(ctx.runner);
      if (!status.ok) return fail(`cannot read machine state: ${status.detail}`, "sudo zsh bench/ops/install-machine.zsh");
      const check = statusMatchesOn(parseKeyValue(status.output));
      if (check.ok) return ok("Spotlight, power, updates and Time Machine are off");
      return fail(firstLines(check.failures), "ademark machine on --apply");
    },
  },
  {
    name: "display at 60 Hz",
    blocking: true,
    run: (ctx) => {
      let reading = profilerDisplay(ctx.runner);
      if ("error" in reading) {
        if (!ctx.runner.exists(DISPLAYPLACER)) {
          return fail(reading.error, "Check the main display in System Settings, or install displayplacer.");
        }
        reading = displayplacerDisplay(ctx.runner);
      }
      if ("error" in reading) {
        return fail(reading.error, "Check the main display in System Settings.");
      }
      if (reading.hz !== 60) {
        return fail(
          `${reading.detail} @ ${reading.hz} Hz`,
          "ademark machine on --apply, or System Settings > Displays > Refresh rate: 60 Hertz",
        );
      }
      if (!ctx.runner.exists(DISPLAYPLACER)) {
        return warn(
          `${reading.detail} @ 60 Hz, but displayplacer is not installed`,
          "brew install displayplacer, or keep 60 Hz by hand in System Settings > Displays.",
        );
      }
      return ok(`${reading.detail} @ 60 Hz`);
    },
  },
  {
    name: "ademark-native built and permitted",
    blocking: true,
    run: (ctx) => {
      if (!ctx.runner.exists(ctx.nativePath)) {
        return fail(`not built at ${ctx.nativePath}`, "bash bench/native/build.sh");
      }
      const result = ctx.runner.run([ctx.nativePath, "permissions"]);
      if (result.code !== 0) {
        return fail(result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`, "bash bench/native/build.sh");
      }
      try {
        const permissions = JSON.parse(result.stdout) as { accessibility?: boolean; screen_recording?: boolean };
        const missing = [
          permissions.accessibility === true ? null : "Accessibility",
          permissions.screen_recording === true ? null : "Screen & System Audio Recording",
        ].filter((entry): entry is string => entry !== null);
        if (missing.length === 0) return ok("Accessibility and Screen & System Audio Recording");
        return fail(
          `missing: ${missing.join(", ")}`,
          "RUNBOOK.md 4.11: System Settings > Privacy & Security, give Ghostty and ademark-native both grants.",
        );
      } catch {
        return fail("ademark-native permissions printed no JSON", "bash bench/native/build.sh");
      }
    },
  },
  {
    name: "Ghostty memory",
    blocking: true,
    run: (ctx) => {
      const result = ctx.runner.run(["ps", "-axo", "pid=,comm=,rss="]);
      if (result.code !== 0) return fail(result.stderr.trim() || "ps failed", "Quit Ghostty and open it from the Dock.");
      const mb = parseGhosttyRssMb(result.stdout);
      if (mb === 0) return ok("Ghostty is not running");
      if (mb < 400) return ok(`${mb.toFixed(0)} MB`);
      return fail(`${mb.toFixed(0)} MB >= 400 MB`, "Quit Ghostty and open it again from the Dock.");
    },
  },
  {
    name: "other GUI apps",
    blocking: true,
    run: (ctx) => {
      const result = ctx.runner.run(["lsappinfo", "list"]);
      if (result.code !== 0) return warn("lsappinfo is not available", "Quit every app except Ghostty and Finder.");
      const others = parseForegroundApps(result.stdout).filter((name) => name !== "Ghostty" && name !== "Finder");
      if (others.length === 0) return ok("only Ghostty and Finder");
      return fail(`running: ${others.join(", ")}`, `Quit them: ${others.join(", ")}.`);
    },
  },
  {
    name: "account items",
    blocking: true,
    run: (ctx) => {
      const items = ctx.account(ctx.runner);
      const bad = items.filter((entry) => entry.status === "missing" || entry.status === "differs");
      if (bad.length === 0) return ok(`${items.length} items ok`);
      return fail(`missing or differs: ${bad.map((entry) => entry.name).join(", ")}`, "ademark account setup --apply");
    },
  },
  {
    name: "claude and codex versions",
    blocking: true,
    run: (ctx) => {
      const pins = readPins(ctx.runner, ctx.privateRoot);
      if (pins === null) return warn("pins/versions.json is not readable", "Copy ~/ademark-private to this user (RUNBOOK.md 4.1).");
      const failures: string[] = [];
      const warnings: string[] = [];
      for (const name of ["claude", "codex"]) {
        const pin = pinFor(pins, name);
        if (pin === null || pin.version === undefined) {
          warnings.push(`${name}: no pin`);
          continue;
        }
        const result = ctx.runner.run([name, "--version"]);
        if (result.code !== 0) {
          failures.push(`${name}: not installed`);
          continue;
        }
        const version = parseVersionOutput(result.stdout);
        if (version === null) failures.push(`${name}: cannot parse --version`);
        else if (version !== pin.version) failures.push(`${name}: ${version} != ${pin.version}`);
      }
      if (failures.length > 0) return fail(firstLines(failures), "Install the pinned build from pins/ (RUNBOOK.md 4.2).");
      if (warnings.length > 0) return warn(firstLines(warnings), "Record claude and codex in pins/versions.json.");
      return ok("claude and codex match their pins");
    },
  },
  {
    name: "Claude login",
    blocking: true,
    run: (ctx) => {
      const result = ctx.runner.run(["security", "find-generic-password", "-s", "Claude Code-credentials"]);
      if (result.code === 0) return ok("Claude Code-credentials is in the keychain");
      return fail("Claude Code-credentials not found", "Run `claude` once and log in with the dedicated account (RUNBOOK.md 4.2).");
    },
  },
  {
    name: "Codex login",
    blocking: true,
    run: (ctx) => {
      if (ctx.agents !== null && !ctx.agents.includes("codex")) {
        return { status: "skip", detail: `Codex is not measured (--agent ${ctx.agents.join(",")})`, fix: "" };
      }
      const path = join(ctx.home, ".codex", "auth.json");
      if (ctx.runner.exists(path)) return ok("~/.codex/auth.json exists");
      return fail("~/.codex/auth.json is absent", "codex login");
    },
  },
  {
    name: "adapter installs",
    // Not blocking: each block checks its ADE against the pin and stops only that ADE (bench/run/loop.ts), so one app
    // that updated itself no longer stops the whole night.
    blocking: false,
    run: async (ctx) => {
      const pins = readPins(ctx.runner, ctx.privateRoot);
      const failures: string[] = [];
      const warnings: string[] = [];
      for (const entry of ctx.adapters) {
        let installed: InstallInfo;
        try {
          installed = await entry.adapter.installCheck();
        } catch (error) {
          failures.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (!installed.installed) {
          failures.push(`${entry.id}: not installed`);
          continue;
        }
        const pin = pinFor(pins, entry.id);
        if (pin === null) {
          warnings.push(`${entry.id}: no pin`);
          continue;
        }
        if (pin.version !== undefined && installed.version !== pin.version) {
          failures.push(`${entry.id}: ${installed.version ?? "no version"} != ${pin.version}`);
        }
        if (pin.binary_sha256 !== undefined && installed.binarySha256 !== pin.binary_sha256) {
          failures.push(`${entry.id}: SHA-256 differs from the pin`);
        }
      }
      if (failures.length > 0) return fail(firstLines(failures), "Install the pinned build from pins/ (RUNBOOK.md 4.3).");
      if (warnings.length > 0) return warn(firstLines(warnings), "Record every ADE in pins/versions.json.");
      return ok(`${ctx.adapters.length} adapters at their pins`);
    },
  },
  {
    name: "adapter logins",
    // Not blocking: the night skips an ADE whose login file is missing (bench/night/select.ts).
    blocking: false,
    run: (ctx) => {
      const failures: string[] = [];
      const warnings: string[] = [];
      const fixes: string[] = [];
      for (const entry of ctx.adapters) {
        const login = entry.adapter.login;
        if (login === undefined) {
          warnings.push(`${entry.id}: login not calibrated`);
          fixes.push(`calibrate ${entry.id}`);
          continue;
        }
        if (login.kind !== "app") continue;
        for (const file of login.files) {
          const path = file === "~" ? ctx.home : file.startsWith("~/") ? join(ctx.home, file.slice(2)) : file;
          if (!ctx.runner.exists(path)) {
            failures.push(`${entry.id}: ${file}`);
            fixes.push(login.signIn ?? `calibrate ${entry.id}`);
          }
        }
      }
      if (failures.length > 0) return fail(firstLines(failures), firstLines(fixes, 3));
      if (warnings.length > 0) return warn(firstLines(warnings), firstLines(fixes, 3));
      return ok(`${ctx.adapters.length} adapters define a login`);
    },
  },
  {
    name: "calibration gates",
    blocking: false,
    run: async (ctx) => {
      const notOk: string[] = [];
      for (const entry of ctx.adapters) {
        let installed: InstallInfo;
        try {
          installed = await entry.adapter.installCheck();
        } catch {
          notOk.push(`${entry.id}: install check failed`);
          continue;
        }
        if (!installed.installed) continue;
        let gate: CalibrationGate | null;
        try {
          gate = readGate(entry.id);
        } catch {
          notOk.push(`${entry.id}: unreadable`);
          continue;
        }
        const status = gate === null ? "missing" : gateStatus(gate, installed);
        if (status !== "ok") notOk.push(`${entry.id}: ${status}`);
      }
      if (notOk.length === 0) return ok("every installed ADE passed its calibration gate");
      return warn(`${firstLines(notOk)}; these ADEs will be skipped tonight`, "ademark calibrate gate --ade <id>");
    },
  },
  {
    name: "mitmproxy",
    blocking: true,
    run: (ctx) => {
      const version = ctx.runner.run(["mitmdump", "--version"]);
      if (version.code !== 0) return fail("mitmdump is not installed", "RUNBOOK.md 4.10: brew install mitmproxy");
      const extensions = ctx.runner.run(["systemextensionsctl", "list"]);
      if (extensions.code !== 0) return fail("systemextensionsctl list failed", "RUNBOOK.md 4.10");
      const activated = extensions.stdout
        .split("\n")
        .some((line) => line.toLowerCase().includes("mitmproxy") && line.includes("activated enabled"));
      if (!activated) return fail("Mitmproxy Redirector is not activated enabled", "RUNBOOK.md 4.10: System Settings > General > Login Items & Extensions > Network Extensions.");
      return ok("mitmdump installed; redirector activated enabled");
    },
  },
  {
    name: "no harness variables in launchd",
    blocking: true,
    run: (ctx) => {
      const names = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "CODEX_CA_CERTIFICATE"];
      const found: string[] = [];
      for (const name of names) {
        const result = ctx.runner.run(["launchctl", "getenv", name]);
        if (result.code === 0 && result.stdout.trim().length > 0) found.push(`${name}=${result.stdout.trim()}`);
      }
      if (found.length === 0) return ok("none set");
      return fail(firstLines(found), `launchctl unsetenv ${names.join(" ")}`);
    },
  },
  {
    name: "replay port free",
    blocking: true,
    run: (ctx) => {
      const result = ctx.runner.run(["lsof", "-nP", "-iTCP:8787", "-sTCP:LISTEN"]);
      const lines = result.stdout.trim().split("\n").filter((line) => line.length > 0);
      if (result.code !== 0 || lines.length <= 1) return ok("port 8787 is free");
      return fail(`in use: ${lines[1]}`, "Stop the process listening on port 8787.");
    },
  },
  {
    name: "gates",
    blocking: true,
    run: async (ctx) => {
      let gates: Gates;
      try {
        gates = await ctx.gates();
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error), "Run `ademark gates` and fix the reading.");
      }
      const swapOk = gates.swap_ok || ctx.ignoreSwap;
      if (swapOk && gates.thermal_ok && gates.cpu_quiet_ok) {
        return ok(`swap 0 MB, thermal nominal, CPU ${gates.cpu_cores_used.toFixed(2)} cores`);
      }
      const parts: string[] = [];
      if (!swapOk) parts.push(`swap ${gates.swap_used_mb.toFixed(0)} MB`);
      if (!gates.thermal_ok) parts.push("thermal limited");
      if (!gates.cpu_quiet_ok) parts.push(`CPU ${gates.cpu_cores_used.toFixed(2)} cores`);
      const top = gates.cpu_top ?? [];
      if (top.length > 0) parts.push(`top: ${top.slice(0, 5).join(", ")}`);
      const analyzers = !gates.cpu_quiet_ok && top.some((line) => /mediaanalysisd|photoanalysisd/.test(line));
      return fail(
        parts.join("; "),
        analyzers
          ? "ademark machine on --apply (it pauses mediaanalysisd and photoanalysisd)"
          : "Quit the busy apps and run again (RUNBOOK.md 8).",
      );
    },
  },
  {
    name: "disk space",
    blocking: true,
    run: (ctx) => {
      const target = ctx.runner.exists(ctx.resultsRoot) ? ctx.resultsRoot : ctx.repoRoot;
      const result = ctx.runner.run(["df", "-k", target]);
      if (result.code !== 0) return fail(result.stderr.trim() || "df failed", "Check the results volume.");
      const available = dfAvailableKb(result.stdout);
      if (available === null) return fail("cannot parse df output", "Check the results volume.");
      const gb = available / 1024 / 1024;
      // Measured 2026-11-09: 5 ADEs wrote 116 MB of receipts, and the largest moved-aside copy (Traycer) is 2.6 GB.
      // The limit was 15 GB from a pilot estimate of 4 GB a night. On 2026-11-10 the Mac had 15.2 GB free, and Control
      // runs this check again when the watchdog restarts it, so a small dip would have stopped the night for no need.
      if (gb >= MIN_FREE_GB) return ok(`${gb.toFixed(2)} GB free`);
      return fail(`${gb.toFixed(2)} GB free < ${MIN_FREE_GB} GB`, `Free at least ${MIN_FREE_GB} GB on the results volume.`);
    },
  },
  {
    name: "clean snapshot",
    blocking: true,
    run: (ctx) => {
      const path = cleanSnapshotDir();
      if (ctx.runner.exists(path)) return ok(path);
      return fail("snapshots/clean is absent", "RUNBOOK.md 4.12: bun bench/cli.ts snapshot save --dir snapshots/clean --apply");
    },
  },
  {
    name: "harness tree clean",
    blocking: true,
    run: (ctx) => {
      const status = ctx.runner.run(["git", "-C", ctx.repoRoot, "status", "--porcelain"]);
      if (status.code !== 0) return fail(status.stderr.trim() || "git status failed", "Run git status in the harness.");
      const dirty = status.stdout.trim().split("\n").filter((line) => line.length > 0);
      if (dirty.length > 0) {
        return fail(`${dirty.length} uncommitted file(s)`, "Commit the harness changes before measuring.");
      }
      const head = ctx.runner.run(["git", "-C", ctx.repoRoot, "rev-parse", "--verify", "HEAD"]);
      if (head.code !== 0 || head.stdout.trim().length === 0) return fail("HEAD is not a commit", "Commit the harness.");
      return ok(`HEAD ${head.stdout.trim().slice(0, 7)}`);
    },
  },
  {
    name: "AC power and Low Power Mode off",
    blocking: true,
    run: (ctx) => {
      const battery = ctx.runner.run(["pmset", "-g", "batt"]);
      const power = ctx.runner.run(["pmset", "-g", "custom"]);
      const onAc = battery.code === 0 && battery.stdout.includes("AC Power");
      const low = power.code === 0 ? parseLowPowerMode(power.stdout) : null;
      if (onAc && low === 0) return ok("AC power; Low Power Mode off");
      return fail(
        `${onAc ? "AC power" : "not on AC power"}; Low Power Mode ${low === null ? "unknown" : low}`,
        "Plug in the power adapter and turn Low Power Mode off (System Settings > Battery).",
      );
    },
  },
  {
    name: "Automation for System Events",
    blocking: false,
    run: (ctx) => {
      // Not needed to measure: apps come to the front with `open`. Only the dismissal of a Gatekeeper dialog uses it.
      const result = ctx.runner.run(["osascript", "-e", 'tell application "System Events" to count processes']);
      if (result.code === 0) return ok("System Events answers");
      return warn(
        `osascript failed: ${(result.stderr || result.stdout).trim().slice(0, 120)}`,
        "Optional: run `tccutil reset AppleEvents com.mitchellh.ghostty`, then answer Allow when macOS asks.",
      );
    },
  },
  {
    name: "Do Not Disturb",
    blocking: false,
    run: (ctx) => {
      const result = ctx.runner.run(["defaults", "-currentHost", "read", "com.apple.notificationcenterui", "doNotDisturb"]);
      if (result.code === 0 && result.stdout.trim() === "1") return ok("Do Not Disturb is on");
      return warn("Focus or Do Not Disturb is off or not readable", "Turn on Do Not Disturb (System Settings > Focus).");
    },
  },
  {
    name: "pf anchor empty",
    blocking: true,
    run: (ctx) => {
      if (!ctx.isAdemark) return skip();
      const status = runStatus(ctx.runner);
      if (!status.ok) return fail(status.detail, "sudo zsh bench/ops/install-machine.zsh");
      const anchor = parseKeyValue(status.output)["pf.ademark"] ?? "unknown";
      if (anchor === "empty") return ok("the com.apple/ademark anchor has no rules");
      if (anchor === "unknown") return warn("pf is not readable", "Enable pf with `sudo pfctl -E` or ignore this check.");
      return fail(`the com.apple/ademark anchor has ${anchor}`, `sudo -n ${MACHINE_BIN} pf-clear`);
    },
  },
  {
    name: "seeds",
    blocking: false,
    run: (ctx) => {
      const missing: string[] = [];
      for (const [id, paths] of Object.entries(SEED_ADAPTERS)) {
        for (const path of paths) {
          const seed = join(ctx.privateRoot, "seeds", id, "home", path);
          if (!ctx.runner.exists(seed)) missing.push(`${id}:${path}`);
        }
      }
      if (missing.length === 0) return ok("every seed is present");
      return warn(`missing: ${missing.join(", ")}`, "Save it with ~/ademark-private/ops/save-seed.sh (RUNBOOK.md 4.3).");
    },
  },
];

export interface DoctorOptions {
  runner?: OpsRunner;
  username?: string;
  privateRoot?: string;
  repoRoot?: string;
  resultsRoot?: string;
  nativePath?: string;
  adapters?: readonly DoctorAdapter[];
  gates?: () => Promise<Gates> | Gates;
  account?: (runner: OpsRunner) => AccountItem[];
  checks?: readonly DoctorCheck[];
  quietWaitMs?: number;
  agents?: readonly Agent[];
  /** Track B reads tokens, so a night of only Track B does not need swap at 0. */
  ignoreSwap?: boolean;
}

export function doctorContext(options: DoctorOptions = {}): DoctorContext {
  const runner = options.runner ?? defaultOpsRunner;
  const username = options.username ?? runner.username();
  const agents = options.agents ?? null;
  const adapters = options.adapters
    ? [...options.adapters]
    : listAdapters().map((adapter) => ({ id: adapter.id, adapter }));
  return {
    runner,
    username,
    isAdemark: username === ADEMARK_USER,
    home: runner.home(),
    privateRoot: options.privateRoot ?? privateRoot(),
    repoRoot: options.repoRoot ?? repoRoot,
    resultsRoot: options.resultsRoot ?? resultsRoot(),
    nativePath: options.nativePath ?? nativeBinary(),
    adapters:
      agents === null ? adapters : adapters.filter((entry) => entry.adapter.agents.some((agent) => agents.includes(agent))),
    agents,
    ignoreSwap: options.ignoreSwap === true,
    gates: options.gates ?? (() => checkGates({ quietWaitMs: options.quietWaitMs ?? 0 })),
    account: options.account ?? ((current) => checkAccount(current)),
  };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<{ results: CheckResult[]; exitCode: number }> {
  const ctx = doctorContext(options);
  const checks = options.checks ?? CHECKS;
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      const outcome = await check.run(ctx);
      results.push({ ...outcome, name: check.name, blocking: check.blocking });
    } catch (error) {
      results.push({
        name: check.name,
        blocking: check.blocking,
        status: check.blocking ? "fail" : "warn",
        detail: error instanceof Error ? error.message : String(error),
        fix: "Fix the error above and run doctor again.",
      });
    }
  }
  return { results, exitCode: results.some((entry) => entry.status === "fail" && entry.blocking) ? 1 : 0 };
}

function statusLabel(status: CheckStatus): string {
  if (status === "fail") return "FAIL";
  return status;
}

export function formatDoctorTable(results: readonly CheckResult[]): string {
  const rows = results.map((entry) => [
    statusLabel(entry.status),
    entry.name,
    entry.detail,
    entry.fix,
  ]);
  const header = ["status", "check", "detail", "fix"];
  const widths = header.map((_, column) => Math.max(header[column]!.length, ...rows.map((row) => row[column]!.length)));
  const format = (row: readonly string[]): string =>
    row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  return [format(header), ...rows.map(format)].join("\n");
}

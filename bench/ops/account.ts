// `ademark account check|setup`: settings that live only in the ademark account, set once and kept.
import { join } from "node:path";
import type { AdapterContext } from "../core/contracts.ts";
import { trustClaudeFolder } from "../adapters/macos.ts";
import { assertApplyAllowed } from "../fault/kill-agent.ts";
import { defaultOpsRunner, type OpsRunner } from "./runner.ts";

// RUNBOOK.md 4.10, comments included, exactly as the owner typed it in the pilot.
export const GHOSTTY_CONFIG = `# Clean shell with no rc files; PATH fixed so claude, codex and bun resolve without a profile. CLAUDE_CODE_NO_FLICKER=1
# keeps Claude Code's fullscreen renderer: after a killed start it otherwise falls back to the classic one (pilot).
command = /usr/bin/env PATH=/Users/ademark/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin CLAUDE_CODE_NO_FLICKER=1 /bin/zsh -f
# bare-cli adapter: tabs close without a dialog; reset and quit close every tab but the harness tab.
confirm-close-surface = false
keybind = super+alt+shift+o=close_tab:other
auto-update = off
`;

export const ADOBE_AGENTS = [
  "com.adobe.AdobeCreativeCloud",
  "com.adobe.AdobeDesktopService",
  "com.adobe.ccxprocess",
] as const;
export const ADOBE_FINDER_SYNC = "com.adobe.accmac.ACCFinderSync";
export const MITM_CA_FIX =
  "security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ~/.mitmproxy/mitmproxy-ca-cert.pem";

export type AccountStatus = "ok" | "missing" | "differs" | "skip";

export interface AccountItem {
  name: string;
  status: AccountStatus;
  detail: string;
  fix: string;
}

function item(name: string, status: AccountStatus, detail: string, fix = ""): AccountItem {
  return { name, status, detail, fix };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ghosttyConfigPath(home: string): string {
  return join(home, ".config", "ghostty", "config");
}

export function claudeSettingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

export function codexConfigPath(home: string): string {
  return join(home, ".codex", "config.toml");
}

export function claudeJsonPath(home: string): string {
  return join(home, ".claude.json");
}

export function codexTopLevelValue(text: string, key: string): { found: boolean; value: string | null } {
  const pattern = new RegExp(`^${key}\\s*=\\s*(.*?)\\s*(?:#.*)?$`);
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) break;
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = trimmed.match(pattern);
    if (match) return { found: true, value: match[1]! };
  }
  return { found: false, value: null };
}

// Keep every other top-level key and every table; replace the update key with the pinned false line.
export function setCodexTopLevelFalse(text: string, key = "check_for_update_on_startup"): string {
  const found = codexTopLevelValue(text, key);
  if (found.found && found.value === "false") return text;
  const keyLine = `${key} = false`;
  const lines = text.length === 0 ? [] : text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let firstTable = lines.findIndex((line) => line.trim().startsWith("["));
  if (firstTable < 0) firstTable = lines.length;
  const pattern = new RegExp(`^${key}\\s*=`);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (index < firstTable && pattern.test(line.trim())) continue;
    kept.push(line);
  }
  let insertAt = kept.findIndex((line) => line.trim().startsWith("["));
  if (insertAt < 0) insertAt = kept.length;
  kept.splice(insertAt, 0, keyLine);
  return `${kept.join("\n")}\n`;
}

export function setClaudeAutoUpdater(text: string): string {
  const data = text.trim().length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("settings.json is not an object");
  const env = data.env;
  if (env !== undefined && (typeof env !== "object" || env === null || Array.isArray(env))) {
    throw new Error("settings.json has an env value that is not an object");
  }
  const envObject = (env ?? {}) as Record<string, unknown>;
  if (envObject.DISABLE_AUTOUPDATER === "1") return text;
  data.env = { ...envObject, DISABLE_AUTOUPDATER: "1" };
  return `${JSON.stringify(data, null, 2)}\n`;
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function launchDisabledLabels(runner: OpsRunner): Map<string, boolean> | null {
  const result = runner.run(["launchctl", "print-disabled", `gui/${runner.uid()}`]);
  if (result.code !== 0) return null;
  const labels = new Map<string, boolean>();
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/"([^"]+)"\s*=>\s*(disabled|enabled)/);
    if (match) labels.set(match[1]!, match[2] === "disabled");
  }
  return labels;
}

function adobeInstalled(runner: OpsRunner, label: string): boolean {
  return (
    runner.exists(`/Library/LaunchAgents/${label}.plist`) || runner.exists(`/Library/LaunchDaemons/${label}.plist`)
  );
}

function mitmCaTrusted(runner: OpsRunner): boolean {
  const result = runner.run([
    "security",
    "find-certificate",
    "-a",
    "-c",
    "mitmproxy",
    "-Z",
    join(runner.home(), "Library", "Keychains", "login.keychain-db"),
  ]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

function finderSyncIgnored(runner: OpsRunner): boolean | null {
  const result = runner.run(["pluginkit", "-m", "-i", ADOBE_FINDER_SYNC]);
  if (result.code !== 0) return null;
  const line = result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.includes(ADOBE_FINDER_SYNC));
  if (line === undefined) return null;
  return line.startsWith("-");
}

export function checkAccount(runner: OpsRunner = defaultOpsRunner): AccountItem[] {
  const home = runner.home();
  const items: AccountItem[] = [];
  const setupFix = "ademark account setup --apply";

  const ghostty = runner.readFile(ghosttyConfigPath(home));
  if (ghostty === null) items.push(item("ghostty-config", "missing", "~/.config/ghostty/config is absent", setupFix));
  else if (ghostty !== GHOSTTY_CONFIG) {
    items.push(item("ghostty-config", "differs", "text differs from RUNBOOK.md 4.10", setupFix));
  } else items.push(item("ghostty-config", "ok", "matches RUNBOOK.md 4.10"));

  const claudeText = runner.readFile(claudeSettingsPath(home));
  if (claudeText === null) {
    items.push(item("claude-autoupdater", "missing", "~/.claude/settings.json is absent", setupFix));
  } else {
    const claude = parseJson(claudeText);
    if (claude === null) items.push(item("claude-autoupdater", "differs", "settings.json is not valid JSON", setupFix));
    else {
      const env = typeof claude.env === "object" && claude.env !== null ? (claude.env as Record<string, unknown>) : {};
      const value = env.DISABLE_AUTOUPDATER;
      if (value === "1") items.push(item("claude-autoupdater", "ok", "env.DISABLE_AUTOUPDATER is \"1\""));
      else if (value === undefined) {
        items.push(item("claude-autoupdater", "missing", "env.DISABLE_AUTOUPDATER is absent", setupFix));
      } else items.push(item("claude-autoupdater", "differs", `env.DISABLE_AUTOUPDATER is ${JSON.stringify(value)}`, setupFix));
    }
  }

  const codexText = runner.readFile(codexConfigPath(home));
  if (codexText === null) items.push(item("codex-update-check", "missing", "~/.codex/config.toml is absent", setupFix));
  else {
    const found = codexTopLevelValue(codexText, "check_for_update_on_startup");
    if (!found.found) items.push(item("codex-update-check", "missing", "top-level check_for_update_on_startup is absent", setupFix));
    else if (found.value === "false") items.push(item("codex-update-check", "ok", "check_for_update_on_startup = false"));
    else items.push(item("codex-update-check", "differs", `check_for_update_on_startup = ${found.value}`, setupFix));
  }

  const arena = join(home, "arena");
  const claudeJson = parseJson(runner.readFile(claudeJsonPath(home)));
  const projects = claudeJson?.projects;
  const trusted =
    typeof projects === "object" &&
    projects !== null &&
    typeof (projects as Record<string, unknown>)[arena] === "object" &&
    (projects as Record<string, { hasTrustDialogAccepted?: unknown }>)[arena]?.hasTrustDialogAccepted === true;
  if (!runner.exists(arena)) items.push(item("arena-trusted", "missing", `${arena} is absent`, setupFix));
  else if (claudeJson === null) items.push(item("arena-trusted", "missing", "~/.claude.json is absent or invalid", setupFix));
  else if (!trusted) items.push(item("arena-trusted", "missing", `${arena} is not trusted in ~/.claude.json`, setupFix));
  else items.push(item("arena-trusted", "ok", `${arena} is trusted`));

  const disabled = launchDisabledLabels(runner);
  for (const label of ADOBE_AGENTS) {
    const name = `adobe-agent:${label}`;
    if (!adobeInstalled(runner, label)) {
      items.push(item(name, "skip", "not installed"));
      continue;
    }
    if (disabled === null) {
      items.push(item(name, "differs", "launchctl print-disabled failed", `launchctl disable gui/${runner.uid()}/${label}`));
      continue;
    }
    if (disabled.get(label) === true) items.push(item(name, "ok", "disabled"));
    else items.push(item(name, "missing", "enabled", `launchctl disable gui/${runner.uid()}/${label}`));
  }

  const finder = finderSyncIgnored(runner);
  if (finder === null) items.push(item("adobe-finder-sync", "skip", "not installed"));
  else if (finder) items.push(item("adobe-finder-sync", "ok", "ignored"));
  else {
    items.push(
      item(
        "adobe-finder-sync",
        "missing",
        "Finder extension is enabled",
        `pluginkit -e ignore -i ${ADOBE_FINDER_SYNC}`,
      ),
    );
  }

  if (mitmCaTrusted(runner)) items.push(item("mitmproxy-ca", "ok", "trusted in the login keychain"));
  else {
    items.push(item("mitmproxy-ca", "missing", "not trusted in the login keychain", MITM_CA_FIX));
  }

  return items;
}

function trustArena(runner: OpsRunner): void {
  const arena = join(runner.home(), "arena");
  runner.mkdirp(arena);
  const ctx: AdapterContext = {
    runDir: runner.home(),
    arenaPath: arena,
    worktree: arena,
    home: runner.home(),
    env: {},
    dryRun: false,
    log: (message) => console.log(message),
  };
  trustClaudeFolder(ctx, arena);
}

export function formatAccountTable(items: readonly AccountItem[]): string {
  const header = ["status", "item", "detail", "fix"];
  const rows = items.map((entry) => [entry.status, entry.name, entry.detail, entry.fix]);
  const widths = header.map((_, column) => Math.max(header[column]!.length, ...rows.map((row) => row[column]!.length)));
  const format = (row: readonly string[]): string =>
    row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  return [format(header), ...rows.map(format)].join("\n");
}

export interface AccountOptions {
  apply?: boolean;
  runner?: OpsRunner;
  out?: (line: string) => void;
}

// Dry run prints one plan line per change. With --apply every change is written, and a second run finds nothing to do.
export function setupAccount(options: AccountOptions = {}): AccountItem[] {
  const runner = options.runner ?? defaultOpsRunner;
  const out = options.out ?? ((line: string) => console.log(line));
  const apply = options.apply === true;
  if (apply) assertApplyAllowed({ apply }, "account setup");
  const home = runner.home();
  const runAndReport = (argv: string[]): void => {
    const result = runner.run(argv);
    const detail = result.code === 0 ? "" : ` (exit ${result.code}: ${(result.stderr || result.stdout).trim()})`;
    out(`${result.code === 0 ? "ran" : "failed"}: ${argv.join(" ")}${detail}`);
  };

  for (const entry of checkAccount(runner)) {
    if (entry.status === "ok" || entry.status === "skip") continue;
    if (entry.name === "mitmproxy-ca") {
      out(`manual: ${MITM_CA_FIX}`);
      continue;
    }
    const fix = entry.fix.length > 0 ? entry.fix : "ademark account setup --apply";
    const prefix = apply ? "fix" : "plan";
    out(`${prefix}: ${entry.name}: ${fix}`);

    if (entry.name === "ghostty-config") {
      if (apply) runner.writeFile(ghosttyConfigPath(home), GHOSTTY_CONFIG);
      continue;
    }
    if (entry.name === "claude-autoupdater") {
      const text = runner.readFile(claudeSettingsPath(home)) ?? "";
      try {
        const next = setClaudeAutoUpdater(text);
        if (apply && next !== text) runner.writeFile(claudeSettingsPath(home), next);
      } catch (error) {
        out(`manual: ${entry.name}: ${errorText(error)}`);
      }
      continue;
    }
    if (entry.name === "codex-update-check") {
      const text = runner.readFile(codexConfigPath(home)) ?? "";
      const next = setCodexTopLevelFalse(text);
      if (apply && next !== text) runner.writeFile(codexConfigPath(home), next);
      continue;
    }
    if (entry.name === "arena-trusted") {
      if (apply) trustArena(runner);
      continue;
    }
    if (entry.name.startsWith("adobe-agent:")) {
      if (apply) {
        const label = entry.name.slice("adobe-agent:".length);
        runAndReport(["launchctl", "disable", `gui/${runner.uid()}/${label}`]);
      }
      continue;
    }
    if (entry.name === "adobe-finder-sync") {
      if (apply) runAndReport(["pluginkit", "-e", "ignore", "-i", ADOBE_FINDER_SYNC]);
    }
  }

  return checkAccount(runner);
}

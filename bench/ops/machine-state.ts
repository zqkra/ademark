// The before.env format and the status comparison, shared by `machine`, `doctor` and their tests.
// The root script writes before.env and prints status; these pure functions read both back.

export const MACHINE_BIN = "/usr/local/libexec/ademark-machine";
export const MACHINE_STATE_DIR = "/var/db/ademark-machine";
export const MACHINE_STATE_FILE = `${MACHINE_STATE_DIR}/before.env`;
export const MACHINE_BLOCK_FILE = `${MACHINE_STATE_DIR}/block.conf`;
export const UPDATE_PLIST = "/Library/Preferences/com.apple.SoftwareUpdate";
export const POWER_KEYS = ["powernap", "sleep", "displaysleep", "disksleep"] as const;
export const UPDATE_KEYS = [
  "AutomaticDownload",
  "AutomaticallyInstallMacOSUpdates",
  "AutomaticCheckEnabled",
  "ConfigDataInstall",
  "CriticalUpdateInstall",
] as const;

export function parseKeyValue(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    out[line.slice(0, equals)] = line.slice(equals + 1);
  }
  return out;
}

export interface SpotlightEntry {
  volume: string;
  enabled: boolean;
}

// `mdutil -a -s` records one volume per pair of keys. The index keeps two volumes with the same path apart.
export function spotlightEntries(before: Record<string, string>): SpotlightEntry[] {
  const entries: SpotlightEntry[] = [];
  for (let index = 0; index < 256; index++) {
    const volume = before[`spotlight.${index}.volume`];
    const enabled = before[`spotlight.${index}.enabled`];
    if (volume === undefined) continue;
    entries.push({ volume, enabled: enabled === "1" });
  }
  return entries;
}

export interface RestoreStep {
  description: string;
  argv: string[];
}

function boolArg(value: string): string | null {
  if (value === "1" || value.toLowerCase() === "true") return "true";
  if (value === "0" || value.toLowerCase() === "false") return "false";
  return null;
}

// Every recorded value, in the order `machine off` restores it. "absent" means the key was not there, so it is deleted.
export function restorePlan(before: Record<string, string>): RestoreStep[] {
  const steps: RestoreStep[] = [];

  for (const entry of spotlightEntries(before)) {
    steps.push({
      description: `Spotlight on ${entry.volume}: ${entry.enabled ? "on" : "off"}`,
      argv: ["/usr/bin/mdutil", "-i", entry.enabled ? "on" : "off", entry.volume],
    });
  }

  const power: string[] = [];
  for (const key of POWER_KEYS) {
    const value = before[key];
    if (value === undefined || value === "absent") continue;
    power.push(key, value);
  }
  if (power.length > 0) {
    steps.push({ description: "power settings", argv: ["/usr/bin/pmset", "-a", ...power] });
  }

  const schedule = before["updates.schedule"];
  if (schedule === "on" || schedule === "off") {
    steps.push({
      description: `automatic update check ${schedule}`,
      argv: ["/usr/sbin/softwareupdate", "--schedule", schedule],
    });
  }

  for (const key of UPDATE_KEYS) {
    const value = before[`updates.${key}`];
    if (value === undefined) continue;
    if (value === "absent") {
      steps.push({
        description: `${key}: delete (it was absent)`,
        argv: ["/usr/bin/defaults", "delete", UPDATE_PLIST, key],
      });
      continue;
    }
    const bool = boolArg(value);
    steps.push({
      description: `${key}: ${value}`,
      argv: bool === null
        ? ["/usr/bin/defaults", "write", UPDATE_PLIST, key, "-string", value]
        : ["/usr/bin/defaults", "write", UPDATE_PLIST, key, "-bool", bool],
    });
  }

  const timeMachine = before["timemachine.autobackup"];
  if (timeMachine === "on" || timeMachine === "off") {
    steps.push({
      description: `Time Machine automatic backups ${timeMachine}`,
      argv: ["/usr/bin/tmutil", timeMachine === "on" ? "enable" : "disable"],
    });
  }

  return steps;
}

export interface MachineStateCheck {
  ok: boolean;
  failures: string[];
}

// `ademark machine on` must leave every setting at the value doctor expects.
export function statusMatchesOn(status: Record<string, string>): MachineStateCheck {
  const failures: string[] = [];
  const spotlight = Object.keys(status).filter((key) => key.startsWith("spotlight."));
  if (spotlight.length === 0) failures.push("no Spotlight volume in the status");
  for (const key of spotlight) {
    const value = status[key];
    if (value !== "off") failures.push(`${key}=${value ?? "missing"} (expected off)`);
  }

  for (const key of POWER_KEYS) {
    const value = status[`power.${key}`];
    if (value !== "0") failures.push(`power.${key}=${value ?? "missing"} (expected 0)`);
  }

  // macOS 27 keeps printing "turned on" after `softwareupdate --schedule off` (pilot 2026-10-20); the
  // AutomaticCheckEnabled key below is what turns the background check off.
  const schedule = status["updates.schedule"];
  const checkOff = ["0", "false"].includes(status["updates.AutomaticCheckEnabled"] ?? "");
  if (schedule !== "off" && !checkOff) failures.push(`updates.schedule=${schedule ?? "missing"} (expected off)`);

  for (const key of UPDATE_KEYS) {
    const value = status[`updates.${key}`];
    if (value !== "0" && value !== "false") {
      failures.push(`updates.${key}=${value ?? "missing"} (expected false)`);
    }
  }

  const timeMachine = status["timemachine.autobackup"];
  if (timeMachine !== "off") failures.push(`timemachine.autobackup=${timeMachine ?? "missing"} (expected off)`);

  return { ok: failures.length === 0, failures };
}

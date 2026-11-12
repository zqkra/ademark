// The night's ADE choice: every adapter in the registry, measured only when it is installed, its calibration gate is
// `ok` and its login is present. The rule is the same for the code adapters (Bare CLI, T3 Code, Zeron).
import { join } from "node:path";
import { gateStatus, type GateStatus } from "../adapters/gates.ts";
import type { Adapter, CalibrationGate, InstallInfo } from "../core/contracts.ts";

export interface SkippedAde {
  ade: string;
  reason: string;
}

export interface NightSelection {
  chosen: Adapter[];
  skipped: SkippedAde[];
}

export interface SelectOptions {
  adapters: readonly Adapter[];
  /** Measure every installed ADE whose login is present, with or without a passed gate; a failing block is retried at
   * the end of the night and then skipped. */
  ungated?: boolean;
  readGate: (id: string) => CalibrationGate | null;
  exists: (path: string) => boolean;
  home: string;
}

/** `~/.t3/userdata` -> `<home>/.t3/userdata`; a path without `~` is used as it is. */
export function loginPath(file: string, home: string): string {
  if (file === "~") return home;
  if (file.startsWith("~/")) return join(home, file.slice(2));
  return file;
}

function gateReason(status: GateStatus, gate: CalibrationGate, installed: InstallInfo): string {
  if (status === "failed") return `gate failed: ${gate.passed} of ${gate.runs} smoke runs passed`;
  if (status === "stale") {
    return `gate stale: it measured ${gate.version}, installed ${installed.version ?? "unknown"}`;
  }
  return `gate ${status}`;
}

function gateSkipReason(options: SelectOptions, adapter: Adapter, installed: InstallInfo): string | null {
  let gate: CalibrationGate | null;
  try {
    gate = options.readGate(adapter.id);
  } catch (error) {
    return `gate unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (gate === null) return `no gate: ademark calibrate gate --ade ${adapter.id}`;
  const status = gateStatus(gate, installed);
  return status === "ok" ? null : gateReason(status, gate, installed);
}

export async function selectAdes(options: SelectOptions): Promise<NightSelection> {
  const chosen: Adapter[] = [];
  const skipped: SkippedAde[] = [];
  for (const adapter of options.adapters) {
    const installed = await adapter.installCheck();
    if (!installed.installed) {
      skipped.push({ ade: adapter.id, reason: "not installed" });
      continue;
    }
    const gateSkip = options.ungated === true ? null : gateSkipReason(options, adapter, installed);
    if (gateSkip !== null) {
      skipped.push({ ade: adapter.id, reason: gateSkip });
      continue;
    }
    const login = adapter.login;
    if (login === undefined) {
      skipped.push({ ade: adapter.id, reason: "login not calibrated" });
      continue;
    }
    const missing = login.files.find((file) => !options.exists(loginPath(file, options.home)));
    if (missing !== undefined) {
      skipped.push({ ade: adapter.id, reason: `login file missing: ${missing}` });
      continue;
    }
    chosen.push(adapter);
  }
  return { chosen, skipped };
}

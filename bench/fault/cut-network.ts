// C5: resolve the model API hosts and block them through the ademark-machine pf anchor (TESTS.md 1.6).
// Dry run by default: resolves, renders the rules for the log and prints the commands it would run.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertApplyAllowed } from "./kill-agent.ts";
import { benchRoot } from "../core/paths.ts";
import { MACHINE_BIN } from "../ops/machine-state.ts";

export const API_HOSTS = ["api.anthropic.com", "api.openai.com", "chatgpt.com"] as const;
export const ANCHOR_NAME = "com.apple/ademark";
// The root script accepts 1 to 32 addresses; a larger list must never be truncated, because that would leave an API
// reachable during C5.
export const MAX_BLOCK_ADDRESSES = 32;

export interface DnsResult {
  host: string;
  v4: string[];
  v6: string[];
}

export function parseDig(output: string, record: "A" | "AAAA"): string[] {
  const out: string[] = [];
  for (const line of output.split("\n")) {
    const value = line.trim();
    if (value.length === 0) continue;
    if (record === "A" && /^\d{1,3}(\.\d{1,3}){3}$/.test(value)) out.push(value);
    if (record === "AAAA" && value.includes(":") && /^[0-9a-f:]+$/i.test(value)) out.push(value);
  }
  return out;
}

export function resolveHost(host: string): DnsResult {
  const lookup = (record: "A" | "AAAA"): string[] => {
    const result = Bun.spawnSync(["dig", "+short", record, host], { stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0 ? parseDig(result.stdout.toString(), record) : [];
  };
  return { host, v4: lookup("A"), v6: lookup("AAAA") };
}

// Three resolutions, as TESTS.md 1.6 asks, so CDN rotation shows up before the anchor is loaded.
export function resolveAll(hosts: readonly string[] = API_HOSTS, times = 3): DnsResult[] {
  const merged = new Map<string, DnsResult>();
  for (let i = 0; i < times; i++) {
    for (const host of hosts) {
      const result = resolveHost(host);
      const existing = merged.get(host) ?? { host, v4: [], v6: [] };
      existing.v4 = [...new Set([...existing.v4, ...result.v4])];
      existing.v6 = [...new Set([...existing.v6, ...result.v6])];
      merged.set(host, existing);
    }
  }
  return [...merged.values()];
}

export function renderAnchor(template: string, results: readonly DnsResult[]): string {
  const v4 = [...new Set(results.flatMap((entry) => entry.v4))].join(", ");
  const v6 = [...new Set(results.flatMap((entry) => entry.v6))].join(", ");
  return template.replace("{{V4_ADDRESSES}}", v4).replace("{{V6_ADDRESSES}}", v6);
}

export function uniqueAddresses(results: readonly DnsResult[]): string[] {
  return [...new Set(results.flatMap((entry) => [...entry.v4, ...entry.v6]))];
}

export function planCommands(addresses: readonly string[]): string[] {
  return [
    `sudo -n ${MACHINE_BIN} pf-block ${addresses.join(" ")}`.trimEnd(),
    `sudo -n ${MACHINE_BIN} pf-clear`,
  ];
}

export interface CutNetworkOptions {
  apply?: boolean;
  durationS?: number;
  // Kept for callers from the pilot; the anchor file is now rendered by the root script under /var/db.
  outDir?: string;
}

export interface CutNetworkResult {
  applied: boolean;
  hosts: DnsResult[];
  anchor: string;
  commands: string[];
  duration_s: number;
  // The rendered anchor rules; dry runs print them instead of writing a file.
  rendered: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function runScript(argv: string[]): void {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`command failed (${result.exitCode}): ${argv.join(" ")}: ${result.stderr.toString().trim()}`);
  }
}

export async function cutNetwork(options: CutNetworkOptions = {}): Promise<CutNetworkResult> {
  const durationS = options.durationS ?? 30;
  const hosts = resolveAll();
  const addresses = uniqueAddresses(hosts);
  if (addresses.length === 0) throw new Error("cut-network: resolved no model API address");
  if (addresses.length > MAX_BLOCK_ADDRESSES) {
    throw new Error(`cut-network: resolved ${addresses.length} addresses; the root script takes at most ${MAX_BLOCK_ADDRESSES}`);
  }
  const templatePath = resolve(benchRoot, "fault", "block.conf.template");
  if (!existsSync(templatePath)) throw new Error(`missing ${templatePath}`);
  const rendered = renderAnchor(readFileSync(templatePath, "utf8"), hosts);
  const commands = planCommands(addresses);
  assertApplyAllowed(options, "fault cut-network");

  if (options.apply) {
    runScript(["sudo", "-n", MACHINE_BIN, "pf-block", ...addresses]);
    await sleep(durationS * 1000);
    runScript(["sudo", "-n", MACHINE_BIN, "pf-clear"]);
  }

  return { applied: options.apply === true, hosts, anchor: ANCHOR_NAME, commands, duration_s: durationS, rendered };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const durationIndex = args.indexOf("--duration-s");
  try {
    const result = await cutNetwork({
      apply: args.includes("--apply"),
      durationS: durationIndex >= 0 ? Number(args[durationIndex + 1]) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

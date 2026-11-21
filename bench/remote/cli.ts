// `ademark remote`: Track R, remote access between two machines (TESTS.md §6).
import { RunWriter } from "../core/results.ts";
import type { PathId } from "./contracts.ts";
import { REMOTE_ADAPTERS, getRemoteAdapter } from "./adapters/registry.ts";
import { processFreeze } from "./cut.ts";
import { R_TESTS, runRemote, type RTest } from "./run.ts";

export const REMOTE_HELP = `ademark remote: Track R, remote access between two machines (TESTS.md §6)

Usage:
  ademark remote list
  ademark remote facts --ade <id>
  ademark remote run --ade <id> --peer <name> [--peer-description <text>] [--paths direct,relay,vpn] [--tests R2,R3,R5,R4,R6]
                     [--rounds 3] [--warm 100] [--cold 20] [--preview-port 47801]
                     [--freeze] [--freeze-seconds 30] [--freeze-rounds 5] [--freeze-peer-pids <pid,...>] [--run-id <id>]
  ademark remote record --ade <id> --run-id <id> --test R1 --value <s> [--rep <n>] [--notes <text>]

run measures every path the ADE offers to the peer, round by round, and writes results/<run-id>/ like run does.
R4 needs --freeze: a process-level drop. The ADE's client-side helpers get SIGSTOP for --freeze-seconds and the
harness leaves its open connections unread, then SIGCONT. No network interface changes. Without it R4 is not measured.
--freeze-peer-pids also stops a peer that runs on this machine (a test instance), with every process under it. R5 needs bench/remote/peer-server.mjs running on the peer.
record writes one manual row, for R1 (pair to first session, timed from a screen recording).
`;

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function num(args: readonly string[], name: string, fallback: number): number {
  const value = flag(args, name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got ${value}`);
  return n;
}

function stamp(): string {
  return new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
}

export async function cmdRemote(args: string[]): Promise<number> {
  const sub = args.shift();
  try {
    switch (sub) {
      case "list":
        for (const a of REMOTE_ADAPTERS) console.log(`${a.id}\t${a.name}`);
        return 0;
      case "facts": {
        const adapter = getRemoteAdapter(flag(args, "--ade") ?? "");
        console.log(JSON.stringify(adapter.facts, null, 2));
        return 0;
      }
      case "record": {
        const adapter = getRemoteAdapter(flag(args, "--ade") ?? "");
        const runId = flag(args, "--run-id");
        const test = flag(args, "--test");
        const value = Number(flag(args, "--value"));
        if (!runId || test !== "R1" || !Number.isFinite(value)) throw new Error("record needs --run-id, --test R1 and --value <s>");
        const writer = new RunWriter().open(runId);
        writer.appendRow({
          run_id: runId, machine_id: "manual", ade: adapter.id, ade_version: await adapter.version(), ade_build_sha256: null,
          family: "NATIVE", test_id: "R1", variant: "", rep: num(args, "--rep", 1), model: null, effort: null, server: "none",
          value, unit: "s", started_at: new Date().toISOString(), duration_ms: 0, valid: true, invalid_reason: null,
          drive: "manual", receipts: { samples: null, video: null, frames: null, capture: null, log: null }, notes: flag(args, "--notes") ?? "",
        });
        console.log(`wrote R1 to ${writer.rowsPath}`);
        return 0;
      }
      case "run": {
        const adapter = getRemoteAdapter(flag(args, "--ade") ?? "");
        const peer = flag(args, "--peer");
        if (!peer) throw new Error("run needs --peer <name>");
        const tests = (flag(args, "--tests")?.split(",") ?? [...R_TESTS]) as RTest[];
        for (const t of tests) if (!(R_TESTS as readonly string[]).includes(t)) throw new Error(`unknown test ${t}; Track R runs ${R_TESTS.join(", ")}`);
        const summary = await runRemote({
          adapter,
          peer,
          peerDescription: flag(args, "--peer-description"),
          runId: flag(args, "--run-id") ?? `remote-${adapter.id}-${stamp()}`,
          tests,
          paths: (flag(args, "--paths")?.split(",") as PathId[] | undefined) ?? null,
          rounds: num(args, "--rounds", 3),
          warmSamples: num(args, "--warm", 100),
          coldSamples: num(args, "--cold", 20),
          previewPort: num(args, "--preview-port", 47801),
          freeze: args.includes("--freeze") ? processFreeze : undefined,
          freezeSeconds: num(args, "--freeze-seconds", 30),
          freezeRounds: num(args, "--freeze-rounds", 5),
          freezePeerPids: flag(args, "--freeze-peer-pids")?.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0),
        });
        console.log(`wrote ${summary}`);
        return 0;
      }
      default:
        console.log(REMOTE_HELP);
        return sub === undefined || sub === "help" ? 0 : 2;
    }
  } catch (error) {
    console.error(`remote: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

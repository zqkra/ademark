// C3 Chat Lock: the lock runs of the C1 and C2 probes together (TESTS.md §4, C3).
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ResultRow } from "../../core/contracts.ts";
import type { TestContext } from "../../run/context.ts";
import { invalidRow } from "../../run/kit.ts";
import type { TestRunner } from "../../run/registry.ts";
import { lockRuns, longestLockMs, recordedProbes } from "./probe.ts";
import { runReceipts } from "./shared.ts";

const VARIANTS = [
  { variant: "locks", unit: "count" },
  { variant: "longest-lock", unit: "s" },
] as const;

// The probe writes one frames file per segment; the last one is the receipt for the whole test.
function lastProbeFrames(ctx: TestContext): string | null {
  const dir = ctx.receiptDir("C3", 1);
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.startsWith("probe-") && name.endsWith(".json"))
      .sort();
  } catch {
    return null;
  }
  const last = names[names.length - 1];
  return last === undefined ? null : relative(ctx.runDir, join(dir, last)).split(sep).join("/");
}

export const c3: TestRunner = {
  id: "C3",
  track: "C",
  repeats: () => 1,
  maxExtraRuns: 0,
  needsExtraRun: () => false,
  runRep: async (ctx, rep) => {
    const probes = recordedProbes(ctx);
    const receipts = runReceipts(ctx);
    if (probes.length === 0) {
      return VARIANTS.map((entry) =>
        invalidRow(
          ctx,
          {
            test_id: "C3",
            variant: entry.variant,
            rep,
            server: "live",
            unit: entry.unit,
            duration_ms: 0,
            receipts,
            notes: "",
          },
          "no probes",
        ),
      );
    }
    const locks = lockRuns(probes);
    const span = (probes.at(-1)!.t_ns - probes[0]!.t_ns) / 1_000_000;
    const values: Record<string, number> = {
      locks: locks.length,
      "longest-lock": longestLockMs(locks) / 1_000,
    };
    const frames = lastProbeFrames(ctx);
    return VARIANTS.map((entry) =>
      ctx.row({
        test_id: "C3",
        variant: entry.variant,
        rep,
        server: "live",
        value: values[entry.variant]!,
        unit: entry.unit,
        duration_ms: Math.max(0, span),
        valid: true,
        invalid_reason: null,
        receipts: { ...receipts, frames },
        notes: `${probes.length} probes, ${probes.filter((probe) => probe.ms === null).length} lost`,
      }),
    );
  },
};

// `ademark prepare` as a command: the machine goes into measuring state, every ADE is proven, and the machine goes back.
import { join } from "node:path";
import { measurementRefusal, MEASURE_USER, utcStamp } from "../calibrate/gate.ts";
import type { Agent } from "../core/contracts.ts";
import type { TrackLetter } from "../run/registry.ts";
import { defaultNightDeps } from "./deps.ts";
import { prepareAll } from "./prepare.ts";
import { realPrepareDeps } from "./prepare-real.ts";
import { repairTemplate } from "./repair.ts";

export async function runPrepare(o: {
  ades: readonly string[];
  tracks: readonly TrackLetter[];
  agents: readonly Agent[];
  rounds?: number;
}): Promise<number> {
  const night = defaultNightDeps();
  const out = night.out;
  const username = night.username();
  if (username !== MEASURE_USER) {
    console.error(`prepare: ${measurementRefusal(username)}`);
    return 2;
  }
  const runId = `prepare-${utcStamp(new Date())}`;
  const runDir = join(night.resultsRoot(), runId);
  const caffeinate = night.caffeinate();
  let restored = false;
  // Each step runs even if the one before it throws, because a machine left in measuring state is the worst outcome.
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      night.machine("off", true, out);
    } catch (error) {
      out(`prepare: machine off failed, run: bun bench/cli.ts machine off --apply (${String(error)})`);
    }
    try {
      caffeinate?.kill();
    } catch (error) {
      out(`prepare: caffeinate: ${String(error)}`);
    }
  };
  const stop = (): void => {
    restore();
    process.exit(130);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    night.machine("on", true, out);
    const deps = realPrepareDeps(out);
    const results = await prepareAll({
      ...o,
      runId,
      runDir,
      template: repairTemplate(),
      deps: {
        ...deps,
        // Each reset moves the app's data aside, and one Traycer copy is 2.6 GB.
        check: (check) => {
          night.pruneAside(true, out);
          return deps.check(check);
        },
      },
    });
    const ready = results.filter((result) => result.ready).length;
    out(`prepare: ${ready} of ${results.length} ready. Report: ${join(runDir, "prepare.md")}`);
    return ready === results.length ? 0 : 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    restore();
  }
}

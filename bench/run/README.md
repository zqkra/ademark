# Run core

`bench/run/` is the shared part of `bun bench/cli.ts run`: the instrument interface, the test-runner registry and the
per-ADE loop of RUNBOOK.md §7. Track runners (A1-C6) live in `bench/tracks/` and are written in wave 2b against
the interfaces here.

## The loop

1. `gates()` (§8): swap, thermal and quiet CPU. Every block writes its gate values as a `gate_values` event; a
   failed gate writes `gate_failure` and stops the block.
2. `installCheck()` against the pinned version and SHA-256 in `manifest.json`. In a dry run a missing app is a note.
3. Global config diff (`diff` in `bench/core/snapshot.ts`) against `snapshots/clean/`, saved to the previous row
   ade's folder (`_start/` for the first block of the run).
4. `prepareArena()` writes the arena at the `arena-v1` tag (or `HEAD`) into `<arenaRoot>/<rowAde>/`, before reset.
5. `adapter.reset()`, then `adapter.configure()`.
6. `startReplay()` and the contamination check in `<arenaRoot>/_contamination/` (prepared once per run). The first
   `body_sha256` of the run is the reference; a different one writes `gate_failure` and stops the block.
7. Environment. Track A points `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` at the replay port. Tracks B and C stop
   the replay server, start capture and set the mitmproxy CA variables of TESTS.md §1.5.
8. `adapter.launch()`. Track A then makes the seed threads (`newThread`, `send "replay:seed"`, `waitDone`), 5 or
   2 in a smoke run; Track C starts the 4 Hz background sampler into `<rowAde>/C/samples.csv`, whose path lands in
   `state["C.samples_csv"]`.
9. Every registered runner of `TRACK_ORDER[track]`, in order, with `repeats(ctx)` runs and
   `needsExtraRun()`/`maxExtraRuns` extra runs. A1 to A4 stop early when their median is stable (below). Every
   returned row, invalid included, is written with `RunWriter.appendRow`. A block whose `<track>.done` marker exists
   is skipped.
10. `adapter.quit()` (best effort), the sampler stop, and `<rowAde>/<track>.done`.
11. An adapter or runner error writes `harness error` and stops the ADE's remaining blocks. `runAll` writes the
    manifest before the first ADE, retries the ADEs that stopped (below), and writes `summary.json` after the last
    one. After a later block stops, a block that finished is not measured again: it keeps its `.done` marker and its
    published rows.

One ADE and track is one reset and one measurement block per agent and model (`blocksFor` in `models.ts`): the
Bare CLI in Tracks A and C is two controls (`bare-cli-claude`, `bare-cli-codex`), Track B runs once per agent the
ADE supports, and the Codex app runs Codex. In Track B the receipts add the agent folder:
`<rowAde>/<test-id>/<agent>/rep-<nn>/`.

A block stops on a failed gate, a version mismatch, a contamination mismatch or a harness error. `runAll`
continues with the next ADE; the CLI exits 1 when any block stopped.

## Instruments

`realInstruments()` needs the `ademark` macOS user and throws otherwise. `dryInstruments(planPath)` measures
nothing, appends `{"call": ..., "args": ...}` to the plan and returns the fixed values below. `<arenaRoot>` is
`$ADEMARK_ARENA` or `~/arena`.

| Member | Real tool | Dry value |
|---|---|---|
| `now` | `clock_gettime_nsec_np(CLOCK_UPTIME_RAW)` | the same real clock (the only varying plan line) |
| `sleep` | host timer | returns at once |
| `procs` | `ademark-native procs` | `[]` |
| `pidOf` | `pgrep -x <name>`, first pid | 88 (A5 reads WindowServer's memory through it when `procs` has no WindowServer) |
| `idle` | `ademark-native idle --cpu-cores <c> --quiet-ms <n> --cap-s <n>` | `waited_ms` 0, quiet, 0 cores |
| `sample` | `ademark-native sample --duration-s <n>` | a real CSV: every tick at `hz` has 1 row per root pid, 2 helpers and 5 agents; the app group grows 0.5 MB/min |
| `sampleStart` | `ademark-native sample --duration-s 0` | the same CSV over 4 minutes; `stop()` returns its summary |
| `window` | `ademark-native window` | 1600 x 1000 frame, window id 1 |
| `keys` | `ademark-native keys` | host clock timestamp |
| `echo` | `ademark-native echo` | ready 1200 ms, settled 1800 ms |
| `watch` | `ademark-native watch` | 900 ms |
| `lag` | `ademark-native lag` | `count` samples of 12 ms, p50 12, p95 12, lost 0, and `probes_ms` with one entry per probe |
| `scroll` | `ademark-native scroll` | 0 gaps over 33 ms |
| `cover` | `ademark-native cover` | window id 1, 1600 x 1000 |
| `screenshot` | `ademark-native screenshot` | the requested path |
| `prepareArena` | `git archive` + `git init -b main` + one fixed commit | writer of the fixed tree, no-op |
| `startReplay` | `bench/replay/server.ts` on port 8787 | empty stats, no-op reset |
| `startCapture` | `mitmdump --mode local -s bench/capture/addon.py` | empty rows |
| `fault` | `killAgent`, `cutNetwork`, `restartApp` with `apply: true` | applied, `detail: "dry run"` |
| `grade` | `gradeTask` with `ADEMARK_HANDOFF_SEED` | every `grade_groups` group passed |
| `footprint` | `sudo footprint -j <out> --unmapped -p <pid>...` | 300 MiB |
| `purge` | `sudo purge` | no-op |
| `gates` | `sysctl`/`pmset`/`top` | all ok |
| `contamination` | `claude ... -p "replay:hi"` + replay log | bytes 1024, fixed 64-hex hash |

## Writing a wave 2b runner

`bench/tracks/<folder>/index.ts`, whatever the folder name, exports `runners: TestRunner[]`; each runner's own
`track` decides its block. Use `ctx.row()` for every row; it fills run, ADE, family, model, effort and drive, and in
a dry run it prefixes the runner's own notes with `dry run; ` (or writes just `dry run` when they are empty).
Use `ctx.receiptDir(testId, rep)` for receipts, `ctx.state` for values shared with
later tests of the same block, and `ctx.freshArena(label)` for the fresh clone a Track C test needs.
`bench/run/kit.ts` holds the small shared helpers: `BYTES_PER_MB`, `receipt`, `emptyReceipts`, `invalidRow`,
`missingCalibration`, `readSamples` and `groupSeries`.

```ts
// bench/tracks/a/index.ts
import type { TestRunner } from "../../run/registry.ts";

export const runners: TestRunner[] = [
  {
    id: "A5",
    track: "A",
    repeats: () => 3,
    maxExtraRuns: 1,
    needsExtraRun: (rows) => rows.some((row) => !row.valid),
    runRep: async (ctx, rep) => {
      const pid = Number(ctx.state.get("launch_pid"));
      const sample = await ctx.instruments.sample({
        rules: { rootPids: [pid], bundlePaths: ctx.adapter.processes().bundlePaths, vendorDirs: [], agentExecutables: [], excludeNames: [] },
        hz: 4,
        durationS: 30,
        csv: `${ctx.receiptDir("A5", rep)}/samples.csv`,
      });
      ctx.state.set("A5.app_median_b", sample.app_median_b);
      return [
        ctx.row({
          test_id: "A5", variant: "", rep, server: "replay", value: sample.app_median_b,
          unit: "B", duration_ms: 30000, valid: true, invalid_reason: null,
          receipts: { samples: "samples.csv", video: null, frames: null, capture: null, log: null },
          notes: "",
        }),
      ];
    },
  },
];
```

`Repeats and extra runs`: `repeats(ctx)` runs first; then `needsExtraRun(rows)` is checked after the base
repetitions and again after every extra run, up to `maxExtraRuns` (3 for A1-A4, 1 for A5-A11, 1 for C1 and C4-C6,
0 otherwise).

## Adaptive repetitions

A1 `cold`, A2 `relaunch`, A3 `default-mode` and A4 `total` carry an `adaptive` block in the runner registry
(`bench/run/registry.ts`): the row variant the stop rule follows, `min` 6 and an absolute tolerance in the row's unit
(1/60 s for A1 and A2, 1000/60 ms for A3 and A4). `repeats()` stays 10, the cap.

After every repetition `runTest` takes the valid rows of that variant and asks
`medianConverged(values, { relTol: 0.05, absTol })` (`bench/core/stats.ts`): the distribution-free 95 % interval of
the median from order statistics (`medianInterval95`, exact binomial ranks: k is 1 for n = 6 to 8 and 2 for n = 9 and
10), half-width against 5 % of the median or the absolute tolerance, whichever is larger. A run stops on the first of:
the interval is narrow enough (`converged`), the valid rows reach `repeats()` (`cap`), or the repetitions reach
`repeats() + maxExtraRuns` (`extra cap`). Invalid rows never count toward `min` or the stop rule; they consume
repetitions, which is what the extra runs are for. Each adaptive test logs one line:
`[<rowAde>] <test> <variant>: stopped at n=<valid> of <reps run> (<reason>)`.

A1's `first-launch` tier runs at repetition 1, and the rule needs 6 valid `cold` rows, so stopping early can never
skip it. Non-adaptive runners keep the schedule above.

## Quiet machine instead of sleeps

A1 replaces its fixed 10 s sleep after `purge` with `idle({ cpuCores: 0.1, quietMs: 2000, capS: 10 })`, and A2 its
5 s sleep after quit with `idle({ cpuCores: 0.1, quietMs: 1000, capS: 5 })`. The threshold is
`QUIET_LIMIT_CORES` in `bench/core/gates.ts`, the same one the pre-block gate uses. The rows carry `idle_ms` and
`idle_quiet` in their JSON notes. A wait that reaches its cap returns `quiet: false`; the gate inside the launch row
then decides whether the row is valid.

## Smoke mode

```sh
bun bench/cli.ts run --ade t3code --tracks A --smoke
```

A smoke run is the rehearsal before the night and the calibration gate. It is only allowed with `--tracks A` (Track B
calls the real API and Track C is long), sets `manifest.mode` to `"smoke"`, writes `results/<run-id>-smoke/` and
runs one repetition per test: `repeats` 1, no extra runs, no adaptive stop, and 2 seed threads. Smoke rows keep their
real `valid` and `invalid_reason`; every note starts with `smoke; ` (in a dry run the `dry run` marker comes first).
`summary.json` says `"smoke": true` and
`bun bench/cli.ts summarize` prints `SMOKE RUN: rehearsal only, never published` as its first line.

Every smoke number lives in `bench/run/smoke.ts`; `smokeSeconds(ctx, full, smokeValue)` and
`smokeCount(ctx, full, smokeValue)` return the full value when `ctx.smoke` is false. Validity thresholds that depend
on a duration scale with it (A7's "5 agents for 150 s of 180 s" becomes the same fraction of the 20 s window).

| Test | Full | Smoke |
|---|---|---|
| A1-A4 | 10 adaptive repetitions | 1 repetition |
| A5 | settle cap 600 s, window 60 s | settle cap 20 s, window 5 s |
| A6 | window 60 s, cover 70 s, lead 5 s | window 5 s, cover 7 s, lead 2 s |
| A7 | window 180 s, 5 agents for 150 s of it | window 20 s, 5 agents for the same fraction |
| A7, A8, A10 | the five streams open 2 s apart | 0.5 s apart |
| A8 | 60 probes | 10 probes |
| A9 | wait 60 s after quit, 10 s lead for `sessions-kept` | 5 s, 5 s lead |
| A10 | 15 extra threads, window 60 s | 3 extra threads, window 5 s |
| A11 | 5 repetitions | 1 repetition: open, scroll and switch once |

## Retry at the end of the night

After every ADE ran once, `runAll` runs each ADE whose block stopped once more, in the same order, and logs
`retry <ade>`. `RunResult.retried` lists them. A block is one (track, agent) pair, so its marker is
`<runDir>/<rowAde>/<track>-<agent>.done`, and on the retry pass a block with its marker is skipped. An old
`<track>.done` marker still counts, but only for a row ade whose track has one block: an old run wrote that marker
once for the whole track, so a stopped agent must not hide behind another agent's marker.

Before a stopped block runs again, only the rows of that block move out of `rows.jsonl` into
`rows-superseded.jsonl`: same `ade`, a test id of its track, and its pinned model. Each of them gets
`"superseded_by": "retry 1"` and `"attempt_dir": "<rowAde>.attempt-1"`. Its receipt folders keep their relative
layout under `<runDir>/<rowAde>.attempt-1/`: `<testId>/` for Track A and C, `<testId>/<agent>/` for Track B
(TESTS.md §0.2). The receipts, rows and markers of the other blocks of that row ade stay where they are, so a
finished Track A keeps its receipts while a stopped Track B agent retries. The published rows are always the last
attempt.

## Deadline

`runAll` takes `deadline` (epoch ms) in its options. Before each ADE starts, and again before each retry, the loop
compares `Date.now()` with it; once the deadline has passed that ADE is not started: the loop logs
`skip <ade>: the deadline has passed` (or `skip retry <ade>`) and lists the ADE in `RunResult.skippedForTime`. A block
that already started always finishes, so the deadline never cuts a measurement in half. `bun bench/cli.ts night --until HH:MM`
sets it; a plain `bun bench/cli.ts run` passes none.

## Dry run

```sh
bun bench/cli.ts run --ade all --tracks A,B,C --dry-run --run-id 2026-10-21T19-00Z-3f9c2a1
```

The run folder is `results/<run-id>-dry/` (`-smoke` for a smoke run, `-dry-smoke` for both); `plan.jsonl` holds every
instrument and fixture adapter call in order. The manifest has `verified: false`, every row's notes start with
`dry run`, and the process exits 0 when every block finished, 1 when one stopped. `--reference` marks
`manifest.verified` true and is refused with `--dry-run`. `--runners <dir>` loads fixture track runners (used by the
tests).

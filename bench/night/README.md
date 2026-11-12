# Night

`bun bench/cli.ts night` is the owner's whole night: one command that puts the machine in measuring state, checks it, rehearses,
measures every calibrated ADE and puts everything back, and leaves one file that says what happened.

```sh
bun bench/cli.ts night --tracks A --until 07:30
```

A real night runs only as the `ademark` macOS user (METHODOLOGY.md §5). `--dry-run` works for anyone: it runs every
step with the dry instruments, prints the machine commands instead of running them, answers its own confirmation
question, and writes `results/<run-id>-dry/` instead of `results/<run-id>/`.

## What the owner does

1. Log in as `ademark`, open Ghostty and run the command above.
2. Watch the rehearsal: the rows of a smoke run scroll by, then `rehearsal passed`.
3. Read the plan and answer `y` to `Start the night? [y/N]`. `--yes` skips the question.
4. Go to sleep. The Mac stays awake because the command holds `caffeinate -dimsu -w <pid>` for its whole life.
5. In the morning, read `results/<run-id>/night.md`.

Every ADE must have passed its calibration gate first (`bun bench/cli.ts calibrate gate --ade <id>`, five smoke runs in a row
from the adapter's own reset). A gate goes `stale` when the installed app's version or bundle SHA-256 changes, so
re-run the gate after an app update. The doctor check `calibration gates` lists the ADEs the night will skip.

## Before the night

`bun bench/cli.ts prepare` proves each ADE on the real app and repairs what fails (RUNBOOK.md §0). It revokes the gate first and runs Track A last, so only a full pass leaves the ADE eligible, also after a Ctrl-C. A night without `--ungated`
measures only the ADEs it left ready. `--tracks A,B,C` may run together: each block clears what launchd kept from the
block before.

## The night in order

1. **Guard.** A real night refuses to run outside the `ademark` user, with the same message as `bun bench/cli.ts run`.
2. **Caffeinate.** `caffeinate -dimsu -w <own pid>` holds the Mac awake for the whole command.
3. **Machine on.** The same functions as `bun bench/cli.ts machine on --apply`: the root script, displayplacer at 60 Hz, the
   paused analyzers, the telemetry variable.
4. **Doctor.** Every check, printed as a table. A blocking failure stops the night before anything is measured.
5. **The ADEs.** Every adapter in the registry is chosen unless it is not installed, its gate is not `ok` (`missing`,
   `failed` or `stale`), or its login is missing or names a file that does not exist. The rule is the same for the
   code adapters (Bare CLI, T3 Code, Zeron): no gate, no measurement. The order is the run order: `RunResult.order`
   is `shuffle(chosen, seed)`.
6. **Rehearsal.** A smoke run (`tracks: ["A"]`) of the Bare CLI plus the first chosen ADE in the run order. Every row
   is printed as it is written, then the pass rule result: every block must have finished and every row must be valid,
   except rows whose `invalid_reason` starts with `not supported`. A failure here stops the night.
7. **The plan.** The chosen ADEs in run order, the skipped ADEs with their reasons, 25 minutes per ADE for Track A and
   7 for Track B, and the expected end time. Then `Start the night? [y/N]`.
8. **The night.** `runAll` with the chosen ADEs, the tracks and the seed (default: the run id), and the deadline from
   `--until` (the next local occurrence of that time). Before each ADE and before each retry, an ADE past the deadline
   is not started; a block that already started always finishes. `RunResult.skippedForTime` lists them.
   **Self-repair.** After `runAll`, every ADE that still fails goes to the repair agent, in run order, with 2 attempts
   at most. It takes the ADEs with the fewest valid rows first. An ADE fails when its last block of a track stopped, or an output of one model has under half of its rows valid. `not supported`
   rows, gate stops and install check stops are not repairable. The agent is `claude -p` with `repair-prompt.md`, capped
   at 45 minutes. A repair starts only from a clean tree. Code then stops every leftover (`agent-desktop`, `ademark-native`, any
   `bench/cli.ts` child, the ADE) and reverts the attempt if it changed anything outside the ADE's profile, gate or
   adapter, or if the harness no longer loads. Only the outcome `fixed` leads to a new measurement. A plan limit stops all
   repairs of the night. A real change supersedes every block of the ADE and a
   child `bun bench/cli.ts run --resume` measures it again, so the new profile loads. The `--until` deadline and
   `--repair-minutes <n>` (default 180, for the whole night) stop new attempts. `--no-repair` turns it off. A dry run
   and a smoke night start no agent.
9. **Report.** `results/<run-id>/night.md`, then machine off, then caffeinate released.

Step 9 always runs, also after an error, a SIGINT (Ctrl-C) or a SIGTERM: `machine off --apply` first, then the
caffeinate child is killed, then `night.md` is written with whatever is known and says why it stopped. A SIGKILL cannot
be cleaned up; use Ctrl-C.

## What happens on a failure

- **A blocking doctor check fails:** the table is printed and the night stops before the ADE choice. The report says
  which checks failed or, when the night stopped before doctor, that it never got there.
- **The rehearsal fails:** each failure is printed as `<ade> <test_id> <variant>: <reason>` or
  `<ade> <track> block: <error>`, and the night stops, unless repair is on: then it warns and goes on. Fix the ADE or its calibration, re-run its gate, run the night
  again.
- **A block stops during the night:** `runAll` retries that ADE once at the end of the run. The report marks the ADE
  `measured` and `retried: yes`. A block that stops again goes to self-repair, and an ADE that still fails after it
  leaves the exit code at 1.
- **The deadline passes:** the night ends early instead of starting another ADE or retry. Those ADEs are
  `skipped for time` in the report.
- **The owner answers `n`:** nothing is measured and the machine goes back.

A dry run is the one exception to the doctor rule: it reports blocking failures and goes on, so the whole night can be
rehearsed before the `ademark` account exists. In a dry run the rehearsal checks that every block finished and not row
validity, because the dry instruments write no replay log for A4; a dry gate goes to a temp folder and never gates a
night.

## How to read `night.md`

The header: start and end (UTC and local), `status: finished` or `status: stopped: <reason>`, the tracks, the seed,
whether it was a dry run, the machine id and the harness commit.

`## ADEs` is one table with a row per adapter:

| status | meaning |
|---|---|
| `measured` | the ADE ran; `rows` counts its rows, `invalid rows` the ones with `valid: false` |
| `skipped` | the ADE choice skipped it; the reason is in the note and in `## Skipped ADEs` |
| `skipped for time` | the deadline passed before the ADE started |
| `not started` | it was chosen, but the night stopped before the run reached it |

`retried` is `yes` when the end-of-night retry ran for that ADE. `duration` is the span from its first row's start to
its last row's end, so it leaves out time a block spent before writing its first row.

`## Skipped ADEs` lists each skipped adapter and the rule that skipped it. `## Doctor` is the table from step 4.
`## Rehearsal` names the rehearsal run, its ADEs, its row count and its result, with one line per failure.
`## Machine` is what `machine on` and `machine off` printed. `## Notes` holds the dry-run warnings and the plan.

The rehearsal and the night write their own run folders next to the report (`<run-id>-rehearsal` and the night's own
`rows.jsonl`, `manifest.json`, `summary.json`, `events.log` and `plan.jsonl`), so everything the report summarizes can
be read in full.

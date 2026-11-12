# ADEMark Control

A local panel with one Start button. It replaces the terminal commands: `bun bench/cli.ts control`, or double-click
`ADEMark Control` on the `ademark` Desktop.

Each step of each ADE is one row in `results/control.sqlite`. Two buttons run the queue:

- **Prepare** (no button since 2026-11-08; Start proves each app itself), by day, runs only the proofs: a real Track B block, then the gate, for each ADE. A proof that passes is saved in
  `results/proofs.json` and holds for 36 hours, while the adapter, the profile and the app stay the same. This is where Claude
  repairs how an app is driven.
- **Start**, at night. An ADE with a valid proof goes straight to measuring:
  1. **Prove.** Skipped when a proof holds.
  2. **Measure.** `run` with Track A only (since 2026-11-12, whatever `~/.config/ademark/tracks` says), about 30 minutes, in its own folder per attempt, cut at 75 minutes
     (`MEASURE_TIMEOUT_MS` in `real.ts`), after up to 11 minutes of waiting for calm. The panel and the heartbeat show
     that sum, 86 minutes, as the step's limit.
  3. **Top-up.** After the first pass of every app, a test with fewer valid repetitions than its minimum runs once more,
     alone, in `<run>-<ade>-topup-<n>` (ADEMARK-47). It refuses another build or machine than the first attempt, and
     skips a test whose reason is an approved accepted limit. `report.md` names the attempt of each test.
  4. **Measure what is missing** (ADEMARK-51). The queue running dry no longer ends a night: it records
     `first_pass_at`, and the night stays open. The one button then says **Measure what is missing**, with a line that
     names the apps and tests (`Conductor, Cloudroom: all tests. Emdash: A7.`). `POST /api/fill` puts each measure that
     is pending, failed or skipped back with its attempt count, and gives each measured app with tests under their
     minimum (after its first attempt and every top-up) a top-up of the next pass in `topup-<next number>`. An app of the measured list
     that the open night does not know (it joined the list after the night began, as Capy and Superset on 11 Nov) is
     missing in full: the pass adds its proof and its measure at the end of the queue. With nothing
     missing the panel says the night is complete and shows no button. **Close this night** (`POST /api/close`, under
     More) ends the night and starts nothing. A test takes the rows of a later attempt only if it was under its
     minimum before that attempt ran; a complete test keeps its attempt.
  5. **Tokens** and **Orchestration** (ADEMARK-49). After every measure and top-up of a pass, each app gets a tokens
     step (`run --tracks B` in `<run>-<ade>-tokens-<n>`, cut at 45 minutes, `TOKENS_TIMEOUT_MS`), then Bare CLI and
     each app whose adapter has an orchestration trigger get an orchestration step (`run --tracks C --tests C1` in
     `<run>-<ade>-orchestration-<n>`, cut at 140 minutes, `ORCHESTRATION_TIMEOUT_MS`). The first pass adds them by itself, after its top-ups; a
     later pass adds them for each app with no done attempt, or whose done attempt has no valid row, and the line under
     the button ends with `Tokens: <apps>. Orchestration: <apps>.` A failed late step changes no other step of its app
     and is not tried again in that pass. Before each one, Control calls the model once: with no answer it waits and asks
     again every 10 minutes for up to 6 hours (`PLAN_POLL_MS`, `PLAN_WAIT_MS`), and the panel says so; after that, every
     late step left in the pass is skipped with `the Claude plan did not answer`. `report.md` has a Track B and a Track C part for each app,
     with their attempt. A `reliability` step (C2 to C6) would go after orchestration (`LATE_STEPS` in `store.ts`).

QA left the night on 2026-11-10 (ADEMARK-46): it only reads files, and 15 checks took up to 2.5 h. Run it by day, from
any account: `bun bench/cli.ts qa --run <run id> [--ade a,b] [--out <dir>]`. It reads the adopted attempt of each app and its
top-up, runs at most 4 reviewers at once, and writes `qa.txt` and `qa-verdict.json` beside the rows. A verdict goes to
`bun bench/cli.ts report --run <run id>` (`results/<run>/report.md`) and never starts a measurement. The panel says `QA: run by day`.

An ADE that fails a first proof or a first measure moves to the end, so healthy apps go first. On that second pass Claude may
repair it, up to 3 rounds. All repairs of a run share 240 minutes. 15 ADEs at 30 minutes are about 7.5 hours.

Before each step Control waits for a calm CPU: a busy Mac is a reason to wait, never a failure of the app. Start clears what
a crash left and checks the sign-ins and permissions, and says what only a person can fix. A crash or Stop loses nothing:
the running step goes back to the queue and repeats from its beginning in a new folder.

Nothing runs during a measurement: steps run one at a time. Close the browser window after Start.

## Rehearse (since 2026-11-10)

**Rehearse** (or `POST /api/rehearse` with `{"ades": ["orca"]}` for some apps) makes a run of its own,
`rehearsal-<time>`, never mixed with a night. For each app, healthy first, it runs `run --smoke --smoke-reps
A1=3,A2=3,A3=3` (A1 to A3 three times, because on 9 Nov Orca's A1 broke at repetition 2 and MonoCode's A2 at 4, every
other test once), with the same calm wait, session check, watchdog and cleanup as the night. After each app it writes
`results/<rehearsal>/rehearsal.md`: the count of NEW invalid rows on the first line, `valid` or `invalid` with the
reason for each app and test, the minutes of each app, and what changed since the last rehearsal. Smoke rows never
count: `report` refuses a rehearsal. `rehearsal.json` records the commit and the hash of the measuring inputs of its
lap. At Start and at New run the panel shows the last lap, its NEW count, and whether it ran on the commit and inputs
of now. Any other case is a yellow warning with the reason; Start still works, because a gate stopped 13 of 15 apps
on 7 Nov.

Each invalid row on the panel and in the reports is `accepted limit` or `NEW`. A row is an accepted limit only when an
entry of `ACCEPTED_LIMITS` in `bench/night/known-failures.ts` names its app, test and reason, and the owner approved it.

A test that a review found wrong is **set aside** (ADEMARK-56): an entry of `SET_ASIDE` in `bench/night/set-aside.ts`
names its run, app, test and attempt (`1`, `topup-1`), with the reason, the evidence and the date. Control reads every
attempt's rows through `rowsIn` (`qa.ts`), which counts those rows as not valid with the reason `set aside after
review: <reason>`. So the pass plan, the merge, the report, the panel and `qa` agree: **Measure what is missing** names
the test, its next top-up replaces its rows, and the report names the set-aside attempt with its reason. `rows.jsonl`
is never written. An entry that matches no folder or row is named in the report's notes.

## Surviving the night (since 2026-11-10)

On 9 Nov Control stopped at 02:20 with no trace, and a second click at 08:34 killed it. These parts keep it alive:

- **One Control.** `results/control.lock` holds its pid, port and start time. A second `control` opens the first
  panel and exits with 0. The launcher (`bench/control/launcher/run`) asks `/api/state` first and starts no second
  Ghostty. Bare CLI's reset never quits a Ghostty that hosts `bench/cli.ts`, and quits others by pid.
- **Log.** `results/control.log` has every panel line with its time, the exit code or signal of each child, and each
  sync call cut at its limit.
- **Heartbeat.** `results/control-heartbeat.json`, every 15 s: pid, port, run, state, intent (`running` or `stopped`),
  app, step, its start and limit, and the child's process group. Stop writes `stopped` first.
- **Watchdog.** The LaunchAgent `dev.ademark.watchdog` runs `bun bench/cli.ts watchdog --once` every 60 s. Start installs it,
  and the panel shows if it is loaded. With a run open, intent `running` and this account on screen:
  - a heartbeat older than 5 minutes: it ends Control and its child group, then runs `launcher/run --continue`;
  - a step past its limit plus 5 minutes: it ends the child's group, and Control records the attempt and goes on.
  It writes `results/watchdog.log` and restarts one run at most 5 times. `bun bench/cli.ts watchdog status`, `install` and
  `uninstall` manage it.
- **Continue adopts.** A measure that was running when Control died is done if one of its attempt folders has the
  marker of every requested block and at least one row. The top-up plan and `bun bench/cli.ts qa` read that folder.
- **Pause.** Before each step and every 15 s during it, Control reads the console session (`stat -f %Su /dev/console`
  and `ioreg -n Root -d1 -a`). Off screen or locked, it ends the child, puts the step back with no attempt counted,
  and shows `Paused: this account is not on screen`. Back on screen, it waits for calm and goes on. Start refuses to
  begin off screen.
- **New run.** When the open run cannot go on (for example the native helper changed), **End this run and start a
  new one** ends it, keeps its rows on disk, and starts a new run with healthy apps first.

A dry run has its own files (`control-dry.*`, `watchdog-dry.*`) and never touches the LaunchAgent.

Dry run, in any account: `bun bench/cli.ts control --dry-run --ade bare-cli,orca`. Watch it: `bun bench/cli.ts watchdog --once --dry-run`.

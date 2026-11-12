# ADEMark methodology

Version: v1.0, 2026-10-19. First results: run `control-2026-11-10T08-31-19Z`, published 2026-11-12.
Reference machine: Mac mini M4, 16 GB, macOS 27.0.1.

This file says **what** ADEMark measures and **why**. The other files say how:

| File | Contents |
|---|---|
| [TESTS.md](TESTS.md) | The exact procedure, repetitions and output of every test ID below |
| [ADES.md](ADES.md) | How to install, reset, configure, drive and attribute each ADE, grouped by stack |
| [TASKS.md](TASKS.md) | Every prompt word for word, the arena work items, follow-up messages and hidden tests |
| [RUNBOOK.md](RUNBOOK.md) | Machine preparation, run order, gates and the 2-day schedule |
| [FAIRNESS.md](FAIRNESS.md) | Every objection we expect, our verdict, and what we changed |
| [BUSINESS.md](BUSINESS.md) | Funding: donations only, and the rules that keep money away from results |

## 1. The question

Same model, same tasks, same machine: how much does the ADE you code in change your result?

An ADE (agentic development environment) wraps a coding agent. The wrapper can change four things.
Each one has its own track:

| What the ADE changes | Track | Model usage |
|---|---|---|
| How fast you get to work, and what it costs your machine | A. Speed and Weight | none: a local replay server answers |
| What the model receives | B. Tokens | small: a few short prompts per ADE |
| How agents work together, and what happens when something breaks | C. Orchestration and Reliability | real: Claude, full tasks |
| What the product offers | F. Fit | none: a fact table with no score |

## 2. The field

17 ADEs and one control. Versions are frozen when a run starts and published with every result. The first results cover 15 of them. The Codex app was not measured in v1, and Conductor left the field on 12 November 2026: since 4 November new users can no longer download it, so it fails the inclusion rule.

| ADE | Family | Claude runs via | Codex runs via |
|---|---|---|---|
| Bare CLI (control, never ranked) | control | `claude` in Ghostty | `codex` in Ghostty |
| T3 Code | EL-SDK | Claude Agent SDK | app-server |
| bb | EL-SDK | Claude Agent SDK | app-server |
| Paseo | EL-SDK | Claude Agent SDK | app-server |
| Synara | EL-SDK | Claude Agent SDK | app-server |
| Traycer | EL-SDK | Agent SDK (chat) or PTY (terminal) | app-server |
| Cloudroom | EL-SDK | Claude Agent SDK | app-server |
| Superset | EL-PTY | CLI in a PTY | CLI in a PTY |
| Orca | EL-PTY | CLI in a PTY | CLI in a PTY |
| Emdash | EL-PTY | CLI in a PTY | CLI in a PTY |
| Zeron | NATIVE (Rust, GPUI) | `claude -p` stream-json | app-server |
| Diri | NATIVE (Rust, GPUI) | CLI TUI in a PTY | CLI TUI in a PTY |
| super.engineering | NATIVE (Rust, GPUI) | CLI or `claude -p` | CLI |
| MonoCode | NATIVE (Tauri 2 + Node host) | `claude` stream-json | app-server |
| Conductor | NATIVE (Tauri, Rust) | Agent SDK, bundled CLI | bundled Codex |
| Capy | OWN (own harness, local mode) | own agent | own agent |
| Claude desktop (Code tab) | FIRST (Anthropic) | Claude Code engine | not supported |
| Codex app (in ChatGPT desktop) | FIRST (OpenAI) | not supported | Codex agent |

Families:

- **EL-SDK**: Electron app that drives the agent through an SDK or a JSON protocol.
- **EL-PTY**: Electron app that runs the agent's own terminal UI in a pseudo-terminal.
- **NATIVE**: non-Electron app (Rust with GPUI, or Tauri).
- **OWN**: runs its own agent instead of Claude Code or Codex. Its results include that harness and are labeled so.
- **FIRST**: the model vendor's own app. It runs only its vendor's models.

Inclusion rule: a macOS desktop app, publicly downloadable on the day the run starts, that runs coding agents on a local repository.

**Local only.** Every ADE runs its agents on the bench Mac. Cloud modes are not tested: Capy cloud VMs, Cloudroom cloud threads,
Conductor Cloud, Superset cloud workspaces, Claude desktop cloud sessions and Codex cloud tasks. Their existence is listed in Track F.
Not in v1: Herdr (a terminal multiplexer, not a desktop app), Tern and Cursor (out of v1 scope).

## 3. Tests

Test IDs are stable. Every chart, receipt and data row carries its test ID.

### Track A. Speed and Weight (replay server, no model usage)

| ID | Public name | Question | Unit, direction | Runs |
|---|---|---|---|---|
| A1 | Cold Start | Launch from a cold machine state to typing accepted. A first launch from a quarantined copy is recorded once and not ranked | s, lower | 10 |
| A2 | Relaunch | Launch after a normal quit, to typing accepted | s, lower | 10 |
| A3 | Thread Open | New-thread action to typing accepted, in the same workspace. Creating a new worktree is timed apart where the ADE does it | ms, lower | 10 |
| A4 | First Word | Enter to the first word of the answer on screen, against the replay server. A live-API number is published as secondary | ms, lower | 10 |
| A5 | Weigh-in | RAM of the app at rest | MB, lower | 1 window of 60 s |
| A6 | Idle Burn | CPU, wakeups and energy at rest, window in front and window covered | %, lower | same window |
| A7 | Fight Weight | RAM of the app while 5 agents stream | MB, lower | 1 window of 3 min |
| A8 | Typing Lag | Keystroke to pixel while 5 agents stream | ms p50/p95, lower | 60 keystrokes |
| A9 | Ghost Weight | RAM still used 60 s after quit | MB, lower | 3 |
| A10 | Scale | RAM and Typing Lag with 20 open threads | MB per thread, lower | 1 |
| A11 | Long Thread | Open, scroll and switch a 2,000-message thread | ms, dropped frames, lower | 5 |
| A12 | Leak | RAM growth over 30 min of real work (measured during Track C) | MB/h, lower | passive |

A1 + A3 + A4 is also shown as one number, **Ready to Answer**, because some ADEs start the agent
when you open a thread and others when you send.

### Track B. Tokens (real model, small usage)

| ID | Public name | Question | Unit | Runs |
|---|---|---|---|---|
| B1 | Hello Tax | Tokens and $ sent for the prompt "hi", split into fresh input, cache write, cache read, output and side calls | tokens, $ | 3 per model |
| B2 | Request Anatomy | What the ADE adds to the first request against the Bare CLI: system prompt, tools, MCP tools, injected text | tokens per category | 1 per model |
| B3 | Real Prompt Tax | The same split for one read-only real prompt | tokens, $ | 1 per model |
| B4 | Repo Rules | Does the agent see the repository's `AGENTS.md` (a canary instruction) | yes or no | 1 per model |

### Track C. Orchestration and Reliability (real model: Claude)

| ID | Public name | Question | Output | Runs |
|---|---|---|---|---|
| C1 | Orchestrated Build | Can a lead agent split 4 work items across workers, merge them and pass hidden tests | Shipped x/5 (hidden test groups W1, W2, W3, W4, Integration), Time to Green, Fan-out, Handoff x/4, Orchestration Tax | 1, a second run if the first fails |
| C2 | Message Delivery | Do follow-up messages sent during work reach the agent and get applied | Dropped x/3, Applied x/3 | 1 |
| C3 | Chat Lock | Does the composer refuse typing for more than 2 s while agents work | count, longest block in s | during C1 and C2 |
| C4 | Agent Killed | The agent process is killed at 90 s. Does the ADE show it and can the task finish | Survival: pass, partial, fail | 1, a second run if fail |
| C5 | Network Cut | The model API is blocked for 30 s at 90 s. Does the task continue | Survival | 1, a second run if fail |
| C6 | App Restart | The ADE is quit and reopened at 90 s. Do threads restore and finish | Survival | 1, a second run if fail |

ADEs without orchestration (Emdash, Conductor) show "not supported" in C1, never zero. C2 to C6 apply to all.

### Track F. Fit (facts, no score)

Platforms, license, price, models and auth (subscription, API key, own credits), factory defaults
(model, effort, permissions, telemetry), orchestration support, worktrees, diff review, PR flow,
remote and mobile access, and what the ADE writes into global agent config.

## 4. Models and settings

Pinned before each run. v1 ran the Claude column only.

| Setting | Claude | OpenAI |
|---|---|---|
| Model | Claude Opus 5.5 (`claude-opus-5-5`) | GPT-6.1 Sol (exact model ID in Codex confirmed in the pilot) |
| Effort | high, set explicitly in every ADE | high, set explicitly |
| Used in | Track A (set in the ADE; the replay server answers); B1-B4 for all ADEs that support Claude; all of Track C | B1-B4 for all ADEs that support Codex; Track C only for the Codex app and the Codex control |
| Plan | one dedicated Claude Max account | one dedicated ChatGPT account |

Every ADE runs with full access inside its worktree, prompt rewriting off, telemetry off and the model fixed
(never an automatic router). Factory defaults are recorded in Track F, not scored.

## 5. Equal conditions

Machine:

1. A dedicated macOS user, `ademark`. The owner's account is logged out during runs.
2. One ADE open at a time. Nothing else runs except the harness in Ghostty.
3. Display at 60 Hz. Resolution and scale are recorded and published.
4. Spotlight, Power Nap, sleep, automatic software updates, iCloud sync and Time Machine are off.
5. Before every Track A and C block: swap used is 0, thermal state is nominal, and non-ADE CPU stays under 0.1 core for
   60 s. Track B reads tokens, which load does not change, so only the thermal gate applies to it.
6. Every ADE window is 1600 × 1000 points, in front and uncovered, except in the covered-window variant of A6.
7. No screen recording runs during A5, A6 and A7. Timing tests (A1-A4, A8, A11) use recording. A8 runs in a second,
   identical 5-stream window right after A7.

Agent:

8. The same Claude Code and Codex binaries for every ADE that allows it. Bundled versions are recorded from each request's User-Agent.
9. The same model, effort and permissions everywhere (section 4).
9b. Experimental orchestration (Orca, super.engineering, Capy) is turned on only for Track C. Tracks A and B measure
    the features each ADE ships by default.

Repository and config:

10. The same arena commit, byte-identical prompts and the same `AGENTS.md`.
11. Before each ADE, inside the `ademark` user: a clean snapshot of `~/.claude`, `~/.codex` and `~/.agents` is restored,
    the ADE's data folder is replaced by its signed-in seed copy (logged in, no threads, no project), and every process
    of the previous ADE is gone.
12. Contamination check before each ADE: a Bare CLI "hi" against the replay server must send a request with the same hash
    as the control's. If not, the block stops. This uses no plan.

Measurement:

13. RAM and CPU count every process the ADE is responsible for: helpers, renderers, daemons, launch agents.
    Agent CLI processes are counted apart.
14. Tokens come from network capture of every process, so side calls (titles, branch names, commit messages) count.
15. Timing uses one method for every app: a probe keystroke and the frame where it appears (TESTS.md).
16. The ADE order is random. The seed is published.

Repairs:

17. If an ADE still fails after the end-of-night retry, an agent may repair how the harness drives that ADE. It runs
    only between blocks, never during one. It may change only that ADE's profile, gate file, adapter file and seed.
    Code refuses every other change, so it can never touch timing, sampling, gates, replay, capture, grading, prompts
    or tasks. Before the ADE runs again, code checks that no agent process and no ADE process is alive. A repaired ADE
    is measured again in full, every test of the track, and its old rows stay as superseded. Every repair diff is
    published.

## 6. Statistics and presentation

- Every run is a dot. Charts show every dot, the median, the 25-75 % box and the min-max range.
- A difference between two ADEs is a **tie** when the 95 % bootstrap interval of the paired difference includes 0.
- Track C results with one run are labeled "single run". A failure gets a second run, and both are published.
- The Bare CLI is a reference line on every chart. It is never ranked.
- Each ADE gets five grades: Speed, Weight, Tokens, Orchestration, Reliability. The grade thresholds are fixed
  after the pilot and before the main run, and published in the pre-registration.
- There is no single overall winner unless its weights were pre-registered.
- v1 publishes no grades and no overall winner. The site ranks each test on its own, and tie intervals are not in v1.

### Top-up inside a run (since 2026-11-10)

After the first pass of every app, Control runs a test again when it has fewer valid repetitions than its minimum
(`adaptive.min` of its runner, else `repeats()`). The rules:

1. All repetitions of one test come from one attempt. A test takes every row of a later attempt only if it was under
   its minimum before that attempt ran, whatever those rows show. A test that was complete keeps its attempt. The
   choice depends only on the state before the top-up, so it never picks the better result.
2. A top-up refuses to run, and its rows are never used, when the machine id or the app's `ade_build_sha256` differs
   from the first attempt. An app that updated itself is measured again in full.
3. A test that reads the state of another test runs with it (`RUNS_WITH` in `bench/control/topup.ts`: A6 and A10 need
   A5). The companion's rows stay from the earlier attempt when it met its minimum there, also when it fails in the
   top-up.
4. A test whose invalid reason is an approved accepted limit (`bench/night/known-failures.ts`) gets no top-up. Rows of a
   variant the app does not support (`not supported`) never make a test short.
5. The night runs one top-up per app by itself. A second failure stays invalid with its reason.
6. More than one top-up for an app happens only after a fix, by the owner's action (**Measure what is missing** on the
   panel), in the same run and with the same native helper (the run's `.inputs` baseline refuses another). That pass
   measures in full each app with no measured attempt, keeping its attempt count, and gives each measured app one more
   top-up of the tests still under their minimum after every earlier attempt. Nothing starts a later top-up by itself,
   so a test that keeps failing cannot loop. The night stays open until the owner closes it.
7. The report names the attempt of each test (`results/<run>/report.md`). Rows of two runs are never mixed: the rows of
   `control-2026-11-09T04-18-06Z` stay a comparison set.
8. A test is set aside only with evidence, by a reviewed entry in the repository (`SET_ASIDE` in
   `bench/night/set-aside.ts`: run, app, test, attempt, one sentence of reason, the evidence path, the date). Its rows in
   that attempt then count as not valid, with the reason `set aside after review: <reason>`, so the test is under its
   minimum and is measured again in the same run, by a top-up under rule 6. The rows on disk never change. The report
   shows the attempt as set aside with its reason, never as valid and never as NEW. An entry never makes a row valid. An
   entry that names no folder or row of the report changes nothing and is named in the report's notes.

Smoke rows (the rehearsal, `rehearsal-<time>`) never count as a measurement: the report refuses a rehearsal folder.

### Tokens and orchestration apart from the measure (since 2026-11-12)

A Control night measures Track A in its measure and top-up steps, whatever `~/.config/ademark/tracks` says. Track B and
C1 run in steps of their own, after every measure and top-up of a pass:

1. **Tokens.** `run --ade <id> --tracks B` in `<run>-<ade>-tokens-<n>`, cut at 45 minutes. A healthy block takes 4
   to 5 (6 Nov); the limit holds a block where every turn runs to its cap, tried twice. Every app gets one.
2. **Orchestration.** `run --ade <id> --tracks C --tests C1` in `<run>-<ade>-orchestration-<n>`, cut at 140 minutes (two
   runs of the 45-minute C1 cap, each with its wait for 5 quiet minutes, the settle and the grading: up to 131 minutes). Bare CLI goes first, because its solo run of the C1 goal is the
   baseline of `orchestration-tax`. Then each app whose adapter has a trigger line, read when the step is planned. An
   app with a null trigger has no orchestration (C1 not supported) and an app with no trigger yet is not calibrated:
   neither gets a step, and the report says which from the adapter.
3. Why apart: on 6 Nov a stopped Track B block made Control measure the whole app again. Track B and C spend the
   Claude plan, and C1 is the longest and riskiest test. Run last and alone, neither can cost a Track A result.
4. A failed or stopped late step changes nothing in the app's other steps: no retry of the measure, no defer, no
   top-up. It shows as failed with its note, and the owner's next pass (**Measure what is missing**) runs it again in
   the next folder number. The report reads only the newest attempt of each kind that ran to its end, whole: a late
   step has no top-up and no merge.
5. Before every late step, Control calls the real model once. If it does not answer (a plan at its limit), Control
   waits and asks again every 10 minutes, for up to 6 hours: a 5-hour window of the plan opens again within that time,
   and one C1 can use up a window. If it still does not answer, every late step left in the pass is skipped with the
   reason `the Claude plan did not answer`. They are not failed attempts, and the next pass runs them.
   A late step that ran to its end with no valid row measured nothing: the next pass runs it again too.
6. A set-aside entry (`attempt: "tokens-1"`) and an approved accepted limit work for B and C1 rows as for A rows.
   `orchestration-tax` is the app's C1 tokens and $ over those of Bare CLI's solo run (its lowest repetition with a
   valid value); without valid rows on both sides the report gives no number, with the reason.

The other Track C tests (C2 to C6, reliability) are not part of a night yet.

## 7. Transparency

1. **Pre-registration.** v1 was not pre-registered. The repository stayed private until the first results, so the
   method, field, versions, prompts and hidden-test hashes are published together with the results. From the next
   release, they are committed and tagged in git before the first run, and the SHA-256 of the tag goes on X.
2. **Lineage and author ties.** Synara is a fork of T3 Code, and Cloudroom's GUI derives from bb. The author called
   T3 Code "best tool" in tier list v2, contributed to several ADEs, and uses a fork of Zeron (upstream Zeron is tested).
3. **Receipts.** Every run of every test is a row in `data/`, with the app version, and every number on the site
   can be rebuilt from it. Screen recordings, screenshots and network captures stay private, because they show
   the reference machine and its account.
4. **Right of reply.** Every vendor can reply after publication. Their reply is shown next to their row, unedited.
   Method errors are fixed in a public corrections log with the old and new value.
5. **Re-runs.** Any vendor can ask for a re-run on a new stable release. Results older than 60 days are marked stale.
6. **Money.** ADEMark sells nothing to vendors and lives on donations. No donation buys inclusion, exclusion, position or a change of result ([BUSINESS.md](BUSINESS.md)).

## 8. Open harness

ADEMark is built like Terminal-Bench: an open harness that anyone can run, with tasks and adapters in a fixed format.

- **One command.** `bun bench/cli.ts run --ade <id> --tracks A,B,C` runs the same tests on any supported machine and writes
  the same `results/` rows and receipts.
- **ADE adapters.** One file per ADE implements the same interface: `installCheck`, `reset`, `configure`, `launch`,
  `newThread`, `send`, `waitDone`, `quit`, `processes`. Vendors and the community add ADEs by pull request.
- **Platform layer.** Each instrument sits behind an interface (sampler, keystroke-echo timer, replay server,
  network capture, fault injector). v1 ships macOS. Linux and Windows implementations can follow without changing tests.
- **Task format.** Each task is a folder: `prompt.md`, `task.toml` (ID, time cap, follow-ups, faults), `tests/`
  (hidden), `solution/` (two references). New task sets can be added without changing the harness.
- **Submissions.** Anyone can submit results from their own machine. Each submission shows its hardware and OS.
  Only runs on the reference machine, or audited re-runs, get the "verified" label.

## 9. What v1 cannot say

- Which ADE writes better code. Track C uses one real task; it shows whether an ADE finishes it, not who codes best.
- Claude against GPT. Each model runs through a different agent.
- Anything about other machines. Results are for the reference machine; the harness is open so anyone can run it.

## Changelog

- 2026-11-12: v1.0 published with the first results: 15 ADEs and the Bare CLI, Track A, Track B and C1. C2 to C6 and the Codex app are not in v1.
- 2026-10-19: v1.0-draft.
- 2026-11-12: a night measures Track A in its measure and top-ups; Track B and C1 run in their own tokens and
  orchestration steps after them, and a failure there never changes a Track A result (§6).
- 2026-11-10: a pass that measures only what is missing (§6, top-up rule 6): later top-ups only by the owner's action
  after a fix, in the same run; a test takes the rows of the latest attempt that ran it while it was short.
- 2026-11-10: top-up inside a run (§6). QA runs by day and never starts a measurement. Each invalid row is an approved
  accepted limit or NEW. A rehearsal (`run --smoke`, A1 to A3 with 3 repetitions) never counts as a measurement.
- 2026-11-06: ADEMark Control runs the queue (RUNBOOK.md §0). mitmproxy and Claude Code telemetry run together in each
  token block: telemetry adds any CLI call the proxy missed, and no call counts twice. CPU and swap gates do not apply to
  Track B. A launch row also
  reports the instructions the app ran.
- 2026-11-05: an ADE enters a night only after `bun bench/cli.ts prepare` proved it on the real app (RUNBOOK.md §0). A test stops
  after 3 failed repetitions in a row. A11 returns to the end of the thread. `app-peak` sums the app group.
- 2026-11-04: §5 item 17 (self-repair between blocks), and swap no longer stops a Track B block.

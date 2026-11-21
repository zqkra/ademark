# Proposal: tests for CPU under load, focus, hidden threads, idle agents and request overhead

Status: draft. A method change needs an issue first (CONTRIBUTING.md, Pull requests). Terms such as night, gate,
rehearsal, top-up and family are defined in METHODOLOGY.md §2 and §6 and TESTS.md §1.

## 1. Issue text

**Title:** Method: measure CPU under load, focus state, hidden threads, idle agents and per-request overhead

**What changes.** Seven additions to Track A and Track B. Three are new rows computed from samples or captures the
harness already takes (items 1, 5, 6). Two are new tests that run only as pilots (items 2, 3). Two are specs with no
code yet (items 4, 7).

| # | Change | Kind | Extra time per app |
|---|---|---|---|
| 1 | A7 also publishes app CPU, wakeups and energy, and agents CPU | new rows, same window | none |
| 2 | A13 Focus Idle: CPU at rest with the composer focused, then with focus moved off it | pilot test | 3 to 13 min |
| 3 | A14 Background Streams: CPU while 5 agents stream, streaming thread in front, then an idle one | pilot test | about 2 min |
| 4 | A15 Idle Release: agent memory and count over 45 min of rest after A10 | spec only | 45 min, only when named with `--tests A15` |
| 5 | A10 also publishes agent memory, agent count and the total of its rest window | new rows, same window | none |
| 6 | B2 also publishes `total`, the sum of its segments | new row, same counts | none |
| 7 | A4, A8 and the CPU rows measured on each surface of apps with both a chat view and a terminal view | spec only | depends on the app |

**Why.**

- A6 measures CPU at rest only. Nothing measures CPU while agents work, which is when a laptop runs warm. A7 already
  samples CPU counters for 3 minutes and throws them away.
- A6 `front` does not say where focus is. In some apps a focused text field keeps the caret, the compositor or a frame
  loop running. The same app can idle at very different CPU depending on focus.
- Users run agents in threads they are not looking at. No test says whether an app keeps rendering threads that are
  hidden.
- Some apps end idle agent sessions after a while, others keep them. A5 and A10 see one minute of rest only.
- A5 and A7 publish `app` and `total` side by side. A10 publishes `app` only, so an app that keeps one agent per
  thread looks light at 20 threads.
- B2 gives tokens per segment. A reader wants one number: the tokens the app adds to every request. B2 has every part
  of it already.
- A3 specifies `other-mode` for apps with two ways to start a thread. Apps with a chat view and a terminal view are
  measured on one of them only.

**Fairness.** Every addition applies to every app the same way. New rows use the Bare CLI as their reference line,
like every other row. Pilot tests are never ranked until the pilot proves them. No existing row, step, window or
order changes: a dry run of `bare-cli` on Tracks A and B writes the 110 rows of `main` with the same values and the
same instrument calls, plus 8 new rows (4 for A7, 3 for A10, 1 for B2).

**What it does not change.** Existing test methods, windows, run order, validity rules, gates and top-ups. The code
does not touch the site; §2.5 proposes label text for the maintainer to decide.

**Disclosure.** The proposer builds Pane, one of the ADEs this benchmark measures. Items 2 and 6 measure focus-idle CPU
and per-request tokens, both of which Pane recently improved.

**When a pilot is proven.** A pilot test enters the night and the site after it gives valid rows on at least 3 apps of
different families on the reference machine, its pilot checks (marked below) pass, and the maintainer accepts it.

## 2. Test specs

Each spec says what it reuses. "Implemented" means the draft pull request has the code and unit tests. "Spec only"
means no code yet.

### 2.1 A7 CPU under load (implemented)

Purpose: CPU, wakeups and energy of the app while 5 agents stream.

Reuses: A7's 3-minute sample window and `appRates` of A6.

Preconditions and steps: A7's, unchanged.

Values (new rows of A7):

| Variant | Computed as |
|---|---|
| `app-cpu` | Δ(`cpu_user_ns` + `cpu_sys_ns`) of the `app` group ÷ Δwall, as % of one core (A6 formula) |
| `app-wakeups` | Δ(`wakeups_idle` + `wakeups_irq`) ÷ Δwall, per s |
| `app-energy` | Δ`energy_nj` ÷ Δwall, in mW |
| `agents-cpu` | The CPU formula over the `agents` group |

`agents-cpu` is not the app's cost. It shows each app carried the same agent load. A drop there means the streams
slowed down, which a reader must see before comparing `app-cpu`.

Validity: A7's rules. A CPU row invalid on its own (an unreadable counter) never re-runs A7, so the memory rows keep
their attempt.

Receipt: A7's `samples.csv`. Runtime cost: none.

**A8 window (spec only).** A8 types for about 15 s while its own 5 streams run. A concurrent sampler would give a
second CPU number under typing. It would also add a process during a timing test. The pilot first checks that a 4 Hz
sampler does not move A8 `p95` on the Bare CLI and two apps (20 runs with and without, paired). Only then does A8
publish `typing-app-cpu`.

### 2.2 A13 Focus Idle (implemented as a pilot)

Purpose: CPU, wakeups and energy at rest with the composer focused, and with focus moved off it inside the app.

Reuses: A5's settle rule, A6's rate formulas, the echo timer (§1.3) and the native `click` command.

Pilot: runs only with `run --tests A13`. Nights, Control, gates and rehearsals do not load it.

Preconditions: after A1, at the end of the Track A block. A1's last repetition quits the app, so A13 launches it
again with `adapter.launch()`. No screen recording during the windows.

Steps:

1. Settle as A5 step 1 (cap 10 min).
2. Click the composer: `focusClick`, else the centre of `launchComposerRect` or `composerRect`. The click puts the
   pointer back where it was.
3. Type the probe until the echo timer reads it (10 s cap), then clear it. The composer now has focus, as after typing.
4. Wait 5 s. Sample 60 s (`focused`).
5. If the profile has `calibration.blurClick`: click it, wait 5 s, sample 60 s (`blurred`), click the composer again.

`blurClick` is a new optional profile field: a point inside the window that takes focus off the composer and starts
nothing (an empty part of a sidebar or a title bar). It is set per app during calibration, from a screenshot, never by
Accessibility in a step.

Values: `focused-cpu`, `focused-wakeups`, `focused-energy`, and the same three for `blurred`. The finding is the gap
between the two windows of one app. A13 runs after 20 threads and a long thread exist, so it is not compared with A6.

Validity: `focused` rows are invalid when the probe never shows. All rows are invalid when swap grew. A profile without
`blurClick` writes no `blurred` rows: not calibrated is no failure. **(validate in pilot: record 2 s of the composer
region before each window and check the caret blinks when focused and stays still when blurred.)**

Receipt: `settle-*.csv`, `samples-focused.csv`, `samples-blurred.csv`, `frames-focus.json`.

Runtime cost: the settle (often 1 to 2 min, at most 10 min) plus about 2.5 min.

### 2.3 A14 Background Streams (implemented as a pilot)

Purpose: the app's CPU while 5 agents stream in threads the user is not looking at.

Reuses: A7's five streams and validity rules, A3's seeded-thread marker and `timed.shortThread`, A6's rate formulas.

Pilot: runs only with `run --tests A14`.

Preconditions: after A13 (or after A1, launching the app again). Replay server on. No screen recording during the
windows.

Steps:

1. Open the 5 streams of A7. Thread 1 ends in front. Wait 5 s.
2. Sample 45 s (`front`).
3. Run `timed.shortThread` and watch `threadRect` for the seed marker `unchanged` (10 s cap).
4. Sample 45 s (`background`).

Both windows and the switch end inside one 3-minute stream, also for an app that takes 40 s to start its five streams.

Values: `front-cpu`, `front-wakeups`, `front-energy`, `front-agents-cpu`, the same four for `background`, and
`agent-count`. The finding is `background-cpu` against `front-cpu` of the same app, with `agents-cpu` equal in both.

Validity: as A7. Each window needs 5 live agent processes in at least 5/6 of its ticks (A7's 150 s of 180 s, applied
to 45 s). Every stream must reach the replay server. No
stream may end before the background window does (from the replay log). `background` rows are invalid when the marker
never shows.

Receipt: `samples-front.csv`, `samples-background.csv`, `frames-switch.json`. Runtime cost: about 2 min.

### 2.4 A15 Idle Release (spec only)

Purpose: does the app end idle agent sessions, and when.

Reuses: A10's 20 threads, the A5 `agents` and `agent-count` computation, and the background sampler of Track C.

Preconditions: the app holds 20 threads, as after A10. In its own late step the app is launched, seeded with 20
threads as A10 does, and left until every seed turn has ended. No input for the whole window.

Steps:

1. Start the background sampler at 1 Hz (4 Hz over 45 min is a large file for no gain).
2. Rest 45 minutes. Nothing is typed or clicked.
3. Every minute, record the median `agents` MB, `agent-count` and `app` MB of that minute.

Values:

| Variant | Computed as |
|---|---|
| `agents-start`, `agents-end` | `agents` MB of the first and the last minute |
| `count-start`, `count-end` | `agent-count` of the first and the last minute |
| `release-minute` | The first minute whose `agent-count` is at most half of `count-start`, or `none` |

Validity: invalid if any agent process used CPU above 0.05 core for more than 10 s in a row (an agent at work is not
idle), or if swap grew.

Where it runs: 45 minutes per app is too long for the Track A block, so it runs only with `--tests A15`, like the
pilots, and never in a night, Control, gate or rehearsal. The total runtime is bounded at 50 minutes per app plus
the seeding (about 2 minutes).

Receipt: `samples.csv` at 1 Hz, `minutes.json`.

### 2.5 App and total side by side (implemented for A10)

Every memory test should publish `app`, `total` and `agent-count` together, so an app is never heavy or light only
because of the agents it keeps.

| Test | `app` | `agents` | `total` | `agent-count` |
|---|---|---|---|---|
| A5 | `app` | `agents` | `total` | `agent-count` |
| A7 | `app-p95` | `agents-p95` | `total-p95` | `agent-count` |
| A9 | | | the sum of everything left after quit | (a process list, not a count) |
| A10 | `rest-20` | `rest-20-agents` (new) | `rest-20-total` (new) | `rest-20-agent-count` (new) |
| A12 | `app` slope | | | |

A10's new rows read its existing rest window. An app whose profile excludes `A5:agents` gets them as not supported,
with the same reason.

Site, smallest change (spec only): the site ranks `A5/total` and `A7/total-p95`, while TESTS.md calls `app-p95` the
A7 headline. The chart titles say "Memory with 5 idle threads" and "Memory while 5 agents stream" without saying
the agents are included. Proposal: keep the ranked key, and add "app and its agents" to the `what` text of A5 and
A7, with the `app` value and agent count in the muted side text. The maintainer decides which key is the headline.

### 2.6 Request overhead in tokens (implemented), and cache across B1 reps (spec only)

**B2 `total`.** B2 now writes a sixth row, the sum of its five segments, each already counted with `count_tokens`.
`total` against the Bare CLI's `total` is the tokens the app adds to every main-thread request before the prompt. The
summary's paired difference gives it with no new code. Each segment is counted alone, so both totals hold the framing
of five count requests. The difference does not.

**Cache across B1 reps.** B1 already writes `cache-write` and `cache-read` per repetition, and the three reps open
new threads within 5 minutes. An app whose request prefix is stable writes the cache once and reads it after. An app
that puts a time, an id or a path into its prefix writes it again for every thread. A cache write is priced above
fresh input and far above a cache read (`prices/2026-10.json`), so this changes cost more than the prefix size does.
Three reps 30 s apart stay inside the 5-minute cache lifetime.
The rows hold this today; the summary median hides it. Proposal (presentation only): the report shows `cache-write` of
rep 1 next to the median of reps 2 and 3, for each app and the Bare CLI. No new measurement.

### 2.7 Per surface (spec only)

Some apps offer two ways to run the same agent: a chat view on an SDK, and a terminal view with the agent's own UI.
TESTS.md A3 already specifies `other-mode` for two thread modes, but no code implements it, and no profile field
describes it.

Proposed profile field:

```json
"surfaces": {
  "other": {
    "label": "terminal",
    "newThread": [{ "kind": "keys", "combo": "cmd+shift+t" }],
    "composerRect": { "x": 300, "y": 900, "w": 900, "h": 60 },
    "activeComposerRect": null,
    "clearKeys": ["ctrl+u"]
  }
}
```

With it, A3 `other-mode`, A4, A7's CPU rows and A8 run once more on the other surface, with variant names prefixed
`other-` (A4 `other-total`, `other-before-request`, `other-on-screen`; A8 `other-p95`). A4 keeps the split of TESTS.md
A4, which the harness already writes as the rows `before-request` (Enter to request received) and `on-screen` (request
received to the first word on screen). Other
surfaces are reported apart and not ranked, as A3 `other-mode`.

Runtime cost: A4 6 to 10 runs, A8 one 5-stream window, per extra surface.

## 3. Open questions for the maintainer

1. A10's rest window starts after 15 seed turns. A8's five 3-minute streams can still run then on an app that seeds
   fast. Should A10 wait for them, as A7 waits for longer streams? This proposal does not change it.
2. Which memory key is the headline? TESTS.md calls A7 `app-p95` the headline, and A5 `app`, while the site ranks
   `A7/total-p95` and `A5/total`. The two give different orders for apps that keep one agent per thread.

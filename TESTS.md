# ADEMark tests

Version: v1.0, 2026-10-19 (first results published 2026-11-12).

This file gives the exact procedure for every test ID in [METHODOLOGY.md](METHODOLOGY.md) §3.
Prompts and hidden tests are in [TASKS.md](TASKS.md). Per-ADE launch, reset, drive and attribution details are in
[ADES.md](ADES.md). Run order, gates and failure handling are in [RUNBOOK.md](RUNBOOK.md).

Items marked **(validate in pilot)** are designed but not yet proven on this machine. The pilot must prove each one
or change it before pre-registration.

Every test runs through one command, on any supported machine:

```sh
bun bench/cli.ts run --ade <id> --tracks A,B,C
```

The same command, the same adapter and the same task folders must give the same rows and receipts whoever runs it
(METHODOLOGY.md §8). Every ADE runs its agents locally. Cloud modes stay off for every ADE (METHODOLOGY.md §2).

## 0. Shared output

### 0.1 Result row

Every measured repetition writes one JSON line to `results/<run-id>/rows.jsonl`:

```json
{
  "run_id": "2026-10-21T19-00Z-3f9c2a1",
  "machine_id": "ref-mac-mini-m4-16gb",
  "ade": "t3code",
  "ade_version": "0.1.0",
  "ade_build_sha256": "…",
  "family": "EL-SDK",
  "test_id": "A1",
  "variant": "cold",
  "rep": 3,
  "model": null,
  "effort": null,
  "server": "none",
  "value": 2.41,
  "unit": "s",
  "started_at": "2026-10-21T19:42:07.113Z",
  "duration_ms": 41230,
  "valid": true,
  "invalid_reason": null,
  "drive": "cdp",
  "receipts": {
    "samples": "t3code/A1/rep-03/samples.csv",
    "video": "t3code/A1/rep-03/video.mov",
    "frames": "t3code/A1/rep-03/frames.json",
    "capture": null,
    "log": "t3code/A1/rep-03/notes.md"
  },
  "notes": ""
}
```

Field rules:

| Field | Rule |
|---|---|
| `ade` | Adapter ID from ADES.md (for example `t3code`). The control adapter `bare-cli` writes `bare-cli-claude` or `bare-cli-codex`. |
| `variant` | Empty unless the test defines variants (`cold`, `first-launch`, `front`, `covered`, `live`, `default-mode`, `other-mode`, `sessions-kept`). |
| `model` | `null` for Track A on the replay server. Model ID string for Track B and C. |
| `server` | `replay`, `live` or `none`. A row with `live` in a test that expects `replay` is shown with a separate marker. |
| `unit` | RAM rows use `MB` = 1,048,576 bytes, the unit of `footprint` and Activity Monitor. |
| `value` | One number in `unit`. Tests with several outputs write one row per output and set `variant` to the output name (for example `p50`, `p95`, `handoff`). |
| `valid` | `false` when a validity rule in the test failed. Invalid rows stay in the file and are never charted. |
| `drive` | How the harness drove the ADE for this row: `cli`, `api`, `cdp`, `ax`, `keys`, or `manual`. |
| `machine_id` | Points to `results/<run-id>/manifest.json`, which records hardware model, chip, RAM, macOS build, display mode, harness commit, and `verified: true` only for the reference machine or an audited re-run. |

Aggregates go to `results/<run-id>/summary.json`: per ADE and test, `n`, `median`, `p25`, `p75`, `min`, `max`,
and, against the Bare CLI, the 95 % bootstrap interval of the paired difference (10,000 resamples).

### 0.2 Receipt folder

`results/<run-id>/<ade>/<test-id>/rep-<nn>/` holds the receipts of one repetition. `<ade>` is the row's `ade`
(`bare-cli-claude`, `bare-cli-codex` or the adapter ID). Track B runs once per agent, so its receipts add the agent:
`results/<run-id>/<ade>/<test-id>/<agent>/rep-<nn>/`.

| File | Contents |
|---|---|
| `samples.csv` | Sampler rows for the measurement window |
| `frames.json` | Frame timestamps, OCR hits and dirty-rect summaries from the echo timer |
| `video.mov` | Recording of the ADE window, for timing tests only |
| `screenshot-<name>.png` | Track C screenshots, one at the start, at each event and at the end |
| `notes.md` | Commands run, gate values, anything unusual |

The capture of model requests and responses (auth headers removed) is not per repetition. It is written once per block, in `results/<run-id>/<ade>/capture-<track>-<n>/capture.jsonl`.

### 0.3 Event log

`results/<run-id>/events.log` records every Stumble with a timestamp: crash, freeze over 2 s outside C3, lost
session, system dialog, gate failure, plan-limit pause, harness error. Harness errors are never counted against an ADE.

## 1. Instruments

### 1.0 Platform interface

Each instrument is an interface. v1 ships the macOS implementation. A Linux or Windows implementation can replace it
without changing any test in this file.

| Interface | Job | macOS v1 implementation |
|---|---|---|
| `Sampler` | RAM, CPU, wakeups and energy per attributed process | `ademark-sample` (Swift, `proc_pid_rusage`), §1.2 |
| `EchoTimer` | Time until typed text appears on screen | `ademark-echo` (Swift, ScreenCaptureKit + Vision), §1.3 |
| `ReplayServer` | A model API that answers with fixed recorded output | `ademark-replay` (Bun), §1.4 |
| `Capture` | Every model request every process sends | `mitmdump --mode local` + addon, §1.5 |
| `Faults` | Kill the agent, cut the network, restart the app | `ademark-fault` (`kill`, `pf`, `osascript`), §1.6 |
| `Adapter` | Install check, reset, configure, launch, drive and quit one ADE | `bench/adapters/<ade>.ts`, §1.7 |

### 1.1 Controller

- The `ademark` CLI is a Bun program in `bench/` (`bench/cli.ts`, installed as `ademark`). It is the only entry point:
  `bun bench/cli.ts run --ade <id> --tracks A,B,C`, plus `bun bench/cli.ts summarize`. The grader is `bench/grade/grade.ts` and `bench/grade/validate.ts` (`bench/grade/README.md`).
- On the reference machine it runs from Ghostty in the `ademark` macOS user. Ghostty runs `command = /bin/zsh -f`,
  so no shell startup files run.
- The CLI is the only process started by the operator during a block. No LLM session runs during a block.
  The repair agent of METHODOLOGY.md §5 item 17 runs only after every block of the night has ended, and code checks
  that it is gone before the repaired ADE is measured again.
- Native helpers (sampler, echo timer, fault injector) are small Swift binaries in `bench/native/`, built once and
  signed ad hoc. Ghostty and the helpers have Accessibility and Screen Recording permission.
- Every timestamp is host time from `mach_absolute_time()` (or `clock_gettime_nsec_np(CLOCK_UPTIME_RAW)` in Bun
  through FFI), converted to nanoseconds with `mach_timebase_info`. **(validate in pilot: Bun and Swift read the same clock.)**
- At start, the CLI writes `results/<run-id>/manifest.json`: hardware, macOS build, display mode, every ADE and CLI
  version, the harness commit, the task folder hashes, the price file hash and the random order seed.

### 1.2 Sampler (`ademark-sample`)

Reads RAM, CPU, wakeups and energy for every process the ADE is responsible for.

Per process, every 250 ms (4 Hz), `proc_pid_rusage(pid, RUSAGE_INFO_V6)`:

| Field | Source | Unit |
|---|---|---|
| `phys_footprint` | `ri_phys_footprint` | bytes |
| `lifetime_max` | `ri_lifetime_max_phys_footprint` | bytes |
| `cpu_user_ns`, `cpu_sys_ns` | `ri_user_time`, `ri_system_time` × timebase (ticks are 125/3 ns on Apple Silicon) | ns |
| `wakeups_idle`, `wakeups_irq` | `ri_pkg_idle_wkups`, `ri_interrupt_wkups` | count |
| `energy_nj` | `ri_energy_nj` **(validate in pilot that it is filled)** | nJ |

Attribution. A process belongs to the ADE if at least one rule is true:

1. It is in the same resource coalition as the ADE's main process (`sudo taskinfo --coalitions`,
   `powermetrics --show-process-coalition`).
2. Its responsible process is the ADE (`sudo launchctl procinfo <pid>`, field "responsible pid").
3. Its executable is inside the ADE bundle or a vendor folder listed in ADES.md, or its code signature carries the
   ADE's Team ID (`codesign -dv <path>`).
4. It appeared after the ADE launched, and its parent chain leads to an attributed process.

The process list refreshes every 1 s (`proc_listallpids`). Shared system services (WindowServer, `mds*`, `trustd`,
`opendirectoryd` and similar) never join the ADE. They go into the system and WindowServer deltas.

Groups:

| Group | Contents |
|---|---|
| `app` | Attributed processes minus the agent subtrees |
| `agents` | Every subtree rooted at an agent process: the `claude` or `codex` binary (system or bundled), an Agent SDK child, an ACP or RPC agent, and their children (git, test runners, dev servers) |
| `system` | Everything else, reported only as a delta |

Per measurement window, the sampler also runs:

- `sudo footprint -j <file> --unmapped -p <pid> …` at the end of the window: the de-duplicated total for the `app` group.
- `sudo footprint --sysFootprint` at the start and end: the system-wide delta.
- `sudo footprint -p WindowServer` at the start and end: memory that lands in WindowServer because of the ADE's windows.

For the whole block, in the background:

- `vm_stat 1` and `sysctl vm.swapusage` every 10 s.
- Each token block runs mitmproxy and Claude Code telemetry together (`bench/capture/telemetry.ts`). The proxy also sees calls
  that skip the CLI, and telemetry adds any CLI call it missed. `capture.jsonl.source` holds the count of each.
- `sudo powermetrics -s tasks,thermal,cpu_power,gpu_power --show-process-coalition -i 1000 -f plist`.
  This keeps CPU time of short-lived processes that exited between samples, because a coalition keeps the usage of
  members that exited. **(validate in pilot: coalition CPU matches the sum of per-process samples within 5 %.)**

`samples.csv` columns: `t_ns, pid, ppid, group, exe, phys_footprint_b, lifetime_max_b, cpu_user_ns, cpu_sys_ns,
wakeups_idle, wakeups_irq, energy_nj`.

### 1.3 Echo timer (`ademark-echo`)

Measures when an app accepts typing, from the pixels only. It treats Electron, native and terminal apps the same way.

1. Record `t0 = mach_absolute_time()` immediately before the trigger: `NSWorkspace.openApplication` (A1, A2),
   the new-thread shortcut or click (A3), or the Enter key (A4).
2. Capture the ADE window with ScreenCaptureKit: `SCContentFilter(desktopIndependentWindow:)`, BGRA,
   `minimumFrameInterval = 1/60`, `queueDepth = 3`. Frame time comes from the sample buffer's presentation time
   on the host clock. For the Bare CLI, the captured window is Ghostty.
3. When the ADE owns an on-screen window at layer 0 (`CGWindowListCopyWindowInfo`), focus the composer. If the
   ADE does not focus it by itself, click the composer point from the ADE's calibration
   (the `calibration` object in `bench/adapters/<ade>.ts`). The click time is recorded; the clock keeps running from `t0`.
4. Post one probe character every 50 ms ±20 % (uniform jitter) with `CGEventPost(kCGHIDEventTap, …)`. The characters cycle through the
   probe string `ademarkqz`. An ADE whose own text in the composer holds a pair of those letters types another probe
   (`calibration.probe`), because step 6 would take that text as the echo: bb and Traycer type `xkvw` since 2026-11-11
   (their placeholders hold "folders" and "commands"). What is timed is the same: the first frame with typed text.
5. Run Vision OCR (`VNRecognizeTextRequest`, fast level) on the composer region of each frame.
6. **Ready** is the timestamp of the first frame where OCR reads 2 or more consecutive characters of the probe
   string in the composer region. The value is `ready − t0`.
7. Clear the composer: Command-A, then Delete. Never press Enter.

Keystrokes and clicks are posted only while the ADE is the frontmost app, so they can never land in another app.
A probe slot while the ADE is not frontmost is skipped, and the clock keeps running from `t0`. If a trigger (launch,
new-thread action or Enter) cannot be posted, the run is invalid with reason `trigger_skipped` and is re-run.
Each frame carries its time source (`pts`, `display` or `arrival`); a run with `arrival` frames is noted.

Analysis runs on the raw frames inside the helper, not on compressed video. The H.264 video is archived as a receipt.
The caret does not affect the result, because OCR reads characters and ignores the caret.

Secondary number, **visually settled**: the first frame after which no `SCStreamFrameInfo.dirtyRects` entry falls
outside the calibrated masks (caret, spinners, clocks) for 1 s. The probe region counts as a mask, because the
composer's caret blinks there. Cap: 5 s. If the window never settles, the row carries `notes: "never settled"`, and the
frames file lists the dirty rects that kept it busy, so calibration can mask them. (Pilot 2026-10-20: with a 30 s cap
and no caret mask, every A1 to A3 run waited the full cap, a third of each Track A block.)

Precision: frames arrive every 16.7 ms at 60 Hz and probes every 50 ms, so Ready is an upper bound within about
67 ms. A3, A4 and A8 publish this bound next to the value.

First read (A1, A2, A3): the harness counts the probe characters on the Ready frame, in probe order, with one misread
or dropped letter allowed inside the run. More than 18 (two cycles of the probe) makes the run invalid with `the
composer region read the probe late: <n> characters at the first read, so the region is not where the composer is`.
A region in the right place reads the probe a few characters after the app takes keys. On 2026-11-10 T3 Code 0.1.8 had
moved its composer, the region cut its first line, and the probe was first read at 88 characters: the times were the
time until the text reached the region. Every other valid A1 to A3 run of that night read 13 or fewer. The row notes
give `first_read_chars`. A real run whose frames file has no Ready frame is invalid with `the first read of the probe
was not checked`.

Real echo (A1, A2, A3): one word of the Ready frame (OCR lines split on spaces, letters and digits only) must be typed
probe. It holds a probe pair, and at most 2 edits (a wrong, missing or extra letter) turn it into a stretch of the
repeated probe; one last `l`, `i` or `1` is the caret and does not count. Otherwise the run is invalid with `Ready came
from text that is not the probe`. On 2026-11-10 bb's A1 and A2 reached Ready on its placeholder (`folders` holds `de`)
and Traycer's A1 on its transcript (`parsed` holds `ar`). The night's real short echoes need up to 2 edits (`adern`,
`> Tharkqzl`, `) rkgiadl`); the ordinary words that gave Ready need 4 or more.

Validation: 3 apps × 5 runs recorded at the same time by an external 240 fps camera. The agreement is published.

A test stops after 3 repetitions in a row with no valid row. Its rows stay invalid and the ADE goes to repair. An
output of one model needs at least half of its repetitions valid, and an adaptive output six valid runs, or the ADE goes
to repair. A2 is invalid when the app
survives the quit, because it would relaunch warm.

Adaptive repetitions (A1 `cold`, A2, A3 `default-mode`, A4 `total`): at least 6 valid runs and at most 10. After each
valid run from the 6th on, the harness computes the distribution-free 95 % interval of the median (order statistics,
binomial ranks). It stops when the interval's half-width is at most 5 % of the median or one display refresh
(16.7 ms), whichever is larger. The summary records how many runs each value used, and the run log records why the
runs stopped. Invalid runs do not count and are re-run as before.
**(validate in pilot)**

### 1.4 Replay server (`ademark-replay`)

A local server that answers like the model API with fixed, recorded output. It removes model and network speed
from Track A.

- Listens on `http://127.0.0.1:8787`.
- Anthropic side: `POST /v1/messages` (streaming SSE and non-streaming) and `POST /v1/messages/count_tokens`.
- OpenAI side: `POST /v1/responses` with streaming, for Codex. **(validate in pilot: the exact endpoint the pinned Codex uses.)**
- Accepts any API key or OAuth token.
- Answers come from fixed session files in `bench/replay/sessions/`. A session file lists, per turn, the SSE events
  to send. Text streams at a fixed 80 tokens/s in 50 ms chunks. Time to first byte is 0 ms by design.
- Logs every request: receive time (host clock), byte size, a SHA-256 of the body with volatile fields removed
  (IDs, timestamps, paths), and which ADE sent it. These logs drive the contamination check (RUNBOOK.md).

Pointing ADEs at it, before launch:

```sh
launchctl setenv ANTHROPIC_BASE_URL http://127.0.0.1:8787
launchctl setenv OPENAI_BASE_URL http://127.0.0.1:8787/v1
```

`launchctl setenv` affects apps that launchd starts after the call. Codex also reads `model_providers` and
`base_url` from `~/.codex/config.toml` in the `ademark` user. **(validate in pilot per ADE.)**

If an ADE ignores the base URL (bundled CLI without environment, the OWN family, first-party apps), its rows for A4,
A7, A8, A10 and A11 run on the live API with the same prompts. They carry `server: "live"` and a separate chart marker.
A1, A2, A3, A5, A6 and A9 never send a prompt, so they need no server.

### 1.5 Network capture (`ademark-capture`)

Records every model request any process of the ADE sends. Used in Track B and Track C. Never on during Track A.

- `mitmdump --mode local -s bench/capture/addon.py`. Local mode intercepts all processes on the machine.
- The addon sets `flow.response.stream = True` for `text/event-stream` responses, so streamed answers are not buffered,
  and writes each chunk to `capture.jsonl` with its host-clock time.
- Request bodies are stored with `authorization`, `x-api-key` and cookie headers removed.
- Usage is read from the final SSE events: Anthropic `message_start` and `message_delta` usage; OpenAI
  `response.completed` usage.

Trust for the mitmproxy CA, set before the ADE launches:

```sh
launchctl setenv NODE_EXTRA_CA_CERTS "$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
launchctl setenv NODE_USE_SYSTEM_CA 1
launchctl setenv SSL_CERT_FILE "$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
launchctl setenv CODEX_CA_CERTIFICATE "$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
```

The CA is also trusted in the `ademark` login keychain, for the Chromium layer of Electron apps.
`CODEX_CA_CERTIFICATE` comes from a third-party write-up. **(validate in pilot.)**

Completeness check: a completion that returned 200 without usage makes the capture incomplete, and token values fall back to
session logs. `/v1/messages/count_tokens` and other non-completion paths never carry usage and do not count, and neither does
a refused request. `nettop -P -L 0 -x -J bytes_in,bytes_out` before and after each test only adds the note
`nettop differs from capture`, because it counts all the traffic of the app, not just its model calls.

Main thread: the request whose last user message is the prompt, then its tool answers and `thread` continuations. A call that
repeats the prompt in its history but ends in its own text (title, suggestion) is a side call. Claude Code marks a real turn with
`cc_turn_origin=human` or `sdk`, which finds a prompt the app wrapped in its own instructions. If the main thread uses a model
other than the model of the run, the rows are invalid (`wrong model`), because they would not compare.

Cross-check against logs: `~/.claude/projects/*/*.jsonl` (usage fields) and `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
(`token_count` events). A difference over 2 % is recorded in `notes`.

If an ADE refuses the proxy (a Rust TLS stack with bundled roots, certificate pinning), the row carries
`notes: "capture refused"` and token values come from session logs only.

### 1.6 Fault injector (`ademark-fault`)

| Fault | Command | Used in |
|---|---|---|
| Kill agent | Find the agent process of the active thread (`agents` group, cwd equal to the task worktree via `lsof -a -p <pid> -d cwd`), then `kill -9 <pid>` | C4 |
| Cut network | Resolve the API hosts (`dig +short`, A and AAAA, three times) and block them in the `pf` anchor `com.apple/ademark` through the root script: `ademark-machine pf-block <addresses>` (it renders the rules and runs `pfctl -E`). After 30 s: `ademark-machine pf-clear` (`pfctl -F all` on the anchor, then `pfctl -X` with the saved token). The anchor sits under `com.apple/` because the macOS main ruleset evaluates only anchors there. **(validate in pilot: CDN IP rotation does not leak traffic.)** | C5 |
| Restart app | `osascript -e 'quit app "<App Name>"'`. Accept a quit-confirmation dialog if it appears and record it. Wait for exit up to 10 s, then `open -a "<App Name>"` and return to the thread as ADES.md says | C6 |

### 1.7 ADE adapters

One file per ADE, `bench/adapters/<ade>.ts`, implements the same interface. Vendors and the community add ADEs by
pull request. The adapter drives the ADE; it never measures. All timing comes from the echo timer, all RAM from the sampler.

| Method | Job |
|---|---|
| `installCheck()` | Confirm the pinned version is installed. Return bundle version and binary SHA-256 |
| `reset()` | Kill every process, boot out launch agents, restore the seed data folder (RUNBOOK.md) |
| `configure()` | Set model, effort, full access in the worktree, prompt rewriting off, telemetry off, local mode, system CLI paths |
| `launch()` | Open the app and set the window to 1600 × 1000 points |
| `newThread()` | Trigger a new thread in the arena project |
| `send(text)` | Type text into the composer and press Enter |
| `waitDone()` | Return when the agent has finished (TESTS.md §4 end rule) |
| `quit()` | Quit like a user does |
| `processes()` | Extra attribution hints: bundle paths, vendor folders, launch-agent labels, Team ID |

Calibration data in the same file, made during the pilot:

| Key | Meaning |
|---|---|
| `bundleId`, `appName` | For launch and quit |
| `composerRect`, `threadRect` | Regions for OCR, relative to the window |
| `focusClick` | Point to click when the composer is not focused |
| `newThread` | Shortcut or click point |
| `masks` | Rectangles ignored by "visually settled" |
| `drive` | `cli`, `api`, `cdp`, `ax` or `keys`, from ADES.md |
| `dataDirs`, `launchAgents` | What `reset()` and attribution must handle |

### 1.8 Task folders

Every task the harness sends lives in `tasks/<task-id>/`:

| File | Contents |
|---|---|
| `prompt.md` | The exact text sent, byte for byte |
| `task.toml` | Task ID, test ID it serves, time cap, follow-up messages with their send times, faults with their times |
| `tests/` | Hidden tests. Kept private until release; their SHA-256 is pre-registered |
| `solution/` | Two independent reference solutions. Both must pass `tests/`, and the pristine arena must fail them |

TASKS.md lists every task ID and its text. Wherever this file says "the X prompt from TASKS.md", the harness reads
`tasks/<task-id>/prompt.md`.

## 2. Track A. Speed and Weight

Shared preconditions for Track A:

- The ADE runs in the `ademark` user, after the per-ADE reset in RUNBOOK.md, in local mode.
- The replay server runs, and `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` point at it.
- Network capture is off.
- The arena is a fresh clone of the pre-registered commit at `~/arena/<ade>/`, added as a project in the ADE.
- **Seeded state**: 5 finished threads, each made by sending the seed prompt from TASKS.md and receiving the fixed
  replay answer. Every ADE gets the same 5 threads.
- The ADE window is 1600 × 1000 points, in front and uncovered. The mouse is parked in the screen corner.

### A1. Cold Start

Purpose: time from launch on a cold machine state to typing accepted.

Preconditions: seeded state exists. The ADE is not running.

Steps:

1. Kill every attributed process of the ADE. Boot out its launch agents: `launchctl bootout gui/$(id -u)/<label>`
   for every label in ADES.md and every new label in `~/Library/LaunchAgents` since the ADE was installed.
2. Confirm no attributed process is alive.
3. Run `sudo purge`. Wait 10 s.
4. Gate: non-harness CPU under 0.1 core for 10 s.
5. Start the echo timer, waiting for a window of the ADE's bundle ID.
6. Launch with `NSWorkspace.openApplication` and record `t0` just before the call.
7. Measure Ready (§1.3) and visually settled.
8. Clear the composer. Quit the ADE with `osascript` and wait until all non-daemon processes exit.

Records: `t_window_ms` (first frame of the window), `t_ready_ms`, `t_settled_ms`, `focus_click`, probe count.

Value: `t_ready − t0` in s. Headline: median of the cold runs (6 to 10, adaptive, §1.3).

Tiers:

| Tier | Runs | Ranked |
|---|---|---|
| `first-launch`: a fresh copy of the app with `com.apple.quarantine` set, so Gatekeeper and XProtect run | 1 | no |
| `cold`: this procedure | 6 to 10 (adaptive, §1.3) | yes |
| `relaunch`: A2 | 10 | yes |

Before step 1 the harness runs the profile's `steps.beforeColdQuit`, untimed, so the app restores a known state. If
those steps fail, the harness logs the error, writes it in `notes.md` as `before_quit_failed`, and measures the run.
Orca sets none since 2026-11-10: its close failed on a stopped app and left no tab to restore. Conductor opens a
workspace there since 2026-11-11: it restores the view it was quit on, and Home has no composer.

Validity: a run is invalid if the gate failed, a system dialog appeared, or the capture dropped more than 5 % of
frames. Re-run up to 3 extra times. When a cold run times out, the harness reads the whole window once with OCR before
the quit. If it shows `command not found`, the reason is `the probe reached the shell before the app's own restore
command`, not `timed_out` (Orca typed `claude --resume` into a fresh shell on 2026-11-09).

Receipt: `samples.csv` (sampler during launch), `frames.json`, `video.mov`, `notes.md`.

### A2. Relaunch

Purpose: time to typing accepted after a normal quit, with factory background processes left as they are.

Preconditions: the ADE was quit normally and the Mac is quiet (at most 60 s of waiting). Daemons and launch agents it
keeps are left alive.

If the Mac is not quiet after 60 s and processes of the ADE are still running, the harness sweeps them. The reason
gives their count and the Mac's cores. The count says what was running, not what was busy: `cpu_top` names that. That repetition is
invalid, A2 ends for the ADE, and the ADE is opened again untimed. If the Mac is not quiet but nothing of the ADE runs,
nothing is swept: the run goes on to the gate of A1 step 4 and the row notes the wait. In both cases `notes.md`
holds `cpu_top`, the busiest processes of one gate sample taken right after the wait.

After the quit the harness waits up to 45 s for the app to end. The app is the process that runs the bundle's own
executable (`CFBundleExecutable`). Another executable in `Contents/MacOS` that the quit leaves running is a background
process the app keeps (Zeron's `Zeron Engine`, 2026-11-10), and it stays alive like a launch agent. If the app is still
running, the row is invalid with `quit failed: the app is still running (<count> processes after 45 s: <names>)`.

Before the quit the harness runs the profile's `steps.beforeRelaunchQuit`, untimed, so the relaunch restores the state
a user leaves after a normal session, not the tabs of the earlier tests (Orca: about 50 Claude tabs on 2026-11-09). A
failed step is handled as in A1.

Steps: A1 steps 4 to 8, without the kill and without `purge`.

Value: median of 6 to 10 runs (adaptive, §1.3), in s.

Validity and receipt: as A1.

### A3. Thread Open

Purpose: time from the new-thread action to typing accepted in the new thread.

Preconditions: the ADE is open, ready and idle, with the arena project selected.

Steps:

1. Untimed: the open thread must be a seeded thread. Read its marker (`unchanged`, from the seed reply) in
   `threadRect`, first with no trigger (2 s). If it is not there, open a seeded thread with the adapter's `shortThread`
   steps and read again (5 s). The notes say which way found it. The old thread's composer stays empty.
2. Record `t0` and trigger the new-thread action from the adapter's calibration, without the waits after its last
   action (waits between actions stay).
3. Measure Ready in the new thread's composer (§1.3). If the ADE does not focus the new composer, the harness clicks
   it, as a user would, and the time counts. A frame is Ready only if `threadRect` of the same frame was read and does
   not show the marker, so a probe that echoes in the old thread's composer never counts.
4. Untimed, right after Ready: read the marker in `threadRect` once more for 1 s, with the same texts and rule as step
   1. If it is read, the run is invalid with `the old thread was still on screen after Ready`. This read is independent
   of the check on the Ready frame: on 2026-11-10 that check saw Emdash's marker in about 950 frames and missed it in
   one, which gave a 17.9 s time.
5. Clear the composer. Untimed, send `replay:seed` in the new thread and wait for the end of its turn, so the next
   repetition starts in a seeded thread without a positional trigger. A seed turn that fails is logged and does not
   change the row; the next repetition uses `shortThread`. A new thread that did not appear is not seeded. Every ADE
   gets the same extra seeded threads, one for each repetition with a new thread.

The read before the action allows one substituted letter in a window of the marker's length, and nothing looser (the
A11 rule). The check on the Ready frame must not see the marker, so it errs toward seeing it: one wrong, missing or
extra letter still counts, and so does the line `repository is unchanged` with up to 3 such letters. On 2026-11-10 a
real window gave `unch&nged`, and the stricter rule let a probe beside the marker read as Ready.
2026-11-09: the earlier proof, a draft typed into the old composer, was misread by OCR, piled up across repetitions
and changed Claude desktop's result, so it is gone.

An ADE whose new-thread action opens the new composer where the old thread has no composer and no transcript (Emdash:
a Create Task modal over the old thread) sets `newThreadComposerRect`. The old thread stays on screen behind it, so its
marker never goes. The proof is the echo in that region instead: a probe sent to the old composer never shows there.
With it, step 3 reads Ready in that region with no marker check and step 4 is skipped; the region must not overlap
`activeComposerRect`, or the run is invalid. Set it only after a check on recorded frames that the old composer and
transcript lie outside it, written in the profile's notes.

The notes give `fixed_wait_ms`, the waits that stay between the actions of the timed trigger, so a fixed wait inside
the stopwatch is never hidden in the number. Emdash has 800 ms: its modal opens with the caret in the task name field,
and the click on the prompt box must wait until the modal is drawn.

An ADE with no replay server (Claude desktop) has no A3 time: `not supported here: without the replay server no seeded
thread shows a certain marker`. The real model's reply may not hold `unchanged`, and its new-thread screen lists the
seed prompt as session titles, so the prompt is no marker either.

Orca has no A3 time (profile `excludeTests.A3`). Its new-thread action opens a shell tab and types its own `claude`
command into it a moment later, so the first probe letter reaches the shell first (2026-11-10, every repetition:
`zsh: command not found: dclaude`). Measuring it needs a helper that starts the probe only once the agent's prompt line
is drawn, with `t0` still at the action.

Variants: A3 runs in the ADE's default new-thread mode (`default-mode`). If the ADE offers the other mode (new worktree
versus same workspace), 5 more runs use it (`other-mode`), reported apart and not ranked. The row notes whether a
worktree was created.

Value: median of 6 to 10 runs (adaptive, §1.3), in ms. The ±67 ms bound is published.

Validity: invalid if the new thread did not appear within 30 s, or a dialog appeared. Invalid before any time is
taken if the marker was not read in step 1 (no `threadRect` or `shortThread`, or no seeded thread on screen). Invalid if
the Ready frame did not check the marker, if the marker was read after Ready, or if the first read was long (§1.3). A
time is published only when the marker was read before the action and was absent on the Ready frame and after it, or,
with `newThreadComposerRect`, when the probe echoed in that region. Re-run up to 3 extra times.

Receipt: `frames-old-thread.json` (step 1), `frames.json` (with `absent_ocr` on frames that would be Ready),
`frames-after-ready.json` (step 4), `video.mov`, `notes.md`.

### A4. First Word

Purpose: time from Enter to the first word of the answer on screen, with no model delay.

Preconditions: replay server on. A new empty thread from A3.

Steps:

1. Type the A4 prompt from TASKS.md. This part is not timed. An app that reads the key code and not the typed text
   gets the prompt by paste (Diri: `:` arrived as `a` on 2026-11-10, so the prompt matched nothing).
2. Record `t0` and press Enter.
3. The replay server answers with the fixed first token `LEDGERMARK` at once.
4. OCR the thread region of each frame. First Word is the first frame where `LEDGERMARK` appears.
5. From the replay log, record `t_request` (request received).

Records and split:

| Part | Computed as |
|---|---|
| Before the request | `t_request − t0`: the ADE builds and sends the request, and may start the agent |
| On screen | `t_first_word − t_request`: the ADE receives and renders |
| Total | `t_first_word − t0` (the value) |

Value: median of 6 to 10 runs (adaptive, §1.3), in ms. Each run uses a new thread.

Live variant: for ADEs that ignore the base URL, 20 live runs alternate with 20 Bare CLI live runs (ABAB).
The published value is the median paired difference against the Bare CLI, labeled `live`.

**Ready to Answer** = median A1 + median A3 + median A4.

Validity: invalid if the replay log shows no request within 30 s, or the OCR never finds the token. Re-run up to 3 extra times.

Receipt: `frames.json`, `video.mov`, replay log lines, `notes.md`.

### Stopwatch start (since 2026-11-07)

`t0` is read right before the last trigger that is not a wait: the action that commits the step. Earlier triggers
(opening a dialog or a palette) and fixed waits are setup. A3 reads the seeded thread's marker in `threadRect` before
its trigger, and Ready needs that marker gone from `threadRect` of the same frame, so an echo in the old composer can
never read as a new thread. The new-thread triggers run without their trailing waits. Native typing posts the real key
code with the text, because Diri 0.11.2 reads the key code.

### A5. Weigh-in

Purpose: RAM of the app at rest.

Preconditions: seeded state, the ADE just launched and ready, no agent running. Screen recording off.

Steps:

1. Settle: sample until the `app` group's RAM slope is under 1 MB/min over a 60 s sliding window. Cap: 10 min.
   If the cap is reached, record `notes: "did not settle"` and continue.
2. Sample for 60 s at 4 Hz.
3. At the end of the window, run `footprint --unmapped` for the `app` group, and the system and WindowServer deltas.

Records: per-sample sums for `app` and `agents`, the main process alone, the de-duplicated total, both deltas.

Value: median of the `app` sum over the 60 s window, in MB. The main process alone is shown next to it, because
that is what Activity Monitor readers compare against.

An ADE can look heavy only because of the agent sessions it keeps alive. So A5 also publishes, over the same window:

| Variant | Computed as |
|---|---|
| `agents` | Median of the `agents` sum, in MB. A tick with no agent counts as 0 |
| `agent-count` | Median number of agent subtrees alive (their git and test children do not count) |
| `total` | Median of `app` + `agents`, in MB: what the Mac pays |

Validity: invalid if swap grew during the window or a gate failed. Repeat once.

Receipt: `samples.csv`, the `footprint` JSON, `notes.md` with settle time.

### A6. Idle Burn

Purpose: CPU, wakeups and energy of the app at rest.

Preconditions: the same window as A5 (`front` variant). For the `covered` variant, the harness places an opaque,
static window of its own over the whole ADE window and samples another 60 s.

Computed from the sampler:

| Output | Formula |
|---|---|
| CPU | Δ(`cpu_user_ns` + `cpu_sys_ns`) of the `app` group ÷ Δwall, as % of one core |
| Wakeups | Δ(`wakeups_idle` + `wakeups_irq`) ÷ Δwall, per s |
| Energy | Δ`energy_nj` ÷ Δwall, in mW |
| Package power | `powermetrics` CPU + GPU power minus the no-app baseline taken at the start of the block, in mW |

Value: CPU % for `front` and `covered`, each one row. Wakeups and energy are separate rows (`variant` = output name).

Validity and receipt: as A5.

### A7. Fight Weight

Purpose: RAM of the app while 5 agents stream.

Preconditions: seeded state. Replay server on. Screen recording off.

Steps:

1. Open 5 new threads and send one A7 prompt from TASKS.md §5 in each (`replay:stream-1` to `replay:stream-5`), 2 s apart.
2. The replay server answers each with the same 3-minute stream: text, code blocks and a diff block, at 80 tokens/s.
   If the profile's fixed setup of one stream (the waits of `timed.newThread` and `timed.send`, the 1.5 s settle after a
   new thread, the 0.5 s paste settle) plus the 2 s gap, four times, leaves less than 150 s of the 3 minutes, every
   stream is longer: 3 minutes plus those four setups plus 20 s. The prompt then ends with ` @<seconds>s`
   (`replay:stream-2 @240s` for Orca), and the server grows the stream's own text by whole paragraphs. When a real night
   measured a longer interval between two starts than that setup plus the gap, the measured interval counts instead
   (Emdash: 9.5 s on 2026-11-10, its new-thread clicks are outside the profile's waits, so `@238s`). A profile that
   leaves 150 s keeps the 3-minute stream and the plain prompt. With longer streams, A7 waits untimed after its
   sample until every stream's long turn has ended (its last request in the replay log plus the stream length plus
   5 s), at most the spread of the starts plus the stream length plus 15 s from the first open, so A8's second window
   starts with only its own five streams.
3. Keep thread 1 in front.
4. Sample the whole 3 minutes at 4 Hz. Run `footprint --unmapped` and the deltas at the end.

Values (one row each):

| Variant | Computed as |
|---|---|
| `app-p95` (headline) | p95 of the `app` sum |
| `agents-p95` | p95 of the `agents` sum |
| `total-p95` | p95 of `app` + `agents` |
| `app-peak` | highest tick sum of `lifetime_max` over the `app` group |
| `per-agent-p95` | p95 of each tick's `agents` sum divided by its agent count: one agent's RAM, compared with the Bare CLI's |
| `agent-count` | Median number of agent subtrees alive |
| `overhead` | `total-p95` minus the Bare CLI's `total-p95` |

Validity: invalid if fewer than 5 agent processes (or 5 SDK sessions) were active for at least 150 s. Also invalid
if the replay log shows the five streams ran together less than 150 s: the stream length minus the time from the first
stream's first request to the fifth's. Repeat once.
The notes list the binary at the root of each agent subtree, so a bundled Claude Code shows its version.

Receipt: `samples.csv`, `footprint` JSON, replay log, `notes.md`.

### A8. Typing Lag

Purpose: keystroke-to-pixel time while 5 agents stream.

Preconditions: A7 has just finished. Start a second identical 5-stream window. Screen recording on.

Steps:

1. Focus the composer of thread 1.
2. Type 60 probe characters, one every 250 ms ±20 % (uniform jitter, so the cadence cannot lock to the 60 Hz display; about 15 s).
3. For each keystroke, latency = first frame whose composer pixels differ, in at least 3 points of columns, from every frame of the 1.2 s before the keystroke, minus the keystroke time. A blinking caret only switches between states already in that window, so it never counts. Pilot 2026-10-20: the first rule (OCR reads one more probe character) failed in Zeron and T3 Code, where Vision's fast OCR misreads the last character while the caret stands after it; every keystroke then waited for the caret to blink off (550 ms). OCR stays the fallback when a frame has no pixels.
4. A keystroke with no echo within 2 s counts as missed.
5. Clear the composer.

Values: p50, p95 and max in ms, and the missed count. Headline: p95.

Validity: invalid if the streams ended before the 60 keystrokes. Repeat once.

Receipt: `frames.json`, `video.mov`, `notes.md`.

### A9. Ghost Weight

Purpose: RAM still used 60 s after the user quits.

Steps for the main variant (`no-sessions`):

1. Start from seeded state, the ADE idle, no agent running.
2. Quit with `osascript`. Record the time.
3. Wait 60 s.
4. Sum `phys_footprint` of every process still attributed to the ADE, launch agents and daemons included.
5. List the processes by name.
6. Relaunch the ADE for the next repetition.

Variant `sessions-kept`: the same, but quit while one agent streams on the replay server. Some ADEs keep sessions
alive by design. This variant is reported apart.

Value: median of 3 runs, in MB. The process list is published with the value.

Receipt: `samples.csv`, process list, `notes.md`.

### A10. Scale

Purpose: how RAM and Typing Lag grow with many threads.

Steps:

1. From seeded state (5 threads), add 15 threads with the seed prompt, for 20 in total.
2. Sample 60 s at rest. Record the `app` median.
3. Start 5 streams (A7 prompt) and type 30 probe characters at 250 ms (A8 method).

Values:

| Variant | Computed as |
|---|---|
| `mb-per-thread` (headline) | (A10 rest median − A5 median) ÷ 15 |
| `rest-20` | the `app` median at rest with 20 threads |
| `lag-p95-20` | Typing Lag p95 with 20 threads and 5 streams |

Runs: 1.

Receipt: `samples.csv`, `frames.json`, `video.mov`.

### A11. Long Thread

Purpose: how the ADE handles a 2,000-message thread.

Preconditions: replay server on. The long thread is made through the ADE, never by writing to its storage, so every
ADE stores it its own way. The A11 prompt in TASKS.md makes the replay answer with 1,000 steps, each a short visible
text followed by a trivial tool call (read a small file), about 2,000 visible items; one text in five holds a code
block. The text keeps ADEs from folding the tool calls into one row. The last message contains `LONGTHREAD-END`. **(validate in pilot: every ADE accepts it.)**

Steps, each repeated 5 times:

1. **Open**: from a short thread, switch to the long thread. Value: time until `LONGTHREAD-END` is visible and the
   window is visually settled, in ms.
2. **Scroll**: post 20 scroll-wheel events (`CGEventCreateScrollWheelEvent`) at 60 Hz toward the top. Value: frame
   gaps over 33 ms during the scroll, as a count. The scroll lasts from the first event to the last event plus one
   event interval (16.7 ms). Frames after it do not count: an app that stops drawing when the content stops moving is
   idle, not stuttering. Then unmeasured events go back to the end until `LONGTHREAD-END` shows, 3 tries at most, so the
   next **Open** can see it in an app that remembers the scroll position.
3. **Switch**: alternate between the long thread and a short thread. Value: time to visually settled, in ms.

OCR reads the marker as one of two exact texts, `THREAD-END` (the pilot read `LONfjTHREAD-END` in Ghostty) or
`NGTHREAEND` or `NGTHREAFEND` (Orca read `L(NGTHREA&END` and `L(NGTHREAFEND` on 2026-11-08 and 9). Each one holds the
marker's `END`, so a line like `Loading thread` never matches. Another misread leaves the row `long thread not built`.

An app whose search opens a hit at the matched message (bb) is searched for the end marker, which only the last
message holds, so the thread opens at its end. A search for the title also matches the first message and opens the
thread at its top (bb, 2026-11-10).

If the ADE compacts or cuts the thread, the row records it in `notes`.

Receipt: `frames.json`, `video.mov`, `notes.md`.

### A12. Leak

Purpose: RAM growth of the app over 30 minutes of real work.

Measured passively during Track C. The sampler runs at 4 Hz through C1 and the following C tests.

Value: the slope of a least-squares line through the `app` sum over the longest continuous 30-minute window, in MB/h,
with its 95 % interval. If Track C for the ADE is shorter than 30 minutes, the row covers the available window and says so.

Receipt: `samples.csv` for the window.

## 3. Track B. Tokens

Shared preconditions for Track B:

- Real API. Network capture on. Replay server off and base URL variables unset (`launchctl unsetenv`).
- Model and effort as METHODOLOGY.md §4. B tests run once per model the ADE supports.
- Each repetition uses a new thread.
- After each answer, wait 30 s for side calls (titles, branch names, summaries) before the next action.
- B2 and B4 read only B1 and B3 repetitions that passed their checks (model, effort, thread, prompt sent once). A
  repetition on another model is no evidence about the ADE at the pinned model.
- A value that needs the session log (tool calls, `obeyed`) is invalid with `no session log` when the log is missing.
  A valid row always has a value.
- `bun bench/tracks/b/rescore.ts <run folder>` re-scores a finished block from its own receipts and lists every valid
  row the capture does not give again.

Token split, for every captured request:

| Component | Anthropic usage field | OpenAI usage field |
|---|---|---|
| Fresh input | `input_tokens` | `input_tokens` − `cached_tokens` |
| Cache write | `cache_creation_input_tokens` | none |
| Cache read | `cache_read_input_tokens` | `input_tokens_details.cached_tokens` |
| Output | `output_tokens` | `output_tokens` (reasoning tokens noted apart) |

Requests are split into the **main thread** (the session of the test thread) and **side calls** (every other model
request the ADE caused in the window, any model, any host).

Pricing comes from `prices/2026-10.json`, dated and hashed in the pre-registration:

| Model | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| Claude Opus 5.5 | $4 per MTok | $20 per MTok | $0.20 per MTok | read from the official pricing page in the pilot |
| OpenAI model (Q1) | read in the pilot | read in the pilot | read in the pilot | n/a |

### B1. Hello Tax

Purpose: tokens and $ the ADE sends when the user only types "hi".

Steps:

1. Open a new thread. Type the B1 prompt from TASKS.md (`hi`). Press Enter.
2. Wait for the answer to end, then 30 s more.
3. Collect every request in the window from the capture.

Values (rows per repetition): fresh input, cache write, cache read, output, side-call tokens (all components summed),
and $ total. Headline: median $ per "hi", with the token split shown under it.

Runs: 3 per model. All three use new threads.

Validity: invalid if the capture completeness check fails and logs cannot replace it. Repeat once.

Receipt: `capture.jsonl` (bodies, auth removed), `notes.md`.

### B2. Request Anatomy

Purpose: what the ADE adds to the first request, against the Bare CLI.

Input: the first main-thread request of the first B1 repetition that passed its checks (normally repetition 1), and
the same request from the Bare CLI. If no B1 repetition passed, every B2 row is invalid.

Steps:

1. Split each request into segments: system prompt, tool definitions (built-in), MCP tools (names starting with
   `mcp__` or declared by an MCP server), injected text in messages, and request parameters (model, effort or
   thinking, max tokens).
2. Count tokens of each segment with `POST /v1/messages/count_tokens` (Anthropic) or the provider's equivalent.
   **(validate in pilot.)**
3. Diff the ADE against the Bare CLI: tools added and removed by name, system text added, parameter changes.
4. Record the User-Agent: Claude Code or SDK version, Codex version.

Values: tokens per segment and the difference against the Bare CLI per segment.

Publication rule: for open-source ADEs, the added text is quoted with a link to its source line. For closed-source
ADEs, only sizes and categories are published.

Receipt: both request bodies (closed-source text kept private), the diff, `notes.md`.

### B3. Real Prompt Tax

Purpose: the same split as B1 for one read-only real prompt.

Steps: as B1 with the B3 prompt from TASKS.md. Wait until the agent finishes and 30 s more.

Values: the B1 components, plus the number of model requests and tool calls. The request count comes from the
capture, the tool calls from the session log.

Runs: 1 per model.

Receipt: `capture.jsonl`, `notes.md`.

### B4. Repo Rules

Purpose: does the agent receive the repository's own instructions.

The arena's `AGENTS.md` and `CLAUDE.md` contain a canary instruction (TASKS.md). Some SDK-based ADEs load no project
instructions unless configured to, so this test is a real finding, not a formality.

Computed from B1 and B3 captures:

| Output | Rule |
|---|---|
| `in-request` (headline) | Yes if the canary text appears in any main-thread request |
| `obeyed` | Yes if the B1 answers end with the canary token. Invalid when a B1 answer has no session log |

Runs: computed once per model from existing captures. No extra prompts.

Receipt: the request excerpt that shows the canary, or its absence.

## 4. Track C. Orchestration and Reliability

Shared preconditions for Track C:

- Real API with Claude (METHODOLOGY.md §4). The Codex app and the Codex control use the OpenAI model.
- Local mode only. The agent runs on the bench Mac in a local worktree or checkout. Cloud threads, cloud sandboxes and
  cloud tasks are never used, even when the ADE offers them by default.
- Network capture on. Its proxy delay is disclosed; Track C times are in minutes.
- Sampler on for the whole track (feeds A12). Screen recording on (receipts and C3).
- Each test starts from a fresh clone of the arena at the pre-registered commit, on `main`.
- Orchestration is enabled as ADES.md says for the ADE. The ADE's trigger line comes first in the prompt, then the
  shared goal text from TASKS.md, byte-identical for every ADE.
- End of a task: the agent's last message is followed by 60 s with no agent process using CPU and no file changes in
  the repo, or the time cap is reached.

Grading, after every C test:

1. Copy the repository state at the end.
2. Restore the pristine `test/` folder and add the hidden tests from `tasks/<task-id>/tests/`.
3. Run `TZ=UTC npm test`. The timezone tests set their own `TZ` per subprocess.
4. Record each hidden test group as pass or fail.

If the grader cannot grade (hidden tests missing, handoff codes missing, a setup error), every value read from the hidden
tests is invalid with reason `grade invalid: <reason>`: C1 `shipped` and `time-to-green`, C2 `applied`, and the
Survival of C4 to C6. Values from the capture, the worktree and the session logs stay.

### C1. Orchestrated Build

Purpose: can a lead agent split 4 work items across workers, merge them on `main` and pass the hidden tests.

Steps:

1. Open a new thread in the arena project. Paste the trigger line and the C1 goal text from TASKS.md. Record `t0`, press Enter.
2. Start the C3 probe.
3. Wait for the end of the task. Cap: 45 min.
4. Grade `main`. Work left on other branches is not graded.

Values:

| Variant | Computed as |
|---|---|
| `shipped` (headline) | Hidden test groups passed on `main`: W1, W2, W3, W4 and integration, x/5 |
| `time-to-green` | End time − `t0` in minutes when shipped is 5/5. Otherwise "not green" and the end time |
| `fan-out` | Most worker agents running at the same time, and total workers started, from session logs (distinct worktree `cwd`, overlapping time) |
| `handoff` | Handoff codes found both in `REPORT.md` and at the top of each module, x/4 |
| `orchestration-tax` | Total tokens and $ of the run (all requests, side calls included) ÷ the same for the Bare CLI solo run of the C1 goal (one agent, no subagents) |

ADEs without orchestration (Emdash, Conductor) get `not supported`, never 0. An ADE that has orchestration but no proven
trigger line gets invalid rows, `not calibrated: orchestrationTrigger`.

**The end of a C1 run** (since 2026-11-11). The first session log with an end of turn can be one worker that finished,
or a lead that handed the work out and ended its turn, while the others still build. So after that first end the capture
decides: the run is over when no request answered a tool for 5 minutes. A working agent answers a tool every few
seconds. The end time is the last answer to a tool, or the first end of turn when none followed it, so the 5 minutes of
waiting are not part of the run. Work that goes past the 45-minute cap cuts the run at the cap, as before; a run that
ended before the cap is not a cut run, whatever the wait.

**A run is orchestrated only with a second agent.** From the capture, an agent is a client session that answered a
tool, plus each further thread that session started (a subagent shares the session of its parent). A title or quota
call is no agent. With one agent the rows are invalid. With one agent after 15 minutes the run stops there, and does
not spend the rest of the cap. bb, Cloudroom, Orca and super.engineering orchestrate with agents of their own (child
threads, chats, terminals), so they need two client sessions at work: subagents inside the lead's session are Claude
Code's (`orchestration.workers` in the profile). The fan-out rows keep the count in their notes.

**An ADE that ships orchestration off** has it switched on for the Track C block only, after the reset and before the
launch (`orchestration.settings` in the profile). super.engineering: `experimental.agent_orchestration` in
`~/.super.engineering/settings.json`. If the switch cannot be made, the block stops before the app is launched.

A real C1 run, and the solo run, is checked on its capture before any value is written (since 2026-11-11, from what
Track B showed on 6 and 7 Nov). Every row of the run is invalid, never a zero, when:

| Reason | What it means |
| --- | --- |
| `no model request captured` | No model call left the app during the run |
| `the prompt never reached the model: no main-thread request captured` | No captured request carries the task, as sent or inside the app's own wrapper |
| `the turn failed` | Every request of the main thread was refused |
| `wrong model: <model>` | The main thread ran another model than the pinned one. A worker on another model is the app's own choice and stays valid |
| `one agent did the work alone: the trigger did not start orchestration` | The capture shows one agent only |
| `no second agent in the first 15 minutes: the trigger did not start orchestration` | The same, and the run was stopped there |
| `the app's own workers did not run: <n> agents in one client session` | The ADE's workers are sessions of their own, and only subagents ran |
| `the run went on after the end of turn that ended the test: <n> tool answers after it` | An agent answered a tool again after 5 quiet minutes, while the grade ran: the grade read a half-built repository |
| `the run ended on a refused request (status <n>): the Claude plan or the sign-in` | The last model request to the main thread's host got a status of 400 or more. After a plan limit nothing answers again; a refusal the client retried is followed by an answer |

`tokens-total` and `usd-total` are also invalid, with `a call has no usage`, when one answered call has no usage.

The Bare CLI solo run (`tasks/C1-solo`) runs in the Bare CLI's C1 block with Claude, whether or not the Bare CLI's own
orchestrated run is calibrated. It gives `solo-shipped`, `solo-tokens-total` and `solo-usd-total`.

Runs: 1. A second run if shipped is under 5/5 or the ADE crashed. Both runs are published.

Receipt: `capture.jsonl`, `samples.csv`, `video.mov`, the final `REPORT.md`, the grader log, `notes.md`.

### C2. Message Delivery

Purpose: do follow-up messages sent during work reach the agent and get applied.

Steps:

1. Open a new thread. Send the C2 task from TASKS.md (a single-agent task). Record `t0`.
2. At `t0 + 30 s`, `t0 + 90 s` and `t0 + 150 s`, type follow-up 1, 2 and 3 from TASKS.md in the same thread and press Enter.
   The C3 probe pauses 3 s around each follow-up.
3. Wait for the end of the task. Cap: 10 min.
4. Grade with the C2 hidden tests, including one test per follow-up.

For each follow-up, record:

| State | Evidence |
|---|---|
| `accepted` | The text appears in the thread on screen within 5 s (OCR) |
| `queued` | The ADE shows a queued state (screenshot) |
| `delivered` | The text appears in a later model request (capture). This is the main evidence |
| `applied` | Its hidden test passes |

Values: `dropped` = follow-ups not delivered (x/3), headline. `applied` = follow-ups applied (x/3).

Runs: 1.

Receipt: `capture.jsonl`, `video.mov`, screenshots at each follow-up, grader log.

### C3. Chat Lock

Purpose: does the composer refuse typing for more than 2 s while agents work.

Runs during C1 and C2:

1. Every 2 s, type one probe character into the composer of the active thread.
2. Measure its echo with the echo timer. Delete it at once. Never press Enter.
3. A **lock** is a probe with no echo within 2 s. The lock lasts until the next echo.

Values: lock count and longest lock in s, for C1 and C2 together.

Receipt: `frames.json`, `video.mov`.

### C4. Agent Killed

Purpose: when the agent process dies, does the ADE show it, and can the task finish.

Steps:

1. Open a new thread. Send the C4 task from TASKS.md. Record `t0`.
2. At `t0 + 90 s`, kill the agent process of the thread (§1.6).
3. Watch for 60 s. Record whether the ADE shows an error or stopped state (screenshot), and whether the agent resumes by itself.
4. If the agent has not resumed after 60 s, send `continue` in the thread. This is a manual action.
5. Wait for the end of the task. Cap: 10 min. Grade with the C4 hidden tests.

If the ADE has no separate agent process to kill, C4 is `not applicable` and the reason is published.

Value, **Survival**:

| Result | Rule |
|---|---|
| `pass` | The task completes with nothing lost and no manual action |
| `partial` | The task completes after a manual `continue`, or work is lost |
| `fail` | The task does not complete, or the ADE crashes |

Runs: 1. A second run if the result is `fail`. Both are published.

Receipt: `video.mov`, screenshots, `capture.jsonl`, grader log, `notes.md`.

### C5. Network Cut

Purpose: when the model API is unreachable for 30 s, does the task continue.

Steps: as C4, with the C5 task, but at `t0 + 90 s` the fault injector blocks the API hosts for 30 s (§1.6).
After the block is lifted, watch 60 s before any manual `continue`.

Value: Survival, same rubric. Runs, receipt: as C4.

### C6. App Restart

Purpose: when the user quits and reopens the ADE mid-task, do threads restore and finish.

Steps: as C4, with the C6 task, but at `t0 + 90 s` the fault injector quits and relaunches the ADE (§1.6), and the
harness returns to the thread. Record any quit-confirmation dialog. Watch 60 s before any manual `continue`.

The return: the adapter's `launch()` reopens the app as in A2 (new pid, window size, the project it keeps), then its
`returnToThread` selects the interrupted thread. An ADE without a calibrated `returnToThread` gets invalid rows,
`not calibrated: returnToThread`, before the task starts. The Bare CLI's host, Ghostty, stays open and also hosts
ADEMark Control, so it is never quit by name: its restart is the adapter's `quit()` (close every CLI tab) and its return
is `claude --continue` in the same arena copy.

Value: Survival, same rubric. Runs, receipt: as C4.

## 5. Track F. Fit

Purpose: facts about each ADE, with no score.

Collected on Day 1 and during the pilot, from official docs and from the installed app. Every fact carries a source:
a link, or "observed in vX.Y.Z on YYYY-MM-DD".

| Field | How it is filled |
|---|---|
| Platforms, license, price | Official site and repository |
| Models and auth | Settings screens and docs: subscription, API key, own credits |
| Factory defaults | Observed in a fresh install: model, effort, permission mode, telemetry, prompt rewriting |
| Orchestration support | Docs and C1 |
| Worktrees, diff review, PR flow, remote and mobile access | Docs and a short check in the app |
| Cloud modes offered (not tested) | Docs: cloud threads, sandboxes, VMs or tasks, listed as a fact only |
| Global agent config written | Diff of `~/.claude`, `~/.codex` and `~/.agents` before and after the ADE's block (RUNBOOK.md per-ADE loop) |
| Background processes kept after quit | A9 process list |

Output: `results/<run-id>/fit.json`, one object per ADE.

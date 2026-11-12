# ADEMark runbook

Version: v1.0, 2026-10-19 (first results published 2026-11-12).

This is the operator's checklist for one full run on the reference machine, in order. What is measured and why is in
[METHODOLOGY.md](METHODOLOGY.md). The procedure of each test ID is in [TESTS.md](TESTS.md). Per-ADE setup is in
[ADES.md](ADES.md). Prompts are in [TASKS.md](TASKS.md).

Every ADE runs in local mode only. No cloud thread, cloud sandbox, cloud VM or cloud task is used in any step.

## 0. Short version (since 2026-10-20)

Since 2026-11-06 the way to run everything is ADEMark Control (`bench/control/README.md`): double-click it on the
`ademark` Desktop and press Start. The commands below are what it runs, and stay as the manual fallback.
If Control dies or freezes, the watchdog (`dev.ademark.watchdog`) restarts it and the run goes on; read
`results/control.log` and `results/watchdog.log` in the morning (`bench/control/README.md`).

Since 2026-11-10 the day has three parts around the night:

1. **Rehearse** (by day, about 2 h with nobody at the Mac): press Rehearse on the panel. It writes
   `results/rehearsal-<time>/rehearsal.md`. Start the night only when its first line says 0, or every invalid row left
   is an approved accepted limit (`bench/night/known-failures.ts`). At Start the panel warns in yellow when the last
   lap is not clean or ran on another commit or other measuring inputs. It never blocks Start.
2. **Night**: press Start. Its queue measures Track A, runs the top-ups, then a **Tokens** step (Track B, up to
   45 min) for each app and an **Orchestration** step (C1, up to 140 min) for Bare CLI and each app with a trigger, and
   the night stays open (METHODOLOGY.md §6, tokens and orchestration). If the Claude plan does not answer before one
   of them, Control waits for it (it asks every 10 minutes, for up to 6 hours); after that the ones left are skipped with that reason, never failed. QA does not run at night. After a fix by day, the same button says **Measure what is missing** and names the apps and tests
   under it: it measures only those, in the same night. When nothing is missing the panel says the night is complete
   and shows no button. **Close this night** (under More) ends it; the button then starts a new night.
3. **Morning**, from any account: `ADEMARK_RESULTS=/Users/ademark/ADEMark/results bun bench/cli.ts qa --run <run id>`
   (add `--out <dir>` when that folder is not writable), then `bun bench/cli.ts report --run <run id>`. The report's
   first line is the count of NEW invalid rows.

The pilot showed that hand steps break a night. Since then the harness does them, and checks them before it measures.
§4 to §9 stay as the reference for what the commands do, and as the manual fallback.

Once, in the owner's account (it needs an administrator password):

```sh
sudo zsh bench/ops/install-machine.zsh
```

WARNING: this installs `/usr/local/libexec/ademark-machine` and a sudoers rule that lets the `ademark` user run it
with no password. The script accepts only fixed subcommands. Anyone who can edit that file gets root, so re-run the
installer after every change to `bench/ops/machine.zsh` and never point the rule at a copy a user can write.

Once, in the `ademark` account:

1. `bun bench/cli.ts account setup --apply`, then run the `security add-trusted-cert` line it prints for mitmproxy.
2. Permissions (§4.11) and the clean snapshot (§4.12).
3. Calibration day: follow `bench/adapters/CALIBRATE.md` for every ADE until `bun bench/cli.ts doctor` shows a gate
   for all 18 rows. The owner signs in to the ADEs that have their own login.

The day before a night, in the `ademark` account:

```sh
bun bench/cli.ts prepare --tracks A,B --agent claude,own --skip claude-desktop,superset,capy
```

For each ADE it runs the short gate, a real Track B block and, with `--tracks C`, test C6. If one fails, the repair
agent fixes how the ADE is driven and the proof runs again, up to 3 rounds. `results/prepare-<stamp>/prepare.md` says
which ADEs are ready and why the others are not. Nothing in that folder is a result. The gate files it commits decide
what the night measures, so a night needs no `--ungated`. An ADE that fails a later track loses the gate it passed.
Track C proves only C6 here: it shows the app can be driven, not that C1 works.

Every night, in the `ademark` account:

1. Log out of your account, log in as `ademark`, open Ghostty from the Dock.
2. `bun bench/cli.ts night --until 07:30`. It holds the Mac awake, runs `machine on` (Spotlight, power, updates,
   Time Machine, 60 Hz, paused background analyzers), runs `doctor`, then a short rehearsal while you watch.
3. Answer `y` to start the night. Every ADE without a passing gate is skipped and listed. A failing ADE is retried once
   at the end. At the end, or on any error or Ctrl-C, `machine off` puts every setting back.
4. In the morning, read `results/<run-id>/night.md`, then log out of `ademark`.

## 1. Roles

| Role | Who | Does |
|---|---|---|
| Owner | the author | Buys the dedicated plans, installs the ADEs, signs in, grants permissions, approves every system change, drives an ADE by hand when its adapter fails, publishes |
| Harness | the `ademark` CLI and its native helpers | Resets, launches, drives and measures every ADE; writes rows and receipts |
| Agent | the Claude Code session that builds the harness | Builds and fixes the harness, runs the pilot with the owner, writes charts and reports. It runs from Ghostty in the owner's account, never inside an ADE under test. It does not run during a measurement block |

## 2. State of the reference machine on 2026-10-19

These facts were observed before any preparation. Each one must be fixed by §4 before the pilot.

| Fact | Why it matters | Fixed in |
|---|---|---|
| Display at 2560 × 1440, 144 Hz, 1x scale | Animations draw 2.4x more frames than at 60 Hz | §4.4 |
| 2.9 GB of 4 GB swap in use | Memory reclaim behaves differently under pressure | §4.9 (reboot) |
| Spotlight indexing on | Background CPU and disk | §4.5 |
| Launch agents running: `dev.cloudroom.preview.061684e561f5ba22` (Cloudroom), `application.com.t3tools.t3code.*` (T3 Code), `so.stencil.tern.daemon` (Tern, not in the field), `dev.bb.desktop.ShipIt` (bb updater) | Processes of one ADE alive while another is measured | §4.8 |
| The owner's background sync jobs run every 10 min | Periodic git and network work | §4.8 |
| The owner's own desktop apps are open | Electron apps using memory on the machine | §4.8 |
| Software update `AutomaticDownload=1`, `powernap 1`, `displaysleep 10` | Background work and sleep during runs | §4.6, §4.7 |

## 3. Schedule

Two days of work, publication on the morning of day 3.

| When | Agent | Owner | Machine |
|---|---|---|---|
| Day 1, 08:00-13:00 | Builds the harness with parallel helpers: replay server, sampler, echo timer, capture addon, fault injector, CLI, adapters, task folders and hidden tests | Buys the dedicated Claude and ChatGPT plans. Creates the `ademark` user (§4.1). Installs the 11 ADEs not yet installed (T3 Code, bb, Capy and Cloudroom are; Cloudroom must move from v104 to the pinned build), plus Claude desktop and the ChatGPT desktop app (Codex). Signs in to all 17 inside the `ademark` user with the dedicated accounts. Grants permissions (§4.11) | |
| Day 1, 13:00-17:00 | Pilot (§6) with the owner | Reviews every pilot receipt | Pilot runs |
| Day 1, 17:00-19:00 | Freezes versions, thresholds and task hashes. Writes the pre-registration (§10) | Publishes the hash on X | |
| Day 1, 19:00 to Day 2, 08:00 | Idle | Asleep | **Track A**, all 17 ADEs and both controls, random order, about 25 min per ADE |
| Day 2, 08:00-09:00 | Checks Track A rows, queues re-runs of invalid rows | Looks at the summary | Re-runs |
| Day 2, 09:00-11:00 | Idle | Present for the network-capture start | **Track B**, all ADEs, each supported model, about 5 min per ADE and model |
| Day 2, 11:00-23:00 | Builds charts and ADE reports from Tracks A and B | Checks in from time to time | **Track C** with Claude (the Codex app and Codex control with the OpenAI model), about 35-45 min per ADE |
| Day 3, 08:00-12:00 | Final charts, receipts upload, corrections log | Reviews and publishes (§11) | Restored (§5) |

If a plan limit stops Track C, the run pauses and resumes after the reset (§8). The schedule then moves by the length
of the pause, never by skipping a test.

## 4. Machine preparation

Do these steps once, in this order, before the pilot. Save every "before" value in `results/prep/before.txt`,
because §5 restores from it.

### 4.1 Dedicated user

CAUTION: this creates a new administrator account. Remove it in §5 if you do not want to keep it.

```sh
sudo sysadminctl -addUser ademark -fullName "ADEMark" -password - -admin
```

The command asks for the password. Then:

1. In the owner's account, quit every app, every ADE included.
2. Let the owner's background sync jobs finish. They stop at log out.
3. Log out of the owner's account (Apple menu > Log Out). Switching users is not enough.
4. Log in as `ademark`. Every later step runs in this account unless it says otherwise.

The harness repo is cloned into `/Users/ademark/ADEMark`, and the private hidden tests are copied next to it. They
never go into the repo. In the `ademark` account:

```sh
git clone https://github.com/zqkra/ademark ~/ADEMark
cp -R /Users/<owner>/ademark-private ~/ademark-private
chmod -R go-rwx ~/ademark-private
cd ~/ADEMark && bash bench/native/build.sh
```

If the owner's home folder is not readable from `ademark`, copy both folders with a USB drive or AirDrop instead.
After this, changes move between the two accounts only through git pull, never by sharing the folder.

### 4.2 Accounts inside `ademark`

1. Sign in to the dedicated Claude account in Claude Code (`claude` then `/login`) and in Claude desktop.
2. Sign in to the dedicated ChatGPT account in Codex (`codex login`) and in the ChatGPT desktop app.
3. Do not sign in to iCloud in this user.
4. Install Claude Code 2.1.303 and Codex 0.163.0 at the pinned versions. Record `claude --version` and `codex --version`.

### 4.3 ADEs

1. Install each ADE from the pinned download. Keep every installer in `pins/` with its SHA-256 in `pins/versions.json`.
2. Open each ADE once, sign in, add nothing else.
3. In each ADE, set local mode, the pinned model and effort, full access in the worktree, prompt rewriting off,
   telemetry off and auto-update off, as ADES.md says for that ADE.
4. Quit it. Copy its data folders (ADES.md) to `~/ademark-private/seeds/<ade>/home/`. The copy loop is in GUIDE.md §4.3 step 4. This **seed** keeps the sign-in and has no threads and no project.
   `reset()` restores it before every block, so every block starts fresh and still signed in.

### 4.4 Display

1. System Settings > Displays > Refresh rate: 60 Hertz.
2. Record the mode: `system_profiler SPDisplaysDataType > results/prep/display.txt`.
3. Keep the resolution the same for the whole run. The resolution and scale are published.

### 4.5 Spotlight

CAUTION: this stops indexing on all volumes until §5 turns it on again.

```sh
mdutil -a -s >> results/prep/before.txt
sudo mdutil -a -i off
```

### 4.6 Power

```sh
pmset -g >> results/prep/before.txt
sudo pmset -a powernap 0 sleep 0 displaysleep 0 disksleep 0
```

### 4.7 Updates

```sh
softwareupdate --schedule >> results/prep/before.txt
defaults read /Library/Preferences/com.apple.SoftwareUpdate >> results/prep/before.txt
sudo softwareupdate --schedule off
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool false
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
```

ADE self-updates are turned off in each ADE (§4.3). The harness also checks the bundle version before every block (§7).

### 4.8 Background processes

The owner's background agents and apps (T3 Code, Cloudroom, Tern, bb and others) stopped at log out
in §4.1. In the `ademark` user, ADEs install their own launch agents at first launch. List them after §4.3:

```sh
launchctl list | grep -v com.apple
ls ~/Library/LaunchAgents
```

Add every label to that ADE's `launchAgents` in its adapter. `reset()` boots them out between ADEs:

```sh
launchctl bootout gui/$(id -u)/<label>
```

Known labels from the owner's account: `dev.cloudroom.preview.*`, `application.com.t3tools.t3code.*`,
`so.stencil.tern.daemon`, `dev.bb.desktop.ShipIt`.

### 4.9 Time Machine and swap

```sh
tmutil status >> results/prep/before.txt
sudo tmutil disable
sudo shutdown -r now
```

After the reboot, log in as `ademark` and confirm `sysctl vm.swapusage` shows `used = 0.00M`.

### 4.10 Harness tools

```sh
brew install mitmproxy
mitmdump --version >> results/prep/before.txt
```

The first `mitmdump --mode local` asks to enable the Mitmproxy Redirector network extension. Approve it in
System Settings > General > Login Items & Extensions > Network Extensions.

WARNING: trusting the mitmproxy CA lets mitmproxy read every TLS connection of this user. Do it only in the
`ademark` user, and remove it in §5.

```sh
security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ~/.mitmproxy/mitmproxy-ca-cert.pem
```

Ghostty config for the `ademark` user (`~/.config/ghostty/config`):

```text
# Clean shell with no rc files; PATH fixed so claude, codex and bun resolve without a profile. CLAUDE_CODE_NO_FLICKER=1
# keeps Claude Code's fullscreen renderer: after a killed start it otherwise falls back to the classic one (pilot).
command = /usr/bin/env PATH=/Users/ademark/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin CLAUDE_CODE_NO_FLICKER=1 /bin/zsh -f
# bare-cli adapter: tabs close without a dialog; reset and quit close every tab but the harness tab.
confirm-close-surface = false
keybind = super+alt+shift+o=close_tab:other
auto-update = off
```

Open Ghostty from the Dock, never from a shell inside an agent session: it would inherit that session's
`CLAUDE_CODE_*` variables and Claude Code would save no transcript (bare-cli `reset` refuses such a Ghostty).

### 4.11 Permissions

In System Settings > Privacy & Security, give Ghostty and `~/ADEMark/bench/native/bin/ademark-native` both:

- Accessibility
- Screen & System Audio Recording

### 4.12 Clean config snapshot

After §4.2 and before any ADE launches, take the clean snapshot that `reset()` restores before every ADE:

```sh
cd ~/ADEMark
bun bench/cli.ts snapshot save --dir snapshots/clean            # dry run: prints what it will copy
bun bench/cli.ts snapshot save --dir snapshots/clean --apply
```

`reset()` restores this exact format with `snapshot restore`. The snapshot leaves out credentials and session history
(`bench/core/snapshot.ts` lists the paths), and it holds no personal configuration, because the `ademark` user never
had any.

## 5. Restore after the run

Do these after §11, in this order.

1. Copy `results/` out of the `ademark` user: `rsync -a /Users/ademark/ADEMark/results/ <owner path>/ADEMark/results/`.
2. Remove the mitmproxy CA: `security delete-certificate -c mitmproxy ~/Library/Keychains/login.keychain-db`.
3. Disable the Mitmproxy Redirector extension in System Settings.
4. Unset harness variables: `launchctl unsetenv ANTHROPIC_BASE_URL OPENAI_BASE_URL NODE_EXTRA_CA_CERTS NODE_USE_SYSTEM_CA SSL_CERT_FILE CODEX_CA_CERTIFICATE`.
5. Flush the `pf` anchor: `sudo /usr/local/libexec/ademark-machine pf-clear`.
6. Spotlight on: `sudo mdutil -a -i on`.
7. Power: restore the `pmset` values saved in `results/prep/before.txt`.
8. Updates: `sudo softwareupdate --schedule on`, and restore the two `defaults` keys to their saved values.
9. Time Machine: `sudo tmutil enable` if it was on before.
10. Display: set the refresh rate back to 144 Hz.
11. Log out of `ademark` and log in to the owner's account.
12. Optional. WARNING: this deletes the `ademark` home folder, including any results not copied in step 1.
    `sudo sysadminctl -deleteUser ademark`

The owner's own agent configuration is never touched, because every run happens in the `ademark` user.

## 6. Pilot

Run on day 1 afternoon with three rows: Bare CLI (Claude and Codex), T3 Code (EL-SDK) and one NATIVE ADE (Zeron or Diri).

1. Run every test once per row: `bun bench/cli.ts run --ade <id> --tracks A,B,C --run-id <pilot id>`.
2. Prove every item marked "(validate in pilot)" in TESTS.md. Write the result in `results/pilot/validation.md`.
3. Calibrate the adapter of every ADE in the field: composer and thread regions, new-thread action, masks. Launch each
   ADE once for this, without measuring.
4. Run the 240 fps camera check on 3 apps × 5 runs (TESTS.md §1.3).
5. Check both reference solutions of every task pass and the pristine arena fails (`bun bench/grade/validate.ts`).
6. Set the grade thresholds in `thresholds.json` from the pilot spread, before any main-run data exists.
7. Discard all pilot rows. They are never published as results.

## 7. Per-ADE loop

The CLI runs this loop for every ADE in the published random order. The operator watches the log.

### 7.1 Track A (overnight, replay server)

1. **Gates** (§8). Stop the block if one fails.
2. **Version check.** `installCheck()` must return the pinned version and binary SHA-256.
3. **Global config diff.** Diff `~/.claude`, `~/.codex` and `~/.agents` against `snapshots/clean/`. Save the diff to
   `results/<run-id>/<previous-ade>/global-config-diff.patch` as a Track F fact about the previous ADE.
4. **Reset.** `reset()`: kill every attributed process, boot out launch agents, confirm none is alive, restore
   `snapshots/clean/`, restore `~/ademark-private/seeds/<ade>/home/`.
5. **Vendor integration.** If ADES.md lists a documented integration step for this ADE, apply it and record what it
   changed.
6. **Contamination check.** Run the Bare CLI prompt `replay:hi` against the replay server. The replay log's request size and
   body hash must equal the control's. If not, stop and find the leak.
7. **Environment.** `launchctl setenv ANTHROPIC_BASE_URL http://127.0.0.1:8787` and `OPENAI_BASE_URL`.
8. **Launch and seed.** `launch()`. Clone the arena at the pre-registered commit to `~/arena/<ade>/`. Add it as a
   project. Create the 5 seeded threads.
9. **Tests in this order:** A5 and A6 (front, then covered), A7, A8, A10, A11, A3, A4, A9 (3 runs, each ends with a
   relaunch), A2 (10 runs), A1 (10 runs, the first-launch tier once per ADE before the cold runs). A1 runs last
   because it kills everything.
10. **Done marker.** Write `results/<run-id>/<ade>/A.done`. The next ADE starts at step 1.

### 7.2 Track B (day 2 morning, real API)

1. Gates, version check, reset, contamination check as in §7.1, with the replay variables unset.
2. Start `mitmdump --mode local`. Set the CA variables (TESTS.md §1.5).
3. Launch. For each model the ADE supports: B1 three times, then B3. B2 and B4 are computed afterwards from the captures.
4. Run the `nettop` completeness check.
5. Quit. Write `B.done`.

### 7.3 Track C (day 2, real API)

1. Gates, version check, reset, contamination check.
2. Capture on, sampler on for the whole ADE (A12), screen recording on.
3. Confirm local mode in the ADE (ADES.md). If the ADE starts a cloud thread, stop and fix the configuration.
4. C1 (cap 45 min), then C2, C4, C5 and C6 (cap 10 min each). C3 runs inside C1 and C2. Each test starts from a fresh
   arena clone.
5. Grade each test with `bun bench/grade/grade.ts` (the run does it for C tests; see `bench/grade/README.md`).
6. If C1 is under 5/5 or a C4-C6 result is `fail`, queue one second run at the end of the track.
7. Quit. Write `C.done`.

## 8. Gates

| Gate | Check | Pass | If it fails |
|---|---|---|---|
| Swap | `sysctl vm.swapusage` | `used = 0.00M` | Reboot. The CLI resumes from the last `.done` marker |
| Thermal | `powermetrics -s thermal` | pressure `Nominal` | Wait 5 min and check again. After 3 failures, stop the block and log it |
| Quiet CPU | coalition CPU of everything except the harness, 60 s | under 0.1 core | Wait up to 5 min. Log the top processes. If a system process keeps it busy (`mds`, `softwareupdated`, `photoanalysisd`), fix the cause and re-run the window |
| Version | `installCheck()` | pinned version and SHA-256 | Stop. Reinstall from `pins/`, re-seed, continue |
| Contamination | replay request hash | equals the control | Stop. Diff the config, restore, retry |
| Network (B, C) | `curl -sI https://api.anthropic.com` and the OpenAI host | HTTP response | Wait. Log the outage. Never run a B or C test without network |
| Plan limit (B, C) | a limit message or HTTP 429 | none | Pause until the window resets (§9) |

Every gate value is written to `events.log` with a timestamp.

## 9. Failure handling

| Failure | What to do | How it is published |
|---|---|---|
| The adapter cannot drive the ADE | The owner drives by hand with the same script: same prompt, same order. The echo timer still listens and timestamps the owner's keystrokes with a `CGEventTap` | Rows carry `drive: "manual"` |
| Plan limit hit | Pause. Resume after the reset from the current test. A task cut by the limit is invalid and runs again | The pause is in `events.log`. Times exclude nothing; the cut task is re-run from the start |
| ADE crash | Record a Stumble in `events.log`. Re-run the test once | Both runs are published |
| ADE freeze over 2 s outside C3 | Record a Stumble | Published in the ADE's report |
| Harness error (our bug) | Fix it, re-run the affected rows | Never counted against the ADE. Listed in the corrections log |
| System dialog (permissions, update) | Dismiss it, mark the row invalid, re-run | Invalid row kept in `rows.jsonl`, not charted |
| Gate failure | §8 | In `events.log` |
| A tokens or orchestration step fails, or the plan does not answer | Nothing else changes: the app's Track A result stays. **Measure what is missing** names it (`Tokens: <apps>`, `Orchestration: <apps>`) and runs it again in the next folder | `report.md` shows the Track B and C1 parts with their attempt, or why there is none |
| A test under its minimum after the first pass | Control runs it once more in a top-up folder of the same run (METHODOLOGY.md §6, top-up). After a fix, **Measure what is missing** runs another top-up | `report.md` names the attempt of each test |
| ADE still fails after the end-of-night retry | `night` starts the repair agent (METHODOLOGY.md §5 item 17): 2 attempts per ADE, 180 minutes in total, 45 per attempt. A repaired ADE is measured again in full | `night.md` lists every attempt. `repairs/<ade>/attempt-<n>/diff.patch` and `result.json` are public. `agent.jsonl` stays private |

## 10. Data layout

```text
results/<run-id>/
  manifest.json            hardware, macOS build, display mode, versions, harness commit,
                           task hashes, price file hash, order seed, verified flag
  rows.jsonl               one row per measured repetition (TESTS.md §0.1)
  summary.json             aggregates per ADE and test
  fit.json                 Track F facts
  events.log               gates, stumbles, pauses, harness errors
  system/                  powermetrics.plist, vm_stat.log, swap.log
  rows-superseded.jsonl    rows of a retried or repaired block
  repairs/<ade>/attempt-<n>/
                           diff.patch, result.json (public), outcome.txt,
                           agent.jsonl (private: it can show account names)
  <ade>/
    global-config-diff.patch
    A.done B.done C.done
    <test-id>/rep-<nn>/    samples.csv, frames.json, video.mov,
                           screenshot-<name>.png, notes.md
    capture-<track>-<n>/   capture.jsonl and bodies/ (one per block)
```

`<run-id>` is the start time in UTC and the harness commit, for example `2026-10-21T19-00Z-3f9c2a1`.

## 11. Pre-registration checklist

Do this on day 1 evening, after the pilot and before the first Track A row.

1. Commit these files and record each SHA-256 in `prereg/hashes.txt`:
   - METHODOLOGY.md, TESTS.md, RUNBOOK.md, ADES.md, TASKS.md, FAIRNESS.md, BUSINESS.md
   - every `tasks/<task-id>/prompt.md` and `task.toml`
   - a tar archive of every `tasks/<task-id>/tests/` folder (the hidden tests stay private; only the hash is public)
   - `prices/2026-10.json`, `thresholds.json`, `pins/versions.json`
   - the arena commit hash and the harness commit hash
   - the random order seed
   - `prereg/prediction.md`: the author's predicted ranking per grade, written before any data
2. `git tag -s ademark-v1-prereg`, then `git rev-parse ademark-v1-prereg`.
3. Timestamp `prereg/hashes.txt` with OpenTimestamps: `ots stamp prereg/hashes.txt`.
4. Post the tag hash and the `hashes.txt` SHA-256 on X.
5. From this point, every change to a hashed file goes to the public changelog with its reason.

## 12. Publish checklist

1. Every row is valid, or its re-run exists, or the gap is explained.
2. Every second run of C1 and C4-C6 is done and published next to the first.
3. The pilot rows are not in the published data, and no smoke row is: a rehearsal folder is refused.
4. Charts and ADE reports are generated from `rows.jsonl` and `summary.json` only. No number is typed by hand.
5. Every chart footer has: machine, date, versions, runs per value, the link to raw data.
6. Receipts are uploaded and every link on the site opens.
7. The hidden tests stay private. Their SHA-256 (`tasks/*/tests/SHA256`) is public and matches the pre-registered one.
8. The corrections log is live.
9. Every vendor gets its ADE report and the right-of-reply contact at the moment of publication.
10. The prediction file is published next to the results.
11. §5 restore is done.

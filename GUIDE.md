# Measure an ADE yourself

This guide takes you from a fresh clone to ADEMark numbers from your own Mac. Path A measures an ADE that v1 already
covers. Path B adds a new one. It is written for a person and for the coding agent they hand the repo to; an agent
reads [AGENTS.md](AGENTS.md) first.

Run every command from the repository root. `bun bench/cli.ts` is the harness CLI, and the other documents call it
`ademark`. `bun bench/cli.ts help` prints every command and flag.

Steps marked **(person)** need a password, a login or a click in System Settings. A coding agent cannot do them.

## 1. What you get and what it takes

Each run writes one folder, `results/<run-id>/`, with one row per repetition and the medians per test, in the same
format as the published data in [`data/v1/`](data/). Your rows are never labeled "verified": that label is for the
reference machine and audited re-runs only (METHODOLOGY.md §8).

| Need | Detail |
|---|---|
| Mac | Apple Silicon. The setup expects Homebrew in `/opt/homebrew`. v1 ran on a Mac mini M4 with 16 GB. |
| macOS | 14 or newer for the native helper. Some ADEs need more (Diri's profile says macOS 15). v1 ran macOS 27.0.1. |
| Display | At least 1680 × 1060 points and a 60 Hz mode. The harness puts each window at (80, 60) and sizes it 1600 × 1000 points. |
| Disk | 8 GB free on the results volume, or `doctor` fails. |
| macOS user | A dedicated user named `ademark`. Creating it needs an administrator password. |
| Claude | Claude Code signed in, for every track. A Claude plan for Tracks B and C. v1 used a dedicated Claude Max account. |
| Codex | Optional. A ChatGPT login to measure Codex, or for the screen agent (§4.3). |

| Step | Time | Model usage |
|---|---|---|
| Track A, speed and weight | about 25 to 30 minutes per ADE | none: a local replay server answers in place of the model |
| Track B, tokens | about 4 to 5 minutes per agent | B1 ("hi") 3 times and B3 once. In v1 one "hi" sent 22.2K to 77.0K tokens. |
| Track C, test C1 | up to 45 minutes per run, and a second run when a graded build is not 5/5 (§7) | In v1 one C1 run sent 1.7 to 4.2 million tokens. One run can use up a 5-hour window of a Claude plan. |
| Calibrating a new ADE | about 45 minutes, then about 25 minutes for the gate | none from the Claude plan: the gate runs Track A |

## 2. Prerequisites

Install the shared tools once, from the account that owns your Homebrew install. The `ademark` user then finds them
in `/opt/homebrew/bin`.

```sh
xcode-select --install                                     # Command Line Tools: Swift 6.4, git, python3
brew install oven-sh/bun/bun mitmproxy node displayplacer
brew install --cask ghostty
```

| Tool | Used for |
|---|---|
| Swift 6.4 (Command Line Tools) | Building `ademark-native`, the timing and memory helper |
| Bun | The harness and its tests |
| mitmproxy | Network capture in Tracks B and C (`mitmdump --mode local`) |
| Node | Track C: the agents run `npm test` in the arena (Node 24 or newer, `arena/package.json`), and the grader runs `node` |
| displayplacer | `machine on` sets the display to 60 Hz with it. Without it, set 60 Hz by hand. |
| Ghostty | The terminal the harness runs in, and the Bare CLI control |

Install the ADE itself from its vendor. Claude Code goes into the `ademark` user in §3.3.

## 3. Machine setup (once)

### 3.1 Create the `ademark` user (person)

The harness moves app data aside, kills processes, replaces `~/.claude`, sets launchd variables and trusts a TLS proxy.
In your own account that would touch your own data. Every ADE must also start from the same clean state
(METHODOLOGY.md §5). So every real command checks the macOS user name and stops in any other account:

```text
run: refusing to measure as "you": a real run is only allowed as the dedicated "ademark" macOS user (METHODOLOGY.md §5). Use --dry-run to exercise the loop without measuring.
```

From an administrator account:

```sh
sudo sysadminctl -addUser ademark -fullName "ADEMark" -password - -admin
```

It asks for the new user's password. The new user is an administrator; §10 removes it.

1. Quit every app in your account.
2. Log out (Apple menu > Log Out). Switching users is not enough.
3. Log in as `ademark`. Every later step runs in this user.

### 3.2 Clone the repository

Open Terminal and run:

```sh
git clone https://github.com/zqkra/ademark ~/ADEMark
cd ~/ADEMark
```

### 3.3 Account settings and Claude Code

The new user's shell does not have `/opt/homebrew/bin` on its PATH yet, so call Bun by its full path once:

```sh
/opt/homebrew/bin/bun bench/cli.ts account setup --apply
```

This writes the Ghostty config of RUNBOOK.md §4.10 (a clean `zsh -f` with a fixed PATH), turns off the update checks
of Claude Code and Codex, trusts `~/arena` for Claude Code, and turns off Adobe background agents when they exist.

Quit Terminal. Drag Ghostty from Applications to the Dock and open it from there, every time from now on. Never start
it from a shell: a Ghostty started inside an agent session passes that session's variables on, and `doctor` fails.
In Ghostty:

```sh
cd ~/ADEMark
curl -fsSL https://claude.ai/install.sh | bash             # Claude Code, into ~/.local/bin
claude                                                     # then /login with your Claude account (person)
```

v1 used Claude Code 2.1.303. Every run records the version you use in its manifest. To measure Codex too, run
`codex login` here (person).

### 3.4 Root helper (person)

```sh
sudo zsh bench/ops/install-machine.zsh
```

It installs `/usr/local/libexec/ademark-machine` and a sudoers rule that lets `ademark` run that one script as root
with no password. The harness needs it for `machine on|off`, `purge` before A1, `footprint` for memory, and the network
cut of C5.

> [!WARNING]
> Anyone who can edit `/usr/local/libexec/ademark-machine` can run code as root. Run the installer again after any
> change to `bench/ops/machine.zsh`. `bench/ops/README.md` says how to remove both files.

### 3.5 mitmproxy (person)

1. Run `mitmdump --mode local`. macOS asks to allow the Mitmproxy Redirector network extension. Allow it in
   System Settings > General > Login Items & Extensions > Network Extensions, then stop mitmdump with Ctrl-C. The
   first start also writes `~/.mitmproxy/mitmproxy-ca-cert.pem`.
2. Trust that certificate in the login keychain. It asks for the `ademark` password.

   ```sh
   security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ~/.mitmproxy/mitmproxy-ca-cert.pem
   ```

3. Check: `bun bench/cli.ts account check` shows `ok` or `skip` on every line.

> [!WARNING]
> A trusted mitmproxy CA can read every TLS connection of this user. Trust it only in `ademark`, and remove it after
> your runs (§10).

### 3.6 Native helper and permissions

```sh
bash bench/native/build.sh
bench/native/bin/ademark-native selftest
```

`selftest` prints `{"passed":249,"failed":0,"failures":[]}`. Then grant these **(person)**:

| Permission | Where | Give it to |
|---|---|---|
| Accessibility | System Settings > Privacy & Security > Accessibility | Ghostty and `~/ADEMark/bench/native/bin/ademark-native` |
| Screen & System Audio Recording | System Settings > Privacy & Security > Screen & System Audio Recording | Ghostty and `~/ADEMark/bench/native/bin/ademark-native` |
| Network extension | §3.5 | Mitmproxy Redirector |
| Automation (optional) | Allow when macOS asks | Ghostty controlling System Events. Only used to dismiss a Gatekeeper dialog. |

```sh
bench/native/bin/ademark-native permissions
```

It prints `{"accessibility":true,"screen_recording":true}` when both grants are in place. It only reads them and never
opens a dialog. Some ADEs ask for their own access at first launch: Diri asked for Desktop, Documents and Apple Music,
and the reference machine denied all three.

### 3.7 Clean config snapshot

Take it after Claude Code is signed in and before any ADE launches:

```sh
bun bench/cli.ts snapshot save --dir snapshots/clean            # dry run: lists what it copies
bun bench/cli.ts snapshot save --dir snapshots/clean --apply
```

Every reset restores this copy of `~/.claude`, `~/.codex` and `~/.agents`, so each ADE starts from the same agent
config. It leaves out credentials and session history.

### 3.8 First doctor

```sh
bun bench/cli.ts doctor --agent claude
```

It prints `status`, `check`, `detail` and `fix` for about 25 checks, changes nothing, and exits 1 when a blocking
check fails. `--agent claude` skips the Codex login check. Use `--agent claude,codex` to measure Codex, and add `own`
for Capy. On a fresh clone expect these:

- `warn` on `claude and codex versions` and `seeds`: the pins and seeds of the reference machine are private.
  `calibration gates` warns for an installed ADE whose gate file is missing, failed, or names another build.
- `FAIL` on `adapter installs` for every ADE you did not install, and on `adapter logins` for every app with its own
  sign-in that is not signed in. These two do not block.
- `FAIL` on `machine state on` and `display at 60 Hz` until you run `machine on --apply` (§4.4).

## 4. Path A: measure an ADE in the field

### 4.1 Pick the ADE

`bun bench/cli.ts adapter list` prints these 18 ids. Fifteen are driven by a profile in `bench/adapters/profiles/`;
`bare-cli`, `t3code` and `zeron` have code adapters.

| id | App | Family | Adapter | Own sign-in | C1 |
|---|---|---|---|---|---|
| `bare-cli` | Bare CLI (control) | control | code | no | solo baseline |
| `t3code` | T3 Code | EL-SDK | code | no | not calibrated |
| `bb` | bb | EL-SDK | profile | no | trigger |
| `paseo` | Paseo | EL-SDK | profile | no | not calibrated |
| `synara` | Synara | EL-SDK | profile | no | trigger |
| `traycer` | Traycer | EL-SDK | profile | yes | not calibrated |
| `cloudroom` | Cloudroom | EL-SDK | profile, screen agent | no | trigger |
| `superset` | Superset | EL-PTY | profile, screen agent | yes | not calibrated |
| `orca` | Orca | EL-PTY | profile | no | trigger |
| `emdash` | Emdash | EL-PTY | profile | no | not supported |
| `zeron` | Zeron | NATIVE | code | no | not calibrated |
| `diri` | Diri | NATIVE | profile | no | not calibrated |
| `monocode` | MonoCode | NATIVE | profile | no | not calibrated |
| `super-engineering` | super.engineering | NATIVE | profile | no | trigger |
| `conductor` | Conductor | NATIVE | profile | no | not supported |
| `capy` | Capy | OWN | profile, screen agent | yes | trigger |
| `claude-desktop` | Claude desktop (Code tab) | FIRST | profile | yes | not calibrated |
| `codex-app` | Codex app (in ChatGPT desktop) | FIRST | profile | yes | not calibrated |

- **Own sign-in** "no" means the app runs the account's own `claude` login.
- **C1**: "trigger" runs the orchestrated build. "Not supported" writes valid rows with no value. "Not calibrated"
  writes invalid rows. The Bare CLI runs the single-agent baseline (C1-solo).
- **Screen agent**: these profiles have `goal` steps, which need the screen agent (§4.3).
- `--agent` must name an agent the ADE runs: `claude` for most, `own` for Capy, `codex` for the Codex app. Any other
  value runs nothing and prints `0 rows in 0 block(s)`. v1 measured Claude only; the Codex app is not in v1.

### 4.2 Dry run first

A dry run works in any account, even before the setup. It plans every step, opens no app and measures nothing:

```sh
bun bench/cli.ts run --ade super-engineering --tracks A --agent claude --dry-run --run-id first-look
```

```text
[super-engineering] A1 cold: stopped at n=6 of 6 (converged)
...
run first-look-dry: 77 rows in 1 block(s), finished
wrote /Users/ademark/ADEMark/results/first-look-dry
```

It writes `results/<run-id>-dry/` with `plan.jsonl` (every instrument call in order), rows whose notes start with
`dry run`, and a manifest with `"verified": false`. Without `--run-id` the id is the UTC start time and the commit,
for example `2026-11-12T21-14Z-bf08167`. Exit code 0 means every block finished, 1 that a block stopped, 2 a refused
command.

### 4.3 Set up the ADE (person)

1. Install the build the profile was calibrated on. Compare what you have with the profile:

   ```sh
   bun bench/cli.ts adapter install-check <id>      # installed version and path
   grep -m1 '"version"' bench/adapters/profiles/<id>.json
   ```

   Another build can move a button or rename a setting. If they differ, plan a new calibration (§5.6 to §5.9).
2. Open the app once. Sign in if it has its own sign-in. Set what ADES.md §1 pins: local mode, Claude Opus 5.5 at high
   effort, full access inside the worktree, prompt rewriting off, telemetry off, auto-update off. The ADE's section in
   [ADES.md](ADES.md) and the `notes` in its profile say where each setting lives and what the reference seed held.
   Start no thread.
3. Quit the app.
4. Save the seed: the files a reset copies back after it moves the app's data aside. The profile lists them in
   `reset.seeds`; the harness reads them from `~/ademark-private/seeds/<id>/home/`.

   ```sh
   id=<id>
   bun -e 'for (const p of (await Bun.file(`bench/adapters/profiles/${process.argv[1]}.json`).json()).reset.seeds) console.log(p)' "$id" |
     while IFS= read -r p; do ditto "$HOME/$p" "$HOME/ademark-private/seeds/$id/home/$p"; done
   chmod -R go-rwx ~/ademark-private
   ```

   Seeds can hold sign-in tokens. They never go into the repository. `t3code` and `zeron` keep their seed paths in
   `SEED_PATHS` in their adapter files (`.t3/userdata`, `.zeron/profiles/local`). `bare-cli` has no seed.

**The screen agent.** After every launch of a profile ADE, the harness shows a screenshot of the app window to a model
and closes any dialog that covers it. It asks Codex first (`codex exec` with your ChatGPT login), then an OpenCode Go
key (`ADEMARK_AGENT_KEY` or `~/.config/ademark/opencode-go.key`). With neither, the check is skipped and logged.
`ADEMARK_AGENT=off` turns this check off. The `goal` steps of `capy`, `cloudroom` and `superset` always use the
screen agent, and fail without it.

### 4.4 Prepare the Mac

At the start of every session, in a Ghostty window opened from the Dock:

```sh
cd ~/ADEMark
bun bench/cli.ts machine on --apply
bun bench/cli.ts doctor --agent claude
```

`machine on` turns off Spotlight indexing, Power Nap, sleep, automatic updates and Time Machine, sets the display to
60 Hz and pauses two photo analyzers. It saves every old value, and `machine off --apply` puts them back. Without
`--apply` both print their plan and change nothing.

Fix every blocking `FAIL` with the command in its `fix` column. Then quit every app except Ghostty and Finder, turn on
Do Not Disturb, connect power, and leave the Mac alone.

### 4.5 Rehearse

```sh
bun bench/cli.ts run --ade <id> --tracks A --agent claude --smoke
```

A smoke run does every Track A test once with short windows. It writes `results/<run-id>-smoke/` and is never
published. List its invalid rows:

```sh
bun -e 'for (const line of (await Bun.file(process.argv[1]).text()).split("\n")) { if (!line) continue; const r = JSON.parse(line); if (!r.valid) console.log(r.test_id, r.variant, r.invalid_reason) }' results/<run-id>-smoke/rows.jsonl | sort | uniq -c
```

Go on when no row is invalid, or when each reason is a known limit of that app: its profile's `excludeTests` names
the tests the harness cannot measure there, and its `notes` record what calibration found.

### 4.6 The real runs

Run each track on its own, as v1 did:

```sh
bun bench/cli.ts run --ade <id> --tracks A --agent claude                # speed and weight
bun bench/cli.ts run --ade <id> --tracks B --agent claude                # tokens: spends the Claude plan
bun bench/cli.ts run --ade <id> --tracks C --tests C1 --agent claude     # orchestration: spends the most
bun bench/cli.ts machine off --apply                                     # when you are done
```

| Track | What the harness does | What to know |
|---|---|---|
| A | Resets the app, writes a fresh arena to `~/arena/<id>/`, starts the replay server on `127.0.0.1:8787`, seeds 5 threads, then runs A5, A6, A7, A8, A10, A11, A3, A4, A9, A2 and A1. | Do not touch the Mac. Keys go to the app only while it is in front, and a skipped key makes the row invalid. |
| B | Resets the app, starts `mitmdump` to capture every model request, runs B1 three times and B3 once per agent, then computes B2 and B4 from the captures. | Needs the plan and network. |
| C | `--tests C1` runs only the orchestrated build of v1: the trigger line, the prompt, the agents, then the grader. | Read §7 first: a clone cannot grade the build. C2 to C6 were not part of v1. |

Each run ends with `wrote <folder>`. What it writes in `results/<run-id>/`:

| Path | Contents |
|---|---|
| `manifest.json` | Run id, machine id, hardware, macOS build, display mode, harness commit, CLI and app versions, task hashes, order seed, `verified` |
| `rows.jsonl` | One JSON row per repetition (TESTS.md §0.1) |
| `summary.json` | Medians and ranges per ADE and test |
| `events.log` | Gate values, gate failures, stumbles and harness errors |
| `<id>/<test>/rep-<nn>/` | Receipts: `samples.csv`, `frames*.json`, `video.mov`, PNG screenshots, `notes.md`. Track B adds the agent: `<id>/<test>/<agent>/rep-<nn>/` |
| `<id>/capture-B-<n>/`, `<id>/capture-C-<n>/` | Every model request and response of the block, with auth headers removed |
| `<id>/<track>-<agent>.done` | Marks a finished block |
| `agent/` | The screen agent's screenshots and answers |

A stopped run can go on in the same folder: repeat the command with `--run-id <the base id> --resume`. Finished blocks
are skipped, and the run refuses to resume when the CLI versions, task hashes or price file changed.

To measure the whole field in one night, use ADEMark Control or `night` instead (RUNBOOK.md §0). They measure only
ADEs whose calibration gate is `ok`.

## 5. Path B: add a new ADE

### 5.1 Check that it can enter

An ADE enters when it is a macOS desktop app, publicly downloadable, that runs coding agents on a local repository
(METHODOLOGY.md §2). Open an [ADE request](https://github.com/zqkra/ademark/issues/new?template=ade-request.yml) first
if you want to know whether someone is already on it.

### 5.2 Pick the closest profile to copy

Families are defined in METHODOLOGY.md §2.

| The app | Family | Copy |
|---|---|---|
| Electron app that drives Claude Code through the Agent SDK | EL-SDK | `synara.json` (keys and paste), `traycer.json` (own sign-in) |
| Electron app that runs the agent's terminal UI in a pseudo-terminal | EL-PTY | `orca.json` (opens the project with its CLI) |
| Native app with its own CLI | NATIVE | `super-engineering.json` |
| Native app with the agent's terminal UI | NATIVE | `diri.json` |
| An app that runs its own agent | OWN | `capy.json` |
| A model vendor's own app | FIRST | `claude-desktop.json` (opens the project with a URL scheme) |

### 5.3 Write the adapter file

`bench/adapters/<id>.ts` holds only the facts ADES.md states. This is the real `bench/adapters/super-engineering.ts`:

```ts
import { profileAdapter } from "./profile.ts";

export const superEngineering = profileAdapter({
  id: "super-engineering",
  name: "super.engineering",
  family: "NATIVE",
  agents: ["claude", "codex"],
  appName: "super.engineering",
  bundleId: "engineering.super.app",
  drive: "cli",
  dataDirs: ["~/.super.engineering"],
  launchAgents: [],
  vendorDirs: ["~/.super.engineering"],
});
```

The id uses lowercase letters, digits and single dashes. It is the same in the file name, the profile file name and
the profile's `ade` field. `family` is `EL-SDK`, `EL-PTY`, `NATIVE`, `OWN` or `FIRST`. `agents` lists `claude`,
`codex` or `own`.

### 5.4 Register it

| File | Change |
|---|---|
| `bench/adapters/registry.ts` | Import the adapter and add `"<id>": <export>` to `adapters`. `run`, `profile check` and `calibrate` refuse an id that is not here. |
| `bench/test/adapters.test.ts` | Add the id to `EXPECTED` and its family to `families`, and raise the count of 18. |
| `ADES.md` §3 | Add a section `### 3.<n> <App>` with a table that has an `Adapter ID` row and an `Orchestration (C1)` row. A test reads them: the cell starts with `not supported` exactly when the profile's `orchestrationTrigger` is `null`. |
| `bench/control/real.ts` | Only for Control nights: add the id to `MEASURED_ADES`. |

### 5.5 Install and probe (person installs)

Install the app in `ademark` and set it up as in §4.3 step 2. Then read what the bundle says, without launching it:

```sh
bun bench/cli.ts calibrate probe --ade <id>
```

```text
super-engineering (/Applications/super.engineering.app)
info: bundle id engineering.super.app, version 15aae8f8 (build 15aae8f8), executable super.engineering, minimum macOS 14.0, URL schemes none
stack: GPUI
```

### 5.6 Write the profile

The profile, `bench/adapters/profiles/<id>.json`, is everything calibration learned about one build, as data. The
harness replays it:

| Stage | What the harness does | Profile fields |
|---|---|---|
| Reset | Quits the app (AppleScript `quit` when `steps.quit` is empty, then 10 s), kills what is left, keeps the sign-in files, moves the data folders aside, copies the seed back, writes settings keys, boots out launch agents, restores `snapshots/clean` | `login.files`, `calibration.dataDirs`, `reset.seeds`, `reset.jsonKeys`, `calibration.launchAgents`, `steps.quit` |
| Launch | Opens the app by bundle id (or `open -a`), waits for its process, sets the window size, runs the after-launch steps, lets the screen agent close dialogs, sets model and effort, then opens the arena once per reset | `calibration.bundleId`, `app.processNames`, `window`, `steps.afterLaunch`, `steps.configure.<agent>`, `steps.openProject` |
| New thread | Runs the new-thread trigger, then waits a moment | `timed.newThread` |
| Send | Pastes the prompt with the clipboard and Cmd+V, then runs the send trigger | `timed.send` |
| Wait | Reads the agent's session log until the turn ends, with the idle rule of TESTS.md §1.7 as a fallback when allowed | `waitDone.cwd`, `waitDone.idleFallback` |
| Quit | Runs the quit steps, waits 10 s, logs what is still alive (A9) | `steps.quit` |
| Timed | The echo timer runs these as synthetic keys and clicks: A1 and A2 `launch`, A3 `newThread`, A4 `send`, A11 the long and short thread | `timed.*` |

This is `super-engineering.json` with its notes, A11 triggers and orchestration settings removed. It passes
`profile check`:

```json
{
  "schema": 1,
  "ade": "super-engineering",
  "app": {
    "path": "/Applications/super.engineering.app",
    "version": "15aae8f8",
    "bundleSha256": "efef5274024b69e8ca7993ef348e064521347f8fd300a9860e7d488f867e9df8",
    "processNames": ["super.engineering"]
  },
  "window": { "w": 1600, "h": 1000 },
  "calibration": {
    "appName": "super.engineering",
    "bundleId": "engineering.super.app",
    "composerRect": { "x": 430, "y": 820, "w": 420, "h": 60 },
    "activeComposerRect": null,
    "launchComposerRect": null,
    "threadRect": { "x": 420, "y": 480, "w": 760, "h": 320 },
    "focusClick": { "x": 800, "y": 848 },
    "masks": [],
    "drive": "cli",
    "dataDirs": ["~/.super.engineering"],
    "launchAgents": []
  },
  "login": { "kind": "agent-cli", "files": [], "signIn": null },
  "reset": {
    "seeds": [".super.engineering/settings.json", ".super.engineering/tool-status.json"],
    "jsonKeys": []
  },
  "steps": {
    "afterLaunch": [],
    "openProject": [
      {
        "kind": "run",
        "argv": ["/Applications/super.engineering.app/Contents/MacOS/sc", "workspace", "open", "${worktree}", "--activate", "--json"],
        "timeoutMs": 60000
      },
      { "kind": "wait", "ms": 1500 },
      { "kind": "keys", "combo": "cmd+l" },
      { "kind": "wait", "ms": 300 }
    ],
    "configure": { "claude": [], "codex": [] },
    "quit": []
  },
  "timed": {
    "launch": [{ "kind": "open", "bundleId": "engineering.super.app" }],
    "newThread": [{ "kind": "keys", "combo": "cmd+t" }],
    "send": [{ "kind": "enter" }]
  },
  "waitDone": { "cwd": "worktree", "idleFallback": false },
  "processes": {
    "vendorDirs": ["~/.super.engineering"],
    "launchAgentLabels": [],
    "teamId": "MR38E36N26",
    "agentExecutables": ["claude", "codex", "/Users/ademark/.local/share/claude/versions/"]
  },
  "orchestrationTrigger": "Use the `sc` CLI to orchestrate this change.",
  "notes": ["Calibrated on build 15aae8f8 at 1600 x 1000 points."]
}
```

What it says, block by block:

- `app`: the build this profile fits, from `adapter install-check`. `processNames` find the app's process.
- `calibration`: OCR regions in window points from the top-left of a 1600 × 1000 window. `composerRect` and
  `threadRect` are required. `focusClick` is the point to click when the app does not focus its composer itself.
- `login.kind`: `agent-cli` when the app runs the account's `claude` login, `app` when it has its own sign-in (then
  list the sign-in files in `login.files` and one line for the person in `signIn`).
- `reset.seeds`: paths under the home folder, copied back from the seed (§4.3 step 4).
- `steps.openProject`: here the app's own CLI opens the arena, then Cmd+L focuses the composer.
- `steps.configure`: empty, because the seed already holds Opus 5.5 at high effort. It needs one list per agent in the
  adapter's `agents`.
- `timed`: Cmd+T opens a new chat tab, Enter sends. `launch`, `newThread` and `send` must not be empty.
- `waitDone.cwd`: `worktree`, because the agent's session log names the arena folder.
- `orchestrationTrigger`: the line sent before the C1 prompt, `null` when the app has no orchestration, or
  `{ "notCalibrated": "<what is missing>" }` until a trigger is proven. Start a new profile with the last one.

Rules:

- Steps never use Accessibility. Reading the AX tree puts Electron and WKWebView apps into a heavier mode, and the steps
  run in the process that is measured. Use keys, clicks, the app's CLI and URLs.
- Step kinds: `keys`, `type`, `enter`, `click`, `wait`, `open`, `paste`, `expectText`, `clickIfText`, `run` and `goal`
  (the screen agent). Timed triggers take only `open`, `keys`, `type`, `click`, `enter` and `wait`.
- A `run` step has no shell: `sudo`, `su`, `sh`, `bash`, `zsh`, `env` and `osascript` are refused.
- Placeholders: `${worktree}`, `${home}`, `${model}`, `${effort}` and `${agent}`.
- Settings files are written only in `reset.jsonKeys`, while the app is closed.

Every field is described in [bench/adapters/profiles/README.md](bench/adapters/profiles/README.md). To find the
values, follow [bench/adapters/CALIBRATE.md](bench/adapters/CALIBRATE.md) in the `ademark` user. Its main tools,
with `<pid>` from `bench/native/bin/ademark-native procs`:

```sh
bench/native/bin/ademark-native window --pid <pid> --size 1600x1000 --front
bench/native/bin/ademark-native menu-shortcuts --pid <pid>
bench/native/bin/ademark-native ax-tree --pid <pid> --window-only
bench/native/bin/ademark-native probe-region --pid <pid> --search <x,y,w,h> --text ademarkqz
```

`probe-region` types the probe and returns the rect that changed: that is the composer. Quit the app after every
calibration session, because the AX reads leave it in the heavier mode.

### 5.7 Validate

These run in any account and launch nothing:

```sh
bun bench/cli.ts profile check <id>        # ok, or every error with its JSON path
bun bench/cli.ts adapter check <id>        # conformance of the adapter and its profile
bun bench/cli.ts run --ade <id> --tracks A,B,C --agent claude --dry-run
cd bench && bun test                       # build the native helper first: two tests call it
```

An error names its JSON path:

```text
super-engineering    invalid
  calibration.composerRect: must lie inside the 1600x1000 window
```

### 5.8 Smoke test (person runs it)

In `ademark`, after §4.4:

```sh
bun bench/cli.ts run --ade <id> --tracks A --agent claude --smoke
```

A failing step names itself as `step <list>[<index>] (<kind>): <reason>`. Read the invalid rows as in §4.5, watch
`video.mov` in the receipts, fix the profile and run it again.

### 5.9 Gate

The gate is 5 smoke runs of Track A in a row, each from a fresh reset, in about 25 minutes. It refuses an uncommitted
tree, because it records the commit it measured with:

```sh
git add -A && git commit -m "Add <id> profile"
bun bench/cli.ts calibrate gate --ade <id>
```

It writes `bench/adapters/gates/<id>.json`. Fix, commit and repeat until it says `passed: 5`, then commit the gate
file. `--dry-run` runs the loop in any account and writes its gate file to a temp folder. `run` does not read gates;
`night` and Control measure only ADEs whose gate is `ok`.

### 5.10 Measure

Run §4.4 to §4.6 with your id. For C1, the trigger line is the app's own documented way to start its orchestration,
sent as one line before the prompt (TASKS.md §1, rule 4). A C1 run where one agent did all the work is invalid.

## 6. Reading results

`summary.json` holds the medians. Each test is keyed `<test>/<variant>`:

```json
"ades": {
  "super-engineering": {
    "family": "NATIVE",
    "tests": {
      "A5/app": { "n": 1, "median": 134.31, "p25": 134.31, "p75": 134.31, "min": 134.31, "max": 134.31, "against_bare_cli": null }
    }
  }
}
```

`rows.jsonl` holds the rows behind it. A row with `"valid": false` keeps its `invalid_reason` and is never charted.
RAM is in MB of 1,048,576 bytes. Print the summary as a table:

```sh
bun bench/cli.ts summarize --run results/<run-id>
```

Put your medians next to v1 for the same ADE:

```sh
bun -e 'const [run, id] = process.argv.slice(1); const mine = (await Bun.file(`${run}/summary.json`).json()).ades[id].tests; const ref = (await Bun.file("data/v1/summary.json").json()).apps[id]?.tests ?? {}; for (const [test, s] of Object.entries(mine)) console.log(test.padEnd(24), String(s.median).padEnd(20), ref[test]?.median ?? "-");' results/<run-id> <id>
```

The columns are test, your median, v1 median. The Bare CLI's v1 keys end in `[bare-cli-claude]`. The v1 numbers are
also on [ademark.dev](https://ademark.dev), whose Data section links `results.json`.

How to compare:

- v1 ran on a Mac mini M4 with 16 GB on macOS 27. On another Mac, absolute numbers move. Measure `bare-cli` on your Mac
  too and compare your ADE's gap to the Bare CLI with the gap on the site. `against_bare_cli` is filled only when both
  ran in the same run.
- Runs are never mixed. Each run folder stands alone with its manifest. Never merge rows of two runs into one test,
  and never count dry or smoke rows.
- Never pass `--reference`. It marks the manifest `verified`, which only the reference machine and audited re-runs
  may carry.

## 7. Track C and the hidden tests

C1 is graded by hidden tests. They are not in this repository. Only their SHA-256 is, in `tasks/*/tests/SHA256`, so
anyone can later check which tests graded v1 (the hash rule is in `bench/grade/README.md`). The grader looks for them
in `~/ademark-private/tasks/<task-id>/tests/`, or under `$ADEMARK_PRIVATE`.

What a clone can do:

- Run C1 from start to end: the trigger line, the prompt with its handoff codes, the agents, the capture and the
  grader call.
- Get valid `fan-out-max`, `fan-out-total`, `handoff`, `codes-placed`, `tokens-total` and `usd-total` rows. They come
  from the worktree, the session logs and the capture, and need a run that passes its checks: at least two agents,
  the app's own workers, the pinned model.
- Check every prompt and follow-up against TASKS.md, byte for byte: `bun bench/grade/check-prompts.ts`.

What a clone cannot do:

- Grade the build. Without the hidden tests the grader returns `missing hidden tests`, and the `shipped` and
  `time-to-green` rows (and the Bare CLI's `solo-shipped`) are invalid with `grade invalid: missing hidden tests`.
- Get the second C1 run. It starts only after a valid `shipped` under 5, or a crash.
- Compare `shipped` or `time-to-green` with the site.

C1 still spends the Claude plan in full. Decide whether the other rows are worth a plan window before you run it.

## 8. Keep your raw results private

A run's raw folder holds personal data:

- Your Claude account email, inside the network captures. Claude Code sends it in its requests.
- Screen recordings and screenshots of the measured app's window, which show whatever the app shows: account names,
  projects, other threads.
- Process names and paths: the app's processes in `samples.csv`, and the busiest processes of the Mac in
  `events.log`.

Share only `rows.jsonl`, `summary.json` and `manifest.json`, and read them first. A row's `notes` can hold text read
from the screen. Look for your email in the three files; no output means it is not there:

```sh
grep -n -i -F "you@example.com" results/<run-id>/rows.jsonl results/<run-id>/summary.json results/<run-id>/manifest.json
```

The screen agent sends screenshots of the app window to its model provider (OpenAI through `codex exec`).
`ADEMARK_AGENT=off` stops the check after each launch. `goal` steps still send their screenshots.

## 9. Share results and get an ADE added

- **Results from your Mac**: open the
  [share-results form](https://github.com/zqkra/ademark/issues/new?template=share-results.yml) and attach the three
  files of §8. Every submission shows its hardware and macOS version.
- **A new ADE**: open an [ADE request](https://github.com/zqkra/ademark/issues/new?template=ade-request.yml), or send a
  pull request with the files of §5.3 to §5.6, the gate file when your gate passed, and a passing `cd bench && bun test`.
- **A wrong number**: open a [wrong-number issue](https://github.com/zqkra/ademark/issues/new?template=wrong-number.yml)
  with the test ID and your evidence.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. A change to the method needs an issue before code, and nobody pays for
a change to a result.

## 10. Undo the setup

In `ademark`, after you copied out what you want to keep from `results/`:

```sh
bun bench/cli.ts machine off --apply
sudo /usr/local/libexec/ademark-machine pf-clear
security delete-certificate -c mitmproxy ~/Library/Keychains/login.keychain-db
launchctl unsetenv ANTHROPIC_BASE_URL OPENAI_BASE_URL NODE_EXTRA_CA_CERTS NODE_USE_SYSTEM_CA SSL_CERT_FILE CODEX_CA_CERTIFICATE
rm -f ~/.ademark/machine-user.json
sudo rm -f /etc/sudoers.d/ademark-machine /usr/local/libexec/ademark-machine
```

Turn off the Mitmproxy Redirector in System Settings > General > Login Items & Extensions > Network Extensions. Then log
out, log in to your own account and, if you want, delete the user. This deletes its home folder and every result in it:

```sh
sudo sysadminctl -deleteUser ademark
```

RUNBOOK.md §5 has the full list.

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `run: refusing to measure as "<name>"` | Not the `ademark` user | Log out and log in as `ademark`, or add `--dry-run`. |
| Doctor: `FAIL not inside an agent session` | Ghostty was opened from an agent session, or an agent runs the command | Quit Ghostty, open it from the Dock, run the command yourself. |
| Doctor: `FAIL ademark-native built and permitted` | The helper is not built, or a grant is missing | `bash bench/native/build.sh`, then grant §3.6. If `permissions` still prints `false` after a rebuild, remove the helper from both lists and add it again. |
| Doctor: `FAIL mitmproxy`, or `mitmproxy-ca missing` in `account check` | mitmproxy missing, extension not approved, or CA not trusted | Repeat §3.5. |
| `events.log`: `gate failure: <id>/A: install check version X != pinned Y` | The app updated itself during the run | Turn off its auto-update, reinstall the build of the profile, and start a new run. A new build needs a new calibration and gate. |
| `events.log`: `gate failure` on swap, thermal or quiet CPU | Swap in use, a hot Mac, or a busy process | `bun bench/cli.ts gates` shows the values and the top processes. Reboot for swap, quit what is busy, or wait with `bun bench/cli.ts settle --minutes 5`. |
| Reset fails: `seed for <id> has no <path>: run save-seed.sh first`, or `restore: snapshot folder does not exist` | No seed for the ADE (`save-seed.sh` is not public), or no clean snapshot | Save the seed with the loop in §4.3 step 4. Take the snapshot in §3.7. |
| `goal not reached`, or `no OpenCode Go key` in the log | The screen agent has no model | `codex login` (person), or set `ADEMARK_AGENT_KEY`. |

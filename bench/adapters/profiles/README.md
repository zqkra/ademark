# ADE profiles

A profile is everything a calibration session learned about one ADE build, as data instead of adapter code.
`bench/adapters/profile.ts` turns `profiles/<ade>.json` into an `Adapter`; the adapter file only keeps what
`ADES.md` already states (`profileAdapter({...})`). The TypeScript shape is `AdeProfile` in
`bench/core/contracts.ts`; `bench/adapters/profile-validate.ts` is the strict check.

```sh
bun bench/cli.ts calibrate probe --ade <id>     # what the bundle says without launching the app
bun bench/cli.ts profile check <id|all>         # ok, missing, or every validation error with its JSON path
bun bench/cli.ts adapter check <id>             # conformance; also validates the profile when the file exists
```

A file that is missing is not an error: the adapter behaves like an uncalibrated stub. A file that exists must pass
validation, or every consumer refuses it with the full list of errors.

## The rule that decides every step

**Steps never use Accessibility.** They run inside the same app process that is then measured, and reading the AX
tree switches Electron and WKWebView apps into a heavier mode that changes the timings. Calibration may use
`ademark-native ax-tree` to find things; the profile replays keys, clicks, CLIs and URLs only.

Placeholders a step may use: `${worktree}`, `${home}`, `${model}`, `${effort}`, `${agent}`. Anything else is a
validation error.

## A complete example

```json
{
  "schema": 1,
  "ade": "demo",
  "app": {
    "path": "/Applications/Demo.app",
    "version": "1.4.2",
    "bundleSha256": "9f2c…",
    "processNames": ["Demo", "Demo Helper"]
  },
  "window": { "w": 1600, "h": 1000 },
  "calibration": {
    "appName": "Demo",
    "bundleId": "dev.demo.app",
    "composerRect": { "x": 600, "y": 800, "w": 400, "h": 100 },
    "activeComposerRect": { "x": 600, "y": 850, "w": 400, "h": 100 },
    "launchComposerRect": null,
    "clearKeys": ["cmd+a", "delete"],
    "threadRect": { "x": 400, "y": 100, "w": 700, "h": 600 },
    "focusClick": { "x": 700, "y": 900 },
    "masks": [{ "x": 1500, "y": 0, "w": 100, "h": 60 }],
    "drive": "keys",
    "dataDirs": ["~/.demo"],
    "launchAgents": ["dev.demo.ShipIt"]
  },
  "login": {
    "kind": "app",
    "files": ["~/.demo/login.json"],
    "signIn": "Sign in with the demo account in Settings > Account"
  },
  "reset": {
    "seeds": [".demo"],
    "jsonKeys": [{ "file": "~/.demo/settings.json", "keys": { "sidebarSort": "created" } }]
  },
  "steps": {
    "afterLaunch": [{ "kind": "keys", "combo": "enter" }],
    "openProject": [
      { "kind": "keys", "combo": "cmd+shift+n" },
      { "kind": "type", "text": "${worktree}" },
      { "kind": "enter" }
    ],
    "configure": {
      "claude": [
        {
          "kind": "run",
          "argv": ["demo", "config", "--model", "${model}", "--effort", "${effort}"],
          "timeoutMs": 30000
        },
        { "kind": "keys", "combo": "cmd+shift+p" }
      ],
      "codex": [
        { "kind": "paste", "text": "configure ${agent} for ${model}" },
        {
          "kind": "expectText",
          "region": { "x": 400, "y": 100, "w": 700, "h": 600 },
          "text": "configured",
          "timeoutMs": 5000
        }
      ]
    },
    "quit": []
  },
  "timed": {
    "launch": [{ "kind": "open", "bundleId": "dev.demo.app" }],
    "newThread": [{ "kind": "keys", "combo": "cmd+n" }],
    "send": [{ "kind": "enter" }],
    "longThread": [{ "kind": "keys", "combo": "cmd+1" }],
    "shortThread": [{ "kind": "keys", "combo": "cmd+2" }]
  },
  "waitDone": { "cwd": "worktree", "idleFallback": false },
  "processes": {
    "vendorDirs": ["~/.demo"],
    "launchAgentLabels": ["dev.demo.ShipIt"],
    "teamId": null,
    "agentExecutables": ["claude", "codex"]
  },
  "orchestrationTrigger": null,
  "notes": ["Calibrated on Demo 1.4.2 at 1600x1000 points."]
}
```

## Fields

| Field | Meaning |
|---|---|
| `schema` | Always `1`. |
| `ade` | Adapter id; must equal the file name and the adapter's `id`. |
| `app.path` | Absolute path of the bundle that was calibrated. |
| `app.version`, `app.bundleSha256` | What `installCheck()` returned. The gate compares them with the installed app. |
| `app.processNames` | Executable names that identify the app's own processes, for `waitForPid`. |
| `window` | Window size in points; every rect and point must fit inside it. |
| `calibration.appName`, `.bundleId` | `open -a` fallback and `open -b`; the app a reset quits. |
| `calibration.composerRect` | The composer OCR region A4, A8 and A10 use by default. Required, not null. |
| `calibration.activeComposerRect` | The composer of a thread with messages, when it differs from `composerRect`. |
| `calibration.launchComposerRect` | The composer the app shows on open, when that is a different one. |
| `calibration.clearKeys` | Keys that empty the composer; omitted means `cmd+a`, `delete`. |
| `calibration.threadRect` | The message column used for OCR. Required, not null. |
| `calibration.newThreadComposerRect` | A3, optional: the composer of the new thread, when the new-thread action opens it where the old thread has no composer (a modal). Needs `activeComposerRect`, and must not overlap it. Set only after a check on recorded frames. |
| `calibration.focusClick` | Point to click when the app does not focus the composer itself; null when it does. |
| `calibration.masks` | Rects the "visually settled" check ignores (caret, spinners, clocks). |
| `calibration.drive` | `cli`, `api`, `cdp`, `ax`, `keys` or `manual`, from `ADES.md`. |
| `calibration.dataDirs` | Folders `reset()` moves aside. Never deleted. |
| `calibration.launchAgents` | Launch-agent labels `reset()` boots out. |
| `login.kind` | `app` when the ADE has its own sign-in, `agent-cli` when it runs the account's `claude`/`codex`. |
| `login.files` | Login files (paths under `~`) that a reset keeps: copied to a temp folder, then put back. Required and non-empty for `"app"`. |
| `login.signIn` | One line the doctor shows the owner when a sign-in is missing; non-empty for `"app"`, null for `"agent-cli"`. |
| `reset.seeds` | Paths under `~/ademark-private/seeds/<ade>/home` restored after the data folders move aside. A seed target must not be exactly a folder that `login.files` recreates, or `restoreSeed` refuses a target that already exists. |
| `reset.jsonKeys` | Settings files and top-level keys to write while the app is closed. This is the only place a profile writes a settings file; the app is open when `steps.configure` runs. |
| `steps.afterLaunch` | Dismiss what's-new dialogs and similar, after the window resize. |
| `steps.openProject` | Make `${worktree}` the open project. |
| `steps.configure.<agent>` | Model, effort, permissions and mode for one agent. Required for every agent in the adapter's `agents`. |
| `steps.quit` | Quit through the UI. Empty means AppleScript `quit app`, then the 10 s wait. |
| `timed` | The triggers the echo timer executes: `launch`, `newThread`, `send`, and A11's `longThread`/`shortThread`. Never empty for the first three. |
| `waitDone.cwd` | `worktree` when the agent runs in the project folder, `any` when the log can be anywhere under home. |
| `waitDone.idleFallback` | Use the TESTS.md 1.7 idle rule when the agent writes no session log. |
| `processes` | Attribution hints: vendor folders, launch-agent labels, Team ID, agent executables. |
| `orchestrationTrigger` | The C1 trigger line, or null when `ADES.md` says "not supported" for the ADE's orchestration. An ADE that has orchestration with no proven trigger line has `{ "notCalibrated": "<what is missing>" }`: its C1 rows are invalid, never "not supported". A test checks null against `ADES.md` both ways. |
| `steps.returnToThread` | C6, optional: after the restart and `launch()`, select the thread the restart interrupted. An empty list says the app reopens it by itself. Missing means C6 is not calibrated and its rows are invalid before the task starts. |
| `steps.beforeRelaunchQuit` | Optional: steps run before the quit that A2 (relaunch) does. `steps.beforeColdQuit` is the same for a cold start. Empty or missing means none. |
| `orchestration` | Track C, optional: `settings` (a list of `{ file, path, value }`: a `.json` file under `~/`, the key path and the value that switch orchestration on) and `workers` (`"sessions"` when its workers are sessions of their own). |
| `excludeTests` | Optional object of test ID (or `<test>:<part>`, for example `A5:agents`) to the reason the test cannot be measured on this ADE. |
| `agentGuide` | Optional plain words for the screen agent that rehearses the app: where a new conversation starts, what is easy to confuse. |
| `notes` | Everything the calibration found that the fields cannot hold. |

## Step kinds

| Kind | Fields | Runs |
|---|---|---|
| `keys` | `combo` | `press` (the combo syntax the native helper takes, for example `cmd+shift+n`). |
| `type` | `text` | `typeText`. |
| `enter` | none | `press` with `enter`. |
| `click` | `point` | `ademark-native click --pid --at`. |
| `wait` | `ms` | `pause`; the UI needs it between steps. |
| `open` | `bundleId` or `appPath`, optional `args` | `openBundle` or `open` with arguments. |
| `paste` | `text` | Clipboard plus `cmd+v`. |
| `expectText` | `region`, `text` or `texts` (a list), `timeoutMs` (1-120000) | OCR via `waitForText`; the first text read ends the wait; fails at the timeout. |
| `clickIfText` | `region`, `texts`, `point`, `timeoutMs` (1-10000), optional `confirmGone` | Clicks `point` only if one of `texts` shows in `region` within the timeout; otherwise logs it and does nothing. For a banner or card that shows on some launches only. With `confirmGone`, it reads the region again 1 s after the click and logs whether a text is still there, with no second click and no failure. A failed OCR call still fails the step. Not a timed trigger. |
| `run` | `argv`, `timeoutMs` (1-600000) | The ADE's CLI or `open <url>`. No shell; `sudo`, `su`, `sh`, `bash`, `zsh`, `env` and `osascript` are rejected. Killed at the timeout. |
| `goal` | `goal` (text), optional `maxActions` (1-20), optional `allowKeys` (only `["cmd+a"]`) | The screen agent looks at the app window and acts until the goal is reached. Throws `goal not reached` if it is not. See the note below on what it sends. |

The screen agent is not local. Every profile launch sends a screenshot of the app window to `codex exec` (OpenAI) to clear dialogs
and banners. `ADEMARK_AGENT=off` disables that check, but `goal` steps still send screenshots.

`setJsonKeys` is not a step kind: the validator rejects it and says to use `reset.jsonKeys`, because settings files are
written only while the app is closed. A failing step throws `step <list>[<index>] (<kind>): <reason>`, so the night log
names the exact step.

## Gate records

A calibration gate run writes `bench/adapters/gates/<ade>.json` (`CalibrationGate`). `readGate(id)` validates the
shape, `gateStatus(gate, install)` returns `missing` (app not installed), `failed` (`passed < runs`), `stale`
(version or SHA-256 differs from the installed app) or `ok`. The night measures an ADE only on `ok`.

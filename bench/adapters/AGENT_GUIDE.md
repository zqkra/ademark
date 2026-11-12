# Adding an ADE to ADEMark

One ADE is one file: `bench/adapters/<adapter-id>.ts`. It implements the `Adapter` interface from
`bench/core/contracts.ts`, with the facts from `ADES.md` §3. This guide is for a human plus an AI coding agent.

**The rule that decides every question here: an adapter drives the ADE and never measures.** Every timing number
comes from `ademark-native echo`, every RAM and CPU number from the sampler, every token count from the capture.
An adapter that computes a number for a result row is a bug.

## 1. Before you write code

1. Read `ADES.md` §1 (rules for every ADE), then the family procedure for your ADE (§2.2-2.6), then its own section.
2. Read `bench/core/contracts.ts` for `Adapter`, `Calibration`, `InstallInfo`, `ProcessHints`, `Trigger`.
3. Read `TESTS.md` §1.7 (what each method must do) and §1.3 (how the echo timer executes `timed` triggers).

## 2. Scaffold

A new ADE is a profile adapter (section 4.1): copy the closest `bench/adapters/<adapter-id>.ts` and
`bench/adapters/profiles/<adapter-id>.json`, as GUIDE.md section 5 says. Then register it: add it to
`bench/adapters/registry.ts`, raise the hard-coded count in `bench/test/adapters.test.ts`, and add a section to `ADES.md`.

```sh
bun bench/cli.ts adapter new <adapter-id>
```

Use this only when the profile format cannot express the ADE. It writes a code-adapter template,
`bench/adapters/<adapter-id>.ts` from `_template.ts`, and a brief in `bench/adapters/<adapter-id>.AGENT_BRIEF.md`. It
refuses to overwrite an existing file. Delete both files if you abandon the attempt.

## 3. The interface, member by member

| Member | What it holds |
|---|---|
| `id` | Adapter ID from ADES.md; equals the file name and the `ade` field of every result row |
| `name` | Product name as ADES.md prints it |
| `family` | `control`, `EL-SDK`, `EL-PTY`, `NATIVE`, `OWN` or `FIRST` (METHODOLOGY.md §2) |
| `agents` | `claude`, `codex` or `own` |
| `calibration.appName`, `.bundleId` | For `open -a` / `open -b` and for quit |
| `calibration.composerRect`, `.threadRect` | OCR regions in window points, relative to the window's top-left |
| `calibration.focusClick` | The point to click when the ADE does not focus its composer itself |
| `calibration.masks` | Rectangles the "visually settled" check ignores (caret, spinners, clocks) |
| `calibration.drive` | `cli`, `api`, `cdp`, `ax` or `keys`: how setup drives the ADE |
| `calibration.dataDirs`, `.launchAgents` | What `reset()` moves aside and which launch agents it boots out |
| `timed.launch`, `.newThread`, `.send` | `Trigger[]` arrays the echo timer executes; the only source of timing |
| `installCheck()` | Bundle version and main-binary SHA-256; `installed: false` when the app is missing |
| `reset()` | Quit, kill attributed processes, boot out agents, move data folders aside, restore the snapshot |
| `configure()` | Model, effort, full access in the worktree, prompt rewriting off, telemetry off, local mode |
| `launch()` | Open the app, set the window to 1600 × 1000 points, return the pid |
| `newThread()` | Open a new thread in the arena project |
| `send(text)` | Put the prompt in the composer and press Enter |
| `waitDone()` | Return when the agent finished (TESTS.md §4 end rule) |
| `quit()` | Quit like a user does |
| `processes()` | `ProcessHints`: bundle paths, vendor dirs, launch-agent labels, Team ID, agent executables |

## 4. Finding the unknowns in the pilot

`ADES.md` marks missing facts as "unknown, find in pilot". Never guess; fill them in the pilot and record what you
found in `ADES.md` in the same change.

- **New-thread shortcut.** Hover the app's own menu bar and read its menus with Accessibility
  (`AXUIElementCopyAttributeValue` on the menu bar), or open the command palette. Record the key combination as a
  `{ kind: "keys", combo: "cmd+n" }` trigger.
- **Composer region.** Take one screenshot of the window at 1600 × 1000 and measure the text area in points. Prefer
  the region that contains only the composer, so thread text cannot produce an OCR false positive.
- **Focus click.** Type one character into the composer by hand. If the app does not take it, the composer was not
  focused; click its center once and record that point.
- **Masks.** Record the window for 10 s at rest with no input. Any rectangle that keeps changing (caret, spinner,
  clock) goes into `masks`; otherwise "visually settled" never settles.
- **Launch agents.** `launchctl list | grep <vendor>` and `ls ~/Library/LaunchAgents` show what survives a quit.
- **Data folders.** `lsof -a -p <pid> -d cwd` plus the vendor's documentation. Move, never delete.

## 4.1 New ADEs are calibrated as profiles

An agent calibrates an ADE in about 45 minutes, and what it learns goes into `bench/adapters/profiles/<adapter-id>.json`,
not into the adapter file. The adapter file keeps only the facts `ADES.md` already states and becomes one call:

```ts
import { profileAdapter } from "./profile.ts";

export const demo = profileAdapter({
  id: "demo",
  name: "Demo",
  family: "EL-SDK",
  agents: ["claude", "codex"],
  appName: "Demo",
  bundleId: "dev.demo.app",
  drive: "keys",
  dataDirs: ["~/.demo"],
  launchAgents: [],
  vendorDirs: ["~/.demo"],
});
```

`bench/adapters/profile.ts` loads the profile on first use. Without a file the adapter behaves like an uncalibrated
stub (`not calibrated: <method>`, no `login`); with a valid file, `calibration`, `timed`, `login`, reset, configure,
launch, newThread, send, waitDone, quit and `processes()` come from the profile. The complete format, field by field,
is `bench/adapters/profiles/README.md`.

```sh
bun bench/cli.ts calibrate probe --ade <adapter-id>   # bundle id, version, stack, fuses, app.asar shortcuts, data folders
bun bench/cli.ts profile check <adapter-id|all>       # ok, missing, or every error with its JSON path
bun bench/cli.ts adapter check <adapter-id>           # conformance; also validates the profile when the file exists
```

The probe only reads the bundle. It never launches, opens, quits or attaches to the app.

**Steps never use Accessibility.** A profile's steps replay keys, clicks, the ADE's CLI and URLs. Reading the AX tree
switches Electron and WKWebView apps into a heavier mode, and the steps run in the same process that is measured;
calibration may use `ademark-native ax-tree` while it looks for controls, but the recorded profile must not. Any
`ax-*` command in a step is a calibration mistake, not a shortcut.

## 5. Check loop

```sh
bun bench/cli.ts adapter check <adapter-id>     # conformance only, launches nothing
cd bench && bun test                  # the harness test suite
```

`adapter check` prints every calibration field as filled or missing, runs `installCheck()` and exits 1 only when a
required member is missing or wrong. Missing calibration values are warnings: an unfilled field means "the pilot has
not measured it yet", which is honest; a guessed value is not.

## 6. Rules that are easy to break

1. Timed actions are synthetic OS input only (`CGEventPost`), timestamped by the echo timer. CDP, HTTP, CLI and
   Accessibility calls are setup only.
2. `--remote-debugging-port` changes the launch. Never use it for a launch that a timing test measures.
3. Do not add `t3.json`, `.cursor/rules` or any other repo file to the arena for an ADE.
4. Do not change an ADE's setting to make B4 pass; record it instead.
5. Report `drive: "manual"` rows when the adapter cannot drive the ADE and the owner drives by hand.
6. Never write a number into `ResultRow` from an adapter.
7. A dry run executes nothing. Every side effect becomes one `plan: <action> <args>` log line (section 7).
8. Never guess a "find in pilot" value. Log it as `MISSING` in dry run and throw `not calibrated` in real mode.

## 7. Dry run, missing values and the two shared modules

Two rules decide how every method behaves before the pilot has measured anything.

**Dry run (`ctx.dryRun === true`).** The method executes nothing. Every side effect becomes one
`ctx.log("plan: <action> <args>")` line and the method then resolves as if it had run: `launch` returns `{pid: 0}`,
`waitDone` returns `{done: true, reason: "dry run"}`. Unknown pids and empty lists print as `-`. `--dry-run` must show
what a real run would do without touching the machine.

**Missing value.** ADES.md marks a fact we do not have with "find in pilot". Never guess and never leave a silent
default: in dry run log `plan: MISSING <field> (<ADES.md wording>)` and continue; in real mode throw
`not calibrated: <field>`. Put the missing-value checks before the first side effect, so a real run never half-applies
a configuration. A `timed` getter has no `ctx`: it returns an empty array while its shortcut or command is unknown,
and the method that needs the value applies the rule.

Both rules live in `bench/adapters/support.ts`: `planMessage`, `missingValue`, `cleanSnapshotDir`, `withoutAncestors`.

### 7.1 `bench/adapters/macos.ts`

Every side effect goes through this module: `setenv`, `unsetenv`, `openBundle`, `quitApp`, `waitGone`, `killPids`,
`bootout`, `moveAside`, `paste`, `press`, `typeText`, `resizeWindow`, `pidsFor`, `procsFor`, `waitForPid`. Each one
logs its plan line in dry run and, in real mode, refuses to run unless `os.userInfo().username === "ademark"`.
Adapters call `isRealRun(ctx)` first so a real run of the wrong user fails before the first command. Tests replace the
whole system side with `setMacosRunner()` (`bench/test/adapters-fake.ts`). `paste` is the ADES.md 1.1 send path:
`pbcopy`, then synthetic `Cmd+V`; the run core posts the Enter trigger, so `send()` never presses Enter twice.

`setenv` only reaches an app that starts after it. A CLI typed into an already running terminal keeps that
terminal's environment, so bare-cli puts the block's variables in the typed command instead
(`envAssignments` in `bare-cli.ts`), built in `launch()` because the run loop fills `ctx.env` after `configure`.

### 7.2 `bench/adapters/session-log.ts`

`waitDone` takes its signal from the agent's own session log: `parseClaudeLog` (Claude Code JSONL, sidechains skipped,
end of turn = the last main-chain line is `end_turn`) and `parseCodexLog` (Codex rollout JSONL, end of turn =
`task_complete` after the last `task_started`). `findSessionLogs` matches a worktree by `cwd` after `realpath` on both
sides, and `waitForEndOfTurn` adds the idle fallback of TESTS.md 1.7 (60 s without a file change, 10 s without agent
CPU). Fixtures for every case are in `bench/test/fixtures/session-logs/`.

### 7.3 An example method

```ts
async waitDone(ctx: AdapterContext, timeoutMs: number): Promise<{ done: boolean; reason: string }> {
  isRealRun(ctx);                       // dry run: false; real mode: only the ademark user gets past this
  if (ctx.dryRun) {                     // nothing executes; the plan is one line
    ctx.log(planMessage("waitForEndOfTurn", [`agent=${state.agent}`, `cwd=${ctx.worktree}`, `timeoutMs=${timeoutMs}`]));
    return { done: true, reason: "dry run" };
  }
  return waitForEndOfTurn({             // the same call the pilot will make
    ctx,
    agent: state.agent,
    cwd: ctx.worktree,
    since: state.since || Date.now(),
    timeoutMs,
    pollMs: 2000,
  });
}
```

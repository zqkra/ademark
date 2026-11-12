# ADEMark ADE playbook

Version: v1.0, 2026-10-19 (first results published 2026-11-12). Field, families and test IDs come from [METHODOLOGY.md](METHODOLOGY.md).
Procedures for each test are in [TESTS.md](TESTS.md). Run order and gates are in [RUNBOOK.md](RUNBOOK.md).

This file says, for each ADE, how to install it, reset it, configure it, drive it and attribute its processes.
Facts come from the field research and the review of 2026-10-19.

Conventions:

- "(verify at freeze)" marks a version read from a release page. Re-read it from the installed bundle on the freeze date.
- "unknown, find in pilot" marks a fact we do not have. Never fill it with a guess. Record what the pilot finds here.
- "Pin" lists the settings every run must use. Factory values go to Track F before they are changed.

## 1. Rules for every ADE

1. **Timed actions are always synthetic OS input.** A1-A4, A8 and A11 start from a `CGEventPost` keystroke or click,
   timestamped in the same recording. CLI, HTTP, CDP and Accessibility calls are used only for untimed setup.
2. **CDP is for setup only.** `--remote-debugging-port` changes the launch. Every launch used for A1, A2, A5, A6, A7 and A9
   is a plain launch with no debug flag.
3. **Window.** 1600 × 1000 points, set with the Accessibility attribute `AXSize` on the main window during setup.
   Before timed runs, check that the size persisted. If an ADE does not persist it, record that and set it before each
   untimed phase only.
4. **Environment.** GUI apps do not read the shell. Set variables with `launchctl setenv NAME value` before `open -a`,
   and `launchctl unsetenv` after the ADE's block. Variables used:
   - `ANTHROPIC_BASE_URL` to point Claude Code at the replay server (Track A).
   - `NODE_EXTRA_CA_CERTS` so Node processes trust the capture CA (Track B). Claude Code honors it.
   - `CODEX_CA_CERTIFICATE` or `SSL_CERT_FILE` for Codex (from a third-party write-up, verify in pilot).
   - The ADE's telemetry flag, where one exists.
5. **System CLIs.** Every ADE that accepts a path runs the system Claude Code 2.1.303 and Codex 0.163.0.
   The Claude Agent SDK runs its own bundled CLI unless it gets a path (`pathToClaudeCodeExecutable` in the SDK,
   `claudeExecutablePath` in Conductor). Whatever happens, record the version and entry point from the
   User-Agent of each captured request.
6. **Repo instructions are not fixed for them.** The Agent SDK loads no `AGENTS.md` or `CLAUDE.md` unless
   `settingSources` includes `project`. B4 measures whether the agent sees the repo's rules. Do not change an ADE's
   setting to make B4 pass.
7. **Global agent config.** Before each ADE, restore the clean snapshot of `~/.claude`, `~/.codex` and `~/.agents`.
   If the vendor documents an integration step (hooks, skills), apply it after the restore. After the block, diff the
   three folders against the snapshot, publish the diff in Track F, then restore again.
8. **Fresh app data.** Move the ADE's data folders aside (never delete), start it once, add the arena project, seed the
   same state, then begin the block. Restore the folders after the run day.
9. **Process attribution.** Count a process for the ADE if it runs from the app bundle or the vendor's folder, if the
   ADE is its responsible process (`sudo launchctl procinfo <pid>`), if it is in the ADE's resource coalition
   (`sudo taskinfo --coalitions`), or if it appeared after launch and belongs to the vendor. Agent CLI processes
   (`claude`, `codex`) are counted in a separate group. Publish the process list per ADE.
10. **Background jobs outside the field** stop for the whole run: Tern's `so.stencil.tern.daemon`, the owner's other
    apps and background sync jobs. Every ADE's own launch agent is booted out while another ADE is measured.
11. **Local only.** Every ADE runs its agents on the bench Mac. No cloud threads, cloud sandboxes, remote hosts,
    SSH hosts or synced devices. Each ADE section has a "Local only" row with the setting that keeps it local and the
    check that proves no remote or cloud thread was created. The check runs after every B and C test.
12. **Logins survive resets.** If an ADE keeps its login inside the data folder, keep the login file and move the rest
    aside. Which file holds the login: find in pilot per ADE.

## 1.1 Adapter interface

Each ADE maps to one file, `bench/adapters/<adapter-id>.ts` ([METHODOLOGY.md](METHODOLOGY.md) section 8).
Every adapter implements the same nine methods. The defaults below apply unless an ADE section says otherwise.

| Method | Default behavior |
|---|---|
| `installCheck` | Read `CFBundleShortVersionString` and the SHA-256 of the main binary. Fail if they differ from the frozen values |
| `reset` | Quit the app, kill every attributed process, boot out its launch agents, move its data folders to `~/ademark-aside/<adapter-id>/<timestamp>/`, restore the clean agent-config snapshot, run the local-only check |
| `configure` | Record the factory values for Track F, then apply the pins. Prefer the vendor CLI or config file, then CDP (Electron families, setup only), then Accessibility |
| `launch` | `launchctl setenv` the block's variables, then `open -b <bundle id>` (or `open -a <App>`). No debug flags in A runs |
| `newThread` | A synthetic keystroke for the ADE's new-thread shortcut, or a synthetic click on the control found with Accessibility. This is the timed action of A3 |
| `send` | Put the prompt on the clipboard, then synthetic `Cmd+V` and `Return`. Every ADE gets the prompt the same way. Setup-only prompts may use the vendor CLI or API |
| `waitDone` | The first available signal: the ADE's own event or API, the end of turn in the agent session log (`~/.claude/projects/*/*.jsonl` or `~/.codex/sessions/`, matched by `cwd`), or agent processes idle and no file change in the worktree for 60 s. The task time cap always applies |
| `quit` | `Cmd+Q` to the app (or AppleScript `quit`), wait up to 10 s, then list the attributed processes still alive (A9) |
| `processes` | Rule 9 above, with the ADE's known extra processes from its section |

## 2. Family procedures

### 2.1 Control: Bare CLI

- Ghostty 1.4.0 with `command = /bin/zsh -f`, so no shell startup file runs and no prompt theme adds time.
- Ghostty is already open when terminal timing starts. Ghostty's own launch is measured as a separate segment.
- Claude Code uses `ANTHROPIC_BASE_URL` for the replay server. Codex uses a provider `base_url` in its config.
- Session logs: `~/.claude/projects/*/*.jsonl` (usage, `effort`, `cwd`, `version`) and
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`token_count`, `rate_limits.primary.used_percent`).
- Processes: `ghostty` and the `claude` or `codex` subtrees. Ghostty is counted in every Bare CLI number,
  so Overhead against the control cancels it.

### 2.2 EL-SDK: Electron app that drives the agent through an SDK or a JSON protocol

Members: T3 Code, bb, Paseo, Synara, Traycer, Cloudroom.

- Processes: the Electron main process, `Helper (Renderer)`, `Helper (GPU)` and other helpers inside the bundle,
  plus a local Node server or daemon. Some daemons detach or run under launchd, so the process tree alone is not enough.
- Claude runs through the Claude Agent SDK, which starts a `claude` process. Codex runs through `codex app-server`.
- Setup driving: the vendor CLI or local API first, then CDP (`--remote-debugging-port` and Playwright
  `connectOverCDP`), then Accessibility.
- Electron marks a fully covered window `hidden` and throttles it. That is why A6 has a covered-window variant.
- Chromium trusts the macOS Keychain. The Node parts need `NODE_EXTRA_CA_CERTS`.
- Common traps: appended system prompt text, injected MCP servers, side calls with a second model, and daemons that
  outlive the window.

### 2.3 EL-PTY: Electron app that runs the agent's own terminal UI in a pseudo-terminal

Members: Superset, Orca, Emdash.

- Processes: the Electron set above, a pty host or pty daemon, and the real `claude` or `codex` TUI processes.
- The TUI is the same program as the Bare CLI, so it reads `~/.claude` and `~/.codex`. A clean snapshot matters most here.
- These ADEs pass launch flags to the CLI (for example `--dangerously-skip-permissions`). Record the exact command line
  of every agent process from `ps`.
- Status comes from hooks that the ADE writes into global agent config. Apply the documented integration after the restore
  and publish the diff.
- The CLI usually starts when the thread opens, so these ADEs pay in A3 and not in A4. Ready to Answer (A1 + A3 + A4)
  is the fair comparison.
- Each also has a chat UI built on ACP or the Agent SDK. The main row uses the factory default interface, recorded in Track F.

### 2.4 NATIVE: non-Electron apps

Members: Zeron, Diri and super.engineering (Rust, GPUI), MonoCode and Conductor (Tauri, Rust).

- GPUI and Metal apps render with Metal. Most GPU and IOSurface memory is charged to the app. Use `footprint --unmapped`
  and record the WindowServer delta between app open and app quit.
- Tauri apps use WKWebView. Its WebContent, Networking and GPU processes are started by launchd, not by the app.
  Attribute them by responsible process and coalition, never by parent PID.
- No CDP. Setup uses the vendor CLI or socket first, then Accessibility. If an app exposes too little to Accessibility,
  fall back to screenshot-located clicks for setup, and record it.
- Several keep daemons or holder processes alive after quit. Ghost Weight reports "no sessions open" and
  "sessions kept alive" separately.

### 2.5 OWN: Capy

- Capy runs its own agent, not Claude Code or Codex. Its results include that harness and are labeled "own harness".
- It runs in local mode only: every thread on "This Mac", in a worktree. Capy's cloud VMs are not used (rule 11).
- Its requests may go to Capy's backend, so B1-B3 are reported only for what capture or Capy's own usage report shows.
- Cost is split into model tokens (the shared price list) and the platform fee. They are never merged into one ranking.

### 2.6 FIRST: the model vendors' own apps

Members: Claude desktop (Code tab), Codex app (inside the ChatGPT desktop app).

- Each runs only its own vendor's models, so each fills one model column. The other column shows "not supported".
- Both are not installed on the bench Mac. Stack, version, data folders and processes are pilot items.
- Claude desktop reads the same settings files as the Claude Code CLI. The clean snapshot of `~/.claude` applies.
- Both have cloud surfaces (Claude desktop cloud sessions, Codex cloud tasks). Only local sessions are used.

## 3. ADEs

### 3.0 Bare CLI (control)

| Field | Value |
|---|---|
| Adapter ID | `bare-cli` (`bench/adapters/bare-cli.ts`) |
| Components | Claude Code 2.1.303, Codex 0.163.0, Ghostty 1.4.0 (`com.mitchellh.ghostty`) |
| On bench Mac | yes |
| Data to move aside | none; the clean snapshot of `~/.claude`, `~/.codex`, `~/.agents` is the state |
| Processes | `ghostty`, `claude` or `codex` subtrees |
| Adds to context | nothing; this is the reference |
| Pin | model and effort per METHODOLOGY section 4; full access (Claude bypass permissions, Codex full access); auto-update off |
| New thread (A3) | new Ghostty tab, then start `claude` or `codex`. Ghostty's new-tab shortcut: verify in pilot |
| Orchestration (C1) | Claude: Claude Code's built-in subagents. Codex: not supported |
| Drive | keystrokes into Ghostty; logs for harvest |
| Traps | shell startup files (disabled with `zsh -f`); counting Ghostty launch inside Thread Open |

Adapter `bare-cli`:

| Method | How |
|---|---|
| `installCheck` | `claude --version` = 2.1.303, `codex --version` = 0.163.0, Ghostty bundle version 1.4.0 |
| `reset` | restart Ghostty (quit it and open it again from LaunchServices) unless the harness runs in one of its tabs, then close every Ghostty tab except the first; restore the agent-config snapshot. Pilot 2026-10-20: a Ghostty open since the morning was 513 MB at block start and A5 counted it, while every other ADE starts its block as a new process |
| `configure` | Claude: `--model` and full access (`--dangerously-skip-permissions`); effort setting: find in pilot. Codex: model and effort settings (find in pilot) and `--dangerously-bypass-approvals-and-sandbox` |
| `launch` | Ghostty is already open. A1 and A2 time the CLI start in a new tab. Ghostty's own launch is a separate segment |
| `newThread` | new-tab keystroke, then type the CLI command and `Return` |
| `send` | default |
| `waitDone` | end of turn in the session log |
| `quit` | close every CLI tab (Cmd+1, then close the other tabs), as quitting an app ends all its threads; Ghostty stays open. Pilot 2026-10-20: closing only the current tab left earlier tabs running and failed the A2 CPU gate |
| `processes` | `ghostty` plus the CLI subtree |

### 3.1 T3 Code

| Field | Value |
|---|---|
| Adapter ID | `t3code` (`bench/adapters/t3code.ts`) |
| Maker, URL, license | pingdotgg, https://t3.codes, github.com/pingdotgg/t3code, MIT |
| Version | 0.1.0 stable, 2026-10-15 (verify at freeze). Nightlies daily: use stable only |
| On bench Mac | yes, 0.1.0 (`T3 Code (Beta).app`), Electron 44.4.5 |
| Bundle id | `com.t3tools.t3code` |
| Family | EL-SDK |
| Data to move aside | `~/.t3/userdata` (`state.sqlite`) |
| Processes | Electron set; the `t3` server (a child of the app on this Mac; `t3 service install` would keep it alive after quit) |
| Claude runs via | Claude Agent SDK running the installed `claude` (2.1.280 or later) |
| Codex runs via | `codex app-server` (0.159 or later). T3 can manage its own Codex install: point it at the system binary |
| Adds to context | appends `<runtime_info>` and PR-linking rules to the Claude Code preset prompt, orchestration instructions, and a `t3-code` MCP server (threads, PRs, browser preview, devices). Codex gets developer instructions |
| Writes global config | none known |
| Pin | model Opus 5.5 (factory Claude default is `claude-fable-5-1`, Codex default `gpt-6-astra`); effort high (factory default unverified); Full access (factory default); `T3CODE_TELEMETRY_ENABLED=false` |
| Side calls (B1) | titles, branch names, commit messages and PR descriptions by `gpt-6-luna` at low effort, also in Claude threads |
| New thread (A3) | unknown, find in pilot. Threads run in the local checkout unless a worktree is chosen or the repo's `t3.json` says so. Do not add `t3.json` to the arena; choose worktree mode in the app and record it |
| Orchestration (C1) | Orchestrator V2: `delegate_task` and the T3 Code MCP orchestrator. Exact trigger: find in pilot |
| Drive (setup) | `t3` CLI, local WebSocket server and web UI, CDP, `t3code://` scheme. `app.t3.codes/new?prompt=` only opens a draft |
| Traps | telemetry sends model, effort, durations and token totals to `ingest.t3.codes` (off for the run); side calls to OpenAI in Claude threads; Synara is a fork |
| Verify in pilot | new-thread shortcut; how to set effort; whether the server survives quit; whether side calls can be turned off |
| Local only | No remote T3 server. The app's own local server only. Check: the thread's host is this Mac (field: find in pilot) |

Adapter `t3code`:

| Method | How |
|---|---|
| `installCheck` | bundle `com.t3tools.t3code`, version 0.1.0 |
| `reset` | default; data `~/.t3/userdata`; make sure the `t3` server is gone |
| `configure` | `T3CODE_TELEMETRY_ENABLED=false` through `launchctl setenv`; model, effort, Full access and worktree mode: settings surface unknown, find in pilot |
| `launch` | `open -b com.t3tools.t3code` |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default; setup threads through the `t3` CLI or WebSocket server (commands: find in pilot) |
| `waitDone` | the Claude or Codex session log, matched by the worktree `cwd` |
| `quit` | default; then check whether the `t3` server survived |
| `processes` | Electron set plus the `t3` server |

### 3.2 bb

| Field | Value |
|---|---|
| Adapter ID | `bb` (`bench/adapters/bb.ts`) |
| Maker, URL, license | get-bb (main contributors Michael Yong, Sawyer Hood; company unverified), https://getbb.app, github.com/get-bb/bb, MIT |
| Version | desktop-v0.46.1, 2026-10-15 (verify at freeze) |
| On bench Mac | yes, 0.46.1, Electron 44.3.0 |
| Bundle id | `dev.bb.desktop`; updater job `dev.bb.desktop.ShipIt` |
| Family | EL-SDK |
| Data to move aside | `~/.bb/` (SQLite, logs, thread storage, plugins, `~/.bb/AGENTS.md`; worktrees in `~/.bb/plugins/environment-git-worktree/host-data/worktrees/`) |
| Processes | Electron set, local server, host daemons; web app on `localhost:38886` |
| Claude runs via | Claude Agent SDK |
| Codex runs via | `codex app-server` |
| Adds to context | appends `~/.bb/AGENTS.md`, `<workspace>/.bb/AGENTS.md` and a skills index to every thread's system prompt; injects a bb bridge MCP server. A setting can hide Claude's Task tool |
| Writes global config | none known outside `~/.bb` |
| Pin | permission mode `full` (factory default for new threads is `auto` with `medium` effort; `full` is only the ceiling); effort high; `BB_TELEMETRY=false`; freeze the plugin set; ShipIt updates off |
| Side calls (B1) | thread titles by a model call; skipped on short prompts such as "hi" |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | manager threads that own child threads; workflows. Exact trigger: find in pilot |
| Drive (setup) | `bb` CLI, unauthenticated loopback HTTP and WebSocket API on `127.0.0.1:38886`, CDP. MCP plugin off by default. No URL scheme |
| Traps | lineage: Cloudroom bundles `bb-app`; plugins change behavior; title side call differs between "hi" and B3 |
| Verify in pilot | new-thread shortcut; C1 trigger; where effort is set; whether the Task-tool setting is factory on or off |
| Local only | Environment `git worktree` on this Mac. No remote host and no Modal sandbox plugin. Check: the worktree exists under `~/.bb/plugins/environment-git-worktree/host-data/worktrees/` |

Adapter `bb`:

| Method | How |
|---|---|
| `installCheck` | bundle `dev.bb.desktop`, version 0.46.1 |
| `reset` | default; data `~/.bb/` (includes `~/.bb/AGENTS.md`); stop `dev.bb.desktop.ShipIt` |
| `configure` | `BB_TELEMETRY=false`; thread permission `full`, effort high and model through the `bb` CLI or HTTP API if exposed, else CDP (find in pilot); freeze plugins |
| `launch` | `open -b dev.bb.desktop` |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default; setup threads through the `bb` CLI or `127.0.0.1:38886` |
| `waitDone` | bb API event if one exists (find in pilot), else the session log |
| `quit` | default; check the host daemons |
| `processes` | Electron set, local server, host daemons |

### 3.3 Paseo

| Field | Value |
|---|---|
| Adapter ID | `paseo` (`bench/adapters/paseo.ts`) |
| Maker, URL, license | Mohamed Boudra (solo, sponsor-funded), https://paseo.sh, github.com/getpaseo/paseo, Apache-2.0 (LICENSE file) |
| Version | 0.11.4 stable, 2026-10-15 (verify at freeze). 0.12.0 is beta: do not use |
| On bench Mac | yes, 0.12.0, Electron 44.2.0 |
| Family | EL-SDK |
| Data to move aside | `~/.paseo` (`config.json`, `daemon.log`, worktrees in `~/.paseo/worktrees`) |
| Processes | Electron set and the local daemon (WebSocket `ws://127.0.0.1:6767`). The daemon stops on quit by default (`keepRunningAfterQuit: false`) |
| Claude runs via | Claude Agent SDK over the official `claude` CLI |
| Codex runs via | `codex app-server` |
| Adds to context | nothing by default. Paseo tools are not injected (`daemon.mcp.injectIntoAgents: false`) |
| Writes global config | none known |
| Pin | Claude mode `bypass` (factory default `auto`, a classifier); Codex full access (factory default `auto-review`); effort high. No telemetry |
| Side calls (B1) | none documented |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | agents launch agents through Paseo tools or the CLI; skills `/paseo-handoff`, `/paseo-committee`. Whether C1 needs `injectIntoAgents: true`: find in pilot, and if it does, record it as the vendor's recommended config |
| Drive (setup) | `paseo` CLI (`run`, `send`, `wait`, `logs`, `--json`, `--output-schema`), TypeScript SDK, WebSocket API, MCP server, `paseo://` scheme, CDP |
| Traps | closest to the Bare CLI; any config needed for orchestration adds context and must be published |
| Verify in pilot | new-thread shortcut; C1 trigger and required settings |
| Local only | Local daemon only. The hosted Hub is not used. Check: `paseo` lists the agent on the local daemon (`ws://127.0.0.1:6767`) |

Adapter `paseo`:

| Method | How |
|---|---|
| `installCheck` | version 0.11.4; bundle id unknown, read at install |
| `reset` | default; data `~/.paseo` |
| `configure` | `~/.paseo/config.json` and agent settings: Claude `bypass`, Codex full access, model, effort (keys: find in pilot); keep `daemon.mcp.injectIntoAgents: false` unless C1 needs it, and record it |
| `launch` | `open -a` with the app name read at install (not installed yet) |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default; setup through `paseo run` and `paseo send` |
| `waitDone` | `paseo wait` |
| `quit` | default; the daemon should stop (`keepRunningAfterQuit: false`) |
| `processes` | Electron set plus the daemon |

### 3.4 Synara

| Field | Value |
|---|---|
| Adapter ID | `synara` (`bench/adapters/synara.ts`) |
| Maker, URL, license | Emanuele Di Pietro, https://trysynara.com, github.com/Emanuele-web04/synara, MIT (LICENSE names T3 Tools Inc.: a fork of T3 Code) |
| Version | 1.0.7 stable, 2026-10-17 (verify at freeze). Remote prereleases exist: do not use |
| On bench Mac | yes, 1.0.7, Electron 43.4.1 |
| Family | EL-SDK |
| Data to move aside | `~/.synara/` (`userdata/state.sqlite`, `logs/provider/events.log`, worktrees in `~/.synara/worktrees`); `SYNARA_HOME` overrides it |
| Processes | Electron set and a Node server |
| Claude runs via | Claude Agent SDK 0.3.296 driving the installed `claude` |
| Codex runs via | `codex app-server` |
| Adds to context | appends "You are running inside Synara…" and the versioned "Synara harness policy" (version `2026-10-14.1`) to every provider; four `worker-*` subagents; a gateway MCP with `synara_*`, `browser_*` and `device_*` tools |
| Writes global config | none known |
| Pin | model Opus 5.5 (factory defaults `claude-sonnet-5`, `gpt-6-astra`); effort high; runtime `full-access` (factory default); plan mode off (factory default). Record the harness policy version |
| Side calls (B1) | git text generation by `gpt-6-luna` at high effort; titles |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | native subagents and `synara_create_threads`. Exact trigger: find in pilot |
| Drive (setup) | headless server HTTP and WebSocket, External MCP, CDP (likely, verify). No URL scheme |
| Traps | T3 Code lineage; heaviest injected prompt in the field; Stable and Beta differ |
| Verify in pilot | CDP works; new-thread shortcut; whether git text calls fire during C1 |
| Local only | No remote server (remote prereleases are not used). Check: the worktree exists under `~/.synara/worktrees` |

Adapter `synara`:

| Method | How |
|---|---|
| `installCheck` | version 1.0.7; record the harness policy version (`2026-10-14.1`) |
| `reset` | default; data `~/.synara/` |
| `configure` | runtime `full-access` (factory), plan mode off (factory), model and effort explicit (settings surface: find in pilot) |
| `launch` | `open -a` with the app name read at install (not installed yet) |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default; setup through the headless server API (endpoints: find in pilot) |
| `waitDone` | `logs/provider/events.log` or the session log |
| `quit` | default |
| `processes` | Electron set plus the Node server |

### 3.5 Traycer

| Field | Value |
|---|---|
| Adapter ID | `traycer` (`bench/adapters/traycer.ts`) |
| Maker, URL, license | Traycer, https://traycer.ai, github.com/traycerai/traycer (clients and protocol only), MIT |
| Version | Desktop, Host and CLI 1.5.1, 2026-10-10 (verify at freeze). The IDE extension retires 2026-10-31: test Desktop |
| On bench Mac | yes, Desktop 1.5.1, Electron 42.11.12 |
| Family | EL-SDK (Electron app plus a background Host service) |
| Data to move aside | `~/.traycer/` (chats, credentials, `host/host.log`, `worktrees/`, `epics/<task-id>`) |
| Processes | Electron set and the Host service, which keeps running after you quit the app. Kill it before cold starts |
| Claude runs via | chat interface: the bundled claude-agent-sdk binary; terminal interface: the official CLI in a PTY |
| Codex runs via | `codex app-server` (inferred from code, verify) |
| Adds to context | Traycer system prompt, task context, artifact instructions, skills and agent-to-agent tools, for terminal agents too. Traycer can manage MCP servers per provider |
| Writes global config | per-provider MCP management: diff after the block |
| Pin | Full access (factory default); Auto mode off (its judge spends Traycer credits); model and effort explicit (factory defaults unverified); use the factory default interface and record it |
| Side calls (B1) | unknown, find in pilot |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | child agents with agent-to-agent messages; artifact skills start one child agent per ticket |
| Drive (setup) | `traycer` CLI (`agent create`, `send`, `transcript`, `monitor`, `worktree create`, `terminal output`), CDP (likely). `traycer://` is for sign-in only |
| Traps | the Host counts in Weight and Ghost Weight; Plan, Phases, Verification and YOLO belong to the retired extension; the author praised Traycer publicly |
| Verify in pilot | factory interface (chat or terminal); Codex path; side calls; new-thread shortcut |
| Local only | No remote hosts. Check: the worktree exists under `~/.traycer/worktrees/` and `host/host.log` shows the local Host only |

Adapter `traycer`:

| Method | How |
|---|---|
| `installCheck` | Desktop, Host and CLI 1.5.1 |
| `reset` | default; data `~/.traycer/` except the credentials; kill the Host |
| `configure` | Full access (factory), Auto mode off, model and effort explicit, factory interface recorded |
| `launch` | `open -a` with the app name read at install (not installed yet) |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default; setup through `traycer agent create` and `traycer agent send` |
| `waitDone` | `traycer agent monitor` or `traycer agent transcript` |
| `quit` | default; the Host keeps running (counted in A9), kill it before A1 |
| `processes` | Electron set plus the Host service |

### 3.6 Cloudroom

| Field | Value |
|---|---|
| Adapter ID | `cloudroom` (`bench/adapters/cloudroom.ts`) |
| Maker, URL, license | David Ondrej, https://www.cloudroom.dev, github.com/davidondrej/cloudroom-gui and cloudroom-core, Apache-2.0 |
| Version | desktop v109 and core `core-v0.1.64`, 2026-10-18 (verify at freeze). Eight versions in six days: pin hard |
| On bench Mac | yes, v104, Electron 44.3.0. The v110 installer is in `pins/` and replaces v104 in the `ademark` account |
| Family | EL-SDK |
| Data to move aside | `~/.cloudroom/skills`; thread database path unknown, find in pilot |
| Processes | Electron set and a LaunchAgent seen on this Mac: `~/Library/LaunchAgents/dev.cloudroom.preview.061684e561f5ba22.plist` (KeepAlive, RunAtLoad, under PID 1, restarts within 5 s). Attribute it to Cloudroom. Boot it out (`launchctl bootout gui/$(id -u)/dev.cloudroom.preview.061684e561f5ba22`) while other ADEs run |
| Claude runs via | Claude Agent SDK (from code). A public listing says only Codex and Pi adapters exist: verify |
| Codex runs via | `codex app-server` |
| Adds to context | one Cloudroom system prompt for every local and cloud agent (since v75), a tool-proxy MCP, memory and custom-instructions plugins |
| Writes global config | unknown, diff after the block |
| Pin | model and effort explicit; subagent model set to the same Claude model if the setting exists (lead agents can spawn OpenRouter models) |
| Side calls (B1) | unknown, find in pilot |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | lead agents spawn subagents |
| Drive (setup) | `room-cli`, `cloudroom://` scheme, CDP, webhooks |
| Traps | lineage: the GUI derives from bb and bundles `bb-app` 0.43.1; the KeepAlive agent pollutes other ADEs' measurements unless booted out; cloud queue delays |
| Verify in pilot | Claude path exists; permission defaults; subagent model setting; thread database path |
| Local only | Local threads only: never a cloud sandbox and never Teleport. Check: the thread shows as local, capture has no traffic to a cloud sandbox, and the free-tier cloud-agent counter did not move |

Adapter `cloudroom`:

| Method | How |
|---|---|
| `installCheck` | desktop v109, core `core-v0.1.64` |
| `reset` | default; data `~/.cloudroom/` (thread database path: find in pilot); boot out `dev.cloudroom.preview.061684e561f5ba22` |
| `configure` | model and effort explicit; subagent model set to the same Claude model if the setting exists |
| `launch` | bootstrap its LaunchAgent back for its own block (factory behavior), then `open -a Cloudroom` |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default; setup through `room-cli` (commands: find in pilot) |
| `waitDone` | the session log |
| `quit` | default; the LaunchAgent process stays alive (counted in A9) |
| `processes` | Electron set plus the LaunchAgent process |

### 3.7 Superset

| Field | Value |
|---|---|
| Adapter ID | `superset` (`bench/adapters/superset.ts`) |
| Maker, URL, license | Superset (San Francisco), https://superset.sh, github.com/superset-sh/superset, Elastic License 2.0 (source-available) |
| Version | desktop-v1.38.0, 2026-10-14 (verify at freeze). Canary builds exist: do not use. A rename is announced for this month: publish name and version |
| On bench Mac | yes, 1.39.0, Electron 41.10.7 |
| Family | EL-PTY |
| Data to move aside | `~/.superset/` (`worktrees`, `sessions`, `bin`); app database path unknown, find in pilot |
| Processes | Electron set and a persistent pty-daemon (terminals survive restarts) |
| Claude runs via | official CLI in node-pty, launched with `--dangerously-skip-permissions`. "Superset Chat" uses ACP adapters and the Agent SDK instead |
| Codex runs via | official CLI in node-pty, launched with `--dangerously-bypass-approvals-and-sandbox` |
| Adds to context | your prompt passes unchanged unless you link an issue or PR. Its skills in `~/.claude/skills` enter Claude Code's skill list, which B2 shows |
| Writes global config | on every launch: 12 skills to `~/.claude/skills/superset` and `~/.agents/skills`, commands to `~/.agents/commands/`, hooks and wrappers into agent configs. Diff and restore after its block |
| Pin | model and effort explicit (factory: the agent's own defaults); permissions already bypassed; telemetry: PostHog ships, opt-out unknown, find in pilot; factory interface (terminal or chat) recorded |
| Side calls (B1) | a small model names branches |
| New thread (A3) | ⌘N creates a worktree and branch under `~/.superset/worktrees` |
| Orchestration (C1) | the `superset:orchestrate` skill: a Claude Code or Codex coordinator drives the Superset CLI |
| Drive (setup) | `superset` CLI (create, wait, read agents), `superset://` deep links, hosted MCP server, OpenAPI spec, TypeScript SDK, CDP (unverified) |
| Traps | its global writes leak into every later ADE and the control (F1); remote access and automations need Pro (not used) |
| Verify in pilot | telemetry opt-out; factory interface; CDP |
| Local only | Local worktrees only (⌘N). No remote hosts and no cloud workspaces. Check: the worktree exists under `~/.superset/worktrees` |

Adapter `superset`:

| Method | How |
|---|---|
| `installCheck` | desktop-v1.38.0; record the product name on the freeze date |
| `reset` | default; data `~/.superset/`; kill the pty-daemon; the snapshot restore removes its global skills and hooks |
| `configure` | model and effort per agent; telemetry opt-out (find in pilot); factory interface recorded |
| `launch` | `open -a` with the app name read at install (not installed yet) |
| `newThread` | `⌘N` |
| `send` | default, into the agent terminal |
| `waitDone` | `superset` CLI wait command, else the session log |
| `quit` | default; the pty-daemon may survive (counted in A9) |
| `processes` | Electron set, pty-daemon, CLI processes |

### 3.8 Orca

| Field | Value |
|---|---|
| Adapter ID | `orca` (`bench/adapters/orca.ts`) |
| Maker, URL, license | Stably AI (YC), https://www.onorca.dev, github.com/stablyai/orca, MIT |
| Version | 1.4.229, 2026-10-17 (verify at freeze). Ships almost daily: pin hard |
| On bench Mac | yes, 1.4.230, Electron 43.7.8 |
| Family | EL-PTY |
| Data to move aside | Electron userData folder (path unknown, find in pilot) |
| Processes | Electron set and PTY agent processes |
| Claude runs via | official CLI in a PTY with `--dangerously-skip-permissions`. An experimental chat UI uses the Agent SDK |
| Codex runs via | official CLI in a PTY with `--dangerously-bypass-approvals-and-sandbox` |
| Adds to context | status hooks. Default agent setup "usually installs" orca-cli, computer-use and orchestration skill stubs (whether it is automatic is unverified). No system prompt injection found |
| Writes global config | hooks and possibly skill stubs: diff after the block |
| Pin | model and effort explicit (factory: CLI defaults); telemetry off (opt-out documented at onorca.dev/docs/telemetry); account hot-swap off |
| Side calls (B1) | unknown, find in pilot |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | experimental and off by default (runs, tasks, workers). Enable it per vendor docs and label the row "experimental" |
| Drive (setup) | `orca` CLI (worktree, terminal wait and send, browser), `orca://` scheme, CDP (unverified) |
| Traps | daily releases; account hot-swap hides rate limits; chat and terminal paths behave differently |
| Verify in pilot | data folder; telemetry setting name; how to enable orchestration |
| Local only | No SSH worktrees, no `orca serve` host and no cloud VMs. Check: the worktree path is on this Mac |

Adapter `orca`:

| Method | How |
|---|---|
| `installCheck` | version 1.4.229 |
| `reset` | default; userData folder (path: find in pilot) |
| `configure` | telemetry off, account hot-swap off, model and effort explicit. Experimental orchestration is enabled before Track C only, and recorded |
| `launch` | `open -a` with the app name read at install (not installed yet) |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default; setup through the `orca` CLI (terminal send) |
| `waitDone` | `orca` terminal wait, else the session log |
| `quit` | default |
| `processes` | Electron set plus PTY agent processes |

### 3.9 Emdash

| Field | Value |
|---|---|
| Adapter ID | `emdash` (`bench/adapters/emdash.ts`) |
| Maker, URL, license | General Action (YC W26), https://emdash.com, github.com/generalaction/emdash, Apache-2.0 |
| Version | 1.2.8, 2026-10-10 (verify at freeze) |
| On bench Mac | yes, 1.2.8, Electron 40.10.2 |
| Family | EL-PTY |
| Data to move aside | local SQLite (path unknown, find in pilot); worktrees in `~/emdash/worktrees` |
| Processes | Electron set and node-pty agent processes |
| Claude runs via | TUI mode (factory default): official CLI in node-pty. Chat UI mode uses ACP (`claude-agent-acp`) |
| Codex runs via | TUI mode: official CLI in node-pty. Chat UI mode uses `codex-acp` |
| Adds to context | nothing by default |
| Writes global config | lifecycle hooks. MCP servers and skills only when the user opts in |
| Pin | `autoApprove` on (factory default off; chat UI mode never auto-approves, so use TUI mode); model and effort explicit; telemetry off (opt-out) |
| Side calls (B1) | unknown, find in pilot |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | not supported |
| Drive (setup) | no CLI, deep link or API found: CDP for setup, Accessibility and keystrokes otherwise |
| Traps | approval prompts block unattended runs; the author publicly said agents "miss messages and the chat locks" here, so C2 and C3 must run byte-identical for every ADE |
| Verify in pilot | data folder; how to enable `autoApprove` |
| Local only | No SSH. Check: the worktree exists under `~/emdash/worktrees` |

Adapter `emdash`:

| Method | How |
|---|---|
| `installCheck` | version 1.2.8 |
| `reset` | default; SQLite folder (path: find in pilot) and `~/emdash/worktrees` |
| `configure` | TUI mode, `autoApprove` on, telemetry off, model and effort explicit; through CDP during setup |
| `launch` | `open -a` with the app name read at install (not installed yet) |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default |
| `waitDone` | the session log of the CLI running in the PTY |
| `quit` | default |
| `processes` | Electron set plus node-pty agent processes |

### 3.10 Zeron

| Field | Value |
|---|---|
| Adapter ID | `zeron` (`bench/adapters/zeron.ts`) |
| Maker, URL, license | 1499487 B.C. LTD, https://zeron.sh, github.com/zeronsh/zeron, MIT. Formerly "Comet" |
| Version | 0.2.114, 2026-10-18 (verify at freeze). Ships every 1 to 3 days. Test upstream, never the author's fork; publish the binary SHA-256 |
| On bench Mac | yes, 0.2.114 (upstream) |
| Family | NATIVE (Rust, GPUI; it used to be Electron) |
| Data to move aside | `~/.zeron/profiles/local/` (`ZERON_DATA_DIR` overrides it); worktrees in `~/.zeron/worktrees` |
| Processes | on macOS the app runs its engine in-process unless a daemon is already running. The always-on daemon is the Linux headless install |
| Claude runs via | `claude -p` subprocess with stream-json on stdio (no PTY, no SDK) |
| Codex runs via | `codex app-server` over JSON-RPC |
| Adds to context | injects its `zeron mcp` server into every run. Title-generation runs use `--system-prompt` |
| Writes global config | none known |
| Pin | Claude `bypassPermissions` and Codex approval `never` with `danger-full-access` are factory and cannot be turned off; model and effort explicit; account swapping off |
| Side calls (B1) | title-generation runs |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | agents orchestrate through its MCP (`create_chats`, one level deep) |
| Drive (setup) | `zeron` CLI, `zeron mcp`, WebSocket RPC on `127.0.0.1:27654`, `zeron://` scheme. No CDP |
| Traps | the author uses a fork; fast release cadence; token-usage display was removed, so B1 relies on capture |
| Verify in pilot | Accessibility coverage of the GPUI window; new-thread shortcut |
| Local only | This device only: no synced machine. Check: the chat's device is this Mac |

Adapter `zeron`:

| Method | How |
|---|---|
| `installCheck` | version 0.2.114 and the binary SHA-256 of the upstream build |
| `reset` | point `ZERON_DATA_DIR` at a fresh folder through `launchctl setenv` (documented override); move `~/.zeron/worktrees` aside |
| `configure` | model and effort explicit; account swapping off. Permissions are already full access |
| `launch` | `open -a` with the app name read at install (not installed yet) |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default; setup through the `zeron` CLI or the WebSocket RPC on `127.0.0.1:27654` |
| `waitDone` | RPC events if available (find in pilot), else the session log |
| `quit` | default |
| `processes` | the app (engine in-process) plus `claude` and `codex` children |

### 3.11 Diri

| Field | Value |
|---|---|
| Adapter ID | `diri` (`bench/adapters/diri.ts`) |
| Maker, URL, license | Cristian Crețu, https://diri.sh, github.com/cristicretu/diri, AGPL-3.0-only from 0.10.0 (Apache-2.0 before). The engine and CLI are called "Dirijor" |
| Version | 0.10.0 stable, 2026-10-18 (verify at freeze). A nightly channel exists: do not use |
| On bench Mac | yes, 0.10.0 (`diri.app`) |
| Family | NATIVE (Rust, GPUI; macOS 15+) |
| Data to move aside | `~/Library/Application Support/Dirijor/` (`state.json`, `logs/dirijord.log`) |
| Processes | the app, the engine daemon `dirijord-rs`, one holder process per session (sessions survive quitting the app) and a launchd wake helper that needs admin approval |
| Claude runs via | the official TUI in a PTY, defined by a JSON manifest. Working or idle status comes from Claude hooks |
| Codex runs via | the official TUI in a PTY. Status is read from the screen for most agents |
| Adds to context | for Claude, Codex and Cursor only: the `dirijor` MCP (with `computer` and `browser` tools), Claude hook settings and a skills plugin |
| Writes global config | Claude hook settings: diff after the block |
| Pin | full access through the agent's own flags or config (factory: CLI defaults, which ask for permission); model and effort explicit; telemetry off (on by default, opt-out) |
| Side calls (B1) | unknown, find in pilot |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | the `dirijor` MCP lets agents spawn and merge other agents |
| Drive (setup) | `dirijor new`, `send`, `capture`, `run --wait`, `events --json`, `mcp-call`, a Unix socket. No CDP, no URL scheme |
| Traps | "done" is read from the screen; held sessions count in Ghost Weight (report both variants) |
| Verify in pilot | how to pass full-access flags through the manifest; Accessibility coverage |
| Local only | No SSH hosts. Check: `dirijor` lists the session on the local engine |

Adapter `diri`:

| Method | How |
|---|---|
| `installCheck` | version 0.10.0, stable channel |
| `reset` | default; data `~/Library/Application Support/Dirijor/`; kill `dirijord-rs` and the holders; boot out the wake helper (label: find in pilot) |
| `configure` | full access through the agent manifest (find in pilot), model and effort explicit, telemetry off |
| `launch` | `open -a` with the app name read at install (not installed yet) |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default; setup through `dirijor new` and `dirijor send` |
| `waitDone` | `dirijor run --wait` or `dirijor events --json` |
| `quit` | default; holders keep sessions alive (A9 reports both variants) |
| `processes` | the app, `dirijord-rs`, holders, the wake helper |

### 3.12 MonoCode

| Field | Value |
|---|---|
| Adapter ID | `monocode` (`bench/adapters/monocode.ts`) |
| Maker, URL, license | Nick (hardbeat920), https://usemono.dev, github.com/hardbeat920/monocode, MIT |
| Version | 0.15.0, 2026-10-18 (verify at freeze) |
| On bench Mac | yes, 0.16.0 |
| Family | NATIVE (Tauri 2 plus a Node host process) |
| Data to move aside | `monocode.db` in Tauri's app data folder (path unknown, find in pilot) |
| Processes | the Tauri app, WebKit WebContent, Networking and GPU processes started by launchd, and the Node host |
| Claude runs via | `claude` stream-json subprocess |
| Codex runs via | `codex app-server` |
| Adds to context | nothing by default. `/operator` turns add instructions. Orchestration workers get a `<monocode_assignment>` block |
| Writes global config | none known |
| Pin | runtime full access (factory `supervised`, Claude `--permission-mode default`); model Opus 5.5 (factory defaults `sonnet-5` and Cursor `composer-2.5`); effort high; orchestration `maxWorkers` 4 to match the C1 cap (factory 2); account failover off |
| Side calls (B1) | titles and branch names |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | `/orchestrator`: a lead with workers |
| Drive (setup) | `MonoCode control` CLI (orchestration lead only), Accessibility and keystrokes. No CDP |
| Traps | 0.15.0 turned on a gradual text reveal by default, which delays the first visible word (A4 measures what the user sees and says so); it lowers agent process priority under memory pressure; account failover hides usage limits |
| Verify in pilot | data folder; how to set `maxWorkers`; whether text reveal can be seen in Track F as a factory default |
| Local only | No remote host over SSH. Check: the session's host is local (field: find in pilot) |

Adapter `monocode`:

| Method | How |
|---|---|
| `installCheck` | version 0.15.0 |
| `reset` | default; Tauri app data folder with `monocode.db` (path: find in pilot); kill the Node host |
| `configure` | runtime full access, model, effort, `maxWorkers` 4, account failover off (through Accessibility) |
| `launch` | `open -a` with the app name read at install (not installed yet) |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default; `/orchestrator` for C1 |
| `waitDone` | the session log, else the idle rule |
| `quit` | default |
| `processes` | the app, WebKit processes by responsible PID, the Node host |

### 3.13 super.engineering

| Field | Value |
|---|---|
| Adapter ID | `super-engineering` (`bench/adapters/super-engineering.ts`) |
| Maker, URL, license | Super Dot Engineering LLC, https://super.engineering, closed source, proprietary. The app is still `Superconductor.app`, bundle id `engineering.super.app` |
| Version | nightly builds only, no version number. Bench build: DMG `15aae8f8`, 2026-10-16. Archive the DMG and publish the app binary SHA-256 and build date |
| On bench Mac | yes, nightly `15aae8f8` (`Superconductor.app`) |
| Family | NATIVE (Rust, GPUI; macOS 14+) |
| Data to move aside | `~/.super.engineering` (older profiles are symlinked) |
| Processes | unknown, find in pilot |
| Claude runs via | terminal mode runs the CLI. The chat UI uses non-interactive `claude -p` unless the beta "Compliant Claude view" is on. The vendor warns that `-p` may not bill against a subscription |
| Codex runs via | CLI |
| Adds to context | the chat UI adds "app-provided instructions" next to your message. With orchestration on, a "tool-use contract" goes into every new session |
| Writes global config | none known |
| Pin | Enhance prompt **off** (factory on, unless you opted out before); model pinned (factory: CLI default); permissions full access (factory: provider default); telemetry off (opt-out); factory interface recorded |
| Side calls (B1) | prompt enhancement (off for the run), worktree naming and Git actions |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | experimental (a lead plus roles). Enable per vendor docs and label "experimental" |
| Drive (setup) | `sc` CLI over a local socket; Accessibility for the UI. No CDP |
| Traps | claims "<0.5s cold start, 160MB idle": A1 and A5 test the claim directly; closed source, so B2 publishes sizes only; `claude -p` billing can change plan usage |
| Verify in pilot | process list; factory interface; how to turn off Enhance prompt and telemetry |
| Local only | No SSH. Check: the worktree path is on this Mac |

Adapter `super-engineering`:

| Method | How |
|---|---|
| `installCheck` | DMG `15aae8f8` and the app binary SHA-256 |
| `reset` | default; data `~/.super.engineering` |
| `configure` | Enhance prompt off, telemetry off, model and permissions pinned, through Accessibility or `sc` (find in pilot) |
| `launch` | `open -a` with the app name (find in pilot) |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default; setup through `sc` |
| `waitDone` | `sc history` or the session log |
| `quit` | default |
| `processes` | unknown, find in pilot |

### 3.14 Conductor

| Field | Value |
|---|---|
| Adapter ID | `conductor` (`bench/adapters/conductor.ts`) |
| Maker, URL, license | Melty Labs (Charlie Holtz and Jackson de Campos, from secondary sources), https://conductor.build, closed source |
| Version | 0.91.0, 2026-10-15 (verify at freeze) |
| On bench Mac | yes, 0.91.2 |
| Family | NATIVE (Tauri, Rust; the 0.91.2 binary links Tauri). Mac only |
| Data to move aside | `~/Library/Application Support/com.conductor.app` and `~/conductor` (workspaces in `~/conductor/workspaces/<repo>/<name>`) |
| Processes | unknown, find in pilot |
| Claude runs via | Agent SDK with a bundled Claude Code 2.1.300. Point it at the system binary with `claudeExecutablePath` |
| Codex runs via | a bundled Codex 0.162.1 through a "Codex SDK" (app-server unverified). How to point it at the system binary: unknown, find in pilot |
| Adds to context | undisclosed system prompt. The agent is told to rename the branch on its first chat, and the repo's `prompts.general` text is added |
| Writes global config | none known |
| Pin | model Opus 5.5 (factory default for new users); effort explicit; tool approvals off (`tool_approvals_enabled` is opt-in, but docs say some actions ask: verify); plan mode off (`models.default_plan_mode` is opt-in) |
| Side calls (B1) | branch rename |
| New thread (A3) | a workspace is a new worktree plus a setup script. Time "new worktree" and "same workspace" separately, and compare like with like |
| Orchestration (C1) | not supported (the Conductor MCP is opt-in) |
| Drive (setup) | `conductor://prompt=…&path=…&branch=` deep links open the composer and still need a click on Create. The API, CLI and MCP cover cloud workspaces only. Locally: deep links plus Accessibility |
| Traps | bundled harness versions differ from the system CLIs; closed source, so B2 publishes sizes only |
| Verify in pilot | stack; process list; Codex binary path; approval prompts |
| Local only | Local workspaces only. Conductor Cloud (Pro) is not used. Check: the workspace exists under `~/conductor/workspaces/` |

Adapter `conductor`:

| Method | How |
|---|---|
| `installCheck` | version 0.91.0 |
| `reset` | default; data `~/Library/Application Support/com.conductor.app` and `~/conductor` |
| `configure` | `claudeExecutablePath` to the system `claude`; Codex binary path: find in pilot; model Opus 5.5, plan mode off, approvals off |
| `launch` | `open -a` with the app name read at install (not installed yet) |
| `newThread` | new workspace (shortcut or control: find in pilot). Time new-worktree and same-workspace threads separately |
| `send` | default; setup through the `conductor://` deep link plus a click on Create |
| `waitDone` | the session log |
| `quit` | default |
| `processes` | unknown, find in pilot |

### 3.15 Capy

| Field | Value |
|---|---|
| Adapter ID | `capy` (`bench/adapters/capy.ts`) |
| Maker, URL, license | Scrapybara Inc. (YC), https://capy.ai, closed source |
| Version | 0.4.7, 2026-10-16 (verify at freeze) |
| On bench Mac | yes, 0.4.7, Electron 44.3.0 |
| Bundle id | `ai.capy.desktop` |
| Family | OWN (own harness, local mode) |
| Data to move aside | `~/.capy/worktrees` (local threads). Messages live in Capy's cloud |
| Processes | Electron set; local agent processes for "This Mac" threads (unknown, find in pilot) |
| Claude and Codex | Capy runs its own model-agnostic agent. About 60 models; factory default Claude Opus 5.5. A Claude subscription cannot be connected: Opus needs an Anthropic API key or Capy credits. ChatGPT/Codex, Copilot and SuperGrok subscriptions can be connected |
| Adds to context | its own undisclosed default prompt, `AGENTS.md` or `CLAUDE.md`, `.capy/rules`, `.cursor/rules`, skills, plugin MCP servers |
| Writes global config | none known |
| Pin | model Opus 5.5 through an Anthropic API key; effort explicit if Capy exposes it (unverified). A Capy plan is required to use your own key (Lite, $20) |
| Side calls (B1) | unknown; capture may not see Capy's backend calls |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | subagents; "Captains" (experimental orchestrator). Label "experimental" |
| Drive (setup) | HTTP API (threads, messages, streams, captains); a CLI is mentioned in the changelog (unverified); CDP |
| Traps | own harness, so its tokens and code are not a wrapper effect; billed at API prices, not a subscription; thread history lives on Capy's servers and cannot be reset |
| Verify in pilot | local agent process list; whether capture sees model requests; effort setting |
| Local only | Every thread on "This Mac". Check: the thread's machine is "This Mac" (API field: find in pilot) and no VM time appears on the usage page |
| Checked 2026-10-24 (0.5.0, owner's account with a Claude Max subscription connected) | The model menu then offers only "Claude Code" models (Claude Code on the Agent SDK), not Capy's own harness. A "This Mac" thread in a folder project answered, but no agent process ran on the Mac and no session log was written: the agent runs on Capy's servers and only the files sync to the Mac (`~/.capy/drive`, `~/.capy/git-shadow`). The replay server cannot answer, so Track A replay tests cannot run, and the run is not local |

Adapter `capy`:

| Method | How |
|---|---|
| `installCheck` | bundle `ai.capy.desktop`, version 0.4.7 |
| `reset` | default; `~/.capy/worktrees`. Thread history on Capy's servers cannot be reset: use a fresh Capy project (find in pilot) |
| `configure` | "This Mac" machine, model Opus 5.5 with an Anthropic API key, effort if exposed |
| `launch` | `open -b ai.capy.desktop` |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default; setup through the HTTP API |
| `waitDone` | thread status or stream from the HTTP API |
| `quit` | default |
| `processes` | Electron set plus local agent processes (find in pilot) |

### 3.16 Claude desktop (Code tab)

| Field | Value |
|---|---|
| Adapter ID | `claude-desktop` (`bench/adapters/claude-desktop.ts`) |
| Maker, URL | Anthropic, https://code.claude.com/docs/en/desktop |
| Version | unknown, read from the bundle at freeze |
| On bench Mac | yes, 2.42304.2 (`Claude.app`) |
| Family | FIRST (Electron 44.7.2) |
| Data to move aside | unknown, find in pilot. It reads the same settings files as the Claude Code CLI, so the `~/.claude` snapshot applies. Worktrees go to `<project-root>/.claude/worktrees/` by default |
| Processes | unknown, find in pilot |
| Claude runs via | the Claude Code engine (local sessions run on your machine) |
| Codex runs via | not supported |
| Adds to context | unknown; B2 shows it |
| Pin | Local environment (not Cloud, not SSH) with the worktree option; model Opus 5.5 from the dropdown; effort from the effort menu (`Cmd` `Shift` `E`); permission mode Bypass permissions (on Pro and Max it must be enabled in Settings first). Extended thinking is on by default |
| Side calls (B1) | unknown, find in pilot |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | subagents and background work in the tasks pane; Claude can list other Code tab sessions, read them and send messages between them. Exact trigger: find in pilot |
| Drive (setup) | Accessibility (no CLI or deep link documented) |
| Traps | it shares settings with the CLI, so a dirty `~/.claude` changes both; a paid plan (Pro or Max) is required |
| Verify in pilot | stack, processes, data folder, new-session shortcut, how to send a prompt without the mouse |
| Local only | Environment Local. Check: no new session appears under Cloud in the app or at claude.ai/code |

Adapter `claude-desktop`:

| Method | How |
|---|---|
| `installCheck` | bundle id and version: read at install |
| `reset` | data folder: find in pilot; the `~/.claude` snapshot covers its settings |
| `configure` | Local environment, worktree option, model from the dropdown, effort menu `Cmd` `Shift` `E`, Bypass permissions enabled in Settings |
| `launch` | `open -a` with the app name read at install (not installed yet) |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default |
| `waitDone` | the session log if it writes to `~/.claude/projects` (find in pilot), else the idle rule |
| `quit` | default |
| `processes` | unknown, find in pilot |

### 3.17 Codex app (inside the ChatGPT desktop app)

| Field | Value |
|---|---|
| Adapter ID | `codex-app` (`bench/adapters/codex-app.ts`) |
| Maker, URL | OpenAI, https://learn.chatgpt.com/docs/app. The Codex app now ships inside the ChatGPT desktop app |
| Version | unknown, read from the bundle at freeze |
| On bench Mac | yes, ChatGPT 26.1007.30912 |
| Family | FIRST (Electron with renamed parts: `Codex Framework`, Chromium 155, `app.asar`) |
| Data to move aside | unknown, find in pilot |
| Processes | unknown, find in pilot |
| Claude runs via | not supported |
| Codex runs via | the Codex agent (relation to app-server unknown, find in pilot) |
| Adds to context | unknown; B2 shows it |
| Pin | local project; the pinned OpenAI model and effort; full access (setting name unknown) |
| Side calls (B1) | unknown, find in pilot |
| New thread (A3) | unknown, find in pilot |
| Orchestration (C1) | the February 2026 launch coverage reported worktrees, skills, automations and multi-agent workflows. Verify on the current app |
| Drive (setup) | Accessibility (no automation surface documented besides scheduled tasks) |
| Traps | the product moved into ChatGPT desktop: publish its current name and version; runs only OpenAI models |
| Verify in pilot | everything above marked unknown |
| Local only | Local project only. Codex cloud tasks are not used. Check: the cloud task list has no new task |

Adapter `codex-app`:

| Method | How |
|---|---|
| `installCheck` | bundle id and version of the ChatGPT desktop app: read at install |
| `reset` | data folder: find in pilot |
| `configure` | local project, the pinned OpenAI model and effort, full access (setting names: find in pilot) |
| `launch` | `open -a` with the app name read at install (not installed yet) |
| `newThread` | shortcut unknown, find in pilot |
| `send` | default |
| `waitDone` | the session log if it writes to `~/.codex/sessions` (find in pilot), else the idle rule |
| `quit` | default |
| `processes` | unknown, find in pilot |

## 4. Summary

| ADE | Adapter ID | Family | Drive for setup | C1 trigger | Top fairness traps |
|---|---|---|---|---|---|
| Bare CLI | `bare-cli` | control | keystrokes, logs | Claude subagents; Codex none | shell startup files; Ghostty launch inside A3 |
| T3 Code | `t3code` | EL-SDK | `t3` CLI, WebSocket, CDP | Orchestrator V2 (`delegate_task`) | telemetry; side calls to OpenAI in Claude threads |
| bb | `bb` | EL-SDK | `bb` CLI, HTTP API, CDP | manager threads | default `auto` + medium effort; Cloudroom bundles bb |
| Paseo | `paseo` | EL-SDK | `paseo` CLI, WebSocket, CDP | agents launch agents (settings to confirm) | orchestration may need extra injected tools; Claude `auto` classifier default |
| Synara | `synara` | EL-SDK | headless server, CDP | subagents, `synara_create_threads` | T3 Code fork; heaviest injected prompt and side calls |
| Traycer | `traycer` | EL-SDK | `traycer` CLI, CDP | child agents per ticket | Host survives quit; injected prompt for all agents |
| Cloudroom | `cloudroom` | EL-SDK | `room-cli`, CDP | lead + subagents | KeepAlive LaunchAgent; bb lineage and fast version drift |
| Superset | `superset` | EL-PTY | `superset` CLI, CDP | `superset:orchestrate` skill | writes global skills and hooks on every launch; rename this month |
| Orca | `orca` | EL-PTY | `orca` CLI, CDP | experimental orchestration | near-daily releases; account hot-swap |
| Emdash | `emdash` | EL-PTY | CDP, Accessibility | not supported | approvals block unattended runs; author's public claim about its chat |
| Zeron | `zeron` | NATIVE | `zeron` CLI, WebSocket | MCP `create_chats` | author uses a fork; injected MCP and forced auto-approve |
| Diri | `diri` | NATIVE | `dirijor` CLI, socket | `dirijor` spawn and merge | held sessions in Ghost Weight; screen-read status |
| MonoCode | `monocode` | NATIVE | Accessibility, limited CLI | `/orchestrator` | supervised default; text reveal delays First Word |
| super.engineering | `super-engineering` | NATIVE | `sc` CLI, Accessibility | experimental lead + roles | Enhance prompt on by default; no version number |
| Conductor | `conductor` | NATIVE | deep links, Accessibility | not supported | bundled CLI versions; new worktree plus setup script in A3 |
| Capy | `capy` | OWN | HTTP API, CDP | subagents, Captains (experimental) | own harness; no Claude subscription, API billing |
| Claude desktop | `claude-desktop` | FIRST | Accessibility | subagents, session messages | shares `~/.claude` with the CLI; stack unknown |
| Codex app | `codex-app` | FIRST | Accessibility | multi-agent (to verify) | moved into ChatGPT desktop; most facts unknown |

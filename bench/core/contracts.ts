// Shared contracts between ADEMark modules. TESTS.md is the source for every field.
// Modules: core (runner, results, gates), adapters, native helpers, replay, capture, grade.

export type TestId =
  | "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7" | "A8" | "A9" | "A10" | "A11" | "A12"
  | "B1" | "B2" | "B3" | "B4"
  | "C1" | "C2" | "C3" | "C4" | "C5" | "C6"
  | "F";

export type Track = "A" | "B" | "C" | "F";
export type Family = "control" | "EL-SDK" | "EL-PTY" | "NATIVE" | "OWN" | "FIRST";
export type Drive = "cli" | "api" | "cdp" | "ax" | "keys" | "manual";
export type Server = "replay" | "live" | "none";
export type Agent = "claude" | "codex" | "own";

// ---------- Results (TESTS.md §0) ----------

export interface Receipts {
  samples: string | null;
  video: string | null;
  frames: string | null;
  capture: string | null;
  log: string | null;
}

export interface ResultRow {
  run_id: string;
  machine_id: string;
  ade: string;
  ade_version: string;
  ade_build_sha256: string | null;
  family: Family;
  test_id: TestId;
  variant: string;
  rep: number;
  model: string | null;
  effort: string | null;
  server: Server;
  value: number | null;
  unit: string;
  started_at: string;
  duration_ms: number;
  valid: boolean;
  invalid_reason: string | null;
  drive: Drive;
  receipts: Receipts;
  notes: string;
}

export interface Manifest {
  run_id: string;
  machine_id: string;
  verified: boolean;
  hardware: { model: string; chip: string; ram_gb: number };
  macos_build: string;
  display: { width: number; height: number; scale: number; refresh_hz: number };
  harness_commit: string | null;
  cli_versions: Record<string, string>;
  ade_versions: Record<string, { version: string; sha256: string | null }>;
  task_hashes: Record<string, string>;
  price_file_sha256: string | null;
  order_seed: string;
  order: string[];
  started_at: string;
  // "smoke": one repetition per test with short windows (the night's rehearsal and the calibration gate). A smoke run
  // is never published. Missing means "full".
  mode?: "full" | "smoke";
}

// ---------- Geometry ----------

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

// ---------- Triggers: declared by adapters, executed and timed by the echo timer ----------

export type Trigger =
  | { kind: "open"; bundleId?: string; appPath?: string; args?: string[] }
  | { kind: "keys"; combo: string }
  | { kind: "type"; text: string }
  | { kind: "click"; point: Point }
  | { kind: "enter" }
  | { kind: "wait"; ms: number };

// ---------- Adapters (TESTS.md §1.7, ADES.md) ----------

export interface Calibration {
  appName: string;
  bundleId: string | null;
  composerRect: Rect | null;
  // The composer of a thread that already has messages, when the ADE moves it there (pilot 2026-10-20: T3 Code
  // centres the composer of an empty thread and docks it at the bottom once a message exists). A8 and A10 type into
  // such a thread; they use this rect when set and composerRect otherwise.
  activeComposerRect?: Rect | null;
  // The composer the app shows when it opens (A1, A2), when that is not composerRect. Pilot 2026-10-20: Zeron reopens
  // its last session, composer at the bottom; the centred rect read the session's text and gave a false 35 s relaunch.
  launchComposerRect?: Rect | null;
  // A3 (ADEMARK-55): the composer of the new thread when the new-thread action opens it in a place where the old thread
  // has no composer and no transcript (Emdash's Create Task modal, 10 Nov). The old thread stays on screen behind it,
  // so its marker is never gone; the proof is the echo in this region, which a probe sent to the old composer never
  // reaches. Set only after a check on recorded frames, written in the profile's notes.
  newThreadComposerRect?: Rect | null;
  // Keys that empty the composer after the echo timer or the lag probe typed into it; omitted: cmd+a, delete. Pilot
  // 2026-10-20: a terminal CLI needs its own (Claude Code: ctrl+u).
  clearKeys?: string[];
  threadRect: Rect | null;
  focusClick: Point | null;
  // The letters A1 to A3 type, when the default probe ("ademarkqz") has a pair that the app's own text holds (a
  // placeholder with "folders" or "commands"): the native rule would take that text as the echo. Lowercase letters
  // whose pairs no ordinary word has. Missing = the default probe.
  probe?: string;
  masks: Rect[];
  drive: Drive;
  dataDirs: string[];
  launchAgents: string[];
}

// How an ADE signs in (ADES.md 1 rule 12).
// "agent-cli": the app runs the account's own `claude` and `codex` logins; there is nothing to sign in inside the app.
// "app": the app has its own sign-in, kept in `files` (paths with ~). reset() keeps these files, and
// `ademark doctor` shows `signIn` to the owner when one is missing.
export interface LoginSpec {
  kind: "agent-cli" | "app";
  files: string[];
  signIn: string | null;
}

export interface InstallInfo {
  installed: boolean;
  version: string | null;
  path: string | null;
  binarySha256: string | null;
}

export interface ProcessHints {
  bundlePaths: string[];
  vendorDirs: string[];
  launchAgentLabels: string[];
  teamId: string | null;
  agentExecutables: string[];
}

export interface RunOptions {
  model: string | null;
  effort: string | null;
  server: Server;
  agent: Agent;
}

export interface AdapterContext {
  runDir: string;
  arenaPath: string;
  worktree: string;
  home: string;
  env: Record<string, string>;
  dryRun: boolean;
  log(message: string): void;
}

export interface Adapter {
  id: string;
  name: string;
  family: Family;
  agents: Agent[];
  calibration: Calibration;
  // C1: the ADE's orchestration trigger line from ADES.md, sent on its own line before the C1 prompt.
  // null = the ADE has no orchestration (C1 "not supported"); undefined = not calibrated yet.
  orchestrationTrigger?: string | null;
  // C1, before the app is launched in a Track C block: switch on what the vendor ships switched off. It throws when the
  // switch cannot be made, and the block stops there: a run with orchestration off is one agent, not a result.
  prepareOrchestration?(ctx: AdapterContext): Promise<void>;
  // C1: "sessions" when the ADE's orchestration is agents of their own (child threads, chats, terminals): then a run
  // counts only with two client sessions at work. Missing: a subagent inside the lead's session is a worker too.
  orchestrationWorkers?: "sessions";
  // C6: after the app is open again, select the thread the restart interrupted (TESTS.md §1.6 "return to the thread").
  // Missing = not calibrated, and C6 rows are invalid before any model time is spent.
  returnToThread?(ctx: AdapterContext): Promise<void>;
  // ADES.md 3.0: the control's host app (Ghostty) stays open; quit ends its CLIs, A1 kills only the CLIs under it and
  // has no first-launch tier.
  hostStaysOpen?: boolean;
  // The ADE ignores the replay server, so Track A uses the real model and runs only the tests that do not need replay.
  liveModel?: boolean;
  // Missing = not calibrated yet.
  login?: LoginSpec;
  // Tests this ADE cannot be measured on, with the reason, written as "not supported here" rows instead of failing the
  // block: Conductor 0.91.2 draws no chat text, so A4 and A11 can never see an answer (2026-11-07).
  // A key is a test ID, or "<test>:<part>" for part of a test (A5:agents: the agent RAM of A5 alone).
  excludedTests?: Partial<Record<string, string>>;
  timed: {
    launch: Trigger[];
    newThread: Trigger[];
    send: Trigger[];
    // A11: from a short thread, open the long thread; and back to a short thread. Missing = not calibrated.
    longThread?: Trigger[];
    shortThread?: Trigger[];
  };
  installCheck(): Promise<InstallInfo>;
  reset(ctx: AdapterContext): Promise<void>;
  configure(ctx: AdapterContext, options: RunOptions): Promise<void>;
  launch(ctx: AdapterContext): Promise<{ pid: number }>;
  newThread(ctx: AdapterContext): Promise<void>;
  send(ctx: AdapterContext, text: string): Promise<void>;
  waitDone(ctx: AdapterContext, timeoutMs: number): Promise<{ done: boolean; reason: string }>;
  quit(ctx: AdapterContext): Promise<void>;
  // Untimed, before the quit of an A2 relaunch ("relaunch") or an A1 cold start ("cold"): leave a known state for the
  // app to restore. Missing: nothing to do.
  beforeQuit?(ctx: AdapterContext, before: "relaunch" | "cold"): Promise<void>;
  processes(): ProcessHints;
}

// ---------- Native helper CLI (bench/native, one binary: ademark-native) ----------
// Every subcommand prints one JSON object on stdout, or JSON lines for streams.
// Timestamps are clock_gettime_nsec_np(CLOCK_UPTIME_RAW) nanoseconds, the clock bench/core/clock.ts reads in Bun.

export interface NativeNow { t_ns: number }

export interface NativeProc {
  pid: number;
  ppid: number;
  path: string;
  name: string;
  responsible_pid: number | null;
}

export interface SampleRules {
  rootPids: number[];
  bundlePaths: string[];
  vendorDirs: string[];
  agentExecutables: string[];
  excludeNames: string[];
  /** The harness itself: it, its children and its shell chain are never the app. */
  harnessPids?: number[];
}

// `ademark-native sample --rules <file.json> --hz 4 --duration-s <n> --csv <out.csv>`
// Rows are appended to the CSV every tick. `--duration-s 0` runs until SIGINT or SIGTERM, then prints
// NativeSample and exits 0: background sampling for A12 and Track C.
// CSV columns (TESTS.md §1.2):
export const SAMPLE_COLUMNS = [
  "t_ns", "pid", "ppid", "group", "exe", "phys_footprint_b", "lifetime_max_b",
  "cpu_user_ns", "cpu_sys_ns", "wakeups_idle", "wakeups_irq", "energy_nj",
] as const;

// Printed by `sample` at the end: per-tick byte sums over the group, then median or p95 over ticks.
export interface NativeSample {
  ticks: number;
  rows: number;
  pids: number;
  app_median_b: number;
  app_p95_b: number;
  agents_median_b: number;
  total_median_b: number;
  total_p95_b: number;
}

// `ademark-native window --pid <pid> --size 1600x1000 --front`
export interface NativeWindow { window_id: number; frame: Rect }

// `ademark-native echo --pid <pid> --triggers <json> --region <x,y,w,h> [--focus-click x,y]
//   --probe ademarkqz --interval-ms 50 --timeout-s <n> --frames <out.json> [--video <out.mov>] [--masks <json>]
//   [--settle-cap-s <n>] [--absent <text> [--absent-region <x,y,w,h> [--absent-also <text>]]]`
// Visually settled (TESTS.md 1.3): the first frame after which no dirty rect falls outside the masks for 1 s. The
// probe region counts as a mask for this rule, because the composer's caret blinks there. Capture stops at settle or
// at `--settle-cap-s` (default 5) from t0, whichever comes first; `settled_ms` is null when the cap is reached.
export interface NativeEcho {
  t0_ns: number;
  ready_ns: number | null;
  ready_ms: number | null;
  settled_ms: number | null;
  frames: number;
  timed_out: boolean;
  /**
   * With `absent`: the text was read before Ready. Without `absentRegion` in the composer region; with it, the probe
   * echoed in some frame while the marker was still in that region.
   */
  absent_seen?: boolean;
  /** With `absentRegion`: the Ready frame's absent region was read and did not show the marker (A3, ADEMARK-40). */
  absent_checked?: boolean;
}

// `ademark-native watch --pid <pid> (--text <word> | --texts <json array>) --region <x,y,w,h> --triggers <json> --timeout-s <n> --frames <out.json>`
// `seen_text` is the text of the list that matched, first in list order.
export interface NativeWatch { t0_ns: number; seen_ns: number | null; ms: number | null; timed_out: boolean; seen_text?: string | null }

// `ademark-native lag --pid <pid> --region <x,y,w,h> --count 60 --interval-ms 250 --frames <out.json>`
// `probes_ms` lists every probe in order: its latency, or null when it was lost (no echo within 2 s).
export interface NativeLag { samples_ms: number[]; p50: number; p95: number; lost: number; probes_ms?: Array<number | null> }

// `ademark-native ocr --image <png> [--region x,y,w,h]` (offline check of the OCR path)
export interface NativeOcr { lines: string[] }

// `ademark-native scroll --pid <pid> --region <x,y,w,h> --count 20 --hz 60 --lines <n> --frames <out.json>`
// Moves the pointer to the region center, posts `count` scroll-wheel events toward the top at `hz` while the pid
// is frontmost, and captures the window as echo does. A gap is the time between two consecutive frames from t0_ns on
// (TESTS.md A11); `frames` counts every captured frame. Gaps count only between t0_ns and t_end_ns, the time of the
// last posted event plus one event interval: after the scroll, an app that stops drawing is idle, not stuttering.
export interface NativeScroll {
  t0_ns: number;
  t_end_ns: number;
  posted: number;
  frames: number;
  gaps_over_33ms: number;
  max_gap_ms: number;
}

// `ademark-native idle --cpu-cores <c> --quiet-ms <n> --cap-s <n>`: waits until the whole machine's CPU use stays
// under `cpu-cores` (1.0 = one core busy) for `quiet-ms`, measured every 100 ms from host CPU ticks, with the helper's
// own use included. Returns at the cap with `quiet: false`. Replaces fixed sleeps (A1 after purge, A2 after quit).
export interface NativeIdle { waited_ms: number; quiet: boolean; cores_last: number }

// `ademark-native permissions`: whether this binary has the two TCC grants the harness needs. Never prompts.
export interface NativePermissions { accessibility: boolean; screen_recording: boolean }

// `ademark-native cover --pid <pid> --duration-s <n>`: an opaque, static, borderless window owned by the helper,
// placed exactly over the pid's layer-0 window for `duration-s`, then closed (A6 `covered` variant).
// `window_id` and `frame` describe the covered ADE window (CG global coordinates, top-left origin).
export interface NativeCover { window_id: number; frame: Rect; shown_ns: number; closed_ns: number }

// Frames file written by echo, watch, lag and scroll (`--frames <out.json>`).
// Keys and clicks are posted only while the measured pid is frontmost. Exit 4 errors include
// `not_frontmost` (keys) and `trigger_skipped` (a trigger could not be posted, so the run is invalid).
export type FrameTimeSource = "pts" | "display" | "arrival";
// `dirty_rects`: the dirty rects outside the masks in window points, at most 8 per frame, so calibration can see what
// keeps a window from settling and add a mask for it.
export interface NativeFrame {
  t_ns: number;
  source: FrameTimeSource;
  ocr: string[];
  dirty_outside_masks: number;
  dirty_rects?: Rect[];
}
export interface NativeFramesFile {
  cleared: boolean | null;
  time_sources: Record<FrameTimeSource, number>;
  frames: NativeFrame[];
}

// ---------- Calibration commands (ademark-native, agent-facing) ----------
// An agent uses these to write an ADE profile. They are never used inside a measured block: reading the
// Accessibility tree switches Electron and WKWebView apps into a heavier mode, so the app is quit and relaunched
// after calibration, before any measurement. Coordinates are window-relative points, top-left origin, like Rect
// everywhere else. Every command prints one JSON object.

// `ademark-native ax-tree --pid <pid> [--depth 12] [--max-nodes 4000] [--window-only]`
// Strings longer than 200 characters are cut, with "…" at the end.
export interface NativeAxNode {
  role: string;
  subrole: string | null;
  title: string | null;
  value: string | null;
  description: string | null;
  identifier: string | null;
  frame: Rect | null;
  enabled: boolean | null;
  focused: boolean | null;
  actions: string[];
  children: NativeAxNode[];
}
export interface NativeAxTree { pid: number; window: Rect | null; nodes: number; truncated: boolean; root: NativeAxNode }

// `ademark-native menu-shortcuts --pid <pid>`: every menu bar item, with its key equivalent as a combo in the syntax
// `keys --combo` accepts ("cmd+shift+n"), or null when it has none.
export interface NativeMenuItem { path: string[]; combo: string | null; enabled: boolean }
export interface NativeMenuShortcuts { pid: number; items: NativeMenuItem[] }

// Finds one Accessibility element. Every given field must match; `index` picks among several matches (0 first, in
// depth-first order).
export interface AxLocator {
  role: string;
  title?: string;
  titleContains?: string;
  identifier?: string;
  description?: string;
  index?: number;
}

// `ademark-native ax-press --pid <pid> --locator <json>`: performs AXPress on the element. Setup only, never timed.
export interface NativeAxPress { pressed: boolean; matches: number; frame: Rect | null }

// `ademark-native click --pid <pid> --at <x,y> [--count 1]`: a left click at a window point, posted only while the pid
// is frontmost (exit 4 `not_frontmost` otherwise). Returns NativeNow.

// `ademark-native probe-region --pid <pid> --search <x,y,w,h> --text <probe> [--clear <combo,combo>]`: types `text` into the
// focused field, compares frames from before and after, and returns the bounding rect of the pixels that changed
// inside `search` (the composer's line), then clears with the clear keys. `ocr_found` is true when OCR reads `text`
// inside `rect`.
export interface NativeProbeRegion { rect: Rect | null; ocr_found: boolean; cleared: boolean }

// ---------- ADE profiles (bench/adapters/profiles/<ade>.json) ----------
// A profile holds everything the agent learned when it calibrated one ADE build, as data. bench/adapters/profile.ts
// turns it into an Adapter and replays it with no model. Strings in steps may use the placeholders ${worktree},
// ${home}, ${model}, ${effort} and ${agent}.
// Steps never use Accessibility: they run in the same app process that is then measured, and reading the AX tree
// makes Electron and WKWebView apps heavier. Calibration uses AX to find things; profiles replay keys, clicks,
// CLIs and URLs.

export type ProfileStep =
  | Trigger
  | { kind: "paste"; text: string }
  // OCR in a window region until `text` shows, or the step fails after `timeoutMs`. `texts` instead of `text`: the
  // first of them read ends the wait. 2026-11-10: OCR read Conductor's "Open project" as "Open rxoiect" in every frame.
  | ({ kind: "expectText"; region: Rect; timeoutMs: number } & ({ text: string; texts?: never } | { texts: string[]; text?: never }))
  // Click `point` only if one of `texts` shows in `region` within `timeoutMs` (short, a few seconds); otherwise do
  // nothing and log it. For a banner or card that shows on some launches only, where the point is wrong without it
  // (2026-11-10: Cloudroom's update banner; its X point opens the right panel when no banner shows).
  // `confirmGone`: after the click, read the region once more and log if a text is still there. No second click and no
  // failure: the guards after it decide.
  | { kind: "clickIfText"; region: Rect; texts: string[]; point: { x: number; y: number }; timeoutMs: number; confirmGone?: boolean }
  // The ADE's own CLI or `open <url>`. Never sudo, never a shell string.
  | { kind: "run"; argv: string[]; timeoutMs: number }
  // The agent looks at the window and acts until the goal is visibly true (bench/agent/goal.ts). Setup only.
  // `allowKeys`: keys the agent never presses otherwise; only "cmd+a" can be allowed (bench/agent/eyes.ts).
  | { kind: "goal"; goal: string; maxActions?: number; allowKeys?: string[] };

export interface OrchestrationSetting {
  /** A JSON file; `${home}` is the account's home. */
  file: string;
  /** The keys from the root to the value. */
  path: string[];
  value: boolean | string | number;
}

export interface AdeProfile {
  schema: 1;
  ade: string;
  // The build this profile was calibrated on. `version` and `bundleSha256` come from installCheck().
  app: { path: string; version: string; bundleSha256: string | null; processNames: string[] };
  window: { w: number; h: number };
  calibration: Calibration;
  login: LoginSpec;
  // reset(): quit, move calibration.dataDirs aside, restore these seed paths, set these JSON keys, boot out
  // calibration.launchAgents, restore the clean config snapshot. Settings files are written only here, because the
  // app is closed only during reset; put the settings of every agent in one list.
  // warmLaunchMs: open and quit the app once after the data folders are replaced, for an app whose first launch on a
  // new data folder never paints (Conductor 0.91.2).
  reset: { seeds: string[]; jsonKeys: Array<{ file: string; keys: Record<string, unknown> }>; warmLaunchMs?: number };
  // launch(): this long after the window resize, read the window once with OCR. With no text at all, quit and launch
  // once more before openProject. For an app whose window can stay black after a launch (Conductor 0.91.2, 8 Nov).
  blankRelaunchMs?: number;
  steps: {
    // After launch and the window resize: dismiss what's-new dialogs and similar.
    afterLaunch: ProfileStep[];
    // Make ${worktree} the open project. The app keeps it across quit and relaunch; it runs again only after reset.
    openProject: ProfileStep[];
    // Model, effort and permissions for one agent, in the running app. configure() at block start finds the app
    // closed, so these steps run in launch(), after afterLaunch and before openProject; in Track C the app is open
    // and they run at once.
    configure: Partial<Record<Agent, ProfileStep[]>>;
    // Empty: quit through AppleScript, then kill what is left after 10 s.
    quit: ProfileStep[];
    // Untimed, before the quit that A2 times the relaunch of, and before A1's cold quit (Adapter.beforeQuit). 2026-11-09:
    // Orca relaunched into about 50 Claude tabs left by the earlier tests, and restored a dead tab by typing
    // `claude --resume` into a fresh shell, where the probe letters raced it. Optional; missing means none.
    beforeRelaunchQuit?: ProfileStep[];
    beforeColdQuit?: ProfileStep[];
    // C6, after the restart and launch(): select the thread the restart interrupted. An empty list says the app reopens
    // that thread by itself, which only the real screen can prove. Missing = not calibrated (Adapter.returnToThread).
    returnToThread?: ProfileStep[];
  };
  timed: Adapter["timed"];
  // waitDone() reads the agent's session log; "worktree" when the agent runs in the project folder itself.
  waitDone: { cwd: "worktree" | "any"; idleFallback: boolean };
  processes: { vendorDirs: string[]; launchAgentLabels: string[]; teamId: string | null; agentExecutables: string[] };
  // A string is the trigger line, null means ADES.md says the ADE has no orchestration. The object is an ADE that has
  // orchestration with no trigger line proven yet: C1 rows are invalid, never "not supported" (2026-11-11: seven draft
  // profiles had null there, so C1 would have published "not supported" for apps that orchestrate).
  orchestrationTrigger: string | null | { notCalibrated: string };
  // Track C only. `settings`: values set in JSON settings files after the reset restored them and before the app is
  // launched, for an ADE that ships its orchestration switched off (2026-11-11: super.engineering's seed has
  // experimental.agent_orchestration false, and with it off its CLI refuses every orchestration command). The key
  // must exist in the file, so a renamed setting stops the block instead of doing nothing. `workers`: see
  // Adapter.orchestrationWorkers.
  orchestration?: { settings?: OrchestrationSetting[]; workers?: "sessions" };
  notes: string[];
  // Plain words for the agent that rehearses the app before it is measured (bench/agent/stage.ts): where a new
  // conversation with the agent starts, what is easy to confuse. Optional.
  agentGuide?: string;
  // Test ID to the reason it cannot be measured on this ADE (Adapter.excludedTests).
  excludeTests?: Record<string, string>;
}

// bench/adapters/gates/<ade>.json, written by `ademark calibrate gate`: `runs` smoke runs in a row from a clean
// reset. The night measures an ADE only when passed == runs and bundleSha256 matches the installed app.
export interface CalibrationGate {
  ade: string;
  runs: number;
  passed: number;
  at: string;
  harnessCommit: string;
  version: string;
  bundleSha256: string | null;
  failures: string[];
}

// ---------- Replay server (bench/replay) ----------
// `bun bench/replay/server.ts --port 8787 --sessions bench/replay/sessions --log <requests.jsonl>`
// Control endpoints: GET /_ademark/health, GET /_ademark/stats, POST /_ademark/reset.

export interface ReplayRequestLog {
  t_ns: number;
  api: "anthropic" | "openai";
  path: string;
  bytes: number;
  body_sha256: string;
  session: string | null;
  user_agent: string | null;
}

// ---------- Capture (bench/capture) ----------

export interface CapturedUsage {
  input: number;
  cache_write: number;
  /** The part of `cache_write` with the one-hour TTL, which costs more. Undefined when the source does not say. */
  cache_write_1h?: number;
  cache_read: number;
  output: number;
}

export interface CaptureRow {
  t_ns: number;
  // The provider's id of this call, so the proxy and telemetry can agree on what is one call.
  request_id?: string | null;
  host: string;
  path: string;
  pid: number | null;
  process: string | null;
  model: string | null;
  user_agent: string | null;
  req_bytes: number;
  status: number;
  usage: CapturedUsage | null;
  /** The provider's id of the answer, which a `thread` continuation names. */
  message_id?: string | null;
  /** A continuation of a request this capture does not have, so its thread is unknown. */
  thread_unresolved?: boolean;
  /** The request that starts a turn on the prompt. Two of them mean the prompt ran twice. */
  starts_turn?: boolean;
  main_thread: boolean | null;
  // SHA-256 hex of each trimmed user-text candidate of the request, in the order of
  // userTextCandidates in bench/replay/session.ts. classifyMainThread compares the prompt hash.
  user_text_sha256: string[];
  // Host-clock time of each streamed response chunk (TESTS.md §1.5); empty when not streamed.
  chunk_t_ns: number[];
  // Request body with auth removed, saved next to capture.jsonl as bodies/<n>.json (B2, B4, C2 delivered).
  body_file: string | null;
}

// ---------- Grader (bench/grade) ----------
// `bun bench/grade/grade.ts --task <task-id> --worktree <path> --out <result.json>`
// Hidden tests live in $ADEMARK_PRIVATE/tasks/<task-id>/tests (default ~/ademark-private).

export interface GradeGroup { id: string; passed: number; total: number; failed: string[] }

export interface GradeResult {
  task: string;
  groups: GradeGroup[];
  valid: boolean;
  reasons: string[];
}

// ---------- Tasks (tasks/<task-id>/task.toml) ----------

// `text` is the file's content, sent byte for byte.
export interface FollowUp { id: string; at_s: number; file: string; text: string }
export interface FollowUpPolicy { refused_retry_every_s: number; refused_give_up_s: number }

// task.toml spells the kinds agent_kill | network_cut | app_restart (TASKS.md §1.1); loadTask maps them.
export type FaultKind = "kill-agent" | "cut-network" | "restart-app";
export interface Fault { kind: FaultKind; at_s: number; duration_s: number | null }
export interface Recovery { wait_s: number; message: string }

export interface TaskSpec {
  id: string;
  version: string;
  test_id: TestId;
  model: "claude" | "codex" | "both";
  time_cap_s: number;
  repeats: number;
  prompt: string;
  grade_groups: string[];
  chat_lock_probe: boolean;
  followups: FollowUp[];
  followup_policy: FollowUpPolicy | null;
  faults: Fault[];
  recovery: Recovery | null;
}

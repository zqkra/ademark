# ademark-native

The macOS helper behind every timing and memory number in ADEMark. One SwiftPM package, one executable,
no external dependencies. Types and field names are fixed by `bench/core/contracts.ts` ("Native helper CLI");
procedures come from `TESTS.md` §1.1 (clock), §1.2 (sampler) and §1.3 (echo timer), with the additions A6
(`covered` variant), A11 (scroll) and A12 (background sampling).

## Build

```sh
bash bench/native/build.sh
```

That runs `swift build -c release --package-path bench/native`, copies the product to
`bench/native/bin/ademark-native` and signs it ad hoc. `bench/native/bin/` and `bench/native/.build/` are ignored
by git. Requires Swift 6.4 with the Command Line Tools and macOS 14 or newer.

## Contract

Every subcommand prints exactly one JSON object on stdout (or writes the file it was given) and exits 0 on success.
A failure prints `{"error":"<code>","message":"..."}` on stdout.

| Exit | Meaning | `error` values |
|---|---|---|
| 0 | success | none |
| 2 | bad arguments | `bad_arguments` |
| 3 | missing permission | `accessibility_not_granted`, `screen_recording_not_granted` |
| 4 | other runtime failure | `runtime_error`, `io_error`, `process_not_found`, `not_frontmost`, `trigger_skipped`, `window_not_found`, `capture_failed`, `capture_timeout`, `app_not_found`, `video_failed`, `not_found`, `no_press_action` |

Argument validation always runs before any permission check or event is posted, so a bad command line never
touches the machine.

## Frontmost guard

Keys and clicks are posted to `.cghidEventTap`, which delivers them to whatever app is frontmost. Every posting
subcommand therefore checks `canPost(frontmostPid:target:)` first. It is true only when the frontmost pid equals the
measured pid, read from `NSWorkspace.shared.frontmostApplication?.processIdentifier`. Nothing is ever posted into
another app:

- `keys` exits 4 with `{"error":"not_frontmost"}` and posts nothing.
- `click` exits 4 with `{"error":"not_frontmost"}` and posts nothing.
- `probe-region` exits 4 with `not_frontmost` and types nothing when the app is not frontmost when the typing is due,
  and records `"cleared": false` when it is no longer frontmost before the clear keys.
- `echo` and `lag` post a probe character only while the measured app is frontmost; a skipped slot keeps the clock
  running from `t0`, so "not frontmost yet" counts as "not ready yet".
- `echo` clears the composer only when the app is frontmost, and records `"cleared": false` otherwise.
- `keys`, `type`, `enter` and `click` triggers wait up to 5 s for the app to come frontmost, and are skipped if it
  does not, so a trigger that can never post cannot consume the measurement window.

A skipped trigger fails the run: `echo`, `watch` and `scroll` exit 4 with
`{"error":"trigger_skipped","message":"<n> trigger(s) skipped: pid <pid> was not frontmost"}` and print no result.
For `scroll` the skipped unit is a wheel post rather than a trigger. A3 is the case that matters: if the new-thread
shortcut is skipped, the probe would land in the old thread's composer and report a normal-looking Ready for the
wrong thread. The capture stream is stopped before the error is raised, so no frames file is left behind.

## Clock

Every timestamp is nanoseconds from `clock_gettime_nsec_np(CLOCK_UPTIME_RAW)`, the same clock Bun reads.
`Date()` is never used for a measurement. Mach ticks (`ri_user_time`, `ri_system_time`) are converted with
`mach_timebase_info`, which is 125/3 ns per tick on Apple Silicon.

## Subcommands

### `now`

```sh
ademark-native now
{"t_ns":53401279540291}
```

### `procs`

Every process the current user can read. `responsible_pid` comes from
`responsibility_get_pid_responsible_for_pid` resolved with `dlsym`; it is `null` when the symbol is missing or
returns an error.

```sh
ademark-native procs
[{"pid":172,"ppid":1,"path":"/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow",
  "name":"loginwindow","responsible_pid":172}]
```

### `sample`

```sh
ademark-native sample --rules rules.json --hz 4 --duration-s 60 --csv samples.csv
{"ticks":240,"rows":6120,"pids":34,"app_median_b":912345678,"app_p95_b":998765432,
 "agents_median_b":534567890,"total_median_b":1446913568,"total_p95_b":1567890123}
```

Rules file (`SampleRules`):

```json
{
  "rootPids": [1234],
  "bundlePaths": ["/Applications/T3 Code.app"],
  "vendorDirs": ["~/.t3"],
  "agentExecutables": ["claude", "codex", "/opt/homebrew/bin"],
  "excludeNames": ["crashpad_handler"]
}
```

A process is attributed when one of these is true: its pid is in `rootPids`; its path starts with a
`bundlePaths` or `vendorDirs` entry (a leading `~` is expanded); its `responsible_pid` is attributed; its parent
chain reaches an attributed pid. The fixed system list (`kernel_task`, `launchd`, `WindowServer`, `mds`, `mds_stores`,
`mdworker`, `mdworker_shared`, `trustd`, `opendirectoryd`, `logd`, `cfprefsd`, `distnoted`, `coreaudiod`,
`syslogd`) and `excludeNames` are never attributed.

`group` is `agents` when the executable's basename or path matches an `agentExecutables` entry, or when a parent in
the chain is already in `agents`; otherwise `app`. The process list refreshes every 1 s.

The CSV is opened before the first tick and gets the header below. Every tick appends its rows and flushes them,
so the file grows while the sampler runs and its rows are never held in memory; only the per-tick group sums are
kept for the summary. `--duration-s 0` means until a signal: the sampler keeps ticking until SIGINT or SIGTERM,
finishes the current tick, closes the CSV, prints `NativeSample` and exits 0. Track C and A12 use that background
mode. A positive value is a fixed window, as before.

```sh
ademark-native sample --rules rules.json --hz 4 --duration-s 0 --csv samples.csv &
# ... later, after the whole track:
kill -TERM <sampler pid>
{"ticks":4321,"rows":88123,"pids":41,"app_median_b":912345678,"app_p95_b":998765432,
 "agents_median_b":534567890,"total_median_b":1446913568,"total_p95_b":1567890123}
```

CSV columns, exactly as `SAMPLE_COLUMNS` in `bench/core/contracts.ts`:

```
t_ns,pid,ppid,group,exe,phys_footprint_b,lifetime_max_b,cpu_user_ns,cpu_sys_ns,wakeups_idle,wakeups_irq,energy_nj
```

One row per attributed pid per tick. `phys_footprint_b` and `lifetime_max_b` come from `ri_phys_footprint` and
`ri_lifetime_max_phys_footprint` (RUSAGE_INFO_V6). A process that exits mid-run simply stops producing rows.
The printed medians and p95s are taken over the per-tick sums of each group.

### `window`

Accessibility: **required**.

```sh
ademark-native window --pid 1234 --size 1600x1000 --front
{"window_id":88123,"frame":{"x":80,"y":60,"w":1600,"h":1000}}
```

Sets the first standard window to position (80, 60) and the given size in points. `--front` raises it and activates
the app. `window_id` is the layer-0 window of that pid from `CGWindowListCopyWindowInfo`.

### `keys`

Accessibility: **required**.

```sh
ademark-native keys --pid 1234 --text "hello"
{"t_ns":53401280000000}

ademark-native keys --pid 1234 --combo cmd+shift+n
{"t_ns":53401280000000}

ademark-native keys --pid 1234 --enter
{"t_ns":53401280000000}
```

`t_ns` is read just before the first event is posted. `--combo` takes modifiers `cmd`, `shift`, `alt` (alias
`option`), `ctrl`, joined with `+`, then one key: `a-z`, `0-9`, `enter`, `tab`, `escape`, `delete`, `space`, `left`,
`right`, `up`, `down`. `--text` types each character with `CGEventKeyboardSetUnicodeString`. Events go to
`CGEventPost(.cghidEventTap, …)`.

### `echo`

Accessibility and Screen Recording: **required**.

```sh
ademark-native echo --pid 1234 --triggers open.json --region 40,700,1200,80 --focus-click 640,740 \
  --probe ademarkqz --interval-ms 50 --timeout-s 60 --frames frames.json --video run.mov --masks masks.json \
  --settle-cap-s 5
{"t0_ns":53401280000000,"ready_ns":53401840123456,"ready_ms":5601.234,"settled_ms":9123.456,
 "frames":612,"timed_out":false}
```

Steps (TESTS.md §1.3):

1. Capture starts as soon as the pid owns an on-screen window at layer 0. `t0` is read immediately before the first
   trigger.
2. Triggers run in order from a JSON array of `Trigger` (contracts.ts): `open` (`NSWorkspace.openApplication`, with
   `args`), `keys`, `type`, `enter`, `click` (window-relative point), `wait`.
3. ScreenCaptureKit captures that window: `SCContentFilter(desktopIndependentWindow:)`, BGRA,
   `minimumFrameInterval = 1/60`, `queueDepth = 3`. A frame's time is its sample buffer presentation time (PTS)
   converted to the `CLOCK_UPTIME_RAW` nanosecond timeline. If the PTS is invalid, `SCStreamFrameInfo.displayTime`
   (a mach absolute time) is converted with `mach_timebase_info`; arrival time is used only when both are missing.
   Each frame records which one was used, and the file counts them, so a fall back to arrival time is visible.
4. `--region`, `--focus-click` and `--masks` are in window points from the window's top-left and are scaled by the
   window's backing scale.
5. With `--focus-click`, that point is clicked once the window exists and the app is frontmost. Then one probe
   character is posted every `--interval-ms`, cycling through `--probe`, but only while the app is frontmost.
6. `VNRecognizeTextRequest` (`.fast`, no language correction) reads the region of every frame. **Ready** is the first
   frame whose recognized text contains two or more consecutive characters of the probe repeated twice,
   case-insensitively. The composer is then cleared with cmd+a and delete. Enter is never pressed.
7. `settled_ms` is the first frame after which no `SCStreamFrameInfo.dirtyRects` rectangle fell outside the masks for
   1 s. The probe region counts as a mask for this rule, because the composer's caret blinks there, so a caret inside
   `--region` never keeps the window busy (pilot 2026-10-20: without it every A1 to A3 run waited the full cap). Capture
   stops as soon as the window settles or at `--settle-cap-s` (default 5 s, must be over 0 and at most 30) from `t0`,
   whichever comes first; `settled_ms` is `null` when the cap is reached.

`--frames` is written as:

```json
{
  "cleared": true,
  "time_sources": {"pts": 610, "display": 0, "arrival": 2},
  "frames": [
    {"t_ns": 53401280000000, "source": "pts", "ocr": ["Ademark"], "dirty_outside_masks": 1,
     "dirty_rects": [{"x": 12, "y": 704, "w": 18, "h": 22}]}
  ]
}
```

`--absent <text>` holds Ready back while the text is still on screen. Alone, it is read in `--region` (exact match),
and the result adds `absent_seen`: the text was read in some frame before Ready.

`--absent-region x,y,w,h` (needs `--absent`) reads the text in its own region of the same frame instead. A3 passes the
old thread's marker and `threadRect`. The region is read only on a frame whose composer would be Ready, from the same
pixels, so other frames cost what they cost before. That frame is Ready only when the region was read and does not
show the text. The match allows one substituted letter in a window of the text's length and nothing looser (the rule of
`watch --fuzzy 1`). The result adds `absent_seen` (the probe echoed in some frame while the text was still in the
region) and `absent_checked` (the Ready frame's region was read and the text was not there). Each frame read there has
`"absent_ocr"` in `--frames`.

This check must not see the marker, so it errs toward seeing it: a wrong, missing or extra letter still counts (1 for a
9 letter marker, `length / 7` in general), counted over all lines of the region joined. `--absent-also <text>` (needs
`--absent-region`) adds a longer text of the same marker line, and either one holds Ready back. A3 passes
`repository is unchanged`. 2026-11-10, real window: Vision read `unchanged` as `unch&nged`, the `&` was dropped by the
normalization, the substitution-only rule did not see the word, and a probe beside the marker read as Ready.

```sh
ademark-native echo --pid 1234 --triggers new-thread.json --region 0,920,1200,40 --probe ademarkqz \
  --interval-ms 50 --timeout-s 30 --frames frames.json --absent unchanged --absent-region 0,150,1600,740
{"t0_ns":53401280000000,"ready_ns":53401460000000,"ready_ms":180,"settled_ms":900,"frames":60,
 "timed_out":false,"absent_seen":false,"absent_checked":true}
```

`cleared` is `false` when the composer was not cleared because the app was not frontmost. `source` is `pts`,
`display` or `arrival`. `dirty_outside_masks` counts every dirty rect outside the masks; `dirty_rects` lists the first
8 of them in window points (the masks' scale, inverted), so calibration can see what kept a window from settling and
add a mask for it. A frame with none has `"dirty_rects": []`. `--video` writes the captured frames as H.264 with
`AVAssetWriter`. `--masks` is a JSON array of `{x,y,w,h}`.

### `watch`

Accessibility and Screen Recording: **required**.

```sh
ademark-native watch --pid 1234 --text LEDGERMARK --region 800,200,700,700 --triggers send.json \
  --timeout-s 30 --frames frames.json
{"t0_ns":53401280000000,"seen_ns":53401315500000,"ms":355,"timed_out":false,"seen_text":"LEDGERMARK"}
```

Same capture as `echo`, no probe keys. `seen` is the first frame whose OCR contains `--text` (case-insensitive,
whitespace-insensitive). Its `--frames` file has the same shape as `echo`'s, with `"cleared": null`.

`--texts '["THREAD-END","NGTHREAEND","NGTHREAFEND"]'` replaces `--text` with a list: the watch stops at the first frame that shows any
of them (with `--nearly`: by the rule of the echo's absent region, a wrong, missing or extra letter still counts,
over all lines joined; A3 reads the old thread's marker this way before the stopwatch), and `seen_text` names the one that matched, first in list order (`null` on a timeout). Set `--text` or
`--texts`, never both. A11 uses the list because Orca's font reads `LONGTHREAD-END` as `L(NGTHREA&END` or `L(NGTHREAFEND`
(2026-11-08 and 9).

### `lag`

Accessibility and Screen Recording: **required**.

```sh
ademark-native lag --pid 1234 --region 40,700,1200,80 --count 60 --interval-ms 250 --frames frames.json
{"samples_ms":[41.2,55.8,60.1],"p50":55.8,"p95":60.1,"lost":0,"probes_ms":[41.2,null,60.1]}
```

Posts one probe character every `--interval-ms`. Per keystroke, latency is the first frame whose recognized text in
the region grew by that character, minus the post time. `lost` counts keystrokes not seen within 2 s
(`LagRule.missNs`, TESTS.md A8 step 4), including slots skipped because the app was not frontmost. `probes_ms` has
one entry per probe in post order, so C3 can see the order of the lost ones: the latency in ms, or `null` when the
probe was lost. `samples_ms` holds the same non-null latencies in the same order. Its `--frames` file has the same
shape as `echo`'s, with `"cleared": null`.

### `scroll`

Accessibility and Screen Recording: **required**.

```sh
ademark-native scroll --pid 1234 --region 0,120,1600,800 --count 20 --hz 60 --lines 3 --frames frames.json
{"t0_ns":53401280000000,"t_end_ns":53401322000000,"posted":20,"frames":143,"gaps_over_33ms":2,
 "max_gap_ms":48.203}
```

Waits for the pid's layer-0 window and starts the capture as `echo` does (the same `CaptureController`). With the
pid frontmost, the pointer is warped to the center of `--region` (window points, converted like `--focus-click`) and
`--count` line-based wheel events are posted to `.cghidEventTap` at `--hz`; positive `--lines` scrolls toward the
top. Capture continues for 1 s after the last post, so the frames file is a full receipt.

`t0_ns` is read just before the first post, and `t_end_ns` is the last posted event plus one event interval
(`1e9 / hz`). Gaps are measured over `[t0_ns]`, the frames strictly after `t0_ns` and at most `t_end_ns` (sorted), and
`[t_end_ns]`: every consecutive difference over 33 ms is a gap, so silence before the first frame and after the last
one both count. A frozen app that draws no frame during the scroll is one gap over the whole window, while frames
after the scroll are idle, not stuttering. `gaps_over_33ms` counts those intervals (exactly 33.0 ms is not a gap);
`max_gap_ms` is the largest. `--frames` is written in the `NativeFramesFile` shape with
`"cleared": null`. A wheel post that is due while another app is frontmost is never posted; if any post was skipped,
the command stops the capture and exits 4 with `trigger_skipped`, and writes no frames file. No on-screen window at
layer 0 within 30 s exits 4 with `window_not_found`.

### `idle`

No permission.

```sh
ademark-native idle --cpu-cores 8 --quiet-ms 300 --cap-s 5
{"waited_ms":415.433,"quiet":true,"cores_last":2}
```

Waits until the whole machine is quiet, so A1 after a purge and A2 after a quit need no fixed sleep. It reads host
CPU ticks (`HOST_CPU_LOAD_INFO`) every 100 ms. Cores busy over one interval is
`(user + system + nice ticks delta) / (total ticks delta) × logical CPU count`; the helper's own use is in those
host ticks and counts, like it would in a fixed sleep. Quiet means every interval in the last `--quiet-ms` is under
`--cpu-cores`. The command returns as soon as it is quiet (`quiet: true`) or at `--cap-s` (`quiet: false`);
`waited_ms` runs from start to return and `cores_last` is the last interval's value. `--cpu-cores` must be over 0,
`--quiet-ms` at least 100, `--cap-s` over 0 and at most 600.

### `permissions`

No permission.

```sh
ademark-native permissions
{"accessibility":true,"screen_recording":true}
```

Reports `AXIsProcessTrusted()` and `CGPreflightScreenCaptureAccess()`. It only preflights: it never prompts, so the
harness can check both grants without opening a dialog. Exit code is 0 whatever the values are.

### `cover`

No permission.

```sh
ademark-native cover --pid 1234 --duration-s 60
{"window_id":88123,"frame":{"x":80,"y":60,"w":1600,"h":1000},
 "shown_ns":53401280000000,"closed_ns":53461290000000}
```

Finds the pid's layer-0 window and shows a borderless, opaque black `NSPanel` at exactly that frame:
`.nonactivatingPanel`, `ignoresMouseEvents`, `level = .floating`, `collectionBehavior = [.canJoinAllSpaces, .stationary]`.
The CGWindow frame (top-left origin) is converted to AppKit coordinates (bottom-left origin) before the panel is
created; a display above the primary one maps to a y above its height. The panel never becomes key and never takes
focus. The command prints nothing until the panel closes after `--duration-s`, then prints `NativeCover`; SIGINT or
SIGTERM closes it early and still prints. `window_id` and `frame` are the covered window (CG global coordinates,
top-left origin), `shown_ns` is read right after `orderFrontRegardless` and `closed_ns` after the panel is closed.
The `covered` variant of A6 uses it. It opens a window on screen, so never run it in an unattended check.

### `ocr`

```sh
ademark-native ocr --image shot.png --region 0,0,800,200
{"lines":["ADEMARK LEDGERMARK 4821"]}
```

Same Vision settings as `echo`. Used for offline checks of the OCR path.

### `screenshot`

Screen Recording: **required**.

```sh
ademark-native screenshot --pid 1234 --out shot.png
{"path":"shot.png"}
```

Captures the pid's layer-0 window with `SCScreenshotManager` and writes a PNG.

### `selftest`

Runs every pure-logic check without touching permissions, events or the screen: key-combo parsing (13 cases),
probe matcher and text matcher (12), attribution on a synthetic process table (16), the settle finder (5),
tick-to-ns conversion (5), median/p95 helpers (7), the frontmost guard (4), frame-time selection (6), the lag miss
rule (5), the frames file shape (2), the skipped-trigger decision (4), the frame-gap window (6), CG-to-AppKit
frame conversion (4), the duration-0 rule (5), the probe region as a settle mask (4), the settle cap (6),
`dirty_rects` (4), the scroll window (9), the idle math (8), an OCR round trip that renders
`ADEMARK LEDGERMARK 4821` with CoreText into a CGImage in memory and checks that Vision reads `LEDGERMARK` (2), and the
calibration cases: menu modifier masks and virtual key names, locator matching and `index` on a synthetic tree,
string truncation at 200, window point conversion, the pixel-diff box and the probe frame choice (42).
About 250 checks in total (the count changes as checks are added).

```sh
ademark-native selftest
{"passed":249,"failed":0,"failures":[]}
```

Exit code is 0 when `failed` is 0, otherwise 4.

## Calibration commands

Five commands an agent uses to write an ADE profile (`bench/adapters/profiles/<ade>.json`). They are setup only and
never run inside a measured block. Coordinates are window points from the window's top-left, like `Rect`.

> **Warning.** Reading the Accessibility tree is not free. `ax-tree`, `menu-shortcuts` and `ax-press` turn on
> `AXManualAccessibility` for Electron and Chromium apps, which is what makes their web content visible at all; from
> then on the app keeps that tree in memory and walks it for every change. Calibration therefore always ends with
> quitting the app, and the measured run launches a fresh one.

Every command prints one JSON object, validates its arguments before the permission check, and never prompts.

### `ax-tree`

Accessibility: **required**.

```sh
ademark-native ax-tree --pid 1234 --depth 12 --max-nodes 4000 --window-only
{"pid":1234,"window":{"x":80,"y":60,"w":1600,"h":1000},"nodes":2,"truncated":false,
 "root":{"role":"AXWindow","subrole":"AXStandardWindow","title":"Chat","value":null,"description":null,
          "identifier":null,"frame":{"x":0,"y":0,"w":1600,"h":1000},"enabled":true,"focused":true,
          "actions":["AXRaise"],
          "children":[{"role":"AXGroup","subrole":null,"title":null,"value":null,"description":null,
                        "identifier":null,"frame":{"x":0,"y":52,"w":1600,"h":948},"enabled":true,
                        "focused":false,"actions":[],"children":[]}]}}
```

`--window-only` starts at the app's focused window, or its first usable window when none is focused, instead of the
app element. `--depth` counts levels including the root and `--max-nodes` caps the walk; `truncated` is true when
either cap cut it. `window` is the target window's frame in screen points, and every node's `frame` is relative to its
top-left corner. Each node carries `role`, `subrole`, `title`, `value`, `description`, `identifier`, `frame`,
`enabled`, `focused`, `actions` and `children`; `value` holds strings, numbers and booleans as text and is null for
any other type; strings over 200 characters are cut to 199 plus "…". Every read arms a 0.5 s Accessibility
messaging timeout first, so an app that stops answering cannot hang the helper.

### `menu-shortcuts`

Accessibility: **required**.

```sh
ademark-native menu-shortcuts --pid 1234
{"pid":1234,"items":[{"path":["File","New Chat"],"combo":"cmd+n","enabled":true},
                      {"path":["Edit","Paste"],"combo":"cmd+v","enabled":false}]}
```

`path` runs from the menu bar item down to the item, skipping the Apple menu; separators are skipped. `combo` is the
item's key equivalent written the way `keys --combo` parses it, in the order `ctrl+alt+shift+cmd+<key>`, or null when
the item has none or its key has no name in that syntax (function keys, forward delete). cmd counts as held unless
the item's modifier mask sets the "no command" bit. Nothing is ever pressed.

### `ax-press`

Accessibility: **required**.

```sh
ademark-native ax-press --pid 1234 --locator '{"role":"AXButton","titleContains":"Send"}'
{"pressed":true,"matches":2,"frame":{"x":1090,"y":742,"w":32,"h":28}}
```

`--locator` is an `AxLocator` object (or a path to a file holding one): `role` is required, `title`, `titleContains`,
`identifier` and `description` must all match when given, and `index` (default 0) picks among the matches in
depth-first order. `matches` is how many nodes matched and `frame` is the pressed node's frame. Exits 4 with
`not_found` when nothing matches or `index` is past the matches, and with `no_press_action` when the element has no
`AXPress` action.

### `click`

Accessibility: **required**.

```sh
ademark-native click --pid 1234 --at 640,740 --count 1
{"t_ns":53401280000000}
```

Converts the window point to a screen point, then posts a left mouse down and up; `--count` 1 to 3, with the click
state set so 2 is a double click and 3 a triple click. Posted only while the pid is frontmost: otherwise exit 4
`not_frontmost` and nothing is posted. `t_ns` is read just before the first mouse down, and the pointer is put back
where it was afterwards.

### `probe-region`

Accessibility and Screen Recording: **required**.

```sh
ademark-native probe-region --pid 1234 --search 40,700,1200,80 --text ademarkqz
{"rect":{"x":44,"y":706,"w":284,"h":46},"ocr_found":true,"cleared":true}
```

Captures the window, keeps a reference frame, types `--text` (only while the pid is frontmost: exit 4
`not_frontmost` otherwise), and compares the first frame that arrives at least 300 ms after the last key with the
reference. `rect` is the bounding box of the pixels inside `--search` that changed by more than 24 on any channel,
in window points, or null when nothing changed; a change below the threshold is not a change. `ocr_found` is true
when OCR reads `--text` inside `rect` padded by 8 points. The field is then emptied with `--clear`, the same
comma-separated combos `echo` takes (default `cmd+a`, `delete`), and `cleared` says whether that happened. This is
the quickest way to learn which line of the window grows when text is typed.

## Permissions

| Subcommand | Accessibility | Screen Recording |
|---|---|---|
| `now`, `procs`, `sample`, `ocr`, `selftest`, `cover`, `idle`, `permissions` | no | no |
| `window`, `keys`, `ax-tree`, `menu-shortcuts`, `ax-press`, `click` | yes | no |
| `echo`, `watch`, `lag`, `scroll`, `probe-region` | yes | yes |
| `screenshot` | no | yes |

Grant both to the binary (or to the terminal that runs it) in System Settings → Privacy & Security. The pilot grants
them to Ghostty, which launches the helper.

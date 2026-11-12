# Calibrating an ADE

This is the procedure an agent follows to calibrate one ADE build into a profile
(`bench/adapters/profiles/<id>.json`). The output is data, not code: the profile adapter (`profile.ts`) replays it
with no model, and the night measures the ADE only after `bun bench/cli.ts calibrate gate` passes 5 smoke runs in a row.

Budget: about 45 minutes per ADE. If an ADE is still failing after 90 minutes, write what blocks it in the profile's
`notes`, quit the app, and go to the next one.

## Rules

1. Calibrate in the `ademark` account, never in the owner's. `reset()` moves the app's data folders aside, and in the
   owner's account that would move the owner's own data.
2. Change only the profile and its gate file. Never edit timing, sampling, assertion or gate code to make a profile
   pass. If the harness is wrong, stop and report it to the orchestrator.
3. Reading the Accessibility tree turns Electron and WKWebView apps into a heavier mode for the rest of their life.
   Quit the app after every calibration session. Profiles never use Accessibility: they replay keys, clicks, the
   ADE's own CLI and URLs.
4. Follow `ADES.md` §1 and the ADE's own section for every setting: local mode, model Opus 5.5 at high effort for
   Claude (GPT-6.1 Sol at high for Codex), full access in the worktree, telemetry and auto-update off.
5. Every rect and point is in window points, top-left origin, for a 1600 × 1000 window.

## Before the first ADE

1. `bun bench/cli.ts doctor`: every blocking check passes, except `calibration gates`.
2. The owner signed in to the ADEs that have their own login (Claude desktop, the Codex app, Conductor, Traycer, and
   any other that asked at first launch).
3. `bench/native/bin/ademark-native permissions` shows both grants.

## Per ADE

1. **Static probe, no GUI:** `bun bench/cli.ts calibrate probe --ade <id>`. Read the stack, the URL schemes, the
   shortcut candidates from `app.asar`, the data folders and any bundled `claude` or `codex`.
2. **Launch:** `open -b <bundle id>`, then
   `bench/native/bin/ademark-native window --pid <pid> --size 1600x1000 --front`. Record the processes it starts
   (`ademark-native procs`) and the launch agents it installs (`launchctl list` before and after).
3. **Menu shortcuts:** `ademark-native menu-shortcuts --pid <pid>`. Find new thread, new project or open folder,
   settings, and switching threads.
4. **Tree:** `ademark-native ax-tree --pid <pid> --window-only`. Find the composer, the thread area, the model and
   effort pickers and the permission mode.
5. **Composer rect:** `ademark-native probe-region --pid <pid> --search <a generous rect around the composer>
   --text ademarkqz`. Use the returned `rect` as `composerRect` when `ocr_found` is true. Repeat in a thread that has
   messages (`activeComposerRect`) and right after launch (`launchComposerRect`) when the composer moves. Measure the
   view the app really opens: Traycer restores its last task at launch, with the composer docked at the bottom, and a
   rect on the empty Start Page read that task's transcript (2026-11-10). Leave about 10 points above and below the
   first text line: a box that grows upward as text wraps moves that line (T3 Code 0.1.8). After an app update,
   measure again; a run that reads the probe late (more than 18 characters at the first read) says the rect moved.
   When the new-thread action opens its composer in a modal over the old thread (Emdash), set `newThreadComposerRect`
   to the modal's prompt box, and write in the notes the frames that show the old composer and transcript outside it.
6. **Project:** find how to make `${worktree}` the open project, in this order of preference: the ADE's CLI, a URL
   scheme, `open -a <app> <folder>`, keys. Write it as `steps.openProject`.
7. **Configure:** write `steps.configure.<agent>` for each agent: model, effort, permission mode. Settings that live
   in a JSON file go to `reset.jsonKeys` instead, because the app is closed only during reset.
8. **Login:** decide `login.kind`. For `"app"`, find the file that holds the sign-in (compare the data folders before
   and after signing out and in), list it in `login.files`, and write the `signIn` text the owner will read. After
   `reset()`, the app must still be signed in.
9. **Masks:** run one echo (`ademark-native echo ... --frames /tmp/<id>-frames.json`) and read `dirty_rects` of the
   frames after Ready. Every rect that keeps changing with nothing typed (spinners, clocks, usage rings) becomes a
   mask. The probe region is masked already.
10. **Timed triggers:** `timed.launch` (usually `open`), `timed.newThread` (the shortcut), `timed.send` (usually
    `enter`), and for A11 `timed.longThread` and `timed.shortThread`.
11. **waitDone:** `"worktree"` when the agent runs in the project folder itself (check the agent's session log path),
    `"any"` otherwise.
12. **Write and check:** write the profile, then `bun bench/cli.ts profile check <id>` until it prints `ok`.
    Text checks: use a word OCR reads right in that region, and give `expectText` a `texts` list when one word is
    misread (2026-11-10: Conductor's 'Open project' read as 'Open rxoiect' in every frame). For a banner, toast or
    card that shows on some launches only, use `clickIfText` with the banner's own text, never a plain `click` on a
    point that does something else when the banner is gone (Cloudroom's update banner X, 2026-11-10).
13. **Quit:** quit the app (rule 3). If the app restores what the earlier tests left open (Orca restores every
    agent tab), write `steps.beforeRelaunchQuit` (A2) and `steps.beforeColdQuit` (A1): untimed steps that close it
    and leave one fresh thread. Leave them out when the app needs nothing.
14. **Gate:** commit the profile (the gate refuses a dirty tree), then
    `bun bench/cli.ts calibrate gate --ade <id>`. Read every failure, fix the profile, commit, and run the gate
    again until it writes `passed: 5`. Commit the gate file.
15. **Record:** add what you learned to the ADE's section in `ADES.md` (only facts you checked) and anything the
    night must know to the profile's `notes`.

## Order

Calibrate the code adapters' gates first (Bare CLI, T3 Code, Zeron), so the gate itself is proven on known ADEs.
Then the ADEs with their own login while the owner is present, then the rest.

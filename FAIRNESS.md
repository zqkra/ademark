# ADEMark fairness ledger

Version: v1.0, 2026-10-19 (first results published 2026-11-12).

This file lists every objection we expect, our verdict, what we changed, and where you can check it.
[METHODOLOGY.md](METHODOLOGY.md) is the source of truth for test IDs and names.

Verdicts:

- **Valid**: the objection is right. We changed the method.
- **Partly valid**: part of it is right. We changed that part and explain the rest.
- **Not valid**: we kept the method and say why.

Results are published whatever they show, including results that contradict the author's earlier opinions (section 8).

## 1. Conflicts

### K1. "He made a viral tier list. Now he 'measures' to prove he was right."
- **Verdict:** Valid as a risk.
- **What we did:**
  - v1 gives no grades and no overall winner. Each test is ranked on its own by its median, so no weight or
    formula can favor an app.
  - The author's public claims are listed in section 8 with the test that checks each one.
- **Verify:** METHODOLOGY.md §6. The raw data in `data/` and in the v1.0.0 release.

### K2. "He uses a Zeron fork. Zeron gets home advantage."
- **Verdict:** Partly valid.
- **What we did:** We test upstream Zeron at its frozen version, installed fresh in the bench user.
  The fork is not installed on the bench user. The fork is disclosed in METHODOLOGY.md §7.2.
- **Verify:** METHODOLOGY.md §7.2. ADES.md, Zeron section.

### K3. "Synara is T3 Code renamed and Cloudroom is bb. That is double counting."
- **Verdict:** Partly valid.
- **What we did:** They ship as separate products with their own changes. Synara adds its own harness policy and
  subagents; Cloudroom adds its own system prompt and tool proxy. Each is measured as shipped.
  The lineage is disclosed, and similar numbers are expected and called out next to the rows.
- **Verify:** METHODOLOGY.md §7.2.

### K4. "He contributed to some of these tools."
- **Verdict:** Valid as a disclosure.
- **What we did:** METHODOLOGY.md §7.2 discloses the author's ties to ADEs in the field.
- **Verify:** METHODOLOGY.md §7.2.

### K5. "Vendors saw the tasks and tuned for them."
- **Verdict:** Partly valid.
- **What we did:** The repository was private until the results, so no vendor saw the tasks before the run.
  The prompts are public now, for every vendor at the same time. The hidden tests stay private and only their
  SHA-256 is published, so a later release can show they did not change. No vendor got a preview of results.
- **Verify:** TASKS.md. The hashes in `tasks/*/tests/SHA256`.

### K6. "Next he will sell the ranking."
- **Verdict:** Valid as a concern.
- **What we did:** ADEMark sells nothing to vendors and lives on donations. No donation buys inclusion, exclusion,
  position, grades, tasks or publication timing.
- **Verify:** BUSINESS.md.

## 2. Field and claims

### L1. "'Tested with every frontier model' is not true."
- **Verdict:** Valid.
- **What the site says:** "Speed and weight need no model. Token tests use Claude Opus 5.5 and OpenAI's
  GPT-6.1 Sol on every ADE that supports each one. Orchestration and reliability tests use Claude Opus 5.5,
  except the Codex app, which runs GPT-6.1 Sol."
- **Verify:** METHODOLOGY.md §4.

### L2. "You said 16 ADEs."
- **Verdict:** Valid.
- **What we say:** The first post said 16. The field then became 17: we removed Herdr, a terminal multiplexer and
  not a desktop app, and added the desktop apps of Anthropic and OpenAI. Cursor was named in the first post and is
  out of v1 scope. v1 publishes 15: the Codex app waits for the GPT pass, and Conductor left the field because new
  users can no longer download it.
- **Verify:** METHODOLOGY.md §2.

### L3. "'The first real ADE benchmark' insults earlier work."
- **Verdict:** Partly valid.
- **What we say:** We found no earlier public benchmark that measures ADEs side by side on one machine. If we
  missed one, tell us and we will link it.

### L4. "Why is X in and Y out?"
- **Verdict:** Partly valid.
- **What we did:** The inclusion rule is published: a macOS desktop app, publicly downloadable on the
  day the run starts, that runs coding agents on a local repository. Out of v1: Herdr (a terminal multiplexer),
  Tern and Cursor (out of v1 scope). Requests go to a public issue and are reviewed
  before each release.
- **Verify:** METHODOLOGY.md §2.

### L5. "Diri and Superset also run terminals. Why keep them and drop Herdr?"
- **Verdict:** Partly valid.
- **What we did:** Diri and Superset are desktop apps with their own window, so every window test applies the same way.
  Herdr is a terminal UI that lives inside another terminal, so A1-A4, A8 and A11 would time the host terminal, not Herdr.

### L6. "Pointless. Every wrapper sends the same request as the CLI."
- **Verdict:** Partly valid. Some do; the data shows which.
- **What we did:**
  - B2 Request Anatomy shows, per ADE, what is added to the first request: system prompt, tools, MCP tools, injected text.
  - B4 Repo Rules shows whether the repository's `AGENTS.md` reaches the agent at all.
  - Track A measures what the wrapper itself costs in time and memory.
  - "Same as the terminal" is a valid, publishable result.
- **Verify:** METHODOLOGY.md §3, Track B.

### L7. "Claude's desktop app has no GPT column. Unfair."
- **Verdict:** Not valid.
- **Why:** First-party apps run only their vendor's models. That is a property of the product.
  The cell says "not supported", never zero.

### L8. "Capy is a cloud product. Testing it locally misses the point."
- **Verdict:** Partly valid.
- **What we did:** Capy runs its own agent, so its row is labeled "own harness". It runs on its local
  "This Mac" threads, on the same machine as every other ADE. Its cost is split into model tokens and platform fee.
- **Verify:** METHODOLOGY.md §2. ADES.md, Capy section.

### L8b. "You did not test our cloud mode."
- **Verdict:** Not valid for v1.
- **Why:** v1 measures the local experience on one machine, so every ADE runs its agents on the bench Mac.
  Cloud modes are not tested for any ADE: Capy cloud VMs, Cloudroom cloud threads, Conductor Cloud, Superset cloud
  workspaces, Claude desktop cloud sessions and Codex cloud tasks. Each ADE's cloud availability is listed in Track F.
- **Verify:** METHODOLOGY.md §2 and Track F.

### L9. "C1 punishes Emdash and Conductor for a feature they do not have."
- **Verdict:** Not valid.
- **Why:** Their C1 cell says "not supported", never zero. C2 to C6 apply to them like everyone else.
- **Verify:** METHODOLOGY.md §3, Track C.

### L10. "You picked T3 Code's default model."
- **Verdict:** Partly valid.
- **What we did:** The model is fixed by a published rule, not by any ADE's default.
  T3 Code's default Claude model (`claude-fable-5-1`) is not the model we use.
- **Verify:** METHODOLOGY.md §4.

## 3. Settings and defaults

### S1. "You turned off what makes us different: prompt enhancement, auto mode, our safe defaults."
- **Verdict:** Partly valid.
- **What we did:** A comparison needs equal inputs, so model, effort, permissions, prompt rewriting and telemetry
  are the same everywhere. Track F lists every factory default we changed and what it does.
  A separate "as shipped" run is a candidate for v1.1, not part of v1.
- **Verify:** METHODOLOGY.md §4 and Track F.

### S2. "You forced full access. We ship ask mode because it is safer."
- **Verdict:** Partly valid.
- **What we did:** Unattended runs need full access inside the worktree. Track F shows "asks before running
  commands (safer default)" for every ADE that ships that way.

### S3. "Our default effort is medium. You set high."
- **Verdict:** Not valid.
- **Why:** Effort is set to the same level in every ADE. If an ADE cannot set it, the effort it used is read
  from the logs and flagged. The factory effort is listed in Track F.

### S4. "Turning telemetry off changes our app."
- **Verdict:** Not valid.
- **Why:** It is off for every ADE, so no vendor receives live run data.
  Track F records which ADEs ship with telemetry on.

### S5. "Your reset deletes the hooks and skills that give us status and resume."
- **Verdict:** Partly valid.
- **What we did:** Before each ADE we restore a clean snapshot of `~/.claude`, `~/.codex` and `~/.agents`,
  because some ADEs write global hooks and skills that would leak into the next ADE and the control.
  Then each ADE's documented integration is applied the way a user gets it: if the app writes it on launch,
  it writes it; if the docs tell the user to install it, the harness installs it. What each ADE writes into
  global agent config is published in Track F.
- **Verify:** METHODOLOGY.md §5.11-5.12. ADES.md, per-ADE reset steps.

### S6. "Old caches and settings from earlier use changed our numbers."
- **Verdict:** Valid.
- **What we did:** Each ADE starts from a fresh data folder, seeded with the same project and the same threads.
- **Verify:** METHODOLOGY.md §5.11. ADES.md.

### S7. "Conductor bundles its own Claude Code. So do the SDK apps."
- **Verdict:** Partly valid.
- **What we did:** Every ADE that allows it is pointed at the same system binaries. Otherwise its bundled version
  is read from the User-Agent of its requests and published.
- **Verify:** METHODOLOGY.md §5.8.

### S8. "That is fixed in today's build."
- **Verdict:** Partly valid.
- **What we did:** Versions are frozen on the stable channel when the run starts. Nightly-only apps are
  identified by the SHA-256 and build date of the app binary, and the build is archived. Any vendor can ask for
  a re-run on a new stable release. Results older than 60 days are marked stale.
- **Verify:** METHODOLOGY.md §7.5.

### S9. "One app at a time in a 1600 × 1000 window is not real life."
- **Verdict:** Not valid.
- **What the site says:** "Each app ran alone, in a 1600 × 1000 window, so its RAM and rendering cost are its own."

### S10. "A thread your script creates through our API is not one a user types."
- **Verdict:** Partly valid.
- **What we did:** Every timed action starts with a synthetic keystroke or click in the app's window.
  CLI, API, CDP and Accessibility are used only for untimed setup. A scripted request must match a request typed
  in the UI, IDs aside. If it does not, the harness uses the UI path.
- **Verify:** TESTS.md. ADES.md, drive method per ADE.

### S11. "The remote debugging flag on Electron apps changes their performance."
- **Verdict:** Valid.
- **What we did:** Launches for timing and weight never use `--remote-debugging-port`. CDP is used only in
  separate setup launches.
- **Verify:** TESTS.md, A1-A7.

## 4. Measurement

### M1. "A blinking caret never stops changing, so your 'no change for 500 ms' rule is broken."
- **Verdict:** Valid.
- **What we did:** Ready means a probe keystroke appears in the composer. The harness types a probe every 50 ms
  and takes the first frame where the text shows. A secondary "visually settled" number masks the caret and spinners.
- **Verify:** TESTS.md, A1-A4.

### M2. "We start the agent when you open a thread. SDK apps start it when you send. Only we look slow."
- **Verdict:** Valid.
- **What we did:** The headline is Ready to Answer (A1 + A3 + A4). Thread Open and First Word are shown under it.
- **Verify:** METHODOLOGY.md §3, Track A.

### M3. "Your clock starts from a CLI call for some apps and from a keystroke for others."
- **Verdict:** Valid.
- **What we did:** Every clock starts at the same synthetic OS event, timestamped by the host clock in the same recording.
- **Verify:** TESTS.md.

### M4. "Your sampler misses our daemon, and launchd restarts the process you killed."
- **Verdict:** Valid.
- **What we did:** A process counts for an ADE when the ADE is responsible for it, it runs from the app bundle or the
  vendor's folder, or it appeared after launch. Launch agents of other ADEs are booted out for the day.
  Each ADE's process list is published.
- **Verify:** TESTS.md, A5. ADES.md, process attribution per ADE.

### M5. "Metal makes native apps look heavier than Electron."
- **Verdict:** Not valid for app memory. Partly valid for WindowServer.
- **What the site says:** "Memory includes GPU memory for every app, native or Electron."
- **What we did:** Window backing stores are charged to WindowServer, so its memory change between app open and
  app quit is recorded and published separately.
- **Verify:** TESTS.md, A5 and A7.

### M6. "Hidden or covered windows get throttled, so idle numbers depend on window state."
- **Verdict:** Valid.
- **What we did:** Idle is measured with the window in front, focused and uncovered. A6 adds a second number with
  the window covered.
- **Verify:** METHODOLOGY.md §5.6. TESTS.md, A6.

### M7. "The display runs at 144 Hz and 1x scale. Results change with refresh rate and scale."
- **Verdict:** Valid.
- **What we did:** The display runs at 60 Hz. Resolution and scale are recorded and published.
- **Verify:** METHODOLOGY.md §5.3.

### M8. "`purge` is not a cold start, and killing our daemon punishes it twice."
- **Verdict:** Partly valid.
- **What we did:** Two tiers. A1 Cold Start clears the file cache and kills every ADE process. A2 Relaunch follows a
  normal quit with daemons alive, so a kept daemon shows its speed benefit. A first launch from a quarantined copy
  is recorded once and not ranked.
- **Verify:** TESTS.md, A1 and A2.

### M9. "Ghost Weight punishes the server that lets my phone reach my agents."
- **Verdict:** Partly valid.
- **What we did:** Ghost Weight is split into "no sessions open" and "sessions kept alive".
- **What the site says:** "Ghost Weight is memory left 60 s after Quit with factory settings. Some apps keep a server
  running on purpose so phones and browsers can reach your agents."
- **Verify:** TESTS.md, A9.

### M10. "Screen recording slows GPU-heavy native apps more."
- **Verdict:** Partly valid.
- **What we did:** No recording runs during A5, A6 and A7. Timing tests capture only the target window.
  The recording timer is checked against a 240 fps camera on 3 apps during the pilot.
- **Verify:** METHODOLOGY.md §5.7. Pilot report.

### M11. "Spotlight, updates, swap and your own sync job were running."
- **Verdict:** Valid.
- **What we did:** They are off. Every block starts with swap at 0, thermal state nominal and non-ADE CPU under
  0.1 core for 60 s. The day-long power and thermal log is published.
- **Verify:** METHODOLOGY.md §5.1-5.5. RUNBOOK.md.

### M12. "Five runs prove nothing."
- **Verdict:** Partly valid.
- **What we did:** A1-A4 run 10 times. Every run is a dot on the chart, with the median, the 25-75 % box and the
  min-max range. Two ADEs tie when the 95 % interval of their paired difference includes 0.
- **Verify:** METHODOLOGY.md §6.

### M13. "Speed against a fake server is not real use."
- **Verdict:** Partly valid.
- **What we did:** The replay server isolates the app's own cost from API speed, which changes minute by minute.
  Live timings from Tracks B and C are published as a secondary number, labeled "live API".
- **Verify:** TESTS.md.

### M14. "Five agents is a toy load. People run fifty."
- **Verdict:** Partly valid.
- **What we did:** A10 Scale opens 20 threads and reports memory per added thread and Typing Lag.
- **Verify:** METHODOLOGY.md §3, A10.

### M15. "It gets slow after an hour, not in a minute."
- **Verdict:** Valid.
- **What we did:** A11 Long Thread opens a 2,000-message thread. A12 Leak measures memory growth over 30 min of real work.
- **Verify:** METHODOLOGY.md §3, A11 and A12.

## 5. Tokens

### T1. "Hello Tax mixes full-price tokens with cache reads that cost a tenth."
- **Verdict:** Valid.
- **What we did:** B1 splits fresh input, cache write, cache read and output, and prices each at its own rate.
- **Verify:** TESTS.md, B1.

### T2. "Hello Tax bills us for the context that makes our agent useful."
- **Verdict:** Partly valid.
- **What the site says:** "Hello Tax is a cost, not a quality score." B2 shows what the extra context contains.

### T3. "'hi' is a poor probe. Some apps skip title calls on short prompts."
- **Verdict:** Valid.
- **What we did:** B3 repeats the split for one real read-only prompt.
- **Verify:** TASKS.md, B3.

### T4. "Side calls for titles and commit messages are hidden."
- **Verdict:** Valid.
- **What we did:** Every request of every ADE process is captured. Side calls are shown apart, including calls to a
  different model.
- **Verify:** TESTS.md, B1.

### T5. "Your proxy misses traffic: certificate pinning, Rust TLS, buffered streams."
- **Verdict:** Partly valid.
- **What we did:** The bytes each process sends to the model APIs are reconciled against the captured requests.
  Streams pass through unbuffered. Session logs are a cross-check. An ADE whose traffic cannot be fully captured is
  marked "partial capture". Capture never runs during timing tests.
- **Verify:** TESTS.md, B1.

### T6. "Apps built on the Agent SDK may not load AGENTS.md at all."
- **Verdict:** Valid, and it is a finding, not an excuse.
- **What we did:** B4 Repo Rules puts a canary instruction in `AGENTS.md` and checks whether the agent follows it.
- **Verify:** TASKS.md, B4.

## 6. Orchestration and reliability

### O1. "One task cannot judge orchestration."
- **Verdict:** Partly valid.
- **What we did:** C1 uses one realistic task and is labeled "single run". It shows whether an ADE finishes the job,
  not which ADE orchestrates best. A failure gets a second run, and both are published.
- **Verify:** METHODOLOGY.md §3 and §8.

### O2. "You told the agent how to orchestrate. Our trigger is different."
- **Verdict:** Partly valid.
- **What we did:** Every ADE gets the same goal text. Each ADE starts orchestration with its own documented trigger,
  published next to the prompt.
- **Verify:** TASKS.md, C1.

### O3. "A cap of 4 workers hurts tools built for many agents."
- **Verdict:** Partly valid.
- **What we did:** The cap keeps cost equal across ADEs. A10 Scale covers many sessions.

### O4. "Our orchestration is experimental."
- **Verdict:** Not valid.
- **Why:** Experimental features (Orca, super.engineering, Capy Captains) are enabled per vendor docs and labeled
  "experimental" on the row.

### O5. "Nobody kills agents in real life."
- **Verdict:** Not valid.
- **Why:** Crashes, dropped Wi-Fi and app restarts happen every day. Each fault is a single event at 90 s, the same
  for every ADE, with pass, partial and fail defined in advance.
- **Verify:** TESTS.md, C4-C6.

### O6. "Queued messages are by design, not lost."
- **Verdict:** Partly valid.
- **What we did:** C2 tells apart accepted, queued, lost and applied. A message that is queued and then applied counts
  as delivered.
- **Verify:** TESTS.md, C2.

### O7. "The API was slow in the afternoon."
- **Verdict:** Partly valid.
- **What we did:** A Bare CLI "hi" runs every hour during Track C, and its timings are published next to the results.
  The ADE order is random with a published seed.
- **Verify:** RUNBOOK.md. Drift probe log.

### O8. "You let an AI touch the benchmark during the run."
- **Verdict:** Partly valid.
- **What we did:** An agent may repair how the harness drives a failed ADE, because an app update can move a menu and
  that says nothing about the app's speed. It runs only after every block has ended. After it exits, code reverts the
  attempt if any file outside that ADE's profile, gate and adapter changed, so it cannot touch timing, sampling, gates,
  replay, capture, grading, prompts or tasks. The ADE is then measured again in full from a fresh launch, and rows from
  before the repair are never mixed with rows after it.
- **Verify:** METHODOLOGY.md §5 item 17. `repairs/<ade>/attempt-<n>/diff.patch` and the Repairs table in `night.md`.

## 7. Statistics and presentation

### P1. "A tier list with a secret formula is an opinion with a chart."
- **Verdict:** Valid.
- **What we did:** v1 gives no grades. Each test is ranked on its own by its median. There is no overall winner,
  because no weights were fixed before the run. Rows sort by value. The Bare CLI is a reference line and is never
  ranked.
- **Verify:** METHODOLOGY.md §6.

### P2. "The animations exaggerate the gaps."
- **Verdict:** Valid as a risk.
- **What we did:** Bars start at zero. Each bar shows its value and its multiple of the Bare CLI (for example
  2.5x), so the size of a gap is written, not only drawn.
- **Verify:** The charts on ademark.dev.

### P3. "One number hides the spread."
- **Verdict:** Valid.
- **What we did:** Compare shows each median with the range from the lowest to the highest run and the run count.
  Every run is a row in `data/`.
- **Verify:** Compare on ademark.dev. `data/v1/runs/`.

### P4. "You adjusted the analysis after seeing the data."
- **Verdict:** Valid as a risk.
- **What we did:** v1 did not freeze the analysis before the run. The rules are in METHODOLOGY.md §6, every number
  on the site comes from `site/scripts/results.ts`, and anyone can rebuild them from `data/`. From the next
  release, the scripts are frozen in the pre-registration tag.

### P5. "Only true on your machine."
- **Verdict:** Partly valid.
- **What we did:** Results are labeled with the reference machine. The harness is open and one command runs it on
  another Mac. Community results are not shown yet.
- **Verify:** README.md, "Run the harness".

## 8. The author's own claims

The author made these claims in public before measuring. Each one is checked by a test, and the result is published
whatever it shows.

| Claim | Source | Test that checks it | Status |
|---|---|---|---|
| Paseo and bb are on top: "the orchestration just works, no agent gets lost" | orchestrator tier list post, 15 Oct 2026 | C1 Handoff, Fan-out, Shipped | not measured yet |
| "T3 Code would be higher but it broke a few times" | same post | C3-C6 | not measured yet |
| Superset and Emdash: "agents miss messages and the chat locks" | reply to the same post | C2 Dropped, C3 Chat Lock | not measured yet |
| "Cloudroom's cloud feels as fast as local" | reply to the same post | not tested in v1: every ADE runs in local mode | not tested |
| T3 Code 0.1.0 is the "best tool right now" | tier list v2 post, 16 Oct 2026 | all five grades | not measured yet |
| "@TraycerAI is goated" | post, 20 Sep 2026 | all five grades | not measured yet |

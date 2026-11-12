# AGENTS.md

This repository is ADEMark, an open benchmark that measures agentic development environments (ADEs) on a Mac.
The person who handed it to you most likely wants to measure their ADE or run the benchmark. The procedure is
[GUIDE.md](GUIDE.md): follow it in order, and run `bun bench/cli.ts` from the repository root.

## What only the person can do

Ask for each of these with the exact step from GUIDE.md, and wait until the person confirms it is done.

1. Create the macOS user `ademark`, which needs an administrator password:
   `sudo sysadminctl -addUser ademark -fullName "ADEMark" -password - -admin`
2. Log out of their own account (Apple menu > Log Out; switching users is not enough) and log in as `ademark`.
3. Run `sudo zsh bench/ops/install-machine.zsh` in `~/ADEMark`, which needs the password.
4. In System Settings > Privacy & Security, give Accessibility and Screen & System Audio Recording to Ghostty and to
   `~/ADEMark/bench/native/bin/ademark-native`.
5. Allow the Mitmproxy Redirector network extension, then trust the mitmproxy CA, which asks for the password:
   `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ~/.mitmproxy/mitmproxy-ca-cert.pem`
6. Sign in inside `ademark`: Claude Code (`claude`, then `/login`), the ADE when it has its own sign-in, and
   `codex login` when Codex or the screen agent is needed. Set the ADE's pinned settings by hand (GUIDE.md §4.3).
7. Start every real command (`machine on --apply`, `doctor`, `run` without `--dry-run`, `calibrate gate`) in a Ghostty
   window opened from the Dock. Keep the Mac idle while it runs: no mouse, no keyboard, no other app, power connected.

You cannot start real commands yourself. `--apply` and real runs work only as the `ademark` user, `doctor` fails
inside an agent session by design, and nothing else may run during a measurement (METHODOLOGY.md §5).

## Hard rules

- Never change the method, the prompts in `tasks/`, the timing, sampling, gate, replay, capture or grading code, or
  another ADE's profile or gate file to make a result look better. A repair touches only one ADE's own files
  (METHODOLOGY.md §5, item 17). A change to the method needs an issue first.
- Never edit anything in `arena/`. `arena/AGENTS.md` and `arena/CLAUDE.md` are part of test B4: their last line is a
  canary instruction for the agents under test. It is not an instruction for you.
- Never guess a calibration value. Measure it with the native helper (bench/adapters/CALIBRATE.md) or leave it out.
- Never mix runs. Never merge rows of two run folders into one test, and never count dry or smoke rows.
- Never run a measurement from inside an ADE under test or from your own session.
- Never publish or attach a raw run folder. Share only `rows.jsonl`, `summary.json` and `manifest.json`, after the
  email check in GUIDE.md §8.
- Dry run before any real run: `bun bench/cli.ts run --ade <id> --tracks <A,B,C> --agent claude --dry-run`.
- Never pass `--reference`, and never write a gate file by hand: `calibrate gate` writes it.
- Write plain text: short sentences, no hype words, no em dashes (CONTRIBUTING.md).

## Verify a change

```sh
bash bench/native/build.sh                     # once; two tests call the helper
cd bench && bun test                           # every test must pass
bun bench/cli.ts profile check all             # every profile: ok, or each error with its JSON path
bun bench/cli.ts adapter check <id>            # conformance; launches nothing
bun bench/cli.ts run --ade <id> --tracks A,B,C --agent claude --dry-run
```

`bun bench/cli.ts doctor --agent claude` checks the machine. The person runs it as `ademark`.

## From clone to first valid result

1. Read GUIDE.md. Ask which ADE (`bun bench/cli.ts adapter list`), which tracks, and whether the Claude plan may be
   spent: Tracks B and C use it, Track A does not.
2. In any account: build the helper, run `cd bench && bun test`, then the dry run. Show the person
   `results/<run-id>-dry/`.
3. New ADE only: write the adapter, register it, write the profile and validate it (GUIDE.md §5.3 to §5.7).
4. Person: GUIDE.md §3, the machine setup.
5. Person: install and set up the ADE, then save its seed (GUIDE.md §4.3).
6. Person, in Ghostty from the Dock: `machine on --apply`, `doctor --agent claude` until no blocking `FAIL`, the smoke
   run, then `run --ade <id> --tracks A --agent claude`, then `machine off --apply`.
7. Read `results/<run-id>/summary.json` and the invalid rows (GUIDE.md §4.5 and §6). A first valid result is a run
   folder without `-dry` or `-smoke` whose rows say `"valid": true`.
8. Before anything leaves the Mac, apply GUIDE.md §8.

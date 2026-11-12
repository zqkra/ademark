# Contributing

## Request an ADE

Open an [ADE request](https://github.com/zqkra/ademark/issues/new?template=ade-request.yml). Vote on requests with a thumbs up. An ADE enters when it meets the inclusion rule in [METHODOLOGY.md](METHODOLOGY.md) section 2: a macOS desktop app, publicly downloadable, that runs coding agents on a local repository.

## Add an ADE yourself

Write its adapter and profile, register it, and pass its calibration gate, as [GUIDE.md](GUIDE.md) section 5 says. Then open a pull request with those files and the gate file.

## Share results from your Mac

Run the harness as [GUIDE.md](GUIDE.md) says, then open the [share-results form](https://github.com/zqkra/ademark/issues/new?template=share-results.yml). Attach only `rows.jsonl`, `summary.json` and `manifest.json`, after the privacy check in GUIDE.md section 8. A raw run folder holds your account email and recordings of the measured app's window.

## Report a wrong number

Open a [wrong-number issue](https://github.com/zqkra/ademark/issues/new?template=wrong-number.yml) with the test ID, the ADE, the number and your evidence. Method errors are fixed in a public corrections log with the old and new value.

## Run the harness

Follow [GUIDE.md](GUIDE.md). Start with `bun bench/cli.ts run --ade <id> --tracks A --agent claude --dry-run`, which works in any account, and `cd bench && bun test` after `bash bench/native/build.sh`.

## Pull requests

- Nobody pays for a change to a result, a rank, a test or an ADE's inclusion. A pull request paid for by a vendor is closed ([BUSINESS.md](BUSINESS.md)).
- A change to the method (tests, settings, equal conditions) needs an issue first. Say what changes and why before you write code.
- An adapter or profile change for one ADE stays inside that ADE's files under `bench/adapters/`. The rules for repairs are in METHODOLOGY.md section 5, item 17. A new ADE also adds its id to `bench/adapters/registry.ts`, `bench/test/adapters.test.ts` and ADES.md (GUIDE.md section 5.4).
- Run `cd bench && bun test` before you open the pull request.
- Text is plain: short sentences, a number, a name or a fact in each, no hype words, no em dashes.

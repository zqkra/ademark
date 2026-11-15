# Changelog

## Unreleased

- Site: a new hero, the bench mark printed as halftone dots over the title "ADEs, measured.", with the marks of the
  15 measured apps under the sentence that names them.
- Site: the CSS is inlined and the hero font is preloaded, so the first paint needs no extra request.
- Site: the sort buttons of the overview table have accessible names that match their labels.
- Site: a donate link to Ko-fi, also as the repository's Sponsor button.
- CI runs the harness tests on macOS and builds the site on every push to `main` and every pull request.
- `SECURITY.md` explains how to report a vulnerability privately.

## 1.0.1 (2026-11-12)

- v1 publishes 15 ADEs: Conductor left the field before publication. The docs and the release say so.
- The overview shows what each app is built with (Electron, Rust, Tauri).
- The site's Contributing section links GUIDE.md, AGENTS.md and the issue forms.
- `ademark-v1-data.zip` in the release holds `data/` and `results.json` alone.

## 1.0.0 (2026-11-12)

First public release.

- First results, run `control-2026-11-10T08-31-19Z`: 15 ADEs and the Bare CLI control on one Mac mini M4 with 16 GB, Claude Opus 5.5 at high effort.
- Conductor was measured but left the field before publication, because new users can no longer download it. Its rows are in `data/`.
- Track A (speed and weight), Track B (tokens) and test C1 (orchestrated build). C2 to C6 and the Codex app are not in v1.
- The harness in `bench/`, the Ledger arena in `arena/`, the prompts and hidden-test hashes in `tasks/`.
- The method, procedures and per-ADE setup in the root documents.
- The site at ademark.dev, and one row per run of every test in `data/`.
- Code under Apache-2.0, data under CC BY 4.0.

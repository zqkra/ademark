# Grader

Decides whether a task run passes, using hidden tests only. It never calls a model and never reads code.

## Commands

```sh
# grade one task worktree
bun bench/grade/grade.ts --task C1-orchestrated-build --worktree /path/to/worktree --out grade.json

# grade against another base tree or a git ref (the default is the arena/ tree at repo HEAD)
bun bench/grade/grade.ts --task C1-orchestrated-build --worktree /path/to/worktree --out grade.json --base arena-v1

# compare every prompt and follow-up with TASKS.md as bytes
bun bench/grade/check-prompts.ts

# validate the grader: pristine arena, both solutions, every mutant and the touched arena
bun bench/grade/validate.ts

# write tasks/<id>/tests/SHA256 and tasks/<id>/solution/SHA256, then validate
bun bench/grade/validate.ts --write-hashes

# unit tests for TAP parsing, codes, flags, hashes and task.toml
bun test bench/grade
```

`ADEMARK_PRIVATE` overrides the private root (default `~/ademark-private`). `ADEMARK_NODE` overrides the
`node` binary; the grader resolves it to one absolute path and records `node: { path, version }` in `--out`.
`ADEMARK_HANDOFF_CODES` passes the filled handoff codes as JSON. `ADEMARK_HANDOFF_SEED` generates them from
a seed. A task with the `C1-handoff` group needs one of the two; otherwise the grade is invalid with reason
`missing handoff codes` and the group is not run. `validate.ts` sets `ADEMARK_HANDOFF_SEED=ademark-validation`.
The graded code gets a minimal env: `PATH` from the resolved node's folder plus `/usr/bin:/bin`, `HOME`,
`TMPDIR`, `LANG=en_US.UTF-8`, `TZ=UTC` and `ADEMARK_HANDOFF_CODES`.

## Private files

Hidden tests and reference solutions stay outside the repository:

```text
~/ademark-private/tasks/<task-id>/
  tests/<group>/*.test.ts   hidden node:test groups
  solution-a/               full arena copy, task done
  solution-b/               full arena copy, written independently
  mutants/                  validity fixtures
```

The public task folders keep only `tests/SHA256` and `solution/SHA256`. Each hash is SHA-256 over the sorted
relative file list and file bytes: for every file, `path + "\0" + bytes + "\0"`. `solution/SHA256` has one line
for `solution-a` and one for `solution-b`.

## Grading a worktree

1. Copy the worktree (without `.git`, `node_modules` and `.DS_Store`) to `$TMPDIR/ademark-grade/<random>/` (per user).
2. Diff it with the base. An empty diff fails every group with reason `empty diff`.
3. Compare the original files in `test/` with the base. Changed or deleted files add the flag `tests modified`.
4. Replace `test/` with the pristine visible tests and copy the private groups to `test-hidden/`.
5. Run each group with the resolved node and `--test-reporter=tap`, 120 s timeout, in the minimal environment.
   `W2-dates` goes through `run-tz.ts`, which runs the group files once under `TZ=America/Los_Angeles`, once
   under `TZ=UTC` and once under `TZ=Asia/Tokyo`; the group passes only when all three pass.
6. Write `GradeResult` from `bench/core/contracts.ts`, plus `node`, `diff`, `tests_modified`, `changed_tests`,
   the workdir and each group's raw command/output, to `--out`.

`valid` is false only when the grader itself failed: missing hidden tests, missing handoff codes for a task
with `C1-handoff`, an unknown group, or a setup error. A group timeout is a failed group, not an invalid run.

## Groups

| Group | Tasks |
|---|---|
| `W1-limiter` | C1-orchestrated-build, C1-solo, C2-message-delivery |
| `W1-api` | C1-orchestrated-build, C1-solo, C2-message-delivery |
| `W2-dates` | C1-orchestrated-build, C1-solo |
| `W3-cursor` | C1-orchestrated-build, C1-solo, C4-agent-killed, C5-network-cut, C6-app-restart |
| `W4-create` | C1-orchestrated-build, C1-solo |
| `W4-idempotency` | C1-orchestrated-build, C1-solo |
| `Integration` | C1-orchestrated-build, C1-solo |
| `C1-handoff` | C1-orchestrated-build, C1-solo |
| `C2-F1` | C2-message-delivery |
| `C2-F2` | C2-message-delivery |
| `C2-F3` | C2-message-delivery |

B1-hello and B3-real-prompt have no hidden tests. B4 reads their final answers for the `ledger-ok` canary.

## Validation rows

`validate.ts` grades the pristine arena, `solution-a`, `solution-b`, the stored mutants and a touched arena for
every task. The touched candidate is built at validate time from the arena at `HEAD` with the line `// touched`
appended to `src/server.ts`. It must not carry the `empty diff` flag, and every hidden group must still fail;
that proves the tests catch the planted bugs without the empty-diff shortcut.

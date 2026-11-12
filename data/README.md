# ADEMark data, v1

This folder holds the measurements behind every number on the site, and nothing else.

## Layout

```
data/v1/summary.json            Medians of the night, one entry per app and test.
data/v1/runs/<run>/rows.jsonl   One line per measured repetition.
data/v1/runs/<run>/summary.json Medians of that run, computed from its rows.
data/v1/runs/<run>/manifest.json  Run id, app and agent versions, model, effort, start and end time,
                                  test ids, machine model and macOS build.
data/v1/runs/<run>/requests.jsonl  Only in the five C1 runs: one line per model request
                                   (time, request id, previous request id, subagent flag, model, token usage).
data/v1/runs/<run>/c1.json         Only in the five C1 runs: how the run ended and how long it took.
```

A run is a folder whose name starts with `control-`. There are 37.

## What is not published
Screen recordings, screenshots, network captures, request bodies, logs and sample files are not published. They
could show the private screen and accounts of the machine owner. Free text that came from the machine was
removed from the rows, and file paths and notes were dropped. Numbers were copied as they were: token counts,
timings and memory values are the same as in the source.

## Rebuild the site numbers
Every number on the site can be rebuilt from this folder. You need [Bun](https://bun.sh).

```
cd site
bun scripts/results.ts          # writes src/data/results.json from summary.json and the token rows
bun scripts/orchestration.ts    # writes src/data/orchestration.json from requests.jsonl and c1.json
```

Both scripts read `data/v1` by default. The output is byte for byte the file the site ships.

## License

CC BY 4.0. See `LICENSE-DATA` in the repository root.

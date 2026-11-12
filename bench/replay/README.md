# ademark-replay

The local fake model API for Track A, the script that writes its sessions, and the recorder that
creates real ones. Answers come from session files and stream at a fixed speed, so speed tests
measure the ADE and not the model or the network. Spec: `TESTS.md` §1.4 and §1.5, `TASKS.md` §5.

## Server

```sh
bun bench/replay/server.ts --port 8787 --sessions bench/replay/sessions --log /tmp/requests.jsonl
```

Listens on `127.0.0.1` only. It accepts any `x-api-key` or `authorization` value.

| Endpoint | Answer |
|---|---|
| `POST /v1/messages` | Anthropic Messages: SSE when `stream` is true, one JSON message otherwise |
| `POST /v1/messages/count_tokens` | `{"input_tokens": ceil(body_bytes / 4)}` |
| `POST /v1/responses`, `POST /responses` | OpenAI Responses: SSE when `stream` is true, one JSON object otherwise |
| `GET /_ademark/health` | `{"ok":true}` |
| `GET /_ademark/stats` | `{"requests":n,"by_session":{...},"unknown":n,"rewrite_misses":n}` |
| `POST /_ademark/reset` | zeroes the counters |

A request that matches no session (thread titles, branch names, commit messages) gets one text block
`ok`, streamed or not as asked, and counts as `unknown`.

### Anthropic SSE

In order: `message_start` (with `usage`), then per block `content_block_start`, one
`content_block_delta` per chunk (`text_delta`, `input_json_delta`, `thinking_delta`),
`content_block_stop`, then `message_delta` (`stop_reason`, `usage.output_tokens`) and `message_stop`.
`event:` and `data:` lines, no `ping`.

### OpenAI SSE

In order: `response.created`, `response.output_item.added`, `response.output_text.delta` (chunks),
`response.output_text.done`, `response.output_item.done`, `response.completed` (with `usage`).
Text blocks become message items; `tool_use` blocks become `function_call` items with
`response.function_call_arguments.delta` and `.done`. Thinking blocks are dropped: the Responses API
has no equivalent here.

### Pacing

Time to first byte is 0 by design: the first chunk is written immediately. The session header picks the
pacing; both emitters obey it.

| `pacing` | Behavior |
|---|---|
| `"fixed"` (default) | After the first chunk, every delta is one chunk of 16 characters every 50 ms, at most 80 tokens/s with 1 token = 4 characters. The pacing is the same for text, JSON and thinking deltas, and across content block boundaries. This is what A4, A7, A8 and A10 need. |
| `"none"` | Every chunk is written at once, with no waits. This is what `long-2000` needs for A11: all 2,000 items exist before the test starts. |

Recorded timing is never used.

### Request log

Every request appends one `ReplayRequestLog` line to `--log`:
`{t_ns, api, path, bytes, body_sha256, session, user_agent}`.
`t_ns` comes from `nowNs()` in `bench/core/clock.ts` (`clock_gettime_nsec_np(CLOCK_UPTIME_RAW)` through
`bun:ffi`), the same clock the native helper reads; it is stored as a number. `body_sha256` is computed
by `normalize.ts`: parse the body, drop every key named `metadata`, `request_id`, `user_id` or
`session_id`, replace absolute paths (`/Users/...`, `/private/var/...`, `/tmp/...`), UUIDs and ISO-8601
timestamps with `<PATH>`, `<UUID>` and `<TIME>`, then serialize with sorted keys and hash the result.
Two requests that differ only in those fields hash equal; a changed word hashes different.

## Session files

`bench/replay/sessions/<name>.jsonl`. JSONL, line 1 is the header, every next line is one assistant
turn:

```json
{"type":"session","name":"hi","api":"anthropic","match":"replay:hi","root":"/private/tmp/ademark-recording/arena"}
{"type":"turn","index":0,"blocks":[{"type":"text","text":"LEDGERMARK. Hi! How can I help you with Ledger?"}],"stop_reason":"end_turn","usage":{"input_tokens":12,"output_tokens":14}}
```

| Field | Meaning |
|---|---|
| `name` | Session name, also the `by_session` key in the stats |
| `api` | `anthropic` or `openai`; the block list is the same for both |
| `match` | The exact first user message text (trimmed) that selects this session, for example `replay:hi` |
| `root` | The worktree path at recording time |
| `pacing` | Optional, `"fixed"` (default) or `"none"`; see Pacing |
| `stand_in` | Optional `true`: the file is a scripted stand-in, not a real recording |
| `blocks` | Anthropic-style content blocks: `text` (`text`), `tool_use` (`id`, `name`, `input`), `thinking` (`thinking`) |
| `stop_reason` | Echoed in the Anthropic `message_delta` / used for `tool_use` turns |
| `usage` | `input_tokens` and `output_tokens`, plus optional `cache_creation_input_tokens` and `cache_read_input_tokens` |

Matching reads every user message of the request, in order. Each message contributes the trimmed
concatenation of its text blocks first, then each text block on its own, without empties or duplicates.
The first candidate that equals a session `match` selects that session. Scanning every user message
matters for clients that put reminders, `AGENTS.md` text or an environment block in earlier user
messages (Claude Code, Codex). `bench/capture/parse.py` mirrors this rule as `user_text_candidates`.

Longer A7 stream: `replay:stream-<n> @<seconds>s` (1 to 600 s) selects `stream-<n>` with the last text block of
its last turn grown by whole paragraphs of its own text, never cut inside a code fence, until it streams at least that
long at the fixed pacing. The session keeps its name in the stats and the log. A7 sends it only for a profile whose five
starts leave less than 150 s together (TESTS.md A7).

Turn selection: the turn index is the number of assistant messages already in the request. Past the last
recorded turn the server answers the last turn's text blocks only, with `stop_reason: "end_turn"`.

Paths: before sending a turn, every occurrence of `root` inside `tool_use.input` (deep, strings only) is
replaced with the current worktree path. The current path is found by walking the parsed request body in
key order. Each string is tried against these patterns in order: `Primary working directory: (\S+)`,
`Working directory: (\S+)`, `CWD: (\S+)`, `<cwd>([^<]+)</cwd>`. Then any object key named `cwd` with a
string value, then the env var `ADEMARK_WORKTREE`. The first hit wins, trimmed. When a rewrite was needed
and no current path was found, the input is left unchanged and `rewrite_misses` increases.

## Shipped sessions

| Key | File | Use | Content |
|---|---|---|---|
| `replay:hi` | `hi.jsonl` | A4 First Word, contamination check (RUNBOOK.md §7.1) | One text turn, `LEDGERMARK. Hi! How can I help you with Ledger?` |
| `replay:seed` | `seed.jsonl` | Seeded state (5 threads), A10 extra threads | One short finished answer, no tool call |
| `replay:long-2000` | `long-2000.jsonl` | A11 Long Thread | 1,001 turns: 1,000 steps, each a short visible text (`Step <n> of 1000.` plus one sentence about reading `src/invoices.ts`, every fifth with a 6 to 10 line TypeScript fence) followed by a `Read` call of `src/invoices.ts` (`toolu_long_0001` to `toolu_long_1000`); then one text turn that contains `LONGTHREAD-END`. About 2,000 visible items. `"pacing": "none"`. |
| `replay:stream-1` | `stream-1.jsonl` | A7 Fight Weight, A8 Typing Lag, A10 streams | Turn 0 reads `src/paginate.ts`; turn 1 is a 3-minute answer (57,600+ characters) with prose, TypeScript fences and diff fences |
| `replay:stream-2` | `stream-2.jsonl` | same | Turn 0 reads `src/dates.ts` |
| `replay:stream-3` | `stream-3.jsonl` | same | Turn 0 reads `src/api.ts` |
| `replay:stream-4` | `stream-4.jsonl` | same | Turn 0 reads `src/invoices.ts` |
| `replay:stream-5` | `stream-5.jsonl` | same | Turn 0 reads `src/server.ts` |

`stream-1` to `stream-5` are scripted stand-ins with `"stand_in": true` until the pilot records the real
sessions from W1, W2, W3, W4 and B3 with `record-all.ts`. The stand-ins keep dry runs and calibration
working; they are replaced before pre-registration.

### Why the long thread has text in every step

The pilot's `long-2000` was 1,000 tool calls and no text. Both ADEs folded that into a single row ("Worked
for 34s" in T3 Code, "Read 1000 files" in Zeron), so the screen held three elements and A11 measured a short
thread, not a long one. Each step now carries its own visible text block, so the thread has about 2,000 items
the transcript has to lay out and virtualize. The step text is picked by index, not by a random seed, and the
sentences and snippets never contain `LONGTHREAD-END` or the Seeded marker `unchanged`: A11 watches for both
and they belong only to their own turns.

## Building the fixed sessions

```sh
bun bench/replay/build-sessions.ts          # writes the managed sessions it owns
bun bench/replay/build-sessions.ts --check  # exit 1 when a managed file differs
```

`build-sessions.ts` always owns `hi.jsonl`, `seed.jsonl` and `long-2000.jsonl`. A `stream-<n>.jsonl` slot
belongs to it only while the file is missing or its header still says `"stand_in": true`. A file without
`stand_in` in that slot is a pilot recording: the rebuild prints `kept recording stream-<n>`, never writes
it, and `--check` leaves it out, so the check stays green after the pilot and fails only on a managed
file that differs. The generator is seeded, so the same bytes come out on every run.

## Recording the real streams (pilot)

`stream-1` to `stream-5` are recorded once, from the Bare CLI (Claude Code, Claude Opus 5.5) against the
real API, on a fresh copy of the arena. `record-all.ts` does the whole loop per stream: copy `arena/` to
a temp folder, start `record.ts` as a proxy, run Claude Code with `ANTHROPIC_BASE_URL` pointing at it,
then cut the answer to exactly 57,600 streamed characters (text plus tool input JSON) and write
`stream-<n>.jsonl` with `match` `replay:stream-<n>` and `root` set to the temp folder.

```sh
bun bench/replay/record-all.ts --dry-run                  # print the five plans, run nothing
bun bench/replay/record-all.ts --only stream-3            # record one stream
bun bench/replay/record-all.ts                            # record all five
bun bench/replay/record-all.ts --force                    # replace existing recordings
bun bench/replay/record-all.ts --upstream http://127.0.0.1:9999 --out /tmp/sessions
```

A recording is written only to `--out`, or to `bench/replay/sessions/` when `--out` is not given. The
script refuses to replace a file that already holds a recording (no `"stand_in": true` in its header)
unless `--force` is given, so a pilot run cannot silently destroy an earlier recording. Without `--dry-run`
and with the default upstream `https://api.anthropic.com`, the script refuses to run unless the current user
is `ademark`: it calls the real API and spends the dedicated account. The recording prompts are read from
the task files at run time (`recordings.ts`): the first paragraph of
`tasks/C1-orchestrated-build/prompt.md` plus its `W<n>.` item with the handoff placeholder removed
(streams 1 to 4), and `tasks/B3-real-prompt/prompt.md` (stream 5). The temp folder with the recorded
arena is kept so the `root` in the session file points somewhere real.

## Recorder

```sh
bun bench/replay/record.ts --upstream <url> --port <n> --name <name> --match <text> --root <path> --out <file>
```

A forwarding proxy: every request goes to `--upstream` with all headers, and the upstream answer streams
back unchanged. When the first user message equals `--match`, the assistant turns are assembled into the
session file in the format above (header on first matching answer, then one line per turn, with the turn
index taken from the request). Non-matching traffic passes through untouched.

The recorder must be tested against a fake upstream started with `Bun.serve`; never point it at a real
API in checks.

## Files

| File | Job |
|---|---|
| `server.ts` | `Bun.serve` routing, stats, request log, CLI |
| `session.ts` | Session file parsing, matching, turn selection, path rewriting |
| `anthropic.ts` | Anthropic event planning and the shared 16-char/50 ms pump |
| `openai.ts` | OpenAI event planning, same pump |
| `normalize.ts` | Volatile-field scrubbing and `body_sha256` |
| `record.ts` | Forwarding proxy that writes session files |
| `build-sessions.ts` | Deterministic writer for `hi`, `seed`, `long-2000` and the stream stand-ins |
| `recordings.ts` | The five recording prompts, read from the task files |
| `record-all.ts` | Pilot loop: arena copy, recorder, Claude Code, cut to 57,600 characters |
| `replay.test.ts` | Server, emitters, pacing and recorder tests |
| `sessions.test.ts` | Shipped sessions, `build-sessions --check` and recording prompts |
| `record-all.test.ts` | Post-processing, the cut and the recording loop against a fake upstream |

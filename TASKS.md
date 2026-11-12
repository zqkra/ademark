# ADEMark tasks and prompts

Version: v1.0, 2026-10-19 (first results published 2026-11-12). Test IDs follow [METHODOLOGY.md](METHODOLOGY.md).

This file holds every prompt word for word, the arena work items, the follow-up messages,
the hidden tests, and the recorded sessions that feed the replay server.

## 1. Rules

1. Every prompt runs in a **local thread on the bench Mac**, inside the arena checkout or a git worktree of it.
   No cloud threads, remote hosts or sandboxes. Capy runs local "This Mac" threads (owner decision, 2026-10-19).
2. Prompts are byte-identical for every ADE. Each task is a folder `tasks/<task-id>/` in the open-harness format
   of METHODOLOGY.md section 8 (section 1.1 below). The text inside the fenced blocks below is the content of each
   `prompt.md` or follow-up file, without the fences.
3. The SHA-256 of every task folder goes into the pre-registration. A task that changes after
   pre-registration gets a new `version` in its `task.toml` and a changelog entry.
4. The only per-ADE difference is a one-line **orchestration trigger** for C1 (for example a slash command).
   It is listed per ADE in [ADES.md](ADES.md), sent as its own line directly before the C1 prompt,
   and printed next to the prompt in every result.
5. The harness pastes each prompt into the ADE's composer and presses Enter. Nobody else types into a thread during a run.
6. Handoff codes for C1 are generated at pre-registration from a published seed:
   - Format: `ADM-W1-` plus 6 characters of the RFC 4648 base32 alphabet (`A-Z`, `2-7`), for example `ADM-W1-K7Q2ZD`.
   - Generation: the first 6 base32 characters of `HMAC-SHA256(seed, "W1")`, and the same for W2, W3, W4.
   - `tasks/C1-orchestrated-build/prompt.md` holds placeholders `{{W1_CODE}}` to `{{W4_CODE}}`. The harness fills them before the run.
     The filled text is the one that is hashed.
   - The seed is published after the run, so anyone can regenerate the codes.

### 1.1 Task folders

Every task is one folder:

```text
tasks/<task-id>/
  prompt.md        the first message, word for word
  task.toml        ID, version, model, time cap, grading groups, follow-ups, faults, recovery
  followups/       follow-up messages, one file each (C2 only)
  tests/           hidden tests
  solution/        two independent reference solutions
```

| Task folder | Test IDs |
|---|---|
| `tasks/B1-hello/` | B1, and B4 reads its answers |
| `tasks/B3-real-prompt/` | B3, and B4 reads its answers |
| `tasks/C1-orchestrated-build/` | C1, and C3 runs during it |
| `tasks/C2-message-delivery/` | C2, and C3 runs during it |
| `tasks/C4-agent-killed/`, `tasks/C5-network-cut/`, `tasks/C6-app-restart/` | C4, C5, C6. Their `prompt.md` files are byte-identical; only the `[fault]` table differs |

Until publication, `tests/` and `solution/` in the public repository hold only a `SHA256` file.
The real files live in `~/ademark-private/tasks/<task-id>/` and are copied in when the results are published.
`tasks/codes.json` (handoff codes and their seed) is published after the run.
Recorded sessions for Track A live in `bench/replay/sessions/*.jsonl` (section 5) and are public before the run.

Example, `tasks/C2-message-delivery/task.toml`:

```toml
id = "C2-message-delivery"
version = "1.0.0"
track = "C"
model = "claude"              # claude | codex | both
mode = "local"                # a local thread on the bench Mac; no cloud, remote or sandbox
thread = "new"
prompt = "prompt.md"
time_cap_s = 900
grade_groups = ["W1-limiter", "W1-api", "C2-F1", "C2-F2", "C2-F3"]
chat_lock_probe = true        # C3 types into the composer every 2 s during this task

[[followup]]
id = "C2-F1"
at_s = 30                     # seconds after the Enter of prompt.md
file = "followups/F1.md"

[[followup]]
id = "C2-F2"
at_s = 90
file = "followups/F2.md"

[[followup]]
id = "C2-F3"
at_s = 150
file = "followups/F3.md"

[followup_policy]
refused_retry_every_s = 1
refused_give_up_s = 10        # still refused after 10 s counts as Dropped
```

The fault tests use the same keys plus a `[fault]` and a `[recovery]` table, for example in `tasks/C5-network-cut/task.toml`:

```toml
[fault]
kind = "network_cut"          # agent_kill | network_cut | app_restart
at_s = 90
duration_s = 30

[recovery]
wait_s = 60
message = "continue"
```

## 2. The arena: Ledger

`arena/` is a small invoicing API in TypeScript. It runs natively on Node 26 with no dependencies.
`npm test` runs `node --test "test/**/*.test.ts"`. It is new code, so no model saw it in training.

Current state:

| File | What it does | Planted defect |
|---|---|---|
| `src/invoices.ts` | `Invoice` and `LineItem` types, subtotal, tax and total in cents, `sampleInvoices(count, seed)` with ids `INV-01001`, `INV-01002`, ... | none |
| `src/paginate.ts` | `paginate(all, page, pageSize)` returns a `Page<T>` | `end = start + pageSize + 1` repeats one item on the next page, under a misleading comment. `hasNext: page <= totalPages` is true on the last page. |
| `src/dates.ts` | `parseDay`, `formatDay`, `addDays`, `dueDate`, `daysOverdue`, `isOverdue` | `parseDay` parses `YYYY-MM-DD` as UTC midnight, but `formatDay` uses local getters. West of UTC, every due date moves one day back. |
| `src/api.ts` | `createApp(options).handle(request)`: GET-only router for `/health`, `/invoices?page=&pageSize=`, `/invoices/:id`. Other methods return 405. | none (it exposes both defects above) |
| `src/server.ts` | `node:http` server on `PORT` (default 3000) around `createApp()` | none |
| `AGENTS.md` | Repository rules: run `npm test`, no dependencies, `.ts` imports, `import type` | none |

Changes the arena needs before the pilot:

1. **Visible tests** in `test/`. They must pass on the pristine arena and on every reference solution, so they avoid both
   planted defects and the `/invoices` query format. They cover totals and tax rounding, `sampleInvoices` determinism,
   `GET /health`, `GET /invoices/:id` found and not found, and 405 for other methods.
2. **B4 canary.** Add this line to `AGENTS.md`: `End every final answer with the line ledger-ok.`
   Add `CLAUDE.md` with the single line `@AGENTS.md`, so Claude Code reads the same rules as Codex.
3. **No `reports.ts`.** The Untangle refactor task was dropped from v1.
4. **No pre-added POST support.** Adding a request body and `POST /invoices` is part of W4.
5. Commit the arena, tag it `arena-v1`, and put the tag hash in the pre-registration.

## 3. Prompts

Each block below is the `prompt.md` (or follow-up file) of the task folder named in its heading.

### B1. Hello Tax (`tasks/B1-hello/`)

Sent as the first message of a new thread, 3 times per model, a new thread each time.

```text
hi
```

### B3. Real Prompt Tax (`tasks/B3-real-prompt/`)

Sent as the first message of a new thread, once per model.

```text
Read src/paginate.ts and src/dates.ts. Explain what each function does and list every bug you find with the line number. Do not change any file.
```

### B4. Repo Rules

B4 sends no prompt of its own. It reads the final answers of the B1 and B3 runs:

- **yes**: every final answer ends with the line `ledger-ok`.
- **partial**: some final answers end with it.
- **no**: none does.

The Bare CLI must score **yes** for both Claude Code and Codex. If it does not, B4 is invalid for that agent and is not published.

### C1. Orchestrated Build (`tasks/C1-orchestrated-build/`)

The ADE's orchestration trigger from ADES.md goes on its own line first. Then:

```text
You are working in the Ledger repository: a TypeScript invoicing API that runs natively on Node 26 with no dependencies. Read AGENTS.md first.

Ship the four work items below. Work on them in parallel with up to 4 agents, one agent per item, each in its own git worktree or branch. Then merge all four into main so that npm test passes on main.

Rules:
- Do not change or delete existing files in test/. New test files are allowed.
- Do not add dependencies.
- Each work item has a handoff code. The agent that does the item puts it as the first line of the named module, exactly: // handoff: <code>
- When all four items are merged, write REPORT.md at the repository root with one line per item, in this form: W1 | <branch> | <handoff code>
- Run npm test on main before you finish.

W1. Rate limiting. Handoff code {{W1_CODE}}. Module: src/rate-limiter.ts
Create src/rate-limiter.ts. It exports createRateLimiter(options: { capacity: number; refillPerSecond: number; now?: () => number }). The result has take(key: string, cost = 1): { allowed: boolean; remaining: number; retryAfterMs: number }.
- It is a token bucket per key. A new key starts with capacity tokens. Tokens refill continuously at refillPerSecond and never go above capacity.
- take() removes cost tokens and returns allowed: true when enough tokens are available. Otherwise it removes nothing and returns allowed: false.
- remaining is the whole number of tokens left after the call.
- retryAfterMs is 0 when allowed. Otherwise it is the milliseconds until cost tokens are available.
- now defaults to Date.now and returns milliseconds. cost must be an integer from 1 to capacity, otherwise take() throws RangeError.
Wire it into createApp with a new option AppOptions.rateLimit?: { capacity: number; refillPerSecond: number; now?: () => number }.
- The key is the x-api-key request header, or "anonymous" when the header is missing.
- Every request except GET /health takes 1 token.
- A limited request returns 429 with the body { "error": "rate_limited" } and the header retry-after, set to the wait in whole seconds, rounded up, minimum 1.
- Every response except GET /health has the header x-ratelimit-remaining.
- src/server.ts turns rate limiting on with capacity 60 and refillPerSecond 1.

W2. Timezone drift. Handoff code {{W2_CODE}}. Module: src/dates.ts
Due dates move one day back on machines west of UTC. For example, with TZ=America/Los_Angeles an invoice issued 2026-03-01 with netDays 30 shows the due date 2026-03-30 instead of 2026-03-31.
- Fix src/dates.ts so that parseDay, formatDay, addDays, dueDate, daysOverdue and isOverdue give the same results in every time zone. Keep their signatures.
- Add tests that run under TZ=America/Los_Angeles, TZ=UTC and TZ=Asia/Tokyo.

W3. Cursor pagination. Handoff code {{W3_CODE}}. Module: src/paginate.ts
GET /invoices uses page numbers and repeats one invoice between pages. Replace it with cursor pagination.
- The request is GET /invoices?limit=<n>&cursor=<c>. limit is an integer from 1 to 100, default 20. Any other limit returns 400 { "error": "bad_request" }.
- Items are ordered by id, ascending. Each item keeps the current summary shape.
- The response body is { "items": [...], "nextCursor": string | null, "limit": n }. nextCursor is null on the last page.
- The cursor is an opaque string. A malformed cursor returns 400 { "error": "bad_cursor" }.
- Following nextCursor from the first page returns every invoice that existed at the first request exactly once, also when invoices are added between requests.
- The page and pageSize parameters are no longer accepted. They return 400 { "error": "use_cursor" }.
- Keep paginate() exported from src/paginate.ts for other callers, and fix it: a page has at most pageSize items, and hasNext is false on the last page.

W4. Idempotent invoice creation. Handoff code {{W4_CODE}}. Module: src/idempotency.ts
Add POST /invoices.
- Add an optional body field (a parsed JSON value) to the Request type. src/server.ts reads the request body and parses it as JSON.
- A valid body has client (non-empty string), issued (YYYY-MM-DD), netDays (integer >= 0), currency ("USD", "EUR" or "MXN") and items (at least one item; quantity is an integer >= 1, unitPriceCents an integer >= 0, taxRate a number from 0 to 1). status is optional and defaults to "draft".
- A valid request creates the invoice with the next id (INV- and the next 5-digit number after the highest existing id). It returns 201 with the invoice and the header location: /invoices/<id>.
- An invalid body returns 400 { "error": "invalid_invoice", "message": "<what is wrong>" }.
- When the request has an idempotency-key header:
  - The same key with the same body returns the first response again, with the extra header idempotent-replay: true, and creates nothing. Same body means the same JSON value; key order does not matter.
  - The same key with a different body returns 422 { "error": "idempotency_key_reused" }.
  - A key expires 24 hours after its first use. After that it acts as a new key.
  - A 400 response is not stored, so the client can fix the body and retry with the same key.
- Time comes from a new option AppOptions.now?: () => number in milliseconds, default Date.now.
- Put the idempotency store in src/idempotency.ts.
- Methods other than GET and POST keep returning 405.
```

### C1-solo. Single-agent baseline (`tasks/C1-solo/`, Bare CLI only)

Orchestration Tax and the Fan-out speedup compare each C1 run against one agent doing the same work alone.
The prompt is the C1 prompt with one change: the paragraph that starts "Ship the four work items below" is replaced by:

```text
Ship the four work items below yourself, one after another, on main. Do not start subagents or other agents.
```

In REPORT.md the branch column is `main`. It runs once per model on the Bare CLI and uses the same hidden tests as C1.

### C2. Message Delivery (`tasks/C2-message-delivery/`)

Base task, sent as the first message of a new thread:

```text
In the Ledger repository, add rate limiting. Work alone in this thread and do not start other agents. Read AGENTS.md first.

Create src/rate-limiter.ts. It exports createRateLimiter(options: { capacity: number; refillPerSecond: number; now?: () => number }). The result has take(key: string, cost = 1): { allowed: boolean; remaining: number; retryAfterMs: number }. It is a token bucket per key: a new key starts with capacity tokens, tokens refill continuously at refillPerSecond up to capacity, take() removes cost tokens when enough are available and otherwise removes nothing. retryAfterMs is the milliseconds until cost tokens are available, or 0 when allowed. now defaults to Date.now.

Wire it into createApp with a new option AppOptions.rateLimit?: { capacity: number; refillPerSecond: number; now?: () => number }. The key is the x-api-key header, or "anonymous" when it is missing. Every request except GET /health takes 1 token. A limited request returns 429 with the body { "error": "rate_limited" } and a retry-after header in whole seconds, rounded up, minimum 1. src/server.ts turns rate limiting on with capacity 60 and refillPerSecond 1.

Do not change or delete existing files in test/. Run npm test before you finish.
```

Follow-up messages. The harness sends each one into the same thread at the given time after the Enter of the base task,
with the ADE's default send action (Enter). It records whether the ADE queued the message, sent it into the running turn,
or refused it.

| ID | Sent at | File |
|---|---|---|
| C2-F1 | 30 s | `tasks/C2-message-delivery/followups/F1.md` |
| C2-F2 | 90 s | `tasks/C2-message-delivery/followups/F2.md` |
| C2-F3 | 150 s | `tasks/C2-message-delivery/followups/F3.md` |

```text
Also: make the limit configurable with the environment variable RATE_LIMIT_RPS. When it is set to a positive integer, src/server.ts uses it for both capacity and refillPerSecond. When it is not set, keep capacity 60 and refillPerSecond 1.
```

```text
Also: add an x-request-id header to every response. Use the request's x-request-id header when it has one. Otherwise generate a random UUID.
```

```text
Also: in the invoice summaries returned by GET /invoices, rename the field due to dueOn. Keep due as a deprecated alias with the same value.
```

If the composer refuses input at the send time, the harness retries every 1 s for up to 10 s and records the delay.
A message that is still refused after 10 s counts as **Dropped**.

A follow-up is:

- **Dropped** when its text never appears in a captured model request after the send time,
  or it disappears from the thread in the UI.
- **Applied** when its hidden test group passes.

### C4, C5, C6. Fault tests (`tasks/C4-agent-killed/`, `tasks/C5-network-cut/`, `tasks/C6-app-restart/`)

All three use the same base task, sent as the first message of a new thread:

```text
In the Ledger repository, replace page-number pagination with cursor pagination. Work alone in this thread and do not start other agents. Read AGENTS.md first.

GET /invoices currently uses page numbers and repeats one invoice between pages.
- The request becomes GET /invoices?limit=<n>&cursor=<c>. limit is an integer from 1 to 100, default 20. Any other limit returns 400 { "error": "bad_request" }.
- Items are ordered by id, ascending, and keep the current summary shape.
- The response body is { "items": [...], "nextCursor": string | null, "limit": n }. nextCursor is null on the last page.
- The cursor is an opaque string. A malformed cursor returns 400 { "error": "bad_cursor" }.
- The page and pageSize parameters return 400 { "error": "use_cursor" }.
- Keep paginate() exported from src/paginate.ts and fix it: a page has at most pageSize items, and hasNext is false on the last page.

Do not change or delete existing files in test/. Run npm test before you finish.
```

The fault happens 90 s after Enter:

| Test | Fault |
|---|---|
| C4 Agent Killed | `kill -9` on the agent process of the thread (the `claude` or `codex` process, or the ADE's own agent worker) |
| C5 Network Cut | The model API hosts are blocked with `pf` for 30 s, then unblocked |
| C6 App Restart | The ADE gets a normal Quit (Cmd-Q). After 5 s it is launched again and the same thread is opened |

Recovery (the `[recovery]` table of each fault task): the harness waits up to 60 s for the agent to resume on its own
(a new model request in the capture). If it does not resume, the harness sends this message once into the same thread:

```text
continue
```

Outcome, with a cap of 15 min from the first Enter:

- **pass**: the task finished without the recovery message, and the W3 hidden tests pass.
- **partial**: the recovery message was needed, and then the W3 hidden tests pass.
- **fail**: the thread was lost, the message could not be sent, or the W3 hidden tests fail at the cap.

The harness also records whether the ADE showed the failure on screen (a screenshot 10 s after the fault).

## 4. Hidden tests

### What each group asserts

| Group | Asserts |
|---|---|
| W1 limiter | A new key allows exactly `capacity` takes at the same instant, then refuses. Refill is continuous: after 500 ms at 2 tokens/s, one more take is allowed. Tokens never exceed capacity after a long idle time. A refused take removes nothing. `remaining` is a whole number. `retryAfterMs` is exact for cost 1 and for cost > 1. Keys are isolated. `cost` of 0, -1, 1.5 or above capacity throws `RangeError`. `now` is injectable and `Date.now` is the default. |
| W1 API | `x-api-key` keys are separate. A missing key uses one shared `anonymous` bucket. `GET /health` takes no token and has no `x-ratelimit-remaining`. The first limited request gets 429, `{ "error": "rate_limited" }`, and `retry-after` in whole seconds rounded up (minimum 1). Every other response has `x-ratelimit-remaining`. `src/server.ts` started as a subprocess allows 60 requests and refuses the 61st. |
| W2 dates | Run in 3 subprocesses with `TZ=America/Los_Angeles`, `TZ=UTC` and `TZ=Asia/Tokyo`. The group passes only if all 3 pass. `addDays` across month end, year end, the leap day 2028-02-29 and the US DST changes of 2026-03-08 and 2026-11-01. `dueDate` for every `netDays` value. `daysOverdue` is a whole number and 0 on the due day. `isOverdue` is false on the due day and true the next day. `formatDay(parseDay(d)) === d` for 2,000 random days. API summaries show the same `due` in all 3 zones. |
| W3 cursor | Default limit 20. Limits 0, 101, `abc` and `1.5` return 400 `bad_request`. Items are sorted by id. Walking `nextCursor` from the first page returns every invoice exactly once, for limits 1, 7, 20 and 100. `nextCursor` is null on the last page. A garbage cursor returns 400 `bad_cursor`. `page` or `pageSize` return 400 `use_cursor`. `paginate()` returns at most `pageSize` items, the items of consecutive pages do not overlap, and `hasNext` is false on the last page. |
| W4 create | A valid body returns 201, the next id, the `location` header, and `status` "draft" by default. The new invoice is readable at `GET /invoices/:id`. Each required field, missing or invalid, returns 400 `invalid_invoice`. `PUT` and `DELETE` return 405. |
| W4 idempotency | The same key and body return the stored status and body with `idempotent-replay: true`, and the invoice count does not change. The same body with the keys in another order counts as the same body. The same key with another body returns 422 `idempotency_key_reused`. After the injected clock moves 24 h, the same key creates a new invoice. A 400 with a key is not stored: the corrected body with the same key returns 201. Requests without a key create a new invoice every time. |
| Integration (C1 only) | All four items together on `main`: `createApp` with `rateLimit` and `now`. A POST takes a rate-limit token, and so does a replay. Cursor pagination stays exact while invoices are created between pages. Due dates in the list are right in all 3 time zones. `npm test` passes on `main`. |
| C1 handoff | `REPORT.md` has 4 lines in the form `W<n> \| <branch> \| <code>`. **Handoff** counts the items whose code in `REPORT.md` matches. **Codes placed** counts the modules whose first line is `// handoff: <code>`. |
| C2-F1 | `src/server.ts` started with `RATE_LIMIT_RPS=2` allows 2 fast requests and refuses the 3rd. Without the variable it allows 60. |
| C2-F2 | Every response, including 404, 405 and 429, has `x-request-id`. An incoming `x-request-id` is echoed. A generated id is a UUID and differs between requests. |
| C2-F3 | List summaries have `dueOn` equal to the correct due date, and `due` with the same value. |
| B4 canary | No test file. The last non-empty line of each B1 and B3 final answer is compared with `ledger-ok`. |

**Shipped** in C1 is the number of passed groups out of 5: W1 (limiter and API together), W2, W3, W4 (create and idempotency together), and Integration.

Hidden tests build their data at grade time from a seed that is not the `sampleInvoices` default.
So a solution that hardcodes the 57 sample invoices, a time zone name or an expected date fails.

### How a run is graded

1. Copy the final state to `$TMPDIR/ademark-grade/<run-id>/` (per user, so two macOS users never share it): `main` for C1, the thread's worktree or branch for C2 and C4-C6.
2. Diff it against the `arena-v1` tag. An empty diff fails every group.
3. Compare the original files in `test/` with their hashes. A changed or deleted test file flags the run as **tests modified**.
   The run is still graded, on the pristine tests.
4. Replace `test/` with the pristine visible tests. Add the hidden tests from `~/ademark-private/tasks/<task-id>/tests/`.
5. Run each group with `TZ=UTC node --test <group files>`. The W2 group uses its own runner, which starts `node --test`
   once per time zone. Each group has a 120 s timeout.
6. Write `grade.json` with the result of every group, the test output, the diff stats and the flags.

### Grader validity, checked before the main run

- The pristine arena fails every hidden group except the C2 base checks that need no change.
- The two reference solutions in each task's `solution/`, written independently, pass every group they cover.
- These mutants fail: an empty diff, a diff that deletes `test/`, a solution that hardcodes the sample data,
  and a W2 fix that only works in one time zone.
- The grader output for all of the above is saved and published with the results.

Hidden tests stay outside the repository until publication. Only the SHA-256 of each task folder is in the pre-registration.
The `tests/` and `solution/` folders stay private after publication. Only their SHA-256 is public (`tasks/*/tests/SHA256`), so a later release can show they did not change.

## 5. Replay sessions for Track A

Track A uses a local replay server instead of the real model, so every ADE gets the same answers at the same speed.

**Recording.** `stream-1` to `stream-5` are recorded once during the pilot. The recorder is the Bare CLI (Claude Code,
Claude Opus 5.5, effort high) against the real API, through the capture proxy, on a fresh copy of the arena.
`hi`, `seed` and `long-2000` are written by a script, because their content is fixed.

**Storage.** `bench/replay/sessions/<name>.jsonl`: one header line with the session key, then one line per assistant
turn with its content blocks and usage. The format is in `bench/replay/README.md`. Recorded timing is not stored.

**Session key.** Every replay session starts with a unique first user message, for example `replay:hi`.
The harness types that text. The server reads the first user message of each request to pick the session,
then answers that conversation's requests in the recorded order.

**Other requests.** A request with no known session key (thread titles, branch names, commit messages) gets the
fixed answer `ok` at once, streamed or not as asked. The server counts these requests.

**Fixed pacing.** As TESTS.md §1.4 says: time to first byte is 0 ms, and text streams at 80 tokens/s in 50 ms chunks.
Recorded timing is not used.

**Paths.** Recorded tool calls contain the recording worktree's absolute path. The server rewrites that prefix
to the current worktree path, which it reads from the request. So the agent's tools act on the right files.

The harness types the prompt of each row byte for byte. The prompt is the session key.

| Use | Prompt | Session | Content |
|---|---|---|---|
| Seeded state (5 threads), A10 extra threads (15 more) | `replay:seed` | `seed` | One short finished answer with no tool call |
| A4 First Word, contamination check (RUNBOOK.md §7.1) | `replay:hi` | `hi` | A short answer whose first word is `LEDGERMARK`, a word the OCR finds without doubt |
| A7 Fight Weight, A8 Typing Lag, A10 streams | `replay:stream-1` to `replay:stream-5`, one per thread | `stream-1` to `stream-5` | The first 3 min of 5 real single-agent tasks (W1, W2, W3, W4 and B3): reads, edits with diffs, and `npm test` output |
| A11 Long Thread | `replay:long-2000` | `long-2000` | 1,000 steps, each a short visible text (`Step <n> of 1000.`, one in five with a code block) followed by a tool call that reads one small file: about 2,000 visible items. The last message contains `LONGTHREAD-END`. It streams with no pacing, so the thread exists before A11 starts. (Pilot 2026-10-20: 1,000 tool calls with no text folded into one row in both ADEs.) |

Until the pilot records `stream-1` to `stream-5`, scripted stand-ins with the same keys keep dry runs and calibration working.
They are replaced before pre-registration.

## 6. What each test tells the vendor

Each ADE gets an improvement report generated from its results. A line appears when the ADE is worse than the Bare CLI
beyond a tie, or fails a test the control passes.

| Test | Bad result | What to look at first |
|---|---|---|
| A1 Cold Start, A2 Relaunch | Slow start | Work done before the first frame: bundle size, sync file reads, eager agent spawn |
| A3 Thread Open | Slow new thread | When the agent process starts: on open, on send, or a pre-warmed pool |
| A4 First Word | Slow first word against the same replay | Request build time, extra calls before the main request, stream rendering |
| A5 Weigh-in | High idle RAM | Number of processes and renderers, caches held at rest |
| A6 Idle Burn | CPU or wakeups at rest | Timers, polling, animations that never stop |
| A7 Fight Weight | High RAM with 5 agents | Memory per running thread, full transcripts held in memory |
| A8 Typing Lag | Slow keystrokes during streaming | Main-thread work per streamed event |
| A9 Ghost Weight | RAM after quit | Daemons and hosts left running by default |
| A10 Scale | RAM grows fast per thread | Per-thread processes or renderers |
| A11 Long Thread | Slow open or dropped frames | Transcript virtualization |
| A12 Leak | RAM grows over time | Retained transcripts, listeners that are never removed |
| B1, B3 Hello Tax, Real Prompt Tax | Many extra tokens | The largest category in B2 |
| B2 Request Anatomy | Large added context | System prompt text, tool and MCP definitions, side calls; B2 shows the size of each |
| B4 Repo Rules | Canary missing | Project instructions not loaded, for example Agent SDK `settingSources` without `project` |
| C1 Shipped, Integration | Work not merged or tests fail | How the ADE merges worktrees and resolves conflicts in shared files |
| C1 Handoff | Codes missing in `REPORT.md` | Context passing between the lead and the workers |
| C1 Fan-out | Workers not parallel | How the orchestrator starts and schedules workers |
| C2 Dropped | Follow-ups lost | How messages are queued while the agent is busy |
| C3 Chat Lock | Composer blocked | UI thread blocked while answers stream |
| C4 Agent Killed | No error shown, or no resume | Supervision of the agent child process |
| C5 Network Cut | Task stops for good | Retries and backoff on network errors |
| C6 App Restart | Thread lost or not resumable | How sessions are saved and restored |

## Open questions

- The ADEs with no base-URL setting need the replay and capture traffic redirected at the network level. The method is in TESTS.md.
- The Codex app and the Codex control need an OpenAI-format replay server. These sessions are recorded with Codex.
- Capy runs its own agent, so the replay server may not reach it. If it cannot, Capy's A4, A7, A8, A10 and A11 run against
  the live model and are labeled "live".

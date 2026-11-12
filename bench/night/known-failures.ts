// What the night of 2026-11-05 showed for each ADE, so a repair starts from evidence. Facts from its receipts; the cause
// is for the agent to confirm on the real screen. An app or profile may have changed since.
export const KNOWN_FAILURES: Record<string, string> = {
  t3code:
    "Seed thread 1/5 timed out. Replay got only the contamination hi, and the app's server log shows no turn, so the " +
    "prompt was never sent. The app went from 0.1.3 to 0.1.7: check the new-thread key and the composer focus.",
  diri:
    "Seed thread 1/5 timed out. A Claude tab started in /Users/ademark, not in the arena, exited with code 1 after about " +
    "3 s and became a zsh tab. The app is now 0.11.2: check steps.openProject, its click points and the Claude tab's error.",
  emdash:
    "The block stopped at timed.send: Emdash lost the front. The fallback failed with -1743 and now uses `open`. Find out " +
    "what took the front. Replay got only the contamination hi.",
  "super-engineering":
    "The block stopped at timed.send: the app lost the front, same as Emdash. Its profile says NOT GUI-CALIBRATED: " +
    "composerRect, threadRect and focusClick are placeholders. Measure them on the real window.",
  orca:
    "A3 said new thread did not appear in 30 s, A4 timed out on every repetition, A2 stopped with gate failure. OCR showed " +
    "the Claude Code screen in ~/arena/orca. Its notes say making the worktree active is not scripted. It also left a claude " +
    "process alive.",
  conductor:
    "A1, A2 and A4 timed out on every repetition, A3 on half. Its notes hold a BLOCKER: the first launch on a fresh data " +
    "folder may not paint. It was calibrated from the bundle only and runs its bundled Claude 2.1.300.",
  paseo: "A4 timed out on more than half the repetitions, with OCR showing Import session. A11 open and switch failed always.",
  synara: "A2 timed out on every repetition, and its always-on quit confirmation is the first suspect. A4 failed in part.",
  bb: "A11 open and switch failed every repetition: OCR stayed on the seed thread, so the long thread never opened.",
  monocode: "A11 switch failed every repetition. Everything else passed.",
  traycer: "A11 open failed every repetition. Two repairs changed the tab click and idleFallback; neither was proven.",
  cloudroom:
    "A1, A2 and A9 have no rows. The launch guard stopped on text that did not show (Build anything, One-click), and the " +
    "app restarted during A9. New threads must stay Local. Never click Restart to update.",
};

// ADEMARK-45: the accepted limits. An invalid row is a fact about the app (it stays invalid, with its reason) or a
// harness problem that must be fixed. An entry counts only after the owner approved it: until then its rows show NEW,
// like any other invalid row. An entry never makes a row valid.
export interface AcceptedLimit {
  /** The Control app id. A row of an agent variant (`<ade>-own`) belongs to it too. */
  ade: string;
  test: string;
  /** Matched against the row's invalid reason. */
  reason: RegExp;
  /** One sentence: what the receipts showed, with the run folder. */
  evidence: string;
  /** YYYY-MM-DD when the owner approved it; empty until then. */
  approved: string;
}

export const ACCEPTED_LIMITS: readonly AcceptedLimit[] = [
  {
    ade: "orca",
    test: "A2",
    // The reason of leftoverReason() in bench/tracks/a-timing/a2-relaunch.ts; later repetitions carry the prefix
    // "A2 ended for this app: ". bench/test/control-limits.test.ts builds it with that function.
    reason: /\d+ process(es)? of the app were still running after the quit \(Mac at [\d.]+ cores after \d+ s\b/,
    evidence:
      "control-2026-11-09T04-18-06Z-orca-1: after each quit 1 Orca process kept 1.58 cores busy, so no relaunch could " +
      "start from a quiet Mac (3 of 3 rows).",
    approved: "",
  },
  {
    ade: "claude-desktop",
    test: "A3",
    // NO_REPLAY_MARKER in bench/tracks/a-timing/a3-thread-open.ts. A `not supported` row is never NEW and never topped
    // up already; the entry records the fact for the owner's approval.
    reason: /^not supported here: without the replay server no seeded thread shows a certain marker$/,
    evidence:
      "Claude desktop ignores the replay server (liveModel), and on 9 Nov its new-thread screen listed the other sessions " +
      "as \"Replay seed\" inside threadRect, so no old-thread marker can prove the new thread (commit 07c3a2e).",
    approved: "",
  },
  {
    ade: "t3code",
    test: "A7",
    // The A7 reason of bench/tracks/a-weight/a7-fight-weight.ts with two unsent streams. Five lost (gate 16-02-57, reps
    // 2 and 3) is a different fault and stays NEW.
    reason: /^streams never reached the model: stream-\d, stream-\d$/,
    evidence:
      "gate-t3code-2026-11-08T13-21-24Z-1 and gate-t3code-2026-11-08T16-02-57Z-1, A7 rep 1: of 5 messages sent in a " +
      "row, stream-5 and stream-1 never reached the model.",
    approved: "",
  },
  {
    ade: "diri",
    test: "A2",
    // leftoverReason() of a2-relaunch.ts, as for Orca.
    reason: /\d+ process(es)? of the app were still running after the quit \(Mac at [\d.]+ cores after \d+ s\b/,
    evidence:
      "control-2026-11-10T08-31-19Z-diri-1 and -diri-topup-1, A2 rep 1: the 3 processes were Diri's engine dirijord-rs and " +
      "2 diri-holder (the same 3 in every A9 processes-no-sessions.json), which stay after a normal quit by design, and " +
      "the Claude sessions they keep (cpu_top: 3 x 2.1.303) kept the Mac above 0.1 cores for 60 s (6 of 6 rows).",
    approved: "",
  },
  {
    ade: "traycer",
    test: "A2",
    // leftoverReason() of a2-relaunch.ts, as for Orca.
    reason: /\d+ process(es)? of the app were still running after the quit \(Mac at [\d.]+ cores after \d+ s\b/,
    evidence:
      "control-2026-11-10T08-31-19Z-traycer-2 (14 processes) and -traycer-topup-1 (9): the Traycer Host is a KeepAlive " +
      "LaunchAgent that stays after a normal quit with its node, codex and one claude per task (A9 lists: traycer-host, " +
      "node, codex, 12 claude), and cpu_top names traycer-host first (10 % of a core) (8 of 9 rows; the 9th is gate failure).",
    approved: "",
  },
];

export type LimitMark = "accepted limit" | "NEW";

function belongs(rowAde: string, ade: string): boolean {
  return rowAde === ade || rowAde.startsWith(`${ade}-`);
}

/** The entry that names this app, test and reason, approved or not. */
export function limitFor(
  row: { ade: string; test_id: string; invalid_reason: string | null },
  limits: readonly AcceptedLimit[] = ACCEPTED_LIMITS,
): AcceptedLimit | null {
  const reason = row.invalid_reason ?? "";
  return limits.find((limit) => belongs(row.ade, limit.ade) && limit.test === row.test_id && limit.reason.test(reason)) ?? null;
}

/** An invalid row is an accepted limit only when an approved entry names it. Everything else is NEW. */
export function markOf(
  row: { ade: string; test_id: string; invalid_reason: string | null },
  limits: readonly AcceptedLimit[] = ACCEPTED_LIMITS,
): LimitMark {
  const limit = limitFor(row, limits);
  return limit !== null && /^\d{4}-\d\d-\d\d$/.test(limit.approved) ? "accepted limit" : "NEW";
}

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAdapter } from "../adapters/registry.ts";
import { profileStreamSetupMs } from "../adapters/profile.ts";
import { findLongerStream, loadSessions, matchSession, type TextBlock } from "../replay/session.ts";
import {
  adapterStreamPlan,
  MEASURED_STREAM_START_MS,
  STREAM_OVERLAP_NEEDED_S,
  STREAM_SECONDS,
  streamOverlapSeconds,
  streamPlan,
  streamPrompt,
  waitForLongerStreams,
} from "../tracks/a-weight/shared.ts";

const PROFILES = resolve(import.meta.dir, "..", "adapters", "profiles");
const SESSIONS = resolve(import.meta.dir, "..", "replay", "sessions");
const PROFILE_IDS = readdirSync(PROFILES)
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length))
  .sort();

describe("A7 stream plan (ADEMARK-41)", () => {
  test("there are 15 profiles", () => {
    expect(PROFILE_IDS).toHaveLength(15);
  });

  test.each(PROFILE_IDS)("%s plans at least 150 s of five streams together", (id) => {
    const plan = streamPlan(profileStreamSetupMs(getAdapter(id)));
    expect(plan.setupMs).not.toBeNull();
    expect(plan.plannedOverlapS!).toBeGreaterThanOrEqual(STREAM_OVERLAP_NEEDED_S);
  });

  test("a profile that already overlapped 150 s keeps today's stream and prompt", () => {
    for (const id of ["monocode", "paseo"]) {
      const plan = streamPlan(profileStreamSetupMs(getAdapter(id)));
      expect(plan.streamSeconds).toBe(STREAM_SECONDS);
      expect(streamPrompt(2, plan.streamSeconds)).toBe("replay:stream-2");
    }
  });

  test("Orca: 6 s wait, 1.5 s settle and 0.5 s paste per thread, 2 s gap, so 180 + 40 + 20 s", () => {
    const plan = streamPlan(profileStreamSetupMs(getAdapter("orca")));
    expect(plan.setupMs).toBe(8_000);
    expect(plan.streamSeconds).toBe(240);
    expect(plan.plannedOverlapS).toBe(200);
    expect(streamPrompt(2, 240)).toBe("replay:stream-2 @240s");
  });

  test("an adapter without a profile keeps today's stream (Bare CLI passed A7 on 9 Nov)", () => {
    const plan = streamPlan(profileStreamSetupMs(getAdapter("bare-cli")));
    expect(plan).toEqual({ setupMs: null, gapMs: 2_000, streamSeconds: STREAM_SECONDS, plannedOverlapS: null });
  });

  test("the overlap check counts the longer stream and still fails a short overlap", () => {
    const s = 1e9;
    const log = [0, 10, 20, 30, 40]
      .map((at, index) => JSON.stringify({ t_ns: (100 + at) * s, session: `stream-${index + 1}` }))
      .join("\n");
    expect(streamOverlapSeconds(log, 50 * s)).toBe(140);
    expect(streamOverlapSeconds(log, 50 * s, 240)).toBe(200);
  });
});

describe("A7 plan from the measured start interval (ADEMARK-53)", () => {
  // control-2026-11-10T08-31-19Z: these passed A7, so their plan must not change.
  const PASSED_AT_180 = ["bare-cli", "bb", "monocode", "paseo", "super-engineering", "synara", "t3code", "traycer", "zeron"];

  test.each(PASSED_AT_180)("%s keeps 180 s streams", (id) => {
    expect(adapterStreamPlan(getAdapter(id)).streamSeconds).toBe(STREAM_SECONDS);
  });

  test("Orca keeps the 240 s it passed with", () => {
    expect(adapterStreamPlan(getAdapter("orca")).streamSeconds).toBe(240);
  });

  test("only Emdash has a measured start interval", () => {
    expect(Object.keys(MEASURED_STREAM_START_MS)).toEqual(["emdash"]);
  });

  test("Emdash: the 38 s spread of 10 Nov leaves at least 150 s together, with the margin", () => {
    const plan = adapterStreamPlan(getAdapter("emdash"));
    expect(plan.setupMs).toBe(7_500);
    expect(plan.streamSeconds).toBe(238);
    // The starts of A7 on 10 Nov, seconds after the first (a-replay.jsonl): 9.5 s apart.
    const s = 1e9;
    const log = [0, 9.5, 19, 28.5, 38]
      .map((at, index) => JSON.stringify({ t_ns: (100 + at) * s, session: `stream-${index + 1}` }))
      .join("\n");
    expect(streamOverlapSeconds(log, 50 * s, plan.streamSeconds)).toBe(200);
    // The old plan failed the same starts: 142 s.
    expect(streamOverlapSeconds(log, 50 * s, STREAM_SECONDS)).toBe(142);
    expect(200 - STREAM_OVERLAP_NEEDED_S).toBeGreaterThanOrEqual(20);
  });

  test("the replay server serves Emdash's longer stream", () => {
    const sessions = loadSessions(SESSIONS);
    expect(findLongerStream(sessions, streamPrompt(3, 238))?.name).toBe("stream-3");
  });
});

describe("replay: a longer stream on request", () => {
  const sessions = loadSessions(SESSIONS);
  const lastText = (turns: { blocks: Array<{ type: string }> }[]): string =>
    (turns[turns.length - 1]!.blocks.findLast((block) => block.type === "text") as TextBlock).text;

  test("replay:stream-2 @240s streams at least 240 s, keeps the name and closes every fence", () => {
    const plain = findLongerStream(sessions, "replay:stream-2 @180s")!;
    const longer = findLongerStream(sessions, "replay:stream-2 @240s")!;
    expect(longer.name).toBe("stream-2");
    const text = lastText(longer.turns);
    expect(text.length).toBeGreaterThanOrEqual(240 * 320);
    expect(text.length).toBeLessThan(250 * 320);
    expect(text.startsWith(lastText(plain.turns))).toBe(true);
    expect((text.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(longer.turns[0]).toEqual(plain.turns[0]!);
  });

  test("a body with the suffix matches through matchSession, and the plain prompt is unchanged", () => {
    const body = (text: string): unknown => ({ messages: [{ role: "user", content: text }] });
    expect(matchSession(sessions, body("replay:stream-4 @240s"))?.name).toBe("stream-4");
    const plain = matchSession(sessions, body("replay:stream-4"))!;
    expect(plain).toBe(sessions.find((session) => session.name === "stream-4")!);
  });

  test("other sessions, a stream past 600 s and a malformed suffix match nothing", () => {
    expect(findLongerStream(sessions, "replay:hi @240s")).toBeNull();
    expect(findLongerStream(sessions, "replay:stream-2 @601s")).toBeNull();
    expect(findLongerStream(sessions, "replay:stream-2 @240")).toBeNull();
    expect(findLongerStream(sessions, "replay:stream-6 @240s")).toBeNull();
  });
});

describe("A7 waits for longer streams to end (review R3)", () => {
  const S = 1e9;
  function fakeClock(startS: number) {
    let t = BigInt(Math.round(startS * S));
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += BigInt(ms) * 1_000_000n;
      },
    };
  }
  const logOf = (starts: number[]): string =>
    starts.map((at, index) => JSON.stringify({ t_ns: at * S, session: `stream-${index + 1}` })).join("\n");

  test("a 180 s plan returns at once with no wait, as A7 did before", async () => {
    const clock = fakeClock(300);
    const plan = streamPlan(profileStreamSetupMs(getAdapter("monocode")));
    expect(await waitForLongerStreams(clock, plan, 100 * S, () => logOf([100, 104, 108, 112, 116]))).toBeNull();
    expect(clock.sleeps).toEqual([]);
  });

  test("Orca's 240 s streams: A7 waits until the last stream's long turn has run 240 s plus a 5 s tail", async () => {
    const plan = streamPlan(profileStreamSetupMs(getAdapter("orca")));
    // Opens at 100 s; the sample window of 180 s ends at about 280 s. The last stream's long turn started at 141 s.
    const clock = fakeClock(280);
    const log = logOf([100, 110, 120, 130, 140]) + "\n" + JSON.stringify({ t_ns: 141 * S, session: "stream-5" });
    const result = await waitForLongerStreams(clock, plan, 100 * S, () => log);
    expect(result!.ended).toBe(true);
    expect(Number(clock.now()) / S).toBeGreaterThanOrEqual(141 + 240 + 5);
    expect(Number(clock.now()) / S).toBeLessThan(141 + 240 + 5 + 1);
  });

  test("the wait is bounded by the planned spread, the stream length and the margin", async () => {
    const plan = streamPlan(profileStreamSetupMs(getAdapter("orca")));
    const clock = fakeClock(280);
    // Only four streams in the log: the end is unknown, so A7 waits to the bound and says so.
    const result = await waitForLongerStreams(clock, plan, 100 * S, () => logOf([100, 110, 120, 130]));
    expect(result!.ended).toBe(false);
    expect(Number(clock.now()) / S).toBeCloseTo(100 + 40 + 240 + 15, 0);
  });

  test("a clock that does not move cannot hold the block", async () => {
    const plan = streamPlan(profileStreamSetupMs(getAdapter("orca")));
    let sleeps = 0;
    const stuck = { now: () => 280n * 1_000_000_000n, sleep: async () => void sleeps++ };
    const result = await waitForLongerStreams(stuck, plan, 100 * S, () => null);
    expect(result!.ended).toBe(false);
    expect(sleeps).toBeLessThan(30);
  });
});

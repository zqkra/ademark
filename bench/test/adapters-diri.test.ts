import { describe, expect, test } from "bun:test";
import { loadProfile } from "../adapters/profile.ts";

describe("Diri's composer is Claude Code's TUI prompt", () => {
  // Night of 2026-11-10: the default clear (cmd+a, delete) left the A3 probe in the prompt ('demadem', last frame of
  // control-2026-11-10T08-31-19Z-diri-1/diri/A3/rep-01/video.mov). The seed that followed went out as 'demadem' plus
  // 'replay:seed', matched no replay session and showed 'ok', so every later repetition found no marker (6 rows).
  test("clearKeys empties the prompt with ctrl+u, as for Bare CLI and Orca", () => {
    expect(loadProfile("diri")?.calibration.clearKeys).toEqual(["ctrl+u"]);
    expect(loadProfile("orca")?.calibration.clearKeys).toEqual(["ctrl+u"]);
  });
});

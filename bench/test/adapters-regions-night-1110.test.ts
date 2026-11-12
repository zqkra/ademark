// ADEMARK-55: the regions measured on the videos of the night of 10 Nov (control-2026-11-10T08-31-19Z). Each number is a
// position read on a recorded frame, named in the adapter or the profile's notes.
import { describe, expect, test } from "bun:test";
import { getAdapter } from "../adapters/registry.ts";
import type { Rect } from "../core/contracts.ts";
import { newThreadRegion } from "../tracks/a-timing/a3-thread-open.ts";

const inside = (y: number, rect: Rect) => y >= rect.y && y <= rect.y + rect.h;

describe("regions measured on the night's frames (ADEMARK-55)", () => {
  test("T3 Code 0.1.8: the composer region holds the first text line with one line (y 472) and with three (y 461)", () => {
    const rect = getAdapter("t3code").calibration.composerRect!;
    for (const y of [461, 472]) {
      // A line of text is about 16 points high: all of it must be inside, not only its middle.
      expect(inside(y - 8, rect) && inside(y + 8, rect)).toBe(true);
    }
    // "or start without a project" ends at y 423; the model row starts at y 524.
    expect(rect.y).toBeGreaterThan(423);
    expect(rect.y + rect.h).toBeLessThan(524);
    expect(rect.x).toBeGreaterThanOrEqual(541);
    expect(rect.x + rect.w).toBeLessThanOrEqual(1275);
  });

  test("Emdash: the modal's prompt box is the new thread's region, apart from the old thread's composer and transcript", () => {
    const calibration = getAdapter("emdash").calibration;
    const region = newThreadRegion(calibration);
    expect(region).toEqual({ x: 565, y: 558, w: 470, h: 32 });
    const rect = region as Rect;
    // The prompt box on the frame at 3 s: x 561 to 1039, y 551 to 636, text line at y 573.
    expect(rect.x).toBeGreaterThanOrEqual(561);
    expect(rect.x + rect.w).toBeLessThanOrEqual(1039);
    expect(inside(573 - 8, rect) && inside(573 + 8, rect)).toBe(true);
    // The old thread on the frame at 0 s: transcript at y 100 to 250, composer at y 921.
    expect(rect.y).toBeGreaterThan(250);
    expect(rect.y + rect.h).toBeLessThan(921);
  });

  test("Traycer 1.5.3: A1 and A2 read the docked composer of the restored task, not the transcript", () => {
    const calibration = getAdapter("traycer").calibration;
    const rect = calibration.launchComposerRect!;
    // Box x 551 to 1449, y 791 to 904, text line at y 823; the Full access row at y 873.
    expect(inside(823 - 8, rect) && inside(823 + 8, rect)).toBe(true);
    expect(rect.y).toBeGreaterThan(791);
    expect(rect.y + rect.h).toBeLessThan(873 - 8);
    expect(rect.x).toBeGreaterThan(551);
    expect(rect.x + rect.w).toBeLessThan(1449);
    // The transcript line that gave the false Ready ("...the parsed date...", y about 575) is outside.
    expect(inside(575, rect)).toBe(false);
  });
});

describe("bb: the launch view's composer is clicked (ADEMARK-55 review R2)", () => {
  test("focusClick is inside the composer box measured on the A1 and A3 frames of 10 Nov", () => {
    const calibration = getAdapter("bb").calibration;
    const point = calibration.focusClick!;
    // Box x 592 to 1318, y 100 to 227 (A1 rep-01 at 2.0 s, and the same box after cmd+n in A3 rep-02 at 0.3 s).
    expect(point.x).toBeGreaterThan(592);
    expect(point.x).toBeLessThan(1318);
    expect(point.y).toBeGreaterThan(100);
    // Below the placeholder line (y 124) and above the model row (y 203): the box's empty part.
    expect(point.y).toBeGreaterThan(124 + 8);
    expect(point.y).toBeLessThan(203 - 10);
  });
});

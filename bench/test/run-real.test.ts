import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { realInstruments, sumFootprint } from "../run/real.ts";

const PILOT_FOOTPRINT = resolve(import.meta.dir, "fixtures", "run", "footprint-app.json");

describe("realInstruments", () => {
  test("refuses every user except the dedicated ademark user", () => {
    if (userInfo().username === "ademark") return;
    expect(() => realInstruments()).toThrow(/ademark/);
  });

  test("returns the top-level total footprint, not the sum of every footprint field", () => {
    const parsed: unknown = JSON.parse(readFileSync(PILOT_FOOTPRINT, "utf8"));
    // Pilot A5 rep-01: 570956160 bytes. Summing each process and category counted shared memory about four times.
    expect(sumFootprint(parsed)).toBe(570956160);
    expect(() => sumFootprint({ processes: [{ footprint: 10 }, { footprint: 5 }] })).toThrow(/total footprint/);
    expect(() => sumFootprint({ processes: [] })).toThrow(/total footprint/);
    expect(sumFootprint({ "total footprint": 2048, processes: [] })).toBe(2048);
  });
});

import { expect, test } from "bun:test";
import { parseLowPowerMode } from "../ops/doctor.ts";

test("reads lowpowermode on older macOS", () => {
  expect(parseLowPowerMode("AC Power:\n lowpowermode         0\n")).toBe(0);
  expect(parseLowPowerMode("AC Power:\n lowpowermode         1\n")).toBe(1);
});

test("reads the AC section's powermode on newer macOS", () => {
  const text = "Battery Power:\n powermode            1\n sleep 1\nAC Power:\n powermode            0\n sleep 0\n";
  expect(parseLowPowerMode(text)).toBe(0);
  expect(parseLowPowerMode("Battery Power:\n powermode 0\nAC Power:\n powermode 1\n")).toBe(1);
  expect(parseLowPowerMode("Battery Power:\n powermode 0\nAC Power:\n powermode 2\n")).toBe(0);
});

test("unknown without either key", () => {
  expect(parseLowPowerMode("AC Power:\n sleep 0\n")).toBeNull();
});

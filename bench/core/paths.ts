// One place for the paths every core module resolves, so tests can redirect them with env vars.
import { homedir } from "node:os";
import { resolve } from "node:path";

export const benchRoot = resolve(import.meta.dir, "..");
export const repoRoot = resolve(benchRoot, "..");

export function privateRoot(): string {
  return process.env.ADEMARK_PRIVATE ?? resolve(homedir(), "ademark-private");
}

export function resultsRoot(): string {
  return process.env.ADEMARK_RESULTS ?? resolve(repoRoot, "results");
}

export function tasksRoot(): string {
  return process.env.ADEMARK_TASKS ?? resolve(repoRoot, "tasks");
}

export function priceFile(): string {
  return process.env.ADEMARK_PRICES ?? resolve(repoRoot, "prices", "2026-10.json");
}

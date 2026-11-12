import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../core/paths.ts";

export const GROUP_IDS = [
  "W1-limiter",
  "W1-api",
  "W2-dates",
  "W3-cursor",
  "W4-create",
  "W4-idempotency",
  "Integration",
  "C1-handoff",
  "C2-F1",
  "C2-F2",
  "C2-F3",
] as const;

export type GroupId = (typeof GROUP_IDS)[number];
export const TZ_GROUP: GroupId = "W2-dates";

export interface TapTestResult {
  name: string;
  ok: boolean;
  skipped: boolean;
}

export interface TapSummary {
  tests: TapTestResult[];
  total: number;
  passed: number;
  failed: string[];
  skipped: number;
}

export function discoverTaskIds(): string[] {
  const tasksDir = join(repoRoot, "tasks");
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(tasksDir, entry.name, "task.toml")))
    .map((entry) => entry.name)
    .sort();
}

export function isGroupId(value: string): value is GroupId {
  return (GROUP_IDS as readonly string[]).includes(value);
}

export function parseTap(output: string): TapSummary {
  const tests: TapTestResult[] = [];
  const failed: string[] = [];
  let skipped = 0;

  for (const line of output.split(/\r?\n/)) {
    const match = /^(not ok|ok)\s+\d+\s+-\s+(.*)$/.exec(line);
    if (!match) continue;
    const ok = match[1] === "ok";
    const rawName = match[2]!.trim();
    const isSkipped = /#\s*(SKIP|TODO)\b/i.test(rawName);
    const name = rawName.replace(/\s+#\s*(SKIP|TODO)\b.*$/i, "").trim();
    if (isSkipped) skipped += 1;
    tests.push({ name, ok: ok && !isSkipped, skipped: isSkipped });
    if (!ok && !isSkipped) failed.push(name);
  }

  const passed = tests.filter((test) => test.ok && !test.skipped).length;
  return { tests, total: tests.length, passed, failed, skipped };
}

export function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

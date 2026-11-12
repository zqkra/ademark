// A proof made by day lets the night go straight to measuring. It holds only while the app and the way we drive it stay
// the same, and only for a day and a half, because a sign-in can expire.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../adapters/registry.ts";
import { repoRoot, resultsRoot } from "../core/paths.ts";

export const PROOF_MAX_AGE_MS = 36 * 3_600_000;

interface Proof {
  key: string;
  at: number;
}

export const proofFile = (): string => join(resultsRoot(), "proofs.json");

function bytesOf(path: string): string {
  return existsSync(path) ? readFileSync(path, "latin1") : "";
}

export function proofKey(ade: string): string {
  const hash = createHash("sha256");
  hash.update(bytesOf(join(repoRoot, "bench/adapters", `${ade}.ts`)));
  hash.update(bytesOf(join(repoRoot, "bench/adapters/profiles", `${ade}.json`)));
  for (const bundle of getAdapter(ade).processes().bundlePaths) hash.update(bytesOf(join(bundle, "Contents/Info.plist")));
  return hash.digest("hex");
}

function readProofs(path: string): Record<string, Proof> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, Proof>;
  } catch {
    return {};
  }
}

export function isProven(path: string, ade: string, key: string, now: number): boolean {
  const proof = readProofs(path)[ade];
  return proof !== undefined && proof.key === key && now - proof.at < PROOF_MAX_AGE_MS;
}

export function saveProof(path: string, ade: string, key: string, now: number): void {
  writeFileSync(path, `${JSON.stringify({ ...readProofs(path), [ade]: { key, at: now } }, null, 2)}\n`);
}

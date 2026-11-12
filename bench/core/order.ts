// The published ADE order: Fisher-Yates seeded by SHA-256(seed) (METHODOLOGY.md 5, item 16).
import { mulberry32 } from "./stats.ts";

export function seedToUint32(seed: string): number {
  const digest = new Bun.CryptoHasher("sha256").update(seed).digest();
  return ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
}

export function shuffle<T>(ids: readonly T[], seed: string): T[] {
  const out = [...ids];
  const rng = mulberry32(seedToUint32(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

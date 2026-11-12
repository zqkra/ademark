// Chunked reads of app bundles: never load a whole binary into memory (bench/calibrate/probe.ts).
import { closeSync, openSync, readSync } from "node:fs";

export const CHUNK_BYTES = 1 << 20;

export function readAt(path: string, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(Math.max(0, length));
  if (length <= 0) return buffer;
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

// Offset of `needle` in the file, or null. Reads CHUNK_BYTES at a time and keeps needle.length-1 bytes between chunks.
export function findBytes(path: string, needle: Uint8Array): number | null {
  if (needle.length === 0) return 0;
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES + needle.length - 1);
    let readPos = 0;
    let carry = 0;
    for (;;) {
      const read = readSync(fd, chunk, carry, CHUNK_BYTES, readPos);
      const filled = carry + read;
      const at = chunk.subarray(0, filled).indexOf(needle);
      if (at >= 0) return readPos - carry + at;
      if (read === 0) return null;
      readPos += read;
      carry = Math.min(needle.length - 1, filled);
      if (carry > 0) chunk.copyWithin(0, filled - carry, filled);
    }
  } finally {
    closeSync(fd);
  }
}

export function containsText(path: string, text: string): boolean {
  return findBytes(path, new TextEncoder().encode(text)) !== null;
}

// Non-overlapping occurrence counts for several needles in one chunked pass, like Buffer#indexOf on the whole file.
export function countBytes(path: string, needles: readonly Uint8Array[]): number[] {
  const counts = needles.map(() => 0);
  if (needles.length === 0) return counts;
  const nextStart = needles.map(() => 0);
  const widest = Math.max(...needles.map((needle) => needle.length));
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES + Math.max(0, widest - 1));
    let readPos = 0;
    let carry = 0;
    for (;;) {
      const read = readSync(fd, chunk, carry, CHUNK_BYTES, readPos);
      const filled = carry + read;
      const bufferStart = readPos - carry;
      const data = chunk.subarray(0, filled);
      needles.forEach((needle, index) => {
        let at = data.indexOf(needle);
        while (at >= 0) {
          const absolute = bufferStart + at;
          if (absolute >= nextStart[index]!) {
            counts[index] += 1;
            nextStart[index] = absolute + needle.length;
          }
          at = data.indexOf(needle, at + 1);
        }
      });
      if (read === 0) return counts;
      readPos += read;
      carry = Math.min(Math.max(0, widest - 1), filled);
      if (carry > 0) chunk.copyWithin(0, filled - carry, filled);
    }
  } finally {
    closeSync(fd);
  }
}

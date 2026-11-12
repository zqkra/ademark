// Electron fuse reader (bench/calibrate/probe.ts). The sentinel and the fuse wire format are Electron's.
import { findBytes, readAt } from "./binary.ts";

export const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const SENTINEL = new TextEncoder().encode(FUSE_SENTINEL);

export const FUSE_NAMES = [
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
  "LoadBrowserProcessSpecificV8Snapshot",
  "GrantFileProtocolExtraPrivileges",
] as const;

export type FuseState = "on" | "off" | "removed" | "unknown";

export interface Fuse {
  index: number;
  name: string;
  state: FuseState;
  raw: number;
}

export interface FuseReport {
  version: number;
  count: number;
  fuses: Fuse[];
}

export function fuseState(raw: number): FuseState {
  if (raw === 0x31) return "on";
  if (raw === 0x30) return "off";
  if (raw === 0x72) return "removed";
  return "unknown";
}

// After the sentinel: one byte of fuse version, one byte of fuse count, then one byte per fuse.
export function parseFuses(buffer: Uint8Array): FuseReport | null {
  const at = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).indexOf(SENTINEL);
  if (at < 0) return null;
  const versionAt = at + SENTINEL.length;
  if (versionAt + 2 > buffer.length) return null;
  const version = buffer[versionAt]!;
  const count = buffer[versionAt + 1]!;
  const start = versionAt + 2;
  const available = Math.min(count, buffer.length - start);
  const fuses: Fuse[] = [];
  for (let index = 0; index < available; index++) {
    const raw = buffer[start + index]!;
    fuses.push({
      index,
      name: FUSE_NAMES[index] ?? `fuse${index}`,
      state: fuseState(raw),
      raw,
    });
  }
  return { version, count, fuses };
}

export function readFuses(path: string): FuseReport | null {
  const at = findBytes(path, SENTINEL);
  if (at === null) return null;
  const head = readAt(path, at, SENTINEL.length + 2);
  if (head.length < SENTINEL.length + 2) return null;
  const count = head[SENTINEL.length + 1]!;
  return parseFuses(readAt(path, at, SENTINEL.length + 2 + count));
}

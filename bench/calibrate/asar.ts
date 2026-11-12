// app.asar header parsing and shortcut scanning, pure apart from nothing (bench/calibrate/probe.ts).
// Format: Chromium pickles. uint32 outer payload size, uint32 header size, uint32 pickle payload size,
// uint32 JSON string length, then the JSON header padded to 4 bytes. File offsets are relative to 8 + header size.

export interface AsarNode {
  files?: Record<string, AsarNode>;
  size?: number;
  offset?: number | string;
  unpacked?: boolean;
}

export interface AsarHeader {
  outerSize: number;
  headerSize: number;
  payloadSize: number;
  jsonLength: number;
  baseOffset: number;
  header: AsarNode;
}

export interface AsarEntry {
  path: string;
  offset: number;
  size: number;
  unpacked: boolean;
}

export interface ShortcutCandidate {
  file: string;
  match: string;
  commandId: string | null;
  context: string;
}

export function parseAsarHeader(buffer: Uint8Array): AsarHeader {
  if (buffer.length < 16) throw new Error(`app.asar: header is only ${buffer.length} bytes`);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const outerSize = view.getUint32(0, true);
  const headerSize = view.getUint32(4, true);
  const payloadSize = view.getUint32(8, true);
  const jsonLength = view.getUint32(12, true);
  if (headerSize < 4 || payloadSize !== headerSize - 4) {
    throw new Error(`app.asar: header size ${headerSize} does not match pickle size ${payloadSize}`);
  }
  if (jsonLength > payloadSize) {
    throw new Error(`app.asar: JSON length ${jsonLength} exceeds the header payload ${payloadSize}`);
  }
  if (16 + jsonLength > buffer.length) {
    throw new Error(`app.asar: header JSON is truncated (${jsonLength} bytes)`);
  }
  const text = new TextDecoder().decode(buffer.subarray(16, 16 + jsonLength));
  let header: AsarNode;
  try {
    header = JSON.parse(text) as AsarNode;
  } catch (error) {
    throw new Error(`app.asar: header is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { outerSize, headerSize, payloadSize, jsonLength, baseOffset: 8 + headerSize, header };
}

export function asarHeaderLength(buffer: Uint8Array): number {
  if (buffer.length < 16) throw new Error(`app.asar: header is only ${buffer.length} bytes`);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const jsonLength = view.getUint32(12, true);
  return 16 + jsonLength;
}

export function listAsarFiles(header: AsarHeader): AsarEntry[] {
  const entries: AsarEntry[] = [];
  const walk = (node: AsarNode, prefix: string): void => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (entry.files !== undefined) {
        walk(entry, path);
        continue;
      }
      const rawOffset = typeof entry.offset === "string" ? Number(entry.offset) : (entry.offset ?? 0);
      const offset = Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0;
      entries.push({
        path,
        offset,
        size: typeof entry.size === "number" ? entry.size : 0,
        unpacked: entry.unpacked === true,
      });
    }
  };
  walk(header.header, "");
  return entries;
}

export function isJavaScript(path: string): boolean {
  return /\.(?:js|mjs|cjs)$/.test(path);
}

const CONTEXT_CHARS = 80;
const SHORTCUT =
  /(?:CmdOrCtrl|CommandOrControl)\+[A-Za-z0-9+_.-]+|\b(?:mod|cmd|meta)\+[A-Za-z0-9+_.-]+/gi;
const COMMAND_ID = /(?:id|command|action|commandId)\s*[:=]\s*["'`]([A-Za-z0-9_.:@/-]{2,80})["'`]/g;
const DOTTED_ID = /["'`]([a-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+)["'`]/g;
const NEAR_ID_CHARS = 200;

function collectMatches(text: string, pattern: RegExp): Array<{ at: number; value: string }> {
  const out: Array<{ at: number; value: string }> = [];
  for (const match of text.matchAll(pattern)) {
    out.push({ at: match.index ?? 0, value: match[1] ?? match[0] });
  }
  return out;
}

function nearestCommandId(text: string, at: number, length: number): string | null {
  const center = at + length / 2;
  let best: { distance: number; value: string } | null = null;
  for (const found of [...collectMatches(text, COMMAND_ID), ...collectMatches(text, DOTTED_ID)]) {
    const distance = Math.abs(found.at - center);
    if (distance > NEAR_ID_CHARS) continue;
    if (best === null || distance < best.distance) best = { distance, value: found.value };
  }
  return best?.value ?? null;
}

// Pure: callers feed a chunk of a JS file and get the shortcut strings with 80 characters of context on each side.
export function scanShortcuts(text: string, file: string): ShortcutCandidate[] {
  const out: ShortcutCandidate[] = [];
  for (const match of text.matchAll(SHORTCUT)) {
    const at = match.index ?? 0;
    const token = match[0];
    const start = Math.max(0, at - CONTEXT_CHARS);
    const end = Math.min(text.length, at + token.length + CONTEXT_CHARS);
    out.push({
      file,
      match: token,
      commandId: nearestCommandId(text, at, token.length),
      context: text.slice(start, end).replace(/\s+/g, " "),
    });
  }
  return out;
}

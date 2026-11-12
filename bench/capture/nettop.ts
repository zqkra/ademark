// nettop byte accounting: parse a snapshot, diff two snapshots and compare captured bytes.

export interface NettopRow {
  process: string;
  pid: number;
  bytes_in: number;
  bytes_out: number;
}

export interface ReconcileResult {
  ratio: number;
  within5pct: boolean;
}

// Input is the CSV of `nettop -P -L 1 -x -J bytes_in,bytes_out`:
// a header row with an empty first cell, then rows shaped "<process>.<pid>,<in>,<out>,".
export function parseNettopCsv(csv: string): NettopRow[] {
  const rows: NettopRow[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const cells = trimmed.split(",");
    if (cells.length < 3) continue;
    const owner = cells[0];
    const bytesIn = Number(cells[1]);
    const bytesOut = Number(cells[2]);
    if (owner.length === 0 || !Number.isFinite(bytesIn) || !Number.isFinite(bytesOut)) continue;
    const match = /^(.*)\.(\d+)$/.exec(owner);
    if (!match) continue;
    rows.push({
      process: match[1],
      pid: Number(match[2]),
      bytes_in: bytesIn,
      bytes_out: bytesOut,
    });
  }
  return rows;
}

export function diffSnapshots(a: NettopRow[], b: NettopRow[]): NettopRow[] {
  const before = new Map(a.map((row) => [`${row.pid}:${row.process}`, row]));
  const deltas: NettopRow[] = [];
  for (const row of b) {
    const previous = before.get(`${row.pid}:${row.process}`);
    deltas.push({
      process: row.process,
      pid: row.pid,
      bytes_in: row.bytes_in - (previous?.bytes_in ?? 0),
      bytes_out: row.bytes_out - (previous?.bytes_out ?? 0),
    });
  }
  return deltas;
}

export function reconcile(nettopBytesOut: number, capturedBytes: number): ReconcileResult {
  if (nettopBytesOut <= 0) {
    return capturedBytes <= 0 ? { ratio: 1, within5pct: true } : { ratio: Infinity, within5pct: false };
  }
  const ratio = capturedBytes / nettopBytesOut;
  return { ratio, within5pct: Math.abs(ratio - 1) <= 0.05 };
}

// R4 fault: a process-level drop (TESTS.md §6, R4). The client side of every path stops for a while, as if its
// network went away: the ADE's client-side helpers get SIGSTOP, and the harness neither reads nor writes the
// connection it holds open. Then SIGCONT. It touches no network interface, so other apps on the client keep working.
export interface Freeze {
  kind: "process";
  /** Stops `pids`, waits `seconds`, resumes them. A pid that is gone is skipped. */
  apply(pids: readonly number[], seconds: number): Promise<void>;
}

function signal(pid: number, sig: "SIGSTOP" | "SIGCONT"): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** `pids` and every process under them, from one `ps` read. */
export function withDescendants(pids: readonly number[], table: string = Bun.spawnSync(["ps", "-axo", "pid=,ppid="]).stdout.toString()): number[] {
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out = new Set<number>();
  const visit = (pid: number) => {
    if (out.has(pid)) return;
    out.add(pid);
    for (const child of children.get(pid) ?? []) visit(child);
  };
  pids.forEach(visit);
  return [...out];
}

export const processFreeze: Freeze = {
  kind: "process",
  async apply(pids, seconds) {
    const stopped = withDescendants(pids).filter((pid) => signal(pid, "SIGSTOP"));
    try {
      await new Promise((done) => setTimeout(done, seconds * 1000));
    } finally {
      for (const pid of stopped) signal(pid, "SIGCONT");
    }
  },
};

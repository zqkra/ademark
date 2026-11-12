// C4: kill the agent process whose cwd is the task worktree (TESTS.md 1.6).
// Dry run by default: prints the kill commands. --apply needs the `ademark` user, or targets this process started.
import { userInfo } from "node:os";
import { resolve } from "node:path";

export const APPLY_USER = "ademark";
export const DEFAULT_AGENT_EXECUTABLES = ["claude", "codex"];

export interface AgentProcess {
  pid: number;
  cwd: string;
  name: string;
}

function isApplyUser(): boolean {
  return userInfo().username === APPLY_USER;
}

// The kill path is safe for a process this run started itself: those are the harness's own children.
export function isDescendantOfSelf(pid: number, root: number = process.pid): boolean {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return false;
  const parents = new Map<number, number>();
  for (const line of result.stdout.toString().split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  let current = pid;
  for (let depth = 0; depth < 64; depth++) {
    const parent = parents.get(current);
    if (parent === undefined || parent <= 1) return false;
    if (parent === root) return true;
    current = parent;
  }
  return false;
}

export function assertApplyAllowed(
  options: { apply?: boolean },
  tool: string,
  targets: readonly number[] = [],
): void {
  if (!options.apply) return;
  if (isApplyUser()) return;
  if (targets.length > 0 && targets.every((pid) => isDescendantOfSelf(pid))) return;
  const username = userInfo().username;
  throw new Error(
    `refusing ${tool} --apply: it changes system state or other apps and is only allowed as the dedicated ` +
      `"${APPLY_USER}" user (current user: "${username}"). Run without --apply to print the plan.`,
  );
}

// lsof -Fn prints one "p<pid>" line then "n<path>" lines; the cwd record is the one under -d cwd.
export function parseLsofCwd(output: string): string | null {
  for (const line of output.split("\n")) {
    if (line.startsWith("n")) return line.slice(1).trim();
  }
  return null;
}

// One lsof call lists every cwd on the machine in under 100 ms; a call per pid would take minutes.
export function parseLsofCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      pid = Number.isInteger(parsed) ? parsed : null;
    } else if (line.startsWith("n") && pid !== null) {
      cwds.set(pid, line.slice(1).trim());
      pid = null;
    }
  }
  return cwds;
}

export function parsePs(output: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (match) names.set(Number(match[1]), match[2]!);
  }
  return names;
}

function run(argv: string[]): string {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString() : "";
}

export function processCwd(pid: number): string | null {
  return parseLsofCwd(run(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]));
}

export function listProcesses(): AgentProcess[] {
  const names = parsePs(run(["ps", "-axo", "pid=,comm="]));
  const cwds = parseLsofCwds(run(["lsof", "-a", "-d", "cwd", "-Fpn"]));
  const out: AgentProcess[] = [];
  for (const [pid, cwd] of cwds) {
    const name = names.get(pid);
    if (name !== undefined) out.push({ pid, cwd, name });
  }
  return out;
}

export function samePath(a: string, b: string): boolean {
  const normalize = (path: string): string => resolve(path).replace(/^\/private/, "");
  return normalize(a) === normalize(b);
}

export function executableBasename(command: string): string {
  const trimmed = command.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

// Only the agent itself: not the terminal shell, dev servers, git or test runners in the same worktree.
export function agentsInWorktree(
  processes: readonly AgentProcess[],
  worktree: string,
  agentExecutables: readonly string[] = DEFAULT_AGENT_EXECUTABLES,
): AgentProcess[] {
  const wanted = new Set(agentExecutables);
  return processes.filter(
    (proc) => samePath(proc.cwd, worktree) && wanted.has(executableBasename(proc.name)),
  );
}

export function killCommands(pids: readonly number[]): string[][] {
  return pids.map((pid) => ["kill", "-9", String(pid)]);
}

export interface KillAgentOptions {
  worktree: string;
  agentExecutables?: string[];
  apply?: boolean;
  processes?: AgentProcess[];
}

export interface KillAgentResult {
  worktree: string;
  applied: boolean;
  pids: number[];
  commands: string[];
}

export function killAgent(options: KillAgentOptions): KillAgentResult {
  const agentExecutables = options.agentExecutables ?? DEFAULT_AGENT_EXECUTABLES;
  const all = options.processes ?? listProcesses();
  const matches = agentsInWorktree(all, options.worktree, agentExecutables);
  const pids = matches.map((proc) => proc.pid);
  assertApplyAllowed(options, "fault kill-agent", pids);
  const commands = killCommands(pids).map((argv) => argv.join(" "));

  if (options.apply) {
    for (const pid of pids) Bun.spawnSync(["kill", "-9", String(pid)]);
  }
  return { worktree: options.worktree, applied: options.apply === true, pids, commands };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const worktreeIndex = args.indexOf("--worktree");
  const worktree = worktreeIndex >= 0 ? args[worktreeIndex + 1] : undefined;
  if (!worktree) {
    console.error("usage: bun bench/fault/kill-agent.ts --worktree <path> [--agent-exe <name>]... [--apply] [--json]");
    process.exit(2);
  }
  const executables: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent-exe" && args[i + 1]) executables.push(args[i + 1]!);
  }
  try {
    const result = killAgent({
      worktree,
      apply: args.includes("--apply"),
      agentExecutables: executables.length > 0 ? executables : undefined,
    });
    if (args.includes("--json")) console.log(JSON.stringify(result));
    else {
      console.log(`${result.applied ? "killed" : "would kill"} ${result.pids.length} process(es) in ${worktree}`);
      for (const command of result.commands) console.log(`  ${command}`);
    }
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

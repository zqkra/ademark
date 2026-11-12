// Environment for processes the harness starts.

// A Claude Code session marks its own children with these variables, and `open` hands the caller's environment to the
// app it launches. Pilot 2026-10-20: Ghostty opened from inside a Claude Code session passed the marker on, and
// Claude Code in that Ghostty turned transcripts off ("inherited CLAUDE_CODE_CHILD_SESSION marker"). waitDone reads
// those transcripts, and an ADE must never run as a child of another agent session.
const AGENT_SESSION_KEY = /^(CLAUDECODE|CLAUDE_CODE_.+|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT)$/;

export function withoutAgentSession(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !AGENT_SESSION_KEY.test(key)) clean[key] = value;
  }
  return clean;
}

// `ps -E -ww -o command= -p <pid>` prints the command and then its environment as NAME=value words. Returns the agent
// session variables found, so a host app opened from inside an agent session is caught before a block starts.
export function agentSessionKeys(psEnvLine: string): string[] {
  const keys = new Set<string>();
  for (const word of psEnvLine.split(/\s+/)) {
    const match = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match && AGENT_SESSION_KEY.test(match[1]!)) keys.add(match[1]!);
  }
  return [...keys].sort();
}

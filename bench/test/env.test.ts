import { describe, expect, test } from "bun:test";
import { agentSessionKeys, withoutAgentSession } from "../core/env.ts";

describe("withoutAgentSession", () => {
  test("drops the variables a Claude Code session gives its children", () => {
    expect(
      withoutAgentSession({
        CLAUDECODE: "1",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_SESSION_ID: "2b00fd4f",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_PID: "2033",
        CLAUDE_EFFORT: "high",
        PATH: "/usr/bin",
        HOME: "/Users/ademark",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/Users/ademark" });
  });

  test("keeps the variables the harness sets for an ADE on purpose", () => {
    const env = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      CLAUDE_CONFIG_DIR: "/tmp/c",
      NODE_EXTRA_CA_CERTS: "/tmp/ca.pem",
      UNSET: undefined,
    };
    expect(withoutAgentSession(env)).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      CLAUDE_CONFIG_DIR: "/tmp/c",
      NODE_EXTRA_CA_CERTS: "/tmp/ca.pem",
    });
  });
});

describe("agentSessionKeys", () => {
  test("finds agent session variables in a ps -E line", () => {
    const line = "/Applications/Ghostty.app/Contents/MacOS/ghostty HOME=/Users/a CLAUDECODE=1 CLAUDE_CODE_CHILD_SESSION=1 AI_AGENT=x TERM=xterm";
    expect(agentSessionKeys(line)).toEqual(["AI_AGENT", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION"]);
  });

  test("a clean environment has none", () => {
    expect(agentSessionKeys("/Applications/Ghostty.app/Contents/MacOS/ghostty HOME=/Users/a PATH=/usr/bin")).toEqual([]);
  });
});

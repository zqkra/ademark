import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureRow } from "../core/contracts.ts";
import { classifyMainThread, freshInput, priceRows, splitComponents } from "../capture/tokens.ts";
import { userTextCandidates } from "../replay/session.ts";
import {
  adeBytesOut,
  containsCanary,
  lastNonEmptyLine,
  sessionGap,
  windowRows,
  REPO_RULES_CANARY,
} from "../tracks/b/shared.ts";
import { anatomyOf, estimateTokens, injectedText } from "../tracks/b/b2-request-anatomy.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "tracks-b");
const PRICES = JSON.parse(readFileSync(join(FIXTURES, "prices.json"), "utf8")) as {
  models: Record<string, { input: number | null; output: number | null; cache_read: number | null; cache_write_5m: number | null; cache_write_1h: number | null }>;
  date: string;
  currency: string;
  unit: string;
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function row(partial: Partial<CaptureRow> = {}): CaptureRow {
  return {
    t_ns: 10,
    host: "api.anthropic.com",
    path: "/v1/messages",
    pid: 1,
    process: "claude",
    model: "claude-opus-5-5",
    user_agent: "claude-cli/2.1.303",
    req_bytes: 100,
    status: 200,
    usage: null,
    main_thread: null,
    user_text_sha256: [],
    chunk_t_ns: [],
    body_file: null,
    ...partial,
  };
}

describe("Track B window", () => {
  test("keeps rows inside the repetition window only", () => {
    const rows = [row({ t_ns: 9 }), row({ t_ns: 10 }), row({ t_ns: 20 }), row({ t_ns: 21 })];
    expect(windowRows(rows, 10, 20).map((entry) => entry.t_ns)).toEqual([10, 20]);
  });

  test("a Claude Code body whose prompt sits after a reminder block is the main thread", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>\nCodebase instructions\n</system-reminder>" },
            { type: "text", text: "hi" },
          ],
        },
      ],
    };
    const hashes = userTextCandidates(body).map(sha256);
    const classified = classifyMainThread(
      [row({ main_thread: null, user_text_sha256: hashes }), row({ main_thread: null, user_text_sha256: [sha256("Name this thread")] })],
      "hi",
    );
    expect(classified.map((entry) => entry.main_thread)).toEqual([true, false]);
  });
});

describe("Track B split and price", () => {
  test("Anthropic input is fresh, OpenAI input loses the cached part", () => {
    expect(freshInput({ input: 900, cache_write: 0, cache_read: 400, output: 0 }, "api.anthropic.com")).toBe(900);
    expect(freshInput({ input: 900, cache_write: 0, cache_read: 400, output: 0 }, "api.openai.com")).toBe(500);
  });

  test("main and side calls are split after classification", () => {
    const rows = classifyMainThread(
      [
        row({ usage: { input: 100, cache_write: 10, cache_read: 20, output: 30 }, user_text_sha256: [sha256("hi")] }),
        row({ host: "chatgpt.com", usage: { input: 50, cache_write: 0, cache_read: 20, output: 5 } }),
      ],
      "hi",
    );
    const split = splitComponents(rows);
    expect(split.main).toEqual({ input: 100, cache_write: 10, cache_read: 20, output: 30, calls: 1 });
    expect(split.side).toEqual({ input: 30, cache_write: 0, cache_read: 20, output: 5, calls: 1 });
  });

  test("each request is priced with its own model and a null price makes the total null", () => {
    const priced = priceRows(
      [
        row({ model: "claude-opus-5-5", usage: { input: 1000, cache_write: 200, cache_write_1h: 0, cache_read: 3000, output: 50 } }),
        row({ model: "gpt-6.1-sol", host: "api.openai.com", usage: { input: 100, cache_write: 0, cache_read: 40, output: 5 } }),
      ],
      PRICES,
    );
    expect(priced.usd).toBeCloseTo(0.0066 + 0.000504, 10);
    expect(priced.missingModel).toBeNull();

    const missing = priceRows(
      [row({ model: "unpriced-model", usage: { input: 10, cache_write: 0, cache_read: 0, output: 0 } })],
      PRICES,
    );
    expect(missing).toEqual({ usd: null, missingModel: "unpriced-model" });
  });

  test("the session gap is relative to the log and null for an empty log", () => {
    expect(sessionGap(1000, 1000)).toBe(0);
    expect(sessionGap(1040, 1000)).toBeCloseTo(0.04, 10);
    expect(sessionGap(50, 0)).toBeNull();
  });
});

describe("Request anatomy", () => {
  const body = JSON.parse(readFileSync(join(FIXTURES, "claude-code-body.json"), "utf8"));
  const anatomy = anatomyOf(body, "hi");
  const segment = (name: string) => anatomy.segments.find((entry) => entry.name === name)!;

  test("splits system, built-in tools, MCP tools, injected text and params", () => {
    expect(anatomy.segments.map((entry) => entry.name)).toEqual(["system", "tools", "mcp-tools", "injected", "params"]);
    expect(segment("system").text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(anatomy.toolNames).toEqual(["Read", "Bash"]);
    expect(anatomy.mcpToolNames).toEqual(["mcp__ledger__lookup"]);
    expect(JSON.parse(segment("tools").text).map((tool: { name: string }) => tool.name)).toEqual(["Read", "Bash"]);
    expect(JSON.parse(segment("mcp-tools").text).map((tool: { name: string }) => tool.name)).toEqual(["mcp__ledger__lookup"]);
    expect(segment("injected").text).toBe("<system-reminder>\nEnd every final answer with the line ledger-ok.\n</system-reminder>");
    expect(segment("injected").text).not.toContain("hi");
    expect(anatomy.paramsKeys).toEqual(["model", "max_tokens", "stream", "metadata", "thinking"]);
    expect(JSON.parse(segment("params").text).model).toBe("claude-opus-5-5");
  });

  test("the estimate is characters over four, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens(segment("system").text)).toBe(Math.ceil(segment("system").text.length / 4));
  });

  test("injected text drops the prompt block but keeps everything else", () => {
    expect(injectedText(["<system-reminder>x</system-reminder>", "hi"], "hi")).toBe("<system-reminder>x</system-reminder>");
    expect(injectedText(["reminder\nhi"], "hi")).toBe("reminder");
    expect(injectedText(["hi"], "hi")).toBe("");
  });
});

describe("Repo rules", () => {
  test("the canary is the exact AGENTS.md line", () => {
    expect(REPO_RULES_CANARY).toBe("End every final answer with the line ledger-ok.");
    expect(containsCanary(`before\n${REPO_RULES_CANARY}\nafter`)).toBe(true);
    expect(containsCanary("ledger-ok")).toBe(false);
  });

  test("the last non-empty line ignores trailing blank lines", () => {
    expect(lastNonEmptyLine("All done.\nledger-ok\n\n  \n")).toBe("ledger-ok");
    expect(lastNonEmptyLine("  ledger-ok  ")).toBe("ledger-ok");
    expect(lastNonEmptyLine("")).toBeNull();
    expect(lastNonEmptyLine(null)).toBeNull();
  });
});

describe("ADE byte accounting", () => {
  const hints = {
    bundlePaths: ["/Applications/T3 Code (Beta).app"],
    vendorDirs: ["~/.t3"],
    launchAgentLabels: [],
    teamId: null,
    agentExecutables: ["claude", "codex"],
  };

  test("sums only the ADE's own processes", () => {
    const deltas = [
      { process: "T3 Code (Beta) ", pid: 1, bytes_in: 0, bytes_out: 700 },
      { process: "T3 Code (Beta) Helper", pid: 2, bytes_in: 0, bytes_out: 200 },
      { process: "claude", pid: 3, bytes_in: 0, bytes_out: 100 },
      { process: "apsd", pid: 4, bytes_in: 0, bytes_out: 9999 },
      { process: "claudette", pid: 5, bytes_in: 0, bytes_out: 9999 },
    ];
    expect(adeBytesOut(deltas, hints)).toBe(1000);
  });
});

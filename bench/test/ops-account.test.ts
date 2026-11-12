import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ADOBE_AGENTS,
  GHOSTTY_CONFIG,
  checkAccount,
  codexTopLevelValue,
  setClaudeAutoUpdater,
  setCodexTopLevelFalse,
} from "../ops/account.ts";
import type { OpsRun, OpsRunner } from "../ops/runner.ts";

const RUNBOOK = resolve(import.meta.dir, "..", "..", "RUNBOOK.md");

function runbookGhosttyBlock(): string {
  const text = readFileSync(RUNBOOK, "utf8");
  const start = text.indexOf("```text\n# Clean shell");
  if (start < 0) throw new Error("RUNBOOK 4.10 has no Ghostty config block");
  const body = text.slice(start + "```text\n".length);
  const end = body.indexOf("```");
  if (end < 0) throw new Error("RUNBOOK 4.10 Ghostty block is not closed");
  return body.slice(0, end);
}

describe("Ghostty config", () => {
  test("is exactly the text in RUNBOOK.md 4.10, comments included", () => {
    expect(GHOSTTY_CONFIG).toBe(runbookGhosttyBlock());
  });
});

describe("claude settings", () => {
  test("sets DISABLE_AUTOUPDATER and keeps every other key", () => {
    const original = JSON.stringify({ model: "x", env: { FOO: "bar" } });
    const next = setClaudeAutoUpdater(original);
    const parsed = JSON.parse(next) as { model: string; env: Record<string, string> };
    expect(parsed.model).toBe("x");
    expect(parsed.env.FOO).toBe("bar");
    expect(parsed.env.DISABLE_AUTOUPDATER).toBe("1");
  });

  test("is idempotent", () => {
    const once = setClaudeAutoUpdater(JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } }));
    expect(setClaudeAutoUpdater(once)).toBe(once);
  });

  test("refuses to overwrite an env that is not an object", () => {
    expect(() => setClaudeAutoUpdater(JSON.stringify({ env: "nope" }))).toThrow(/env/);
  });
});

describe("codex config", () => {
  test("reads only top-level keys", () => {
    const text = "check_for_update_on_startup = true\n[table]\ncheck_for_update_on_startup = false\n";
    expect(codexTopLevelValue(text, "check_for_update_on_startup")).toEqual({ found: true, value: "true" });
  });

  test("inserts the false line before the first table and keeps the rest", () => {
    const text = '# header\nmodel = "x"\n[table]\nkey = 1\n';
    expect(setCodexTopLevelFalse(text)).toBe(
      '# header\nmodel = "x"\ncheck_for_update_on_startup = false\n[table]\nkey = 1\n',
    );
  });

  test("replaces a top-level true line and leaves a false file alone", () => {
    const replaced = setCodexTopLevelFalse("check_for_update_on_startup = true\n[table]\n");
    expect(replaced).toBe("check_for_update_on_startup = false\n[table]\n");
    expect(setCodexTopLevelFalse(replaced)).toBe(replaced);
    expect(setCodexTopLevelFalse("")).toBe("check_for_update_on_startup = false\n");
  });
});

function fakeRunner(files: Record<string, string>, existing: readonly string[], disabled: boolean): OpsRunner {
  const result = (code: number, stdout = "", stderr = ""): OpsRun => ({ code, stdout, stderr });
  return {
    username: () => "ademark",
    uid: () => 502,
    home: () => "/tmp/home",
    env: () => undefined,
    envWithPrefix: () => [],
    exists: (path) => existing.includes(path),
    readFile: (path) => files[path] ?? null,
    writeFile: () => undefined,
    mkdirp: () => undefined,
    signal: () => undefined,
    sleep: async () => undefined,
    now: () => 0,
    run(argv) {
      if (argv[0] === "launchctl" && argv[1] === "print-disabled") {
        return result(
          0,
          `disabled services = {\n${ADOBE_AGENTS.map((label) => `  "${label}" => ${disabled ? "disabled" : "enabled"}`).join("\n")}\n}\n`,
        );
      }
      if (argv[0] === "pluginkit") return result(0, "-    com.adobe.accmac.ACCFinderSync(7.10.0.1)\n");
      if (argv[0] === "security" && argv[1] === "find-certificate") {
        return existing.includes("/tmp/home/.mitmproxy/mitmproxy-ca-cert.pem")
          ? result(0, "SHA-256 hash: 0123456789ABCDEF\n")
          : result(0);
      }
      return result(127, "", `unexpected command: ${argv.join(" ")}`);
    },
  };
}

describe("account check", () => {
  const happyFiles = {
    "/tmp/home/.config/ghostty/config": GHOSTTY_CONFIG,
    "/tmp/home/.claude/settings.json": JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } }),
    "/tmp/home/.codex/config.toml": "check_for_update_on_startup = false\n",
    "/tmp/home/.claude.json": JSON.stringify({ projects: { "/tmp/home/arena": { hasTrustDialogAccepted: true } } }),
  };
  const happyExisting = [
    "/tmp/home/arena",
    "/tmp/home/.mitmproxy/mitmproxy-ca-cert.pem",
    ...ADOBE_AGENTS.map((label) => `/Library/LaunchAgents/${label}.plist`),
  ];

  test("reports every item ok on a configured home", () => {
    const items = checkAccount(fakeRunner(happyFiles, happyExisting, true));
    expect(items.map((entry) => entry.status)).toEqual(items.map(() => "ok"));
    expect(items.length).toBe(9);
  });

  test("reports missing items without crashing on an empty home", () => {
    const items = checkAccount(fakeRunner({}, [], false));
    expect(items.find((entry) => entry.name === "ghostty-config")?.status).toBe("missing");
    expect(items.find((entry) => entry.name === "claude-autoupdater")?.status).toBe("missing");
    expect(items.find((entry) => entry.name === "codex-update-check")?.status).toBe("missing");
    expect(items.find((entry) => entry.name === "arena-trusted")?.status).toBe("missing");
    expect(items.find((entry) => entry.name === "mitmproxy-ca")?.status).toBe("missing");
    expect(items.find((entry) => entry.name.startsWith("adobe-agent:"))?.status).toBe("skip");
  });

  test("reports enabled Adobe agents as missing", () => {
    const items = checkAccount(fakeRunner(happyFiles, happyExisting, false));
    expect(items.find((entry) => entry.name === `adobe-agent:${ADOBE_AGENTS[0]}`)?.status).toBe("missing");
  });
});

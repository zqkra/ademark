// Superset 2.0.8 workarounds (bench/adapters/superset.ts): the replay env reaches the workspace claude through
// ~/.claude/settings.json, and each new worktree folder is trusted while the app runs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "../core/contracts.ts";
import { CLAUDE_SETTINGS_ENV_KEYS, resetMacosRunner, setMacosRunner, syncClaudeSettingsEnv, trustClaudeTree } from "../adapters/macos.ts";
import { validateProfile } from "../adapters/profile-validate.ts";
import { fakeRunner } from "./adapters-fake.ts";
import { PROFILE_ID, validProfile } from "./adapters-profile-fixture.ts";

let home: string;
let lines: string[];
const ctx = (dryRun = false): AdapterContext => ({
  runDir: home,
  arenaPath: home,
  worktree: home,
  home,
  env: {},
  dryRun,
  log: (line) => lines.push(line),
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ademark-superset-env-"));
  lines = [];
  setMacosRunner(fakeRunner("ademark"));
});
afterEach(() => {
  resetMacosRunner();
  rmSync(home, { recursive: true, force: true });
});

const claudeJson = (): { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> } =>
  JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
const settingsJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));

describe("syncClaudeSettingsEnv", () => {
  const MANAGED = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"];

  test("sets the replay URL, keeps every other key, and removes it again for a live block", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" }, theme: "dark" }),
      { mode: 0o600 },
    );
    syncClaudeSettingsEnv(ctx(), MANAGED, { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" });
    expect(settingsJson()).toEqual({
      env: { DISABLE_AUTOUPDATER: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" },
      theme: "dark",
    });
    expect(statSync(join(home, ".claude", "settings.json")).mode & 0o777).toBe(0o600);

    syncClaudeSettingsEnv(ctx(), MANAGED, {});
    expect(settingsJson()).toEqual({ env: { DISABLE_AUTOUPDATER: "1" }, theme: "dark" });
  });

  test("creates settings.json when the account has none, and an empty cleanup never creates it", () => {
    syncClaudeSettingsEnv(ctx(), MANAGED, { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" });
    expect(settingsJson()).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" } });
    rmSync(join(home, ".claude"), { recursive: true, force: true });
    // A crashed block's cleanup must not leave a settings.json behind for the next ADE.
    syncClaudeSettingsEnv(ctx(), MANAGED, {});
    expect(() => settingsJson()).toThrow();
  });

  test("an empty cleanup on a file without the managed keys writes nothing", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } }));
    syncClaudeSettingsEnv(ctx(), MANAGED, {});
    expect(settingsJson()).toEqual({ env: { DISABLE_AUTOUPDATER: "1" } });
    expect(lines).toEqual([]);
    // The same values again are a no-op too: the file is not rewritten on every send.
    syncClaudeSettingsEnv(ctx(), MANAGED, { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" });
    syncClaudeSettingsEnv(ctx(), MANAGED, { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" });
    expect(lines).toHaveLength(1);
  });

  test("the next ADE's block clears the keys a crashed Superset block left behind", () => {
    // What Superset's launch does on a Track A block, then the block dies before quit.
    syncClaudeSettingsEnv(ctx(), CLAUDE_SETTINGS_ENV_KEYS, {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      OPENAI_BASE_URL: "http://127.0.0.1:8787/v1",
    });
    // The run loop calls this with an empty map before every block's reset, for every ADE.
    const bareCli = { ...ctx(), runDir: join(home, "bare-cli") };
    syncClaudeSettingsEnv(bareCli, CLAUDE_SETTINGS_ENV_KEYS, {});
    expect(settingsJson()).toEqual({ env: {} });
  });

  test("a dry run plans it and writes nothing; another account writes nothing", () => {
    syncClaudeSettingsEnv(ctx(true), MANAGED, { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" });
    expect(lines).toEqual([
      `plan: syncClaudeSettingsEnv ${join(home, ".claude", "settings.json")} ANTHROPIC_BASE_URL=http://127.0.0.1:8787 OPENAI_BASE_URL=<unset>`,
    ]);
    // The per-block cleanup plans its own line too.
    lines.length = 0;
    syncClaudeSettingsEnv(ctx(true), CLAUDE_SETTINGS_ENV_KEYS, {});
    expect(lines).toEqual([
      `plan: syncClaudeSettingsEnv ${join(home, ".claude", "settings.json")} ANTHROPIC_BASE_URL=<unset> OPENAI_BASE_URL=<unset>`,
    ]);
    expect(() => syncClaudeSettingsEnv(ctx(), MANAGED, {})).not.toThrow();
    setMacosRunner(fakeRunner("owner"));
    expect(() => syncClaudeSettingsEnv(ctx(), MANAGED, { ANTHROPIC_BASE_URL: "x" })).toThrow(
      "refusing macOS side effect",
    );
  });
});

describe("trustClaudeTree", () => {
  test("trusts every folder under the roots, down to the depth limit, and remembers them", () => {
    const root = join(home, ".superset", "worktrees");
    const slug = join(root, "superset", "slug-a");
    const deep = join(slug, "nested", "deeper", "too-deep");
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(root, "other"), { recursive: true });
    const seen = new Set<string>();

    trustClaudeTree(ctx(), ["~/.superset/worktrees", "~/.paradev/worktrees"], seen);
    const projects = claudeJson().projects!;
    expect(projects[join(root, "superset")]?.hasTrustDialogAccepted).toBe(true);
    expect(projects[slug]?.hasTrustDialogAccepted).toBe(true);
    expect(projects[join(root, "other")]?.hasTrustDialogAccepted).toBe(true);
    // depth: root(0) > superset(1) > slug-a(2) > nested(3); "deeper" is level 4 and is not reached
    expect(projects[join(slug, "nested")]?.hasTrustDialogAccepted).toBe(true);
    expect(projects[deep]?.hasTrustDialogAccepted).toBeUndefined();
    expect(projects[root]?.hasTrustDialogAccepted).toBeUndefined();

    // A second call trusts only folders it has not seen.
    const fresh = join(root, "superset", "slug-b");
    mkdirSync(fresh, { recursive: true });
    trustClaudeTree(ctx(), ["~/.superset/worktrees"], seen);
    const again = claudeJson().projects!;
    expect(again[fresh]?.hasTrustDialogAccepted).toBe(true);
    expect(Object.keys(again).filter((key) => key.startsWith(home))).toHaveLength(5);
  });

  test("a dry run plans the roots and writes nothing; a missing root is skipped", () => {
    trustClaudeTree(ctx(true), ["~/.superset/worktrees"], new Set());
    expect(lines).toEqual([`plan: trustClaudeTree ${join(home, ".superset", "worktrees")}`]);
    trustClaudeTree(ctx(), ["~/.superset/worktrees"], new Set());
    expect(() => claudeJson()).toThrow();
  });
});

describe("validateProfile claudeTrustScanDirs", () => {
  test("accepts ~ paths and rejects the rest", () => {
    const json = validProfile();
    (json as Record<string, unknown>).claudeTrustScanDirs = ["~/.superset/worktrees"];
    expect(validateProfile(json, PROFILE_ID, ["claude", "codex"])).toEqual([]);
    (json as Record<string, unknown>).claudeTrustScanDirs = ["/etc/passwd"];
    expect(validateProfile(json, PROFILE_ID, ["claude", "codex"])).toContain(
      "claudeTrustScanDirs[0]: must be a path under ~ (start with \"~/\")",
    );
    (json as Record<string, unknown>).claudeTrustScanDirs = "~/.superset/worktrees";
    expect(validateProfile(json, PROFILE_ID, ["claude", "codex"])).toContain(
      "claudeTrustScanDirs: must be an array of paths under ~",
    );
  });
});

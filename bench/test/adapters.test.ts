import { launchAgentPids, mainAppProcesses, orphanAgents } from "../adapters/macos.ts";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADAPTER_IDS, adapters, getAdapter, listAdapters } from "../adapters/registry.ts";
import { CALIBRATION_KEYS, checkAdapter, formatCheck } from "../adapters/check.ts";
import { ADAPTER_ID, renderBrief, scaffoldAdapter } from "../adapters/new.ts";
import { checkApp, parseVersionOutput, readBundleInfo } from "../adapters/support.ts";
import { profileAdapter } from "../adapters/profile.ts";
import { benchRoot } from "../core/paths.ts";

const EXPECTED = [
  "bare-cli", "t3code", "bb", "paseo", "synara", "traycer", "cloudroom", "superset", "orca", "emdash",
  "zeron", "diri", "monocode", "super-engineering", "conductor", "capy", "claude-desktop", "codex-app",
];

describe("registry", () => {
  test("lists all 18 adapter IDs from ADES.md", () => {
    expect([...ADAPTER_IDS].sort()).toEqual([...EXPECTED].sort());
    expect(listAdapters().length).toBe(18);
  });

  test("every adapter's id matches its registry key", () => {
    for (const [key, adapter] of Object.entries(adapters)) expect(adapter.id).toBe(key);
  });

  test("families match ADES.md", () => {
    const families: Record<string, string> = {
      "bare-cli": "control",
      t3code: "EL-SDK",
      bb: "EL-SDK",
      paseo: "EL-SDK",
      synara: "EL-SDK",
      traycer: "EL-SDK",
      cloudroom: "EL-SDK",
      superset: "EL-PTY",
      orca: "EL-PTY",
      emdash: "EL-PTY",
      zeron: "NATIVE",
      diri: "NATIVE",
      monocode: "NATIVE",
      "super-engineering": "NATIVE",
      conductor: "NATIVE",
      capy: "OWN",
      "claude-desktop": "FIRST",
      "codex-app": "FIRST",
    };
    for (const [id, family] of Object.entries(families)) expect(getAdapter(id).family).toBe(family);
  });

  test("getAdapter throws a helpful error for an unknown id", () => {
    expect(() => getAdapter("nope")).toThrow(/unknown adapter "nope"/);
  });
});

describe("adapter conformance", () => {
  test("every shipped adapter conforms", async () => {
    for (const id of ADAPTER_IDS) {
      const result = await checkAdapter(id, adapters[id]!);
      expect({ id, errors: result.errors }).toEqual({ id, errors: [] });
      expect(result.ok).toBe(true);
    }
  });

  test("every adapter has every calibration key", () => {
    for (const adapter of listAdapters()) {
      for (const key of CALIBRATION_KEYS) expect(key in adapter.calibration).toBe(true);
    }
  });

  test("timed triggers are arrays", () => {
    for (const adapter of listAdapters()) {
      expect(Array.isArray(adapter.timed.launch)).toBe(true);
      expect(Array.isArray(adapter.timed.newThread)).toBe(true);
      expect(Array.isArray(adapter.timed.send)).toBe(true);
    }
  });

  test("processes() returns attribution hints for every adapter", () => {
    for (const adapter of listAdapters()) {
      const hints = adapter.processes();
      expect(Array.isArray(hints.bundlePaths)).toBe(true);
      expect(Array.isArray(hints.vendorDirs)).toBe(true);
      expect(Array.isArray(hints.launchAgentLabels)).toBe(true);
      expect(Array.isArray(hints.agentExecutables)).toBe(true);
      expect(hints.teamId === null || typeof hints.teamId === "string").toBe(true);
    }
  });

  test("processes() names the bundle from ADES.md", () => {
    expect(getAdapter("t3code").processes().bundlePaths).toContain("/Applications/T3 Code (Beta).app");
    expect(getAdapter("bb").processes().launchAgentLabels).toContain("dev.bb.desktop.ShipIt");
    expect(getAdapter("cloudroom").processes().launchAgentLabels).toContain("dev.cloudroom.preview.86e6d7d7b43e198e");
    expect(getAdapter("capy").processes().agentExecutables).toEqual([]);
  });

  const uncalibrated = () =>
    profileAdapter({
      id: "uncalibrated-fixture",
      name: "Uncalibrated fixture",
      family: "EL-SDK",
      agents: ["claude"],
      appName: "Uncalibrated Fixture",
      bundleId: "dev.ademark.uncalibrated-fixture",
      drive: "keys",
      dataDirs: ["~/.uncalibrated-fixture"],
      launchAgents: [],
      vendorDirs: ["~/.uncalibrated-fixture"],
    });

  test("uncalibrated methods throw 'not calibrated'", async () => {
    const adapter = uncalibrated();
    const ctx = {
      runDir: "/tmp/r",
      arenaPath: "/tmp/a",
      worktree: "/tmp/w",
      home: "/tmp/h",
      env: {},
      dryRun: true,
      log: () => {},
    };
    await expect(adapter.launch(ctx)).rejects.toThrow("not calibrated: launch");
    await expect(adapter.waitDone(ctx, 10)).rejects.toThrow("not calibrated: waitDone");
    await expect(adapter.quit(ctx)).rejects.toThrow("not calibrated: quit");
  });

  test("a broken adapter is reported, not thrown", async () => {
    const broken = { ...uncalibrated(), calibration: {}, timed: { launch: null } };
    const result = await checkAdapter("uncalibrated-fixture", broken);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("calibration is missing the key appName"))).toBe(true);
    expect(result.errors.some((error) => error.includes("timed.launch must be an array"))).toBe(true);
  });

  test("formatCheck prints filled and missing fields", async () => {
    const text = formatCheck(await checkAdapter("t3code", getAdapter("t3code")));
    expect(text).toContain("conforms");
    expect(text).toContain("ok      bundleId = com.t3tools.t3code");
    expect(text).toContain("missing focusClick");
  });
});

describe("installCheck", () => {
  test("reads a real bundle's version and hash", async () => {
    const info = await getAdapter("t3code").installCheck();
    expect(info.installed).toBe(true);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.binarySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("reports installed:false for a missing app", async () => {
    const info = await checkApp("NoSuchApp-ademark");
    expect(info.installed).toBe(false);
    expect(info.binarySha256).toBeNull();
  });

  test("readBundleInfo returns null for a missing bundle", () => {
    expect(readBundleInfo("/Applications/NoSuchApp-ademark.app")).toBeNull();
  });

  test("parses CLI version strings", () => {
    expect(parseVersionOutput("2.1.303 (Claude Code)")).toBe("2.1.303");
    expect(parseVersionOutput("codex-cli 0.163.0")).toBe("0.163.0");
    expect(parseVersionOutput("no version here")).toBeNull();
  });
});

describe("adapter new", () => {
  test("accepts lowercase, digits and single dashes", () => {
    expect(ADAPTER_ID.test("demo-ade")).toBe(true);
    expect(ADAPTER_ID.test("my-ade-2")).toBe(true);
    expect(ADAPTER_ID.test("Demo")).toBe(false);
    expect(ADAPTER_ID.test("demo--ade")).toBe(false);
    expect(ADAPTER_ID.test("demo_ade")).toBe(false);
  });

  test("scaffolds an adapter and a brief, and refuses to overwrite", () => {
    const dir = `${benchRoot}/adapters`;
    const result = scaffoldAdapter("ademark-scaffold-test", dir);
    try {
      const source = readFileSync(result.adapterPath, "utf8");
      expect(source).toContain('id: "ademark-scaffold-test"');
      expect(source).not.toContain('id: "template"');
      expect(readFileSync(result.briefPath, "utf8")).toContain("Adapters drive the ADE; they never measure");
      expect(() => scaffoldAdapter("ademark-scaffold-test", dir)).toThrow(/refusing to overwrite/);
    } finally {
      Bun.spawnSync(["rm", "-f", result.adapterPath, result.briefPath]);
    }
  });

  test("rejects an invalid id", () => {
    expect(() => scaffoldAdapter("Bad_ID", resolve(benchRoot, "adapters"))).toThrow(/invalid adapter id/);
  });

  test("the brief names the files an agent must read", () => {
    const brief = renderBrief("demo-ade");
    expect(brief).toContain("ADES.md");
    expect(brief).toContain("bench/core/contracts.ts");
    expect(brief).toContain("bench/adapters/AGENT_GUIDE.md");
    expect(brief).toContain("ademark adapter check demo-ade");
  });
});

describe("mainAppProcesses", () => {
  const ps = [
    "  200   502 /Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)",
    "  201   502 /Applications/T3 Code (Beta).app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
    "  202   501 /Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)",
    "  203   502 /Applications/Orca.app/Contents/MacOS/Orca",
  ].join("\n");

  test("finds this account's main executable, not helpers or other accounts", () => {
    expect(mainAppProcesses(ps, ["/Applications/T3 Code (Beta).app"], 502)).toEqual([200]);
  });
});

describe("launchAgentPids", () => {
  test("reads the pid of a loaded label from launchctl list", () => {
    const list = "PID\tStatus\tLabel\n321\t0\tdev.cloudroom.preview.86e6\n-\t0\tai.traycer.host\n";
    expect(launchAgentPids(list, ["dev.cloudroom.preview.86e6", "ai.traycer.host"])).toEqual([321]);
  });
});

describe("orphanAgents", () => {
  const ps = [
    "  100     1   502 /Users/ademark/.local/share/claude/versions/2.1.303",
    "  101   900   502 /Users/ademark/.local/share/claude/versions/2.1.303",
    "  102     1   501 /Users/owner/.local/share/claude/versions/2.1.303",
    "  103     1   502 /opt/homebrew/bin/codex",
    "  104     1   502 /Applications/Ghostty.app/Contents/MacOS/ghostty",
    "  105     1   502 claude",
  ].join("\n");

  test("takes this account's agent CLIs whose parent died, and nothing else", () => {
    expect(orphanAgents(ps, 502)).toEqual([100, 103, 105]);
  });
});

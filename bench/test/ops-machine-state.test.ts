import { describe, expect, test } from "bun:test";
import {
  parseKeyValue,
  restorePlan,
  spotlightEntries,
  statusMatchesOn,
} from "../ops/machine-state.ts";
import { analyzerPids, modeAt60, parseDisplayplacerMode, readUserState } from "../ops/machine.ts";
import type { OpsRunner } from "../ops/runner.ts";

const BEFORE = `saved_at=2026-10-20T02:00:00Z
spotlight.count=2
spotlight.0.volume=/
spotlight.0.enabled=1
spotlight.1.volume=/Volumes/Scrawl
spotlight.1.enabled=0
powernap=1
sleep=0
displaysleep=10
disksleep=10
updates.schedule=on
updates.AutomaticDownload=1
updates.AutomaticallyInstallMacOSUpdates=1
updates.AutomaticCheckEnabled=absent
updates.ConfigDataInstall=1
updates.CriticalUpdateInstall=1
timemachine.autobackup=on`;

describe("before.env", () => {
  test("parses key=value lines and keeps spaces in the value", () => {
    const parsed = parseKeyValue("a=1\nb=two words\n# comment\n\n");
    expect(parsed).toEqual({ a: "1", b: "two words" });
  });

  test("reads every Spotlight volume and its state", () => {
    expect(spotlightEntries(parseKeyValue(BEFORE))).toEqual([
      { volume: "/", enabled: true },
      { volume: "/Volumes/Scrawl", enabled: false },
    ]);
  });

  test("restores Spotlight exactly, including a volume that was off", () => {
    const plan = restorePlan(parseKeyValue(BEFORE));
    const spotlight = plan.filter((step) => step.argv[0] === "/usr/bin/mdutil");
    expect(spotlight.map((step) => step.argv)).toEqual([
      ["/usr/bin/mdutil", "-i", "on", "/"],
      ["/usr/bin/mdutil", "-i", "off", "/Volumes/Scrawl"],
    ]);
  });

  test("restores power, updates and Time Machine", () => {
    const plan = restorePlan(parseKeyValue(BEFORE));
    expect(plan.find((step) => step.argv[0] === "/usr/bin/pmset")?.argv).toEqual([
      "/usr/bin/pmset", "-a", "powernap", "1", "sleep", "0", "displaysleep", "10", "disksleep", "10",
    ]);
    expect(plan.find((step) => step.argv[0] === "/usr/sbin/softwareupdate")?.argv).toEqual([
      "/usr/sbin/softwareupdate", "--schedule", "on",
    ]);
    expect(plan.find((step) => step.argv[0] === "/usr/bin/tmutil")?.argv).toEqual(["/usr/bin/tmutil", "enable"]);
  });

  test("deletes an update key that was absent and writes the others", () => {
    const plan = restorePlan(parseKeyValue(BEFORE));
    const defaults = plan.filter((step) => step.argv[0] === "/usr/bin/defaults").map((step) => step.argv);
    expect(defaults).toContainEqual([
      "/usr/bin/defaults", "delete", "/Library/Preferences/com.apple.SoftwareUpdate", "AutomaticCheckEnabled",
    ]);
    expect(defaults).toContainEqual([
      "/usr/bin/defaults", "write", "/Library/Preferences/com.apple.SoftwareUpdate", "AutomaticDownload", "-bool", "true",
    ]);
    expect(defaults).toContainEqual([
      "/usr/bin/defaults", "write", "/Library/Preferences/com.apple.SoftwareUpdate", "ConfigDataInstall", "-bool", "true",
    ]);
  });

  test("handles an empty file without inventing steps", () => {
    expect(restorePlan({})).toEqual([]);
  });
});

const ON_STATUS: Record<string, string> = {
  "before.env": "present",
  "spotlight./": "off",
  "spotlight./System/Volumes/Data": "off",
  "power.powernap": "0",
  "power.sleep": "0",
  "power.displaysleep": "0",
  "power.disksleep": "0",
  "updates.schedule": "off",
  "updates.AutomaticDownload": "0",
  "updates.AutomaticallyInstallMacOSUpdates": "0",
  "updates.AutomaticCheckEnabled": "0",
  "updates.ConfigDataInstall": "0",
  "updates.CriticalUpdateInstall": "0",
  "timemachine.autobackup": "off",
  "pf.ademark": "empty",
};

describe("statusMatchesOn", () => {
  test("accepts the state machine on leaves", () => {
    expect(statusMatchesOn(ON_STATUS)).toEqual({ ok: true, failures: [] });
  });

  test("fails when Spotlight is on", () => {
    const status = { ...ON_STATUS, "spotlight./": "on" };
    expect(statusMatchesOn(status).ok).toBe(false);
    expect(statusMatchesOn(status).failures[0]).toContain("spotlight./=on");
  });

  test("accepts a schedule macOS still prints as on when AutomaticCheckEnabled is false", () => {
    expect(statusMatchesOn({ ...ON_STATUS, "updates.schedule": "on" }).ok).toBe(true);
    const unchecked = { ...ON_STATUS, "updates.schedule": "on", "updates.AutomaticCheckEnabled": "absent" };
    expect(statusMatchesOn(unchecked).failures).toContain("updates.schedule=on (expected off)");
  });

  test("fails when an update key is absent", () => {
    const status = { ...ON_STATUS, "updates.AutomaticCheckEnabled": "absent" };
    expect(statusMatchesOn(status).ok).toBe(false);
  });

  test("fails when there is no Spotlight volume at all", () => {
    const status = { ...ON_STATUS };
    delete status["spotlight./"];
    delete status["spotlight./System/Volumes/Data"];
    expect(statusMatchesOn(status).failures).toContain("no Spotlight volume in the status");
  });
});

describe("displayplacer", () => {
  test("takes the full mode string that list prints", () => {
    const output = `Resolution: 2560x1440\nHertz: 144\ndisplayplacer "id:1 res:2560x1440 hz:144 color_depth:8 scaling:on origin:(0,0) degree:0"\n`;
    expect(parseDisplayplacerMode(output)).toBe("id:1 res:2560x1440 hz:144 color_depth:8 scaling:on origin:(0,0) degree:0");
  });

  test("switches only the refresh rate", () => {
    expect(modeAt60("id:1 res:2560x1440 hz:144 color_depth:8 scaling:on origin:(0,0) degree:0")).toBe(
      "id:1 res:2560x1440 hz:60 color_depth:8 scaling:on origin:(0,0) degree:0",
    );
    expect(modeAt60("id:1 res:2560x1440 color_depth:8")).toBeNull();
  });
});

describe("analyzerPids", () => {
  test("keeps only this user's analyzers", () => {
    const ps = `  550   502 /usr/libexec/mediaanalysisd\n  551   502 /usr/libexec/photoanalysisd\n  552     0 /usr/libexec/mediaanalysisd\n  553   502 /usr/bin/other\n`;
    expect(analyzerPids(ps, 502)).toEqual([
      { pid: 550, name: "mediaanalysisd" },
      { pid: 551, name: "photoanalysisd" },
    ]);
  });
});

describe("readUserState", () => {
  test("returns defaults when the file is missing or invalid", () => {
    const runner = {
      username: () => "ademark",
      uid: () => 502,
      home: () => "/Users/ademark",
      env: () => undefined,
      envWithPrefix: () => [],
      run: () => ({ code: 1, stdout: "", stderr: "" }),
      exists: () => false,
      readFile: () => "not json",
      writeFile: () => undefined,
      mkdirp: () => undefined,
      signal: () => undefined,
      sleep: async () => undefined,
      now: () => 0,
    } satisfies OpsRunner;
    expect(readUserState(runner)).toEqual({ displayplacer: null, paused: [], saved_at: "" });
  });
});

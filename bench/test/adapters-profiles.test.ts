import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProfile, loadProfile, ProfileError, profileFile } from "../adapters/profile.ts";
import { validateProfile } from "../adapters/profile-validate.ts";
import { PROFILE_ID, profileJson, validProfile } from "./adapters-profile-fixture.ts";

type AnyJson = Record<string, any>;

interface BadProfile {
  name: string;
  break: (json: AnyJson) => void;
  expected: string;
}

const BAD_PROFILES: BadProfile[] = [
  {
    name: "schema must be 1",
    break: (json) => {
      json.schema = 2;
    },
    expected: "schema: must be 1",
  },
  {
    name: "the ade field must match the adapter id",
    break: (json) => {
      json.ade = "other-ade";
    },
    expected: 'ade: "other-ade" does not match the adapter id "demo-ade"',
  },
  {
    name: "window width must be a positive integer",
    break: (json) => {
      json.window.w = 0;
    },
    expected: "window.w: must be a positive integer",
  },
  {
    name: "composerRect must not be null",
    break: (json) => {
      json.calibration.composerRect = null;
    },
    expected: "calibration.composerRect: must not be null",
  },
  {
    name: "a calibration rect must lie inside the window",
    break: (json) => {
      json.calibration.threadRect = { x: 1200, y: 100, w: 700, h: 600 };
    },
    expected: "calibration.threadRect: must lie inside the 1600x1000 window",
  },
  {
    name: "a mask must have a positive size",
    break: (json) => {
      json.calibration.masks[0] = { x: 1500, y: 0, w: 0, h: 60 };
    },
    expected: "calibration.masks[0]: must have a positive size",
  },
  {
    name: "a focus click must lie inside the window",
    break: (json) => {
      json.calibration.focusClick = { x: 2000, y: 900 };
    },
    expected: "calibration.focusClick: must lie inside the 1600x1000 window",
  },
  {
    name: "steps.beforeRelaunchQuit must be a list when set",
    break: (json) => {
      json.steps.beforeRelaunchQuit = { kind: "wait", ms: 1 };
    },
    expected: "steps.beforeRelaunchQuit: must be an array of steps",
  },
  {
    name: "steps.beforeColdQuit checks each step like the other lists",
    break: (json) => {
      json.steps.beforeColdQuit = [{ kind: "run", argv: ["osascript"], timeoutMs: 10 }];
    },
    expected: 'steps.beforeColdQuit[0].argv[0]: "osascript" is not allowed',
  },
  {
    name: "blankRelaunchMs must be a positive integer up to 60000",
    break: (json) => {
      json.blankRelaunchMs = 0;
    },
    expected: "blankRelaunchMs: must be an integer from 1 to 60000",
  },
  {
    name: "an app login needs its files",
    break: (json) => {
      json.login.files = [];
    },
    expected: 'login.files: must not be empty for kind "app"',
  },
  {
    name: "an agent-cli login has no signIn text",
    break: (json) => {
      json.login = { kind: "agent-cli", files: [], signIn: "ask the agent" };
    },
    expected: 'login.signIn: must be null for kind "agent-cli"',
  },
  {
    name: "login files are paths under home",
    break: (json) => {
      json.login.files = ["/etc/passwd"];
    },
    expected: 'login.files[0]: must be a path under ~ (start with "~/")',
  },
  {
    name: "timed launch must not be empty",
    break: (json) => {
      json.timed.launch = [];
    },
    expected: "timed.launch: must not be empty",
  },
  {
    name: "a step kind must be a ProfileStep",
    break: (json) => {
      json.steps.openProject[0] = { kind: "sudo" };
    },
    expected: 'steps.openProject[0].kind: "sudo" is not a ProfileStep',
  },
  {
    name: "a probe is 4 to 12 different lowercase letters",
    break: (json) => {
      json.calibration.probe = "aab";
    },
    expected: "calibration.probe: must be 4 to 12 different lowercase letters",
  },
  {
    name: "orchestration.workers is sessions or absent",
    break: (json) => {
      json.orchestration = { workers: "threads" };
    },
    expected: 'orchestration.workers: must be "sessions" or absent',
  },
  {
    name: "an orchestration setting is a key path in a JSON file under home",
    break: (json) => {
      json.orchestration = { settings: [{ file: "/etc/settings.json", path: [], value: null }] };
    },
    expected: "orchestration.settings[0].file: must be a .json path under ~/",
  },
  {
    name: "setJsonKeys is not a step any more",
    break: (json) => {
      json.steps.openProject[0] = { kind: "setJsonKeys", file: "~/.demo/settings.json", keys: {} };
    },
    expected: 'steps.openProject[0].kind: "setJsonKeys" is not a ProfileStep; use reset.jsonKeys',
  },
  {
    name: "a run step never uses a shell",
    break: (json) => {
      json.steps.configure.claude[0].argv = ["bash", "-c", "echo hi"];
    },
    expected: 'steps.configure.claude[0].argv[0]: "bash" is not allowed',
  },
  {
    name: "a run timeout is 1 to 600000 ms",
    break: (json) => {
      json.steps.configure.claude[0].timeoutMs = 0;
    },
    expected: "steps.configure.claude[0].timeoutMs: must be an integer from 1 to 600000",
  },
  {
    name: "an expectText timeout is 1 to 120000 ms",
    break: (json) => {
      json.steps.configure.codex[1].timeoutMs = 200_000;
    },
    expected: "steps.configure.codex[1].timeoutMs: must be an integer from 1 to 120000",
  },
  {
    name: "expectText takes text or texts, not both",
    break: (json) => {
      json.steps.configure.codex[1].texts = ["ready", "set"];
    },
    expected: "steps.configure.codex[1]: set text or texts, not both",
  },
  {
    name: "expectText texts is a non-empty list",
    break: (json) => {
      delete json.steps.configure.codex[1].text;
      json.steps.configure.codex[1].texts = [];
    },
    expected: "steps.configure.codex[1].texts: must be a non-empty array of strings",
  },
  {
    name: "expectText texts holds non-empty strings",
    break: (json) => {
      delete json.steps.configure.codex[1].text;
      json.steps.configure.codex[1].texts = ["ready", ""];
    },
    expected: "steps.configure.codex[1].texts[1]: must be a non-empty string",
  },
  {
    name: "clickIfText needs texts",
    break: (json) => {
      json.steps.afterLaunch[0] = { kind: "clickIfText", region: { x: 1, y: 1, w: 10, h: 10 }, point: { x: 5, y: 5 }, timeoutMs: 2000 };
    },
    expected: "steps.afterLaunch[0].texts: must be a non-empty array of strings",
  },
  {
    name: "a clickIfText point lies inside the window",
    break: (json) => {
      json.steps.afterLaunch[0] = { kind: "clickIfText", region: { x: 1, y: 1, w: 10, h: 10 }, texts: ["x"], point: { x: 1700, y: 5 }, timeoutMs: 2000 };
    },
    expected: "steps.afterLaunch[0].point: must lie inside the 1600x1000 window",
  },
  {
    name: "a clickIfText region lies inside the window",
    break: (json) => {
      json.steps.afterLaunch[0] = { kind: "clickIfText", region: { x: 1590, y: 1, w: 20, h: 10 }, texts: ["x"], point: { x: 5, y: 5 }, timeoutMs: 2000 };
    },
    expected: "steps.afterLaunch[0].region: must lie inside the 1600x1000 window",
  },
  {
    name: "a clickIfText timeout is 1 to 10000 ms",
    break: (json) => {
      json.steps.afterLaunch[0] = { kind: "clickIfText", region: { x: 1, y: 1, w: 10, h: 10 }, texts: ["x"], point: { x: 5, y: 5 }, timeoutMs: 30_000 };
    },
    expected: "steps.afterLaunch[0].timeoutMs: must be an integer from 1 to 10000",
  },
  {
    name: "clickIfText confirmGone is a boolean",
    break: (json) => {
      json.steps.afterLaunch[0] = { kind: "clickIfText", region: { x: 1, y: 1, w: 10, h: 10 }, texts: ["x"], point: { x: 5, y: 5 }, timeoutMs: 2000, confirmGone: "yes" };
    },
    expected: "steps.afterLaunch[0].confirmGone: must be a boolean",
  },
  {
    name: "clickIfText is not a timed trigger",
    break: (json) => {
      json.timed.send[0] = { kind: "clickIfText", region: { x: 1, y: 1, w: 10, h: 10 }, texts: ["x"], point: { x: 5, y: 5 }, timeoutMs: 2000 };
    },
    expected: 'timed.send[0].kind: "clickIfText" is not a trigger (open, keys, type, click, enter, wait)',
  },
  {
    name: "placeholders are limited to the five names",
    break: (json) => {
      json.steps.openProject[1].text = "${cwd}";
    },
    expected:
      'steps.openProject[1].text: placeholder "${cwd}" is not allowed; use ${worktree}, ${home}, ${model}, ' +
      "${effort} or ${agent}",
  },
  {
    name: "timed entries are triggers, not steps",
    break: (json) => {
      json.timed.send[0] = { kind: "paste", text: "hi" };
    },
    expected: 'timed.send[0].kind: "paste" is not a trigger (open, keys, type, click, enter, wait)',
  },
  {
    name: "a click point lies inside the window",
    break: (json) => {
      json.timed.shortThread[0] = { kind: "click", point: { x: 5000, y: 20 } };
    },
    expected: "timed.shortThread[0].point: must lie inside the 1600x1000 window",
  },
  {
    name: "reset json keys need an object",
    break: (json) => {
      json.reset.jsonKeys[0].keys = null;
    },
    expected: "reset.jsonKeys[0].keys: must be an object",
  },
  {
    name: "processes.teamId is a string or null",
    break: (json) => {
      json.processes.teamId = 5;
    },
    expected: "processes.teamId: must be a string or null",
  },
  {
    name: "app.path is required",
    break: (json) => {
      json.app.path = "";
    },
    expected: "app.path: must be a non-empty string",
  },
];

describe("validateProfile", () => {
  test("a complete profile has no errors", () => {
    expect(validateProfile(validProfile(), PROFILE_ID, ["claude", "codex"])).toEqual([]);
  });

  test("every agent the adapter runs needs configure steps", () => {
    expect(validateProfile(validProfile(), PROFILE_ID, ["claude", "own"])).toContain(
      'steps.configure.own: must be a list for the adapter\'s agent "own"',
    );
  });

  test("expectText with texts and a clickIfText step pass (ADEMARK-52)", () => {
    const json = profileJson();
    delete json.steps.configure.codex[1].text;
    json.steps.configure.codex[1].texts = ["Open", "project"];
    json.steps.afterLaunch.unshift({
      kind: "clickIfText",
      region: { x: 340, y: 12, w: 520, h: 28 },
      texts: ["new version"],
      point: { x: 1566, y: 26 },
      timeoutMs: 2000,
      confirmGone: true,
    });
    expect(validateProfile(json, PROFILE_ID, ["claude", "codex"])).toEqual([]);
  });

  test("orchestrationTrigger: a string, null, or what is still missing", () => {
    const errorFor = (value: unknown): string[] => {
      const json = profileJson();
      json.orchestrationTrigger = value;
      return validateProfile(json, PROFILE_ID, ["claude", "codex"]).filter((error) => error.startsWith("orchestration"));
    };
    expect(errorFor("/orchestrate")).toEqual([]);
    expect(errorFor(null)).toEqual([]);
    expect(errorFor({ notCalibrated: "the trigger line needs a real C1" })).toEqual([]);
    for (const bad of ["", {}, { notCalibrated: "" }, { notCalibrated: "x", extra: 1 }, 3]) {
      expect(errorFor(bad).length).toBe(1);
    }
  });

  test("returnToThread is optional, and its steps are checked like the others", () => {
    const json = profileJson();
    json.steps.returnToThread = [{ kind: "keys", combo: "cmd+1" }];
    expect(validateProfile(json, PROFILE_ID, ["claude", "codex"])).toEqual([]);
    json.steps.returnToThread = [{ kind: "teleport" }];
    expect(validateProfile(json, PROFILE_ID, ["claude", "codex"]).some((error) => error.startsWith("steps.returnToThread"))).toBe(true);
  });

  // 2026-11-11: seven draft profiles had null for apps ADES.md says orchestrate, so C1 would have published a valid
  // "not supported" for them. null is allowed only where ADES.md says "not supported", and there it is required.
  test("a null orchestration trigger matches ADES.md's not supported, both ways", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const root = join(import.meta.dir, "..", "..");
    const ades = readFileSync(join(root, "ADES.md"), "utf8");
    const cells = new Map<string, string>();
    for (const section of ades.split(/\n### 3\.\d+ /).slice(1)) {
      const id = /\| Adapter ID \| `([^`]+)`/.exec(section)?.[1];
      const cell = /\| Orchestration \(C1\) \| ([^|\n]+)/.exec(section)?.[1];
      if (id !== undefined && cell !== undefined) cells.set(id, cell.trim());
    }
    const folder = join(root, "bench", "adapters", "profiles");
    const files = readdirSync(folder).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const json = JSON.parse(readFileSync(join(folder, file), "utf8")) as { ade: string; orchestrationTrigger: unknown };
      const cell = cells.get(json.ade);
      expect(cell, json.ade).toBeDefined();
      expect([json.ade, json.orchestrationTrigger === null]).toEqual([json.ade, cell!.startsWith("not supported")]);
    }
  });

  test("beforeRelaunchQuit and beforeColdQuit are optional, and valid lists pass", () => {
    const json = profileJson();
    json.steps.beforeRelaunchQuit = [{ kind: "keys", combo: "cmd+alt+t" }, { kind: "wait", ms: 6000 }];
    json.steps.beforeColdQuit = [];
    expect(validateProfile(json, PROFILE_ID, ["claude", "codex"])).toEqual([]);
  });

  test("only Conductor and Orca set the steps before a quit, the same for A1 and A2", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const folder = join(import.meta.dir, "..", "adapters", "profiles");
    const users: string[] = [];
    for (const file of readdirSync(folder).filter((name) => name.endsWith(".json"))) {
      const json = JSON.parse(readFileSync(join(folder, file), "utf8")) as { ade: string; steps: Record<string, unknown> };
      if (json.steps.beforeRelaunchQuit !== undefined || json.steps.beforeColdQuit !== undefined) users.push(json.ade);
      // 2026-11-10 (ADEMARK-53): the close and cmd+alt+t left a relaunched Orca with no tab, and the close fails on a
      // stopped app, so both lists are empty until a real pass proves a step.
      if (json.ade === "orca") {
        expect(json.steps.beforeColdQuit).toEqual([]);
        expect(json.steps.beforeRelaunchQuit).toEqual([]);
      }
      // 2026-11-11: Conductor restores the view it was quit on, and the seed threads leave it on Home, which has no
      // composer: every A1 and A2 repetition of that night timed out there. It opens a workspace before the quit.
      if (json.ade === "conductor") {
        expect(json.steps.beforeColdQuit).toEqual([{ kind: "keys", combo: "cmd+2" }, { kind: "wait", ms: 1500 }]);
        expect(json.steps.beforeRelaunchQuit).toEqual(json.steps.beforeColdQuit);
      }
    }
    // The folder is not read in a fixed order.
    expect([...users].sort()).toEqual(["conductor", "orca"]);
  });

  // 2026-11-10 (ADEMARK-53): every Orca A3 video showed the probe in a fresh shell ("command not found: dclaude").
  test("Orca's A3 is not supported, and the reason names the probe in the shell and what the helper needs", async () => {
    const { readFileSync } = await import("node:fs");
    const json = JSON.parse(readFileSync(join(import.meta.dir, "..", "adapters", "profiles", "orca.json"), "utf8")) as {
      excludeTests?: Record<string, string>;
    };
    const reason = json.excludeTests?.A3 ?? "";
    expect(reason).toContain("first probe letter reaches the shell");
    expect(reason).toContain("command not found: dclaude");
    expect(reason).toContain("start the probe only once the agent's prompt line is drawn");
    expect(Object.keys(json.excludeTests ?? {})).toEqual(["A3"]);
  });

  test("only Conductor's profile relaunches a blank window", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const folder = join(import.meta.dir, "..", "adapters", "profiles");
    const users = readdirSync(folder)
      .filter((name) => name.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(join(folder, file), "utf8")) as { ade: string; blankRelaunchMs?: number })
      .filter((json) => json.blankRelaunchMs !== undefined)
      .map((json) => json.ade);
    expect(users).toEqual(["conductor"]);
  });

  test("a non-object is rejected once", () => {
    expect(validateProfile([], PROFILE_ID)).toEqual(["profile: must be a JSON object"]);
  });

  for (const { name, break: mutate, expected } of BAD_PROFILES) {
    test(name, () => {
      const json = profileJson();
      mutate(json);
      const errors = validateProfile(json, PROFILE_ID, ["claude", "codex"]);
      expect(errors).toContain(expected);
    });
  }

  test("one profile reports every error, each with its path", () => {
    const json = profileJson();
    json.schema = 2;
    json.window.h = -1;
    json.steps.openProject[0] = { kind: "run", argv: ["osascript"], timeoutMs: 10 };
    const errors = validateProfile(json, PROFILE_ID, ["claude", "codex"]);
    expect(errors).toContain("schema: must be 1");
    expect(errors).toContain("window.h: must be a positive integer");
    expect(errors).toContain('steps.openProject[0].argv[0]: "osascript" is not allowed');
  });
});

describe("profile files", () => {
  let dir = "";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.ADEMARK_PROFILES;
    dir = mkdtempSync(join(tmpdir(), "ademark-profiles-"));
    process.env.ADEMARK_PROFILES = dir;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ADEMARK_PROFILES;
    else process.env.ADEMARK_PROFILES = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  test("profileFile points into the profile folder", () => {
    expect(profileFile("demo-ade")).toBe(join(dir, "demo-ade.json"));
  });

  test("a missing profile is null, not an error", () => {
    expect(checkProfile(PROFILE_ID, ["claude", "codex"]).status).toBe("missing");
    expect(loadProfile(PROFILE_ID)).toBeNull();
  });

  test("a valid profile loads", () => {
    writeFileSync(profileFile(PROFILE_ID), JSON.stringify(validProfile()));
    expect(checkProfile(PROFILE_ID, ["claude", "codex"]).status).toBe("ok");
    expect(loadProfile(PROFILE_ID)?.ade).toBe(PROFILE_ID);
  });

  test("an invalid profile lists every error", () => {
    const json = profileJson();
    json.schema = 2;
    json.window.w = 0;
    writeFileSync(profileFile(PROFILE_ID), JSON.stringify(json));
    const check = checkProfile(PROFILE_ID, ["claude", "codex"]);
    expect(check.status).toBe("invalid");
    expect(check.errors).toEqual(["schema: must be 1", "window.w: must be a positive integer"]);
    expect(() => loadProfile(PROFILE_ID)).toThrow(ProfileError);
  });

  test("broken JSON is reported as invalid", () => {
    writeFileSync(profileFile(PROFILE_ID), "{not json");
    const check = checkProfile(PROFILE_ID);
    expect(check.status).toBe("invalid");
    expect(check.errors[0]).toContain("not valid JSON");
  });
});

describe("Cloudroom's first new thread is Local (ADEMARK-43)", () => {
  test("a dry launch sets defaults.startingMachine before the first cmd+n, and the Full guard still runs", async () => {
    const { getAdapter } = await import("../adapters/registry.ts");
    const { captureContext } = await import("./adapters-fake.ts");
    const adapter = getAdapter("cloudroom");
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/cloudroom" });
    await adapter.configure(ctx, { model: null, effort: null, server: "replay", agent: "claude" });
    await adapter.launch(ctx);
    const setting = lines.findIndex((line) => line.includes("settings ui set defaults.startingMachine last"));
    const firstNew = lines.findIndex((line) => line.includes("combo=cmd+n"));
    expect(setting).toBeGreaterThan(-1);
    expect(firstNew).toBeGreaterThan(setting);
    expect(lines.filter((line) => line.includes("settings ui set defaults.startingMachine last"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("text=Full"))).toHaveLength(2);
  });
});

describe("Conductor and Cloudroom start from the screenshots of 10 Nov (ADEMARK-52)", () => {
  test("Cloudroom closes the banner and hides the card first in afterLaunch, and keeps both guards", async () => {
    const { getAdapter } = await import("../adapters/registry.ts");
    const { captureContext } = await import("./adapters-fake.ts");
    // A worktree of its own: the adapter is shared, and openProject runs only for a worktree it has not opened yet.
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/cloudroom-52" });
    const adapter = getAdapter("cloudroom");
    await adapter.configure(ctx, { model: null, effort: null, server: "replay", agent: "claude" });
    await adapter.launch(ctx);
    const conditional = lines.filter((line) => line.startsWith("plan: clickIfText"));
    expect(conditional).toEqual([
      "plan: clickIfText pid=0 texts=Get started|started region=1268,364,160,26 at=1551,597 timeoutMs=2000",
      "plan: clickIfText pid=0 texts=version|Restart|update|password|ready|new version of Cloudroom|Cloudroom is ready " +
        "region=340,12,860,28 at=1566,26 timeoutMs=2000 confirmGone",
      "plan: clickIfText pid=0 texts=Get started|started region=1268,312,160,26 at=1551,545 timeoutMs=2000",
    ]);
    const lastConditional = lines.lastIndexOf(conditional[2]!);
    expect(lastConditional).toBeLessThan(lines.findIndex((line) => line.includes("settings ui set")));
    expect(lines.filter((line) => line.includes("text=One-click"))).toHaveLength(2);
    expect(lines.filter((line) => line.includes("text=Full"))).toHaveLength(2);
    // Restart to update (x 1412 to 1536, y about 12 to 40) is never a click point of any step.
    const points = lines.flatMap((line) => [...line.matchAll(/at=(\d+),(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]));
    expect(points.some(([x, y]) => x! >= 1400 && x! <= 1545 && y! <= 45)).toBe(false);
  });

  test("Conductor's Home check takes Open or project, and the banner check two words of the banner", async () => {
    const { getAdapter } = await import("../adapters/registry.ts");
    const { captureContext } = await import("./adapters-fake.ts");
    const { ctx, lines } = captureContext({ worktree: "/tmp/home/arena/conductor-52" });
    const adapter = getAdapter("conductor");
    await adapter.configure(ctx, { model: null, effort: null, server: "replay", agent: "claude" });
    await adapter.launch(ctx);
    const waits = lines.filter((line) => line.startsWith("plan: waitForText"));
    expect(waits).toEqual(["plan: waitForText pid=0 texts=Open|project", "plan: waitForText pid=0 texts=new copy|copy of"]);
    const home = lines.indexOf(waits[0]!);
    expect(lines.slice(home).find((line) => line.startsWith("plan: click "))).toBe("plan: click pid=0 at=711,431 count=1");
  });
});

// 2026-11-11, third pass: Cloudroom's block stopped twice at openProject[13] with the thread already on arena and
// Local. The region of 'Full' had been moved to the sidebar footer from a screenshot alone, and OCR reads nothing
// there; the region of 'High' read 'g'. The fixture is the screenshot the failed wait kept
// (control-2026-11-10T08-31-19Z-cloudroom-5/waits/2026-11-11T18-50-02-401Z-Full.png): the new-thread screen of 150
// that every text check of afterLaunch and openProject must read, with the real helper.
describe("Cloudroom's text checks read the real new-thread screen of 150", () => {
  const frame = join(import.meta.dir, "fixtures", "cloudroom-150-new-thread.png");
  const helper = join(import.meta.dir, "..", "native", "bin", "ademark-native");
  const plain = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const read = (region: { x: number; y: number; w: number; h: number }): string[] => {
    const out = Bun.spawnSync([helper, "ocr", "--image", frame, "--region", `${region.x},${region.y},${region.w},${region.h}`]);
    return (JSON.parse(out.stdout.toString()) as { lines: string[] }).lines;
  };

  test("every expectText of afterLaunch and openProject finds its text on the screenshot", () => {
    const profile = loadProfile("cloudroom");
    const checks = [...(profile.steps.afterLaunch ?? []), ...(profile.steps.openProject ?? [])].flatMap((step) =>
      step.kind === "expectText" ? [step] : [],
    );
    expect(checks.map((step) => step.text)).toEqual(["One-click", "Full", "One-click", "Full", "arena", "High"]);
    for (const step of checks) {
      const lines = read(step.region);
      const texts = step.texts ?? [step.text as string];
      const found = lines.some((line) => texts.some((text) => plain(line).includes(plain(text))));
      expect({ text: step.text, region: step.region, lines, found }).toMatchObject({ found: true });
    }
  });

  test("the sidebar footer and the old 'High' region do not read, so they stay out of the profile", () => {
    expect(read({ x: 250, y: 963, w: 70, h: 28 })).toEqual([]);
    expect(read({ x: 716, y: 152, w: 100, h: 28 }).some((line) => plain(line).includes("high"))).toBe(false);
  });
});

// 2026-11-11: on Superset 2.0.8 the second fixed click of openProject lands inside the composer, so the typed folder
// path and the two Enters that followed would have sent the path as a message. Nothing is typed by a fixed step now.
describe("Superset's openProject types nothing by itself (2.0.8)", () => {
  test("only the screen agent acts, and a last look fails unless the project reads superset", () => {
    const steps = loadProfile("superset").steps.openProject ?? [];
    expect(steps.filter((step) => step.kind === "type" || step.kind === "enter" || step.kind === "click" || step.kind === "keys")).toEqual([]);
    const goals = steps.flatMap((step) => (step.kind === "goal" ? [step] : []));
    expect(goals).toHaveLength(2);
    expect(goals[0]!.goal).toContain("Never type anything unless that file dialog is on the screen");
    expect(goals[0]!.goal).toContain("never send a message");
    expect(goals[1]!.maxActions).toBe(1);
    expect(goals[1]!.goal).toContain("must read 'superset'");
    expect(steps.at(-1)).toBe(goals[1]!);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GHOSTTY_CONFIG } from "../ops/account.ts";
import type { AccountItem } from "../ops/account.ts";
import { CHECKS, runDoctor, type DoctorAdapter, type DoctorOptions, type PinsFile } from "../ops/doctor.ts";
import { DISPLAYPLACER } from "../ops/machine.ts";
import { writeGate } from "../adapters/gates.ts";
import type { Adapter, CalibrationGate, InstallInfo } from "../core/contracts.ts";
import type { Gates } from "../core/gates.ts";
import type { OpsRun, OpsRunner } from "../ops/runner.ts";
import { cleanSnapshotDir } from "../adapters/support.ts";

const HOME = "/Users/ademark";
const REPO = "/Users/ademark/ADEMark";
const PRIVATE = "/Users/ademark/ademark-private";
const NATIVE = `${REPO}/bench/native/bin/ademark-native`;
const ARENA = `${HOME}/arena`;

interface Scenario {
  username: string;
  machineOn: boolean;
  sudoAllowed: boolean;
  displayHz: number;
  displayplacer: boolean;
  nativeBuilt: boolean;
  permissions: { accessibility: boolean; screen_recording: boolean };
  ghosttyKb: number;
  guiApps: string[];
  accountBad: boolean;
  pins: PinsFile;
  claudeVersion: string;
  codexVersion: string;
  claudeLogin: boolean;
  codexAuth: boolean;
  adapterInstalled: boolean;
  adapterLoginFile: boolean;
  mitmdump: boolean;
  extension: boolean;
  envVars: Record<string, string>;
  portBusy: boolean;
  gates: Gates;
  freeKb: number;
  snapshot: boolean;
  gitDirty: number;
  onAc: boolean;
  lowPower: number;
  dnd: boolean;
  pfAnchor: string;
  seeds: boolean;
}

const HAPPY_PINS: PinsFile = {
  apps: { "fake-ade": { version: "1.0.0", binary_sha256: "abc" } },
  clis: { claude: { version: "2.1.303" }, codex: { version: "0.163.0" } },
};

const HAPPY_GATES: Gates = {
  swap_ok: true,
  swap_used_mb: 0,
  thermal_ok: true,
  cpu_quiet_ok: true,
  cpu_cores_used: 0.02,
  cpu_top: [],
};

const GATE: CalibrationGate = {
  ade: "fake-ade",
  runs: 5,
  passed: 5,
  at: "2026-10-21T00:00:00.000Z",
  harnessCommit: "abc1234",
  version: "1.0.0",
  bundleSha256: "abc",
  failures: [],
};

let gatesDir = "";
let savedGatesDir: string | undefined;

beforeEach(() => {
  savedGatesDir = process.env.ADEMARK_GATES;
  gatesDir = mkdtempSync(join(tmpdir(), "ademark-doctor-gates-"));
  process.env.ADEMARK_GATES = gatesDir;
  writeGate(GATE);
});

afterEach(() => {
  if (savedGatesDir === undefined) delete process.env.ADEMARK_GATES;
  else process.env.ADEMARK_GATES = savedGatesDir;
  rmSync(gatesDir, { recursive: true, force: true });
});

function happyScenario(): Scenario {
  return {
    username: "ademark",
    machineOn: true,
    sudoAllowed: true,
    displayHz: 60,
    displayplacer: true,
    nativeBuilt: true,
    permissions: { accessibility: true, screen_recording: true },
    ghosttyKb: 100 * 1024,
    guiApps: [],
    accountBad: false,
    pins: HAPPY_PINS,
    claudeVersion: "2.1.303",
    codexVersion: "0.163.0",
    claudeLogin: true,
    codexAuth: true,
    adapterInstalled: true,
    adapterLoginFile: true,
    mitmdump: true,
    extension: true,
    envVars: {},
    portBusy: false,
    gates: HAPPY_GATES,
    freeKb: 40 * 1024 * 1024,
    snapshot: true,
    gitDirty: 0,
    onAc: true,
    lowPower: 0,
    dnd: true,
    pfAnchor: "empty",
    seeds: true,
  };
}

function machineStatus(scenario: Scenario): string {
  const on = scenario.machineOn;
  return [
    "before.env=present",
    `spotlight./=${on ? "off" : "on"}`,
    `power.powernap=${on ? 0 : 1}`,
    `power.sleep=${on ? 0 : 1}`,
    `power.displaysleep=${on ? 0 : 10}`,
    `power.disksleep=${on ? 0 : 10}`,
    `updates.schedule=${on ? "off" : "on"}`,
    `updates.AutomaticDownload=${on ? 0 : 1}`,
    `updates.AutomaticallyInstallMacOSUpdates=${on ? 0 : 1}`,
    `updates.AutomaticCheckEnabled=${on ? 0 : 1}`,
    `updates.ConfigDataInstall=${on ? 0 : 1}`,
    `updates.CriticalUpdateInstall=${on ? 0 : 1}`,
    `timemachine.autobackup=${on ? "off" : "on"}`,
    `pf.ademark=${scenario.pfAnchor}`,
  ].join("\n");
}

function displayJson(hz: number): string {
  return JSON.stringify({
    SPDisplaysDataType: [
      {
        spdisplays_ndrvs: [
          {
            spdisplays_main: "spdisplays_yes",
            _spdisplays_resolution: `2560 x 1440 @ ${hz}.00Hz`,
            _spdisplays_pixels: "2560 x 1440",
          },
        ],
      },
    ],
  });
}

function lsappinfoText(extra: readonly string[]): string {
  const lines = [
    ' 1) "Ghostty" ASN:0x0-0x1:',
    '    pid = 1 token=[sess=1 pid=1 uid:502] type="Foreground" flavor=3',
    ' 2) "Finder" ASN:0x0-0x2:',
    '    pid = 2 token=[sess=1 pid=2 uid:502] type="Foreground" flavor=3',
  ];
  let index = 3;
  for (const app of extra) {
    lines.push(` ${index}) "${app}" ASN:0x0-0x${index}:`);
    lines.push(`    pid = ${index} token=[sess=1 pid=${index} uid:502] type="Foreground" flavor=3`);
    index += 1;
  }
  return `${lines.join("\n")}\n`;
}

function scenarioRunner(scenario: Scenario): OpsRunner {
  const files = new Map<string, string>([
    [`${HOME}/.config/ghostty/config`, GHOSTTY_CONFIG],
    [`${HOME}/.claude/settings.json`, JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } })],
    [`${HOME}/.codex/config.toml`, "check_for_update_on_startup = false\n"],
    [`${HOME}/.claude.json`, JSON.stringify({ projects: { [ARENA]: { hasTrustDialogAccepted: true } } })],
    [`${PRIVATE}/pins/versions.json`, JSON.stringify(scenario.pins)],
  ]);
  const existing = new Set<string>([ARENA]);
  if (scenario.adapterLoginFile) existing.add(`${HOME}/seed.json`);
  if (scenario.displayplacer) existing.add(DISPLAYPLACER);
  if (scenario.codexAuth) existing.add(`${HOME}/.codex/auth.json`);
  if (scenario.nativeBuilt) existing.add(NATIVE);
  if (scenario.snapshot) existing.add(cleanSnapshotDir());
  if (scenario.seeds) {
    existing.add(`${PRIVATE}/seeds/t3code/home/.t3/userdata`);
    existing.add(`${PRIVATE}/seeds/zeron/home/.zeron/profiles/local`);
  }

  const result = (code: number, stdout = "", stderr = ""): OpsRun => ({ code, stdout, stderr });

  return {
    username: () => scenario.username,
    uid: () => 502,
    home: () => HOME,
    env: (name) => scenario.envVars[name],
    envWithPrefix: (prefix) => Object.keys(scenario.envVars).filter((name) => name.startsWith(prefix)).sort(),
    exists: (path) => existing.has(path) || files.has(path),
    readFile: (path) => files.get(path) ?? null,
    writeFile: () => undefined,
    mkdirp: () => undefined,
    signal: () => undefined,
    sleep: async () => undefined,
    now: () => 0,
    run(argv) {
      const [command, second, third] = argv;
      if (command === "sudo") {
        if (!scenario.sudoAllowed) return result(1, "", "sudo: a password is required");
        return result(0, machineStatus(scenario));
      }
      if (command === "system_profiler") return result(0, displayJson(scenario.displayHz));
      if (command === DISPLAYPLACER) {
        return result(0, `Resolution: 2560x1440\ndisplayplacer "id:1 res:2560x1440 hz:${scenario.displayHz} scaling:on"\n`);
      }
      if (command === NATIVE) {
        return result(0, JSON.stringify(scenario.permissions));
      }
      if (command === "ps") {
        return result(0, `  123 /Applications/Ghostty.app/Contents/MacOS/ghostty ${scenario.ghosttyKb}\n`);
      }
      if (command === "lsappinfo") return result(0, lsappinfoText(scenario.guiApps));
      if (command === "claude") return result(0, `${scenario.claudeVersion} (Claude Code)\n`);
      if (command === "codex") return result(0, `codex-cli ${scenario.codexVersion}\n`);
      if (command === "security" && second === "find-generic-password") {
        return scenario.claudeLogin ? result(0, "keychain: login.keychain-db\nclass: genp\n") : result(44, "", "not found");
      }
      if (command === "security" && second === "find-certificate") {
        return result(0, "SHA-256 hash: 0123456789ABCDEF\n");
      }
      if (command === "mitmdump") {
        return scenario.mitmdump ? result(0, "Mitmproxy: 12.2.3 binary\n") : result(127, "", "not found");
      }
      if (command === "systemextensionsctl") {
        return result(
          0,
          scenario.extension
            ? "*\t*\tS8XHQB96PW\torg.mitmproxy.macos-redirector.network-extension (2.0/1)\tnetwork-extension\t[activated enabled]\n"
            : "*\t*\tS8XHQB96PW\torg.mitmproxy.macos-redirector.network-extension (2.0/1)\tnetwork-extension\t[terminated waiting to uninstall]\n",
        );
      }
      if (command === "launchctl" && second === "getenv") {
        return result(0, scenario.envVars[third ?? ""] ?? "");
      }
      if (command === "launchctl" && second === "print-disabled") {
        return result(
          0,
          `disabled services = {\n  "com.adobe.AdobeCreativeCloud" => disabled\n  "com.adobe.AdobeDesktopService" => disabled\n  "com.adobe.ccxprocess" => disabled\n}\n`,
        );
      }
      if (command === "lsof") {
        return scenario.portBusy
          ? result(0, "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode 1234 ademark 20u IPv4 0x1 0t0 TCP *:8787 (LISTEN)\n")
          : result(1);
      }
      if (command === "df") {
        return result(
          0,
          `Filesystem   1024-blocks      Used Available Capacity iused      ifree %iused  Mounted on\n/dev/disk3s5   239362496 181570584 ${scenario.freeKb}    85% 2258658 321477840    1%   /System/Volumes/Data\n`,
        );
      }
      if (command === "git" && second === "-C") {
        if (argv[3] === "status") {
          return result(0, Array.from({ length: scenario.gitDirty }, (_, index) => ` M file-${index}.ts`).join("\n"));
        }
        if (argv[3] === "rev-parse") return result(0, "6213db0abcdef0123456789abcdef0123456789a\n");
      }
      if (command === "pmset") {
        if (second === "-g" && third === "batt") {
          return result(0, scenario.onAc ? "Now drawing from 'AC Power'\n" : "Now drawing from 'Battery Power'\n");
        }
        if (second === "-g" && third === "custom") {
          return result(0, `AC Power:\n lowpowermode         ${scenario.lowPower}\n`);
        }
      }
      if (command === "osascript") return result(0, "120\n");
      if (command === "defaults") {
        return scenario.dnd ? result(0, "1\n") : result(1, "", "The domain/default pair does not exist");
      }
      if (command === "pluginkit") return result(0, "-    com.adobe.accmac.ACCFinderSync(7.10.0.1)\n");
      return result(127, "", `unexpected command: ${argv.join(" ")}`);
    },
  };
}

function fakeAdapter(installed: boolean, loginFile: boolean): DoctorAdapter {
  const info: InstallInfo = installed
    ? { installed: true, version: "1.0.0", path: "/Applications/Fake.app", binarySha256: "abc" }
    : { installed: false, version: null, path: "/Applications/Fake.app", binarySha256: null };
  const adapter = {
    id: "fake-ade",
    name: "Fake",
    family: "NATIVE",
    agents: ["claude"],
    calibration: {
      appName: "Fake",
      bundleId: null,
      composerRect: null,
      threadRect: null,
      focusClick: null,
      masks: [],
      drive: "keys",
      dataDirs: [],
      launchAgents: [],
    },
    login: loginFile ? { kind: "app", files: ["~/seed.json"], signIn: "Sign in to Fake" } : undefined,
    timed: { launch: [], newThread: [], send: [] },
    installCheck: async () => info,
    reset: async () => undefined,
    configure: async () => undefined,
    launch: async () => ({ pid: 0 }),
    newThread: async () => undefined,
    send: async () => undefined,
    waitDone: async () => ({ done: true, reason: "" }),
    quit: async () => undefined,
    processes: () => ({ bundlePaths: [], vendorDirs: [], launchAgentLabels: [], teamId: null, agentExecutables: [] }),
  } as unknown as Adapter;
  return { id: "fake-ade", adapter };
}

function accountItems(bad: boolean): AccountItem[] {
  return bad
    ? [{ name: "ghostty-config", status: "missing", detail: "missing", fix: "ademark account setup --apply" }]
    : [{ name: "ghostty-config", status: "ok", detail: "ok", fix: "" }];
}

function options(scenario: Scenario): DoctorOptions {
  return {
    runner: scenarioRunner(scenario),
    username: scenario.username,
    privateRoot: PRIVATE,
    repoRoot: REPO,
    resultsRoot: join(REPO, "results"),
    nativePath: NATIVE,
    adapters: [fakeAdapter(scenario.adapterInstalled, scenario.adapterLoginFile)],
    gates: () => scenario.gates,
    account: () => accountItems(scenario.accountBad),
  };
}

async function outcome(name: string, scenario: Scenario) {
  const check = CHECKS.find((entry) => entry.name === name);
  if (check === undefined) throw new Error(`no check named ${name}`);
  const { results } = await runDoctor({ ...options(scenario), checks: [check] });
  return results[0]!;
}

const FAILING: Array<{ name: string; patch: Partial<Scenario> }> = [
  { name: "running as ademark", patch: { username: "owner" } },
  { name: "not inside an agent session", patch: { envVars: { CODEX_HOME: "/tmp/codex" } } },
  { name: "root script installed and allowed", patch: { sudoAllowed: false } },
  { name: "machine state on", patch: { machineOn: false } },
  { name: "display at 60 Hz", patch: { displayHz: 144 } },
  { name: "ademark-native built and permitted", patch: { permissions: { accessibility: true, screen_recording: false } } },
  { name: "Ghostty memory", patch: { ghosttyKb: 500 * 1024 } },
  { name: "other GUI apps", patch: { guiApps: ["T3 Code (Beta)"] } },
  { name: "account items", patch: { accountBad: true } },
  {
    name: "claude and codex versions",
    patch: {
      pins: {
        apps: { "fake-ade": { version: "1.0.0", binary_sha256: "abc" } },
        clis: { claude: { version: "2.1.304" }, codex: { version: "0.163.0" } },
      },
    },
  },
  { name: "Claude login", patch: { claudeLogin: false } },
  { name: "Codex login", patch: { codexAuth: false } },
  { name: "adapter installs", patch: { adapterInstalled: false } },
  { name: "adapter logins", patch: { adapterLoginFile: false } },
  { name: "mitmproxy", patch: { mitmdump: false } },
  { name: "no harness variables in launchd", patch: { envVars: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" } } },
  { name: "replay port free", patch: { portBusy: true } },
  {
    name: "gates",
    patch: {
      gates: { swap_ok: false, swap_used_mb: 512, thermal_ok: true, cpu_quiet_ok: true, cpu_cores_used: 0.02, cpu_top: [] },
    },
  },
  { name: "disk space", patch: { freeKb: 5 * 1024 * 1024 } },
  { name: "clean snapshot", patch: { snapshot: false } },
  { name: "harness tree clean", patch: { gitDirty: 2 } },
  { name: "AC power and Low Power Mode off", patch: { onAc: false, lowPower: 1 } },
  { name: "Do Not Disturb", patch: { dnd: false } },
  { name: "pf anchor empty", patch: { pfAnchor: "2 rules" } },
  { name: "seeds", patch: { seeds: false } },
];

describe("doctor", () => {
  test("has one check for every check in the brief, in order", () => {
    expect(CHECKS.map((check) => check.name)).toEqual([
      "running as ademark",
      "not inside an agent session",
      "root script installed and allowed",
      "machine state on",
      "display at 60 Hz",
      "ademark-native built and permitted",
      "Ghostty memory",
      "other GUI apps",
      "account items",
      "claude and codex versions",
      "Claude login",
      "Codex login",
      "adapter installs",
      "adapter logins",
      "calibration gates",
      "mitmproxy",
      "no harness variables in launchd",
      "replay port free",
      "gates",
      "disk space",
      "clean snapshot",
      "harness tree clean",
      "AC power and Low Power Mode off",
      "Automation for System Events",
      "Do Not Disturb",
      "pf anchor empty",
      "seeds",
    ]);
  });

  test("--agent without codex skips the Codex login and the adapters that run none of the agents", async () => {
    const pick = (name: string) => CHECKS.filter((entry) => entry.name === name);
    const codex = await runDoctor({
      ...options({ ...happyScenario(), codexAuth: false }),
      checks: pick("Codex login"),
      agents: ["claude", "own"],
    });
    expect(codex.results[0]!.status).toBe("skip");
    const logins = await runDoctor({
      ...options({ ...happyScenario(), adapterLoginFile: false }),
      checks: pick("adapter logins"),
      agents: ["codex"],
    });
    expect(logins.results[0]!.status).toBe("ok");
  });

  test("every check passes on a healthy fake machine", async () => {
    for (const check of CHECKS) {
      const result = await outcome(check.name, happyScenario());
      expect({ name: check.name, status: result.status, detail: result.detail }).toEqual({
        name: check.name,
        status: "ok",
        detail: result.detail,
      });
    }
  });

  test("disk space: 10 GB free is enough for a night, 5 GB is not", async () => {
    // 2026-11-10: the old 15 GB limit would have stopped a watchdog restart on a Mac with 15.2 GB free.
    expect((await outcome("disk space", { ...happyScenario(), freeKb: 10 * 1024 * 1024 })).status).toBe("ok");
    expect((await outcome("disk space", { ...happyScenario(), freeKb: 5 * 1024 * 1024 })).status).toBe("fail");
  });

  test("warns when displayplacer is missing even though the display is at 60 Hz", async () => {
    const result = await outcome("display at 60 Hz", { ...happyScenario(), displayplacer: false });
    expect(result.status).toBe("warn");
    expect(result.fix).toContain("displayplacer");
  });

  test("falls back to displayplacer when system_profiler fails", async () => {
    const scenario = happyScenario();
    const runner = scenarioRunner(scenario);
    const original = runner.run.bind(runner);
    const broken: OpsRunner = {
      ...runner,
      run: (argv) => (argv[0] === "system_profiler" ? { code: 1, stdout: "", stderr: "boom" } : original(argv)),
    };
    const { results } = await runDoctor({
      ...options(scenario),
      runner: broken,
      checks: CHECKS.filter((check) => check.name === "display at 60 Hz"),
    });
    expect({ status: results[0]!.status, detail: results[0]!.detail }).toEqual({
      status: "ok",
      detail: "2560x1440 @ 60 Hz",
    });
  });

  test("warns for an ADE with no calibration gate", async () => {
    rmSync(join(gatesDir, "fake-ade.json"));
    const result = await outcome("calibration gates", happyScenario());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("fake-ade: missing");
    expect(result.detail).toContain("these ADEs will be skipped tonight");
    expect(result.fix).toBe("ademark calibrate gate --ade <id>");
  });

  test("warns for a stale calibration gate", async () => {
    writeGate({ ...GATE, version: "0.9.0" });
    const result = await outcome("calibration gates", happyScenario());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("fake-ade: stale");
  });

  test("every check reports a failing or warning result when its input is bad", async () => {
    for (const entry of FAILING) {
      const result = await outcome(entry.name, { ...happyScenario(), ...entry.patch });
      expect({ name: entry.name, status: result.status }).not.toEqual({ name: entry.name, status: "ok" });
    }
  });

  test("exits 0 when every check passes", async () => {
    const { exitCode, results } = await runDoctor(options(happyScenario()));
    expect(results.length).toBe(CHECKS.length);
    expect(exitCode).toBe(0);
  });

  test("exits 1 when a blocking check fails", async () => {
    const { exitCode } = await runDoctor(options({ ...happyScenario(), displayHz: 144 }));
    expect(exitCode).toBe(1);
  });

  test("warnings alone do not fail the run", async () => {
    const { exitCode, results } = await runDoctor(options({ ...happyScenario(), dnd: false, seeds: false }));
    expect(results.filter((entry) => entry.status === "warn").length).toBe(2);
    expect(exitCode).toBe(0);
  });

  test("skips sudo checks when the user is not ademark", async () => {
    const scenario = { ...happyScenario(), username: "owner" };
    for (const name of ["root script installed and allowed", "machine state on", "pf anchor empty"]) {
      expect((await outcome(name, scenario)).status).toBe("skip");
    }
  });
});

// `pins record` and `pins profiles` with a fake runner and temp app bundles: no real /Applications, no ademark user.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallInfo } from "../adapters/support.ts";
import {
  appPinAt,
  cliPin,
  collectPins,
  formatProfileStatus,
  pinsPath,
  profilesStatus,
  recordPinsCommand,
  writeProfiles,
} from "../ops/pins.ts";
import type { OpsRun, OpsRunner } from "../ops/runner.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ademark-pins-"));
}

function makeApp(dir: string, name: string, version: string, bundleId: string): string {
  const app = join(dir, `${name}.app`);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key><string>${bundleId}</string>\n<key>CFBundleShortVersionString</key><string>${version}</string>\n<key>CFBundleExecutable</key><string>${name}</string>\n</dict></plist>\n`,
  );
  writeFileSync(join(app, "Contents", "MacOS", name), "#!/bin/sh\nexit 0\n");
  return app;
}

interface FakeOptions {
  username?: string;
  files?: Record<string, string>;
  versions?: Record<string, string>;
  teamId?: string;
}

function fakeRunner(o: FakeOptions = {}): { runner: OpsRunner; written: Map<string, string> } {
  const written = new Map<string, string>();
  const result = (code: number, stdout = "", stderr = ""): OpsRun => ({ code, stdout, stderr });
  return {
    written,
    runner: {
      username: () => o.username ?? "someone",
      uid: () => 502,
      home: () => "/tmp/home",
      env: () => undefined,
      envWithPrefix: () => [],
      exists: () => false,
      readFile: (path) => o.files?.[path] ?? null,
      writeFile: (path, text) => {
        written.set(path, text);
      },
      mkdirp: () => undefined,
      signal: () => undefined,
      sleep: async () => undefined,
      now: () => 0,
      run(argv) {
        if (argv[0] === "codesign") {
          return result(0, "", o.teamId === undefined ? "" : `Executable=/x\nTeamIdentifier=${o.teamId}\n`);
        }
        const name = argv[0];
        const version = name === undefined ? undefined : o.versions?.[name];
        if (version !== undefined) return result(0, `${name} ${version}\n`);
        return result(127, "", `unexpected command: ${argv.join(" ")}`);
      },
    },
  };
}

const notInstalled: InstallInfo = { installed: false, version: null, path: null, binarySha256: null };

describe("appPinAt", () => {
  test("reads version, bundle id, executable sha and team id from a bundle", () => {
    const dir = tmp();
    try {
      const app = makeApp(dir, "Fake", "1.2.3", "com.example.fake");
      const { runner } = fakeRunner({ teamId: "TEAM12345" });
      const pin = appPinAt(app, runner);
      expect(pin?.version).toBe("1.2.3");
      expect(pin?.bundle_id).toBe("com.example.fake");
      expect(pin?.team_id).toBe("TEAM12345");
      expect(pin?.binary_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(appPinAt(join(dir, "Missing.app"), runner)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cliPin", () => {
  test("parses --version and hashes the resolved binary", () => {
    const dir = tmp();
    try {
      const bin = join(dir, "claude");
      writeFileSync(bin, "binary");
      const { runner } = fakeRunner({ versions: { claude: "2.1.303" } });
      const pin = cliPin("claude", runner, () => ({ version: null, path: bin }));
      expect(pin?.version).toBe("2.1.303");
      expect(pin?.binary_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(cliPin("codex", runner, () => ({ version: null, path: null }))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pins record", () => {
  test("dry run prints old -> new and keeps replaced entries, writes nothing", async () => {
    const dir = tmp();
    try {
      const app = makeApp(dir, "Paseo", "0.16.2", "sh.paseo.app");
      const privateDir = join(dir, "private");
      const oldFile = JSON.stringify({
        apps: { paseo: { version: "0.15.0", bundle_id: "sh.paseo.app" }, conductor: { version: "0.91.2" } },
        clis: { claude: { version: "2.1.303" } },
        agents: { keep: { version: "1" } },
      });
      const { runner, written } = fakeRunner({
        files: { [pinsPath(privateDir)]: oldFile },
        versions: { claude: "2.1.303", codex: "0.163.0" },
        teamId: "TEAM1",
      });
      const install = async (id: string): Promise<InstallInfo> =>
        id === "paseo" ? { installed: true, version: "0.16.2", path: app, binarySha256: null } : notInstalled;
      const { code, text } = await recordPinsCommand({
        apply: false,
        runner,
        privateRootPath: privateDir,
        deps: { install, ghosttyPath: join(dir, "none.app"), cliResolve: () => ({ version: null, path: null }) },
      });
      expect(code).toBe(0);
      expect(text).toContain("apps.paseo: 0.15.0 -> 0.16.2");
      expect(text).toContain("apps.conductor: 0.91.2 -> removed");
      expect(text).toContain("dry run");
      expect(written.size).toBe(0);

      const { file } = await collectPins(runner, privateDir, {
        install,
        ghosttyPath: join(dir, "none.app"),
        cliResolve: () => ({ version: null, path: null }),
      });
      expect(file.apps?.paseo?.version).toBe("0.16.2");
      expect(file.apps?.paseo?.team_id).toBe("TEAM1");
      expect(file.apps?.conductor).toBeUndefined();
      const replaced = file.replaced as Record<string, Record<string, { version?: string }>>;
      expect(replaced.apps?.paseo?.version).toBe("0.15.0");
      expect(replaced.apps?.conductor?.version).toBe("0.91.2");
      expect(file.agents).toEqual({ keep: { version: "1" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--apply refuses outside the ademark user and writes as ademark", async () => {
    const dir = tmp();
    try {
      const privateDir = join(dir, "private");
      const { runner: other, written } = fakeRunner({ username: "someone" });
      const refused = await recordPinsCommand({
        apply: true,
        runner: other,
        privateRootPath: privateDir,
        deps: { install: async () => notInstalled, ghosttyPath: join(dir, "none.app"), cliResolve: () => ({ version: null, path: null }) },
      });
      expect(refused.code).toBe(2);
      expect(refused.text).toContain('refusing to write as "someone"');
      expect(written.size).toBe(0);

      const { runner: ademark, written: wrote } = fakeRunner({ username: "ademark" });
      const done = await recordPinsCommand({
        apply: true,
        runner: ademark,
        privateRootPath: privateDir,
        deps: { install: async () => notInstalled, ghosttyPath: join(dir, "none.app"), cliResolve: () => ({ version: null, path: null }) },
      });
      expect(done.code).toBe(0);
      expect(done.text).toContain("wrote");
      expect(wrote.get(pinsPath(privateDir))).toContain('"apps"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pins profiles", () => {
  test("reports pinned vs installed and --write updates only app.version and app.bundleSha256", async () => {
    const dir = tmp();
    try {
      const profilesDir = join(dir, "profiles");
      const gatesDir = join(dir, "gates");
      mkdirSync(profilesDir, { recursive: true });
      mkdirSync(gatesDir, { recursive: true });
      const app = makeApp(dir, "Fake", "2.0.0", "com.example.fake");
      const profile = {
        schema: 1,
        ade: "fake",
        app: { path: app, version: "1.0.0", bundleSha256: "oldsha", processNames: ["Fake"] },
        notes: ["keep me"],
      };
      writeFileSync(join(profilesDir, "fake.json"), `${JSON.stringify(profile, null, 2)}\n`);
      const installedSha = "a".repeat(64);
      const installed = async () => ({ installed: true, version: "2.0.0", path: app, binarySha256: installedSha });

      const statuses = await profilesStatus({ profilesDir, gatesDir, installed });
      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.differs).toBe(true);
      expect(formatProfileStatus(statuses)).toContain("DIFFERS");

      const writes = new Map<string, string>();
      const result = await writeProfiles({ profilesDir, installed, write: (path, text) => writes.set(path, text) });
      expect(result.code).toBe(0);
      expect(result.text).toContain("1.0.0 oldsha -> 2.0.0 aaaaaaaaaaaa");
      const written = JSON.parse(writes.get(join(profilesDir, "fake.json"))!) as typeof profile;
      expect(written.app.version).toBe("2.0.0");
      expect(written.app.bundleSha256).toBe(installedSha);
      expect(written.app.processNames).toEqual(["Fake"]);
      expect(written.notes).toEqual(["keep me"]);
      expect(readFileSync(join(profilesDir, "fake.json"), "utf8")).toContain('"version": "1.0.0"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

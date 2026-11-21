import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orca } from "../adapters/orca.ts";
import { resetMacosRunner, setMacosRunner } from "../adapters/macos.ts";
import type { AdapterContext } from "../core/contracts.ts";
import { captureContext, fakeRunner } from "./adapters-fake.ts";

const ORCA_CLI = "/Applications/Orca.app/Contents/Resources/bin/orca";

function installArgs(agent: string): string[] {
  return [ORCA_CLI, "skills", "install", "--skill", "orca-cli", "--skill", "orchestration", "--agent", agent];
}

// The install writes the shared .agents folder for every agent and links ~/.claude/skills only for claude
// (the vendor CLI's own --dry-run shows the same split).
function skillTargets(home: string, agent: string | undefined): string[] {
  const shared = ["orca-cli", "orchestration"].map((name) => join(home, ".agents", "skills", name));
  if (agent === "codex") return shared;
  return [...shared, ...["orca-cli", "orchestration"].map((name) => join(home, ".claude", "skills", name))];
}

let homes: string[] = [];

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ademark-orca-"));
  homes.push(home);
  return home;
}

beforeEach(() => {
  resetMacosRunner();
});

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("orca orchestration skill", () => {
  test("a Track C block plans the vendor install, the PATH shim, the marker and the full cleanup", async () => {
    setMacosRunner(fakeRunner("owner"));
    const { ctx, lines } = captureContext({ home: "/tmp/orca-home" });

    await orca.prepareOrchestration!(ctx);
    await orca.quit(ctx);

    // No agent on the context: the install covers both, the way `orca skills install` detects them.
    expect(lines).toContain(`plan: run ${installArgs("claude,codex").join(" ")}`);
    expect(lines).toContain(`plan: linkPath /tmp/orca-home/.local/bin/orca ${ORCA_CLI}`);
    expect(lines.some((line) => line.startsWith("plan: writeFile /tmp/orca-home/.config/ademark/orca-c1-installed.json"))).toBe(true);
    for (const path of [...skillTargets("/tmp/orca-home", undefined), "/tmp/orca-home/.local/bin/orca"]) {
      expect(lines).toContain(`plan: removePath ${path}`);
    }
    expect(lines).toContain("plan: removePath /tmp/orca-home/.config/ademark/orca-c1-installed.json");
  });

  test("a claude block installs for claude only and a codex block for codex only", async () => {
    setMacosRunner(fakeRunner("owner"));
    const claude = captureContext({ home: "/tmp/orca-claude", agent: "claude" });
    const codex = captureContext({ home: "/tmp/orca-codex", agent: "codex" });

    await orca.prepareOrchestration!(claude.ctx);
    await orca.prepareOrchestration!(codex.ctx);
    await orca.quit(claude.ctx);
    await orca.quit(codex.ctx);

    expect(claude.lines).toContain(`plan: run ${installArgs("claude").join(" ")}`);
    expect(codex.lines).toContain(`plan: run ${installArgs("codex").join(" ")}`);
    expect(claude.lines).not.toContain(`plan: run ${installArgs("claude,codex").join(" ")}`);
    // The codex plan tracks only the shared .agents paths, never the ~/.claude links.
    for (const path of skillTargets("/tmp/orca-codex", "codex")) {
      expect(codex.lines).toContain(`plan: removePath ${path}`);
    }
    expect(codex.lines.some((line) => line.includes("/tmp/orca-codex/.claude/skills"))).toBe(false);
  });

  test("a real block installs the skills and shim, then quit removes exactly those paths", async () => {
    const runner = fakeRunner("ademark");
    setMacosRunner(runner);
    const home = fakeHome();
    const { ctx } = captureContext({ dryRun: false, home });

    // A path that predates the block is not ours and must survive.
    const foreign = join(home, ".agents", "skills", "orchestration");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "KEEP.txt"), "keep");

    await orca.prepareOrchestration!(ctx);

    expect(runner.commands).toContainEqual(installArgs("claude,codex"));
    const shim = join(home, ".local", "bin", "orca");
    expect(lstatSync(shim).isSymbolicLink()).toBe(true);
    expect(readlinkSync(shim)).toBe(ORCA_CLI);
    const marker = JSON.parse(readFileSync(join(home, ".config", "ademark", "orca-c1-installed.json"), "utf8")) as string[];
    expect(marker).toContain(shim);
    expect(marker).toContain(join(home, ".claude", "skills", "orchestration"));
    expect(marker).not.toContain(foreign);

    await orca.quit(ctx);

    expect(existsSync(shim)).toBe(false);
    expect(existsSync(join(home, ".config", "ademark", "orca-c1-installed.json"))).toBe(false);
    expect(readFileSync(join(foreign, "KEEP.txt"), "utf8")).toBe("keep");
  });

  test("a crashed block's leftovers are removed by the next prepare before reinstalling", async () => {
    const runner = fakeRunner("ademark");
    setMacosRunner(runner);
    const home = fakeHome();
    const { ctx } = captureContext({ dryRun: false, home });

    // What a killed run leaves behind: the marker plus one skill copy.
    const leftover = join(home, ".claude", "skills", "orchestration");
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, "SKILL.md"), "old");
    mkdirSync(join(home, ".config", "ademark"), { recursive: true });
    writeFileSync(join(home, ".config", "ademark", "orca-c1-installed.json"), JSON.stringify([leftover]));

    await orca.prepareOrchestration!(ctx);

    expect(existsSync(join(leftover, "SKILL.md"))).toBe(false);
    expect(runner.commands).toContainEqual(installArgs("claude,codex"));
    const marker = JSON.parse(readFileSync(join(home, ".config", "ademark", "orca-c1-installed.json"), "utf8")) as string[];
    expect(marker).toContain(leftover);

    await orca.quit(ctx);
    expect(existsSync(leftover)).toBe(false);
  });

  test("reset cleans a stale install even when this block is not Track C", async () => {
    const runner = fakeRunner("ademark");
    setMacosRunner(runner);
    const home = fakeHome();
    const { ctx } = captureContext({ dryRun: false, home });

    const shim = join(home, ".local", "bin", "orca");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    symlinkSync(ORCA_CLI, shim);
    mkdirSync(join(home, ".config", "ademark"), { recursive: true });
    writeFileSync(join(home, ".config", "ademark", "orca-c1-installed.json"), JSON.stringify([shim]));

    // The profile reset then stops on the missing seed fixture; the skill cleanup already ran.
    await expect(orca.reset(ctx)).rejects.toThrow("seed for orca");

    expect(existsSync(shim)).toBe(false);
    expect(existsSync(join(home, ".config", "ademark", "orca-c1-installed.json"))).toBe(false);
  });
});

// C6: quit the ADE like a user, wait up to 10 s, then open it again (TESTS.md 1.6).
// Dry run by default. --apply is only allowed for the dedicated `ademark` user.
import { assertApplyAllowed } from "./kill-agent.ts";
import { withoutAgentSession } from "../core/env.ts";

export interface RestartOptions {
  appName: string;
  apply?: boolean;
  timeoutS?: number;
  bundleId?: string;
}

export interface RestartResult {
  app: string;
  applied: boolean;
  quit: string;
  open: string;
  quit_ms: number | null;
  restarted: boolean;
}

export function quitScript(appName: string): string {
  return `quit app "${appName}"`;
}

export function isAppRunning(appName: string): boolean {
  const script = `application "${appName}" is running`;
  const result = Bun.spawnSync(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 && result.stdout.toString().trim() === "true";
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function restartApp(options: RestartOptions): Promise<RestartResult> {
  assertApplyAllowed(options, "fault restart-app");
  const timeoutS = options.timeoutS ?? 10;
  const quit = `osascript -e '${quitScript(options.appName)}'`;
  const open = options.bundleId ? `open -b ${options.bundleId}` : `open -a "${options.appName}"`;
  const result: RestartResult = {
    app: options.appName,
    applied: options.apply === true,
    quit,
    open,
    quit_ms: null,
    restarted: false,
  };
  if (!options.apply) return result;

  const quitStart = Date.now();
  const quitResult = Bun.spawnSync(["osascript", "-e", quitScript(options.appName)], { stdout: "pipe", stderr: "pipe" });
  if (quitResult.exitCode !== 0) {
    throw new Error(`quit failed: ${quitResult.stderr.toString().trim()}`);
  }
  while (Date.now() - quitStart < timeoutS * 1000) {
    if (!isAppRunning(options.appName)) break;
    await sleep(200);
  }
  result.quit_ms = Date.now() - quitStart;

  const openArgs = options.bundleId ? ["open", "-b", options.bundleId] : ["open", "-a", options.appName];
  const openResult = Bun.spawnSync(openArgs, { stdout: "pipe", stderr: "pipe", env: withoutAgentSession() });
  if (openResult.exitCode !== 0) throw new Error(`open failed: ${openResult.stderr.toString().trim()}`);
  result.restarted = true;
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const appIndex = args.indexOf("--app");
  const appName = appIndex >= 0 ? args[appIndex + 1] : undefined;
  if (!appName) {
    console.error("usage: bun bench/fault/restart-app.ts --app <App Name> [--bundle-id <id>] [--apply]");
    process.exit(2);
  }
  const bundleIndex = args.indexOf("--bundle-id");
  try {
    const result = await restartApp({
      appName,
      bundleId: bundleIndex >= 0 ? args[bundleIndex + 1] : undefined,
      apply: args.includes("--apply"),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

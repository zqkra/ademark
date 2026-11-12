// macOS lets only a person grant a permission, so this asks for all of them at once, with the owner watching: the
// night then has no dialog left to show. It opens and quits each app, which is what makes macOS ask.
import { getAdapter } from "../adapters/registry.ts";
import { MEASURED_ADES } from "./real.ts";

const GHOSTTY = "com.mitchellh.ghostty";
const ANSWER_MS = 120_000;
const OPEN_WAIT_MS = 3_000;

async function run(argv: string[], timeoutMs: number): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: timeoutMs });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, text: `${out}${err}` };
}

function appsToAsk(): { name: string; bundle: string }[] {
  return MEASURED_ADES.filter((ade) => ade !== "bare-cli").map((ade) => {
    const { appName, bundleId } = getAdapter(ade).calibration;
    return { name: appName, bundle: bundleId };
  });
}

/** Returns what still needs the owner. Empty means no dialog is left for the night. */
export async function askPermissions(log: (line: string) => void, cancelled: () => boolean = () => false): Promise<string[]> {
  const missing: string[] = [];
  // An old "Don't Allow" never asks again, so the answers start from zero.
  await run(["tccutil", "reset", "AppleEvents", GHOSTTY], 10_000);
  log("Press Allow on every macOS dialog.");
  const events = await run(["osascript", "-e", 'tell application "System Events" to count processes'], ANSWER_MS);
  if (events.code !== 0) missing.push("System Events: System Settings > Privacy & Security > Automation > Ghostty");
  for (const { name, bundle } of appsToAsk()) {
    if (cancelled()) return missing;
    log(`Asking for ${name}`);
    await run(["open", "-g", "-b", bundle], 20_000);
    await Bun.sleep(OPEN_WAIT_MS);
    const quit = await run(["osascript", "-e", `quit app "${name}"`], ANSWER_MS);
    if (quit.text.includes("-1743")) missing.push(`${name}: System Settings > Privacy & Security > Automation > Ghostty`);
  }
  log(missing.length === 0 ? "All permissions are done." : `${missing.length} still need you.`);
  return missing;
}

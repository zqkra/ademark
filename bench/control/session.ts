// ADEMARK-38: is this account in front, with the screen unlocked? Read with system tools, so the native helper stays
// the same: `stat -f %Su /dev/console` names the console user, and `ioreg -n Root -d1 -a` lists every session in
// IOConsoleUsers with kCGSSessionOnConsoleKey and, while locked, CGSSessionScreenIsLocked.
import { userInfo } from "node:os";

/**
 * Three answers, because a slow ioreg is no proof of anything (review, 2026-11-10): one bad read must never cut a
 * 30 minute measure. Only a clear answer is "off".
 */
export type Screen = "on" | "off" | "unknown";

export interface SessionView {
  screen: Screen;
  reason: string;
}

// The <dict> of each session inside the IOConsoleUsers array of the plist that ioreg prints.
function sessions(plist: string): string[] {
  const start = plist.indexOf("<key>IOConsoleUsers</key>");
  if (start === -1) return [];
  const array = plist.slice(start);
  const end = array.indexOf("</array>");
  const body = end === -1 ? array : array.slice(0, end);
  return body.split("<dict>").slice(1);
}

function flag(dict: string, key: string): boolean | null {
  const match = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`).exec(dict);
  return match === null ? null : match[1] === "true";
}

function text(dict: string, key: string): string | null {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(dict)?.[1] ?? null;
}

/** Pure, so tests read made outputs. Off only for a clear answer: another console user, off console, or locked. */
export function readSession(consoleUser: string, ioregPlist: string, me: string): SessionView {
  const user = consoleUser.trim();
  if (user.length === 0) return { screen: "unknown", reason: "stat named no console user" };
  if (user !== me) return { screen: "off", reason: `console user is ${user}, not ${me}` };
  if (!ioregPlist.includes("<key>IOConsoleUsers</key>")) return { screen: "unknown", reason: "ioreg listed no IOConsoleUsers" };
  const mine = sessions(ioregPlist).find((dict) => text(dict, "kCGSSessionUserNameKey") === me);
  if (mine === undefined) return { screen: "unknown", reason: `no session of ${me} in IOConsoleUsers` };
  const onConsole = flag(mine, "kCGSSessionOnConsoleKey");
  if (onConsole === false) return { screen: "off", reason: `the session of ${me} is not on console` };
  if (flag(mine, "CGSSessionScreenIsLocked") === true) return { screen: "off", reason: "the screen is locked" };
  if (onConsole === null) return { screen: "unknown", reason: "the session has no kCGSSessionOnConsoleKey" };
  return { screen: "on", reason: "" };
}

async function output(argv: string[], timeoutMs: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: timeoutMs });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

/** Two small children with a time limit each, so the panel's thread never waits on them. */
export async function sessionNow(me: string = userInfo().username): Promise<SessionView> {
  const [consoleUser, plist] = await Promise.all([
    output(["/usr/bin/stat", "-f", "%Su", "/dev/console"], 10_000),
    output(["/usr/sbin/ioreg", "-n", "Root", "-d1", "-a"], 10_000),
  ]);
  // Another console user is a clear answer even when ioreg is slow.
  if (consoleUser !== null && plist === null) {
    const user = consoleUser.trim();
    if (user.length > 0 && user !== me) return { screen: "off", reason: `console user is ${user}, not ${me}` };
  }
  if (consoleUser === null || plist === null) return { screen: "unknown", reason: "stat or ioreg did not answer" };
  return readSession(consoleUser, plist, me);
}

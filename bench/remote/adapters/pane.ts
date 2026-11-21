// Pane (runpane.com), remote access between two computers linked by a QR scan (TESTS.md §6, R-tests).
// Paths:
// - relay:  TLS to https://<id>.runpane.net. The relay routes by SNI and never decrypts; the peer ends TLS with its own
//           key, which the client pins (SPKI SHA-256).
// - direct: `pane-direct connect`, the QUIC helper Pane's desktop runs, carries the same TLS bytes peer to peer.
// - vpn:    Pane's Workspaces listener on the peer's Tailscale name (`tailscale serve`, https :8443).
// Setup (TESTS.md §6.1): both computers run Pane, the client is linked with the peer (Settings › Remote Access ›
// Devices), and for vpn both run Tailscale. The token and the pin come from the client's Pane config; nothing is
// printed or written to a receipt.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Http1Connection, type Endpoint } from "../http1.ts";
import type { OpenPath, RemoteAdapter, RemoteContext, RemotePath } from "../contracts.ts";

interface RelayProfile {
  id: string;
  label: string;
  baseUrl: string;
  token: string;
  relay?: { fingerprint: string };
}

interface DirectEndpoint {
  nodeId: string;
  addrs: string[];
  relayUrls: string[];
}

function paneDir(): string {
  return process.env.PANE_DIR ?? join(homedir(), ".pane");
}

/** The linked computer whose label or id starts with `peer` (case-insensitive). */
export function findProfile(config: unknown, peer: string): RelayProfile {
  const profiles = ((config as { remoteDaemon?: { client?: { profiles?: RelayProfile[] } } }).remoteDaemon?.client?.profiles ?? [])
    .filter((p) => p.relay !== undefined && typeof p.token === "string");
  const wanted = peer.toLowerCase();
  const match = profiles.filter((p) => p.label.toLowerCase().startsWith(wanted) || p.id.toLowerCase().includes(wanted));
  if (match.length !== 1) {
    const names = profiles.map((p) => p.label).join(", ") || "none";
    throw new Error(`pane: ${match.length === 0 ? "no" : "more than one"} linked computer matches "${peer}" (linked: ${names})`);
  }
  return match[0]!;
}

function profileFor(peer: string): RelayProfile {
  // A linked-computer profile in a file of its own, for a test instance paired by the harness (TESTS.md §6.2).
  const own = process.env.ADEMARK_PANE_PROFILE;
  if (own) return findProfile({ remoteDaemon: { client: { profiles: [JSON.parse(readFileSync(own, "utf8"))] } } }, peer);
  const file = join(paneDir(), "config.json");
  if (!existsSync(file)) throw new Error(`pane: no config at ${file}; link this computer with the peer first`);
  return findProfile(JSON.parse(readFileSync(file, "utf8")), peer);
}

function relayEndpoint(profile: RelayProfile): Endpoint {
  const name = new URL(profile.baseUrl).hostname;
  return { host: name, port: 443, servername: name, pin: profile.relay!.fingerprint };
}

function auth(profile: RelayProfile): Record<string, string> {
  return { Authorization: `Bearer ${profile.token}` };
}

export function paneDirectBin(): string | null {
  const candidates = [
    process.env.PANE_DIRECT_BIN,
    "/Applications/Pane.app/Contents/Resources/pane-direct",
    join(homedir(), "Applications/Pane.app/Contents/Resources/pane-direct"),
  ].filter((p): p is string => typeof p === "string");
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function directEndpoint(profile: RelayProfile): Promise<DirectEndpoint> {
  const conn = await Http1Connection.open(relayEndpoint(profile));
  try {
    const response = await conn.send({
      method: "POST",
      path: "/invoke",
      headers: { ...auth(profile), "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "relay:client:computer", args: [] }),
    });
    const direct = (JSON.parse(response.body) as { result?: { direct?: DirectEndpoint } }).result?.direct;
    if (!direct) throw new Error("pane: the peer publishes no direct endpoint (pane-direct is not running there)");
    return direct;
  } finally {
    conn.close();
  }
}

interface Helper {
  child: ChildProcess;
  port: number;
  path: string | null;
}

/** Starts `pane-direct connect` and waits until it reports the direct path, or `timeoutMs`. */
async function startHelper(bin: string, endpoint: DirectEndpoint, ctx: RemoteContext, timeoutMs = 20_000): Promise<Helper> {
  const args = ["connect", "--node-id", endpoint.nodeId];
  for (const addr of endpoint.addrs) args.push("--direct-addr", addr);
  for (const url of endpoint.relayUrls) args.push("--relay-url", url);
  // stdin stays open: the helper exits when its parent closes it, as in Pane.
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
  const helper: Helper = { child, port: 0, path: null };
  createInterface({ input: child.stdout! }).on("line", (line) => {
    try {
      const event = JSON.parse(line) as { t: string; port?: number; path?: string; message?: string };
      if (event.t === "ready" && event.port) helper.port = event.port;
      if (event.t === "path") helper.path = event.path ?? null;
      if (event.t === "error") ctx.log(`pane-direct: ${event.message ?? line}`);
    } catch {
      ctx.log(`pane-direct: ${line}`);
    }
  });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`pane-direct exited with ${child.exitCode}`);
    if (helper.port > 0 && helper.path === "direct") return helper;
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error(`pane-direct found no direct path in ${timeoutMs / 1000} s (last path: ${helper.path ?? "none"})`);
}

/** TCP connect time to the relay the peer uses, in ms: the transport alone, with no TLS and no Pane. */
async function tcpConnectMs(host: string, port: number): Promise<number | null> {
  const { connect } = await import("node:net");
  return await new Promise((resolve) => {
    const started = performance.now();
    const socket = connect({ host, port }, () => {
      resolve(performance.now() - started);
      socket.destroy();
    });
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve(null);
    });
    socket.on("error", () => resolve(null));
  });
}

function tailscaleBin(): string | null {
  const candidates = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** `tailscale ping` to the peer: one WireGuard-level round trip, and the route it took (`direct` or `derp`). */
async function tailscalePingMs(peer: string): Promise<{ ms: number | null; via: string | null }> {
  const bin = tailscaleBin();
  if (!bin) return { ms: null, via: null };
  const result = Bun.spawnSync([bin, "ping", "--c", "1", peer], { stdout: "pipe", stderr: "pipe" });
  return parseTailscalePing(result.stdout.toString());
}

/** "pong from x (100.x) via 203.0.113.9:41641 in 33ms" is direct; "via DERP(sfo)" is Tailscale's relay. */
export function parseTailscalePing(text: string): { ms: number | null; via: string | null } {
  const match = /via (\S+) in (\d+(?:\.\d+)?)ms/.exec(text);
  if (!match) return { ms: null, via: null };
  return { ms: Number(match[2]), via: match[1]!.startsWith("DERP") ? `derp ${match[1]}` : "direct" };
}

function tailscaleDnsName(peer: string): string {
  const bin = tailscaleBin();
  if (!bin) throw new Error("pane vpn: Tailscale is not installed on the client");
  const result = Bun.spawnSync([bin, "status", "--json"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`pane vpn: tailscale status failed: ${result.stderr.toString().trim()}`);
  const status = JSON.parse(result.stdout.toString()) as { BackendState?: string; Peer?: Record<string, { HostName: string; DNSName: string; Online: boolean }> };
  if (status.BackendState !== "Running") throw new Error(`pane vpn: Tailscale is ${status.BackendState ?? "not running"} on the client`);
  const wanted = peer.toLowerCase();
  const match = Object.values(status.Peer ?? {}).find((p) => p.HostName.toLowerCase().startsWith(wanted) || p.DNSName.toLowerCase().startsWith(wanted));
  if (!match) throw new Error(`pane vpn: no tailnet peer named ${peer}`);
  if (!match.Online) throw new Error(`pane vpn: ${match.DNSName} is offline in Tailscale`);
  return match.DNSName.replace(/\.$/, "");
}

function paths(profile: RelayProfile): RemotePath[] {
  const relay = relayEndpoint(profile);
  return [
    {
      id: "direct",
      label: "pane-direct QUIC helper, peer to peer",
      async open(): Promise<OpenPath> {
        const bin = paneDirectBin();
        if (!bin) throw new Error("pane direct: pane-direct not found; set PANE_DIRECT_BIN");
        const ctx = { peer: profile.label, log: () => {} };
        const helper = await startHelper(bin, await directEndpoint(profile), ctx);
        return {
          endpoint: { host: "127.0.0.1", port: helper.port, servername: relay.servername, pin: relay.pin },
          // No floor: the QUIC transport cannot be timed without Pane's own helper, and the adapter never times.
          observed: () => helper.path,
          clientPids: () => (helper.child.pid ? [helper.child.pid] : []),
          close: async () => {
            helper.child.kill();
          },
        };
      },
    },
    {
      id: "relay",
      label: `Pane relay, TLS to ${relay.host}`,
      async open(): Promise<OpenPath> {
        return {
          endpoint: relay,
          observed: () => "relay",
          // The relay's address answers TCP itself, so its connect time is the client-to-relay leg only.
          floorMs: () => tcpConnectMs(relay.host, 443),
          close: async () => {},
        };
      },
    },
    {
      id: "vpn",
      label: "Pane Workspaces over Tailscale (tailscale serve, :8443)",
      async open(): Promise<OpenPath> {
        const name = tailscaleDnsName(profile.label);
        let via: string | null = null;
        return {
          endpoint: { host: name, port: Number(process.env.PANE_WORKSPACES_PORT ?? 8443), servername: name },
          observed: () => via,
          floorMs: async () => {
            const ping = await tailscalePingMs(name);
            via = ping.via;
            return ping.ms;
          },
          close: async () => {},
        };
      },
    },
  ];
}

export const pane: RemoteAdapter = {
  id: "pane",
  name: "Pane",
  // Electron; runs each agent's own CLI in a pseudo-terminal.
  family: "EL-PTY",
  async version() {
    const plist = "/Applications/Pane.app/Contents/Info.plist";
    if (!existsSync(plist)) return "unknown";
    const result = Bun.spawnSync(["/usr/bin/defaults", "read", plist.replace(/\.plist$/, ""), "CFBundleShortVersionString"], { stdout: "pipe" });
    return result.stdout.toString().trim() || "unknown";
  },
  async paths(ctx) {
    return paths(profileFor(ctx.peer));
  },
  async probe(ctx) {
    // Answers 204 right after the token check, before any other work (Pane httpApiServer `/events?auth_check=1`).
    // Over vpn the Workspaces listener admits by Tailscale identity, and the same route answers the same way.
    return { method: "GET", path: "/events?auth_check=1", headers: auth(profileFor(ctx.peer)) };
  },
  probeStatus: 204,
  async forwardPort(ctx, path, port) {
    // `/ports/<port>` is a WebSocket that carries raw TCP bytes to that loopback port on the peer; Pane forwards every
    // listening port it lists. The desktop's port tunnel opens one per local connection, the same way.
    // A client lists the peer's ports before it opens one (`ports:list` reads them now), as the desktop's Ports list and
    // the phone's preview do; the peer refuses a port its list does not hold.
    const profile = profileFor(ctx.peer);
    const conn = await Http1Connection.open(path.endpoint);
    const listed = await conn.send({
      method: "POST",
      path: "/invoke",
      headers: { ...auth(profile), "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "ports:list", args: [] }),
    });
    if (listed.status !== 200) throw new Error(`ports:list answered ${listed.status}`);
    const ports = (JSON.parse(listed.body) as { result?: { ports?: Array<{ port: number }> } }).result?.ports ?? [];
    if (!ports.some((p) => p.port === port)) throw new Error(`the peer lists no listener on port ${port}; start bench/remote/peer-server.mjs there`);
    return await conn.upgrade(`/ports/${port}`, auth(profile));
  },
  facts: {
    mechanism: {
      value: "Vendor relay by default (runpane.net, regions us, eu, asia), QUIC direct path when both networks allow it; Tailscale optional; relay is open source and self-hostable",
      source: "https://github.com/greenfield-inc/Pane/blob/main/docs/QR_PAIRING.md, docs/SELF_HOSTED_RELAY.md",
    },
    whoCanRead: {
      value: "Only the two ends. The relay routes by TLS server name and never decrypts; each computer ends TLS with its own key and clients pin it. The relay sees which computer, IP addresses, timing and byte counts",
      source: "https://github.com/greenfield-inc/Pane/blob/main/docs/QR_PAIRING.md#how-it-connects",
    },
    pairing: {
      value: "QR code, single use, expires after 10 minutes; no account",
      source: "https://github.com/greenfield-inc/Pane/blob/main/docs/QR_PAIRING.md#pair-a-phone",
    },
    perDeviceRevoke: {
      value: "Yes: remove one phone from one computer or from all; open connections close within one heartbeat",
      source: "https://github.com/greenfield-inc/Pane/blob/main/docs/QR_PAIRING.md#remove-a-phone-or-a-computer",
    },
    previews: {
      value: "Yes: every listening port on the host is forwarded to signed-in clients; phones get preview links",
      source: "https://github.com/greenfield-inc/Pane/blob/main/docs/QR_PAIRING.md#what-works",
    },
    withoutVpn: {
      value: "Yes",
      source: "https://github.com/greenfield-inc/Pane/blob/main/docs/QR_PAIRING.md",
    },
  },
};

// A Pane test instance as the Track R peer on the client machine (TESTS.md §6.2). macOS.
// It runs Pane's headless host from a Pane source checkout that has `pnpm run build:main` and
// `pnpm --filter runpane build` done, with its own PANE_DIR, HOME and empty login keychain, so it never touches the
// operator's Pane, agent configs or keychain. It pairs the harness with it through Pane's own pairing code.
//
//   node pane-test-host.mjs start  <dir> <region> <pane source>   # prints the pid; writes <dir>/profile.json
//   node pane-test-host.mjs region <dir> <region> <pane source>   # moves it to us | eu | asia and waits for DNS
//   node pane-test-host.mjs stop   <dir>
//
// Then: ADEMARK_PANE_PROFILE=<dir>/profile.json bun bench/cli.ts remote run --ade pane --peer test-host \
//         --freeze --freeze-peer-pids $(cat <dir>/host.pid) ...
// Each new <dir> creates one new computer on Pane's relay, with its own certificate. Reuse <dir> across regions.
import { spawn, spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { join, resolve } from "node:path";

const [command, dirArg, region, sourceArg] = process.argv.slice(2);
if (!command || !dirArg) {
  console.error("usage: pane-test-host.mjs start|region|stop <dir> [<region> <pane source>]");
  process.exit(2);
}
const dir = resolve(dirArg);
const paneDir = join(dir, "pane");
const home = join(dir, "home");
const keychain = join(home, "Library/Keychains/login.keychain-db");

async function daemon(source) {
  const { invokeDaemon } = await import(join(source, "packages/runpane/dist/daemonClient.js"));
  const { boundary } = await import(join(source, "packages/runpane/dist/boundaryDecoder.js"));
  return (channel, args = []) => invokeDaemon(channel, args, boundary.json, { paneDir, timeoutMs: 15000 });
}

async function waitReady(call, wanted) {
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const status = await call("relay:status").catch(() => null);
    if (status?.phase === "ready" && (!wanted || status.region === wanted)) return status;
  }
  throw new Error(`the test host's relay is not ready${wanted ? ` on ${wanted}` : ""}`);
}

/**
 * The computer's name moves between relays by DNS (TTL 60 s), and caches answer the old relay for a while; that relay
 * drops new connections. Wait until this machine resolves the name to the region 12 times in a row, 5 s apart.
 */
async function waitDns(status) {
  const want = (await lookup(`${status.region}.relay.${status.domain}`)).address;
  let streak = 0;
  for (let i = 0; i < 120; i++) {
    streak = (await lookup(`${status.id}.${status.domain}`)).address === want ? streak + 1 : 0;
    if (streak >= 12) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`DNS does not resolve ${status.id}.${status.domain} to the ${status.region} relay yet`);
}

function post(host, path, body) {
  return new Promise((done, fail) => {
    const req = https.request({ host, port: 443, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => done({ status: res.statusCode, body: data }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

if (command === "start") {
  const source = resolve(sourceArg ?? ".");
  mkdirSync(paneDir, { recursive: true });
  mkdirSync(join(home, "Library/Preferences"), { recursive: true });
  if (!existsSync(keychain)) {
    // An empty keychain in the test HOME: Pane keeps its relay keys there, never in the operator's keychain.
    const sec = (args) => spawnSync("security", args, { env: { ...process.env, HOME: home }, stdio: "inherit" });
    sec(["create-keychain", "-p", "", keychain]);
    sec(["list-keychains", "-d", "user", "-s", keychain]);
    sec(["default-keychain", "-d", "user", "-s", keychain]);
    sec(["set-keychain-settings", keychain]);
  }
  const config = join(paneDir, "config.json");
  if (!existsSync(config)) {
    writeFileSync(config, JSON.stringify({
      // A listener port of its own, so it never collides with the operator's Pane on 42137.
      remoteDaemon: { host: { config: { enabled: true, pairingRequired: true, listenPort: 42199 } }, relay: { enabled: true, relayAddress: `${region}.relay.runpane.net` } },
    }, null, 2));
  }
  const env = { ...process.env, PANE_DIR: paneDir, HOME: home, NODE_ENV: "production" };
  if (!env.PANE_DIRECT_BIN && existsSync("/Applications/Pane.app/Contents/Resources/pane-direct")) env.PANE_DIRECT_BIN = "/Applications/Pane.app/Contents/Resources/pane-direct";
  const log = openSync(join(dir, "host.log"), "a");
  const host = spawn(join(source, "node_modules/.bin/electron"), [join(source, "main/dist/main/src/daemon/headless.js"), "--disable-gpu"], { env, stdio: ["ignore", log, log], detached: true });
  host.unref();
  writeFileSync(join(dir, "host.pid"), String(host.pid));
  const call = await daemon(source);
  const status = await waitReady(call, null);
  await waitDns(status);
  const code = await call("relay:pairing-code");
  const params = new URLSearchParams(new URL(code.url).hash.slice(1));
  const name = `${params.get("c")}.${status.domain}`;
  const started = performance.now();
  const pair = await post(name, "/pair/exchange", JSON.stringify({ secret: params.get("s"), label: "ADEMark harness" }));
  if (pair.status !== 200) throw new Error(`pairing answered ${pair.status}: ${pair.body.slice(0, 200)}`);
  const answer = JSON.parse(pair.body);
  writeFileSync(join(dir, "profile.json"), JSON.stringify({
    id: `relay-${status.id}`, label: "test-host", baseUrl: `https://${name}`, token: answer.token,
    relay: { fingerprint: answer.computer?.fingerprint ?? status.fingerprint },
  }));
  console.log(JSON.stringify({ pid: host.pid, relay: status.relay, pairing_exchange_ms: Math.round(performance.now() - started) }));
} else if (command === "region") {
  const call = await daemon(resolve(sourceArg ?? "."));
  await call("relay:set-address", [`${region}.relay.runpane.net`]);
  const status = await waitReady(call, region);
  await waitDns(status);
  console.log(`test host on ${status.relay}`);
} else if (command === "stop") {
  const pid = Number(readFileSync(join(dir, "host.pid"), "utf8"));
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
  console.log(`stopped ${pid}`);
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}

// Track R (TESTS.md §6): the HTTP/1.1 client every path is timed with, the runner's rows, and the setup readers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunWriter } from "../core/results.ts";
import type { ResultRow } from "../core/contracts.ts";
import { Http1Connection, parseResponse } from "../remote/http1.ts";
import type { RemoteAdapter } from "../remote/contracts.ts";
import { findProfile, parseTailscalePing } from "../remote/adapters/pane.ts";
import { processFreeze, withDescendants } from "../remote/cut.ts";
import { runRemote } from "../remote/run.ts";

describe("parseResponse", () => {
  test("reads a Content-Length body and says how many bytes it used", () => {
    const bytes = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloHTTP/1.1 204");
    expect(parseResponse(bytes)).toEqual({ response: { status: 200, body: "hello" }, consumed: 43 });
  });

  test("reads a chunked body", () => {
    const bytes = Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n");
    expect(parseResponse(bytes)?.response).toEqual({ status: 200, body: "abcde" });
  });

  test("a 204 has no body", () => {
    expect(parseResponse(Buffer.from("HTTP/1.1 204 No Content\r\nCache-Control: no-store\r\n\r\n"))?.response).toEqual({ status: 204, body: "" });
  });

  test("waits for the rest of a body", () => {
    expect(parseResponse(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel"))).toBeNull();
  });
});

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer t") {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(204).end();
  });
  server.on("upgrade", (request, socket) => {
    // A port forward: after the upgrade, echo each client frame back as an unmasked binary frame.
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (frame: Buffer) => {
      const length = frame[1]! & 0x7f;
      const mask = frame.subarray(2, 6);
      const payload = Buffer.from(frame.subarray(6, 6 + length).map((b, i) => b ^ mask[i % 4]!));
      socket.write(Buffer.concat([Buffer.from([0x82, payload.length]), payload]));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
});

describe("Http1Connection", () => {
  test("sends several requests on one kept-alive connection", async () => {
    const conn = await Http1Connection.open({ host: "127.0.0.1", port, servername: null });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await conn.send({ method: "GET", path: "/", headers: { Authorization: "Bearer t" } })).status);
    conn.close();
    expect(statuses).toEqual([204, 204, 204]);
  });

  test("a WebSocket tunnel carries bytes both ways", async () => {
    const conn = await Http1Connection.open({ host: "127.0.0.1", port, servername: null });
    const tunnel = await conn.upgrade("/ports/1");
    tunnel.send(Buffer.from("ping"));
    const back = await tunnel.receive((bytes) => bytes.length >= 4);
    tunnel.close();
    expect(back.toString()).toBe("ping");
  });
});

describe("runRemote", () => {
  const fake = (): RemoteAdapter => ({
    id: "fake",
    name: "Fake",
    family: "EL-SDK",
    version: async () => "1.0.0",
    probeStatus: 204,
    probe: async () => ({ method: "GET", path: "/events", headers: { Authorization: "Bearer t" } }),
    paths: async () => [
      {
        id: "relay",
        label: "local server",
        open: async () => ({ endpoint: { host: "127.0.0.1", port, servername: null }, observed: () => "relay", floorMs: async () => 1, close: async () => {} }),
      },
      {
        id: "vpn",
        label: "a VPN that is off",
        open: async () => {
          throw new Error("VPN is off on the client");
        },
      },
    ],
    facts: {
      mechanism: { value: "test", source: "test" },
      whoCanRead: { value: "test", source: "test" },
      pairing: { value: "test", source: "test" },
      perDeviceRevoke: { value: "test", source: "test" },
      previews: { value: "test", source: "test" },
      withoutVpn: { value: "test", source: "test" },
    },
  });

  test("writes p50 and p95 per path and round, and names what it could not measure", async () => {
    const root = mkdtempSync(join(tmpdir(), "ademark-remote-"));
    await runRemote({
      adapter: fake(),
      peer: "peer",
      runId: "remote-test",
      tests: ["R2", "R3", "R5", "R4"],
      paths: null,
      rounds: 2,
      warmSamples: 5,
      coldSamples: 3,
      previewPort: 1,
      freezeSeconds: 30,
      freezeRounds: 1,
      writer: new RunWriter(root),
      log: () => {},
    });
    const rows = readFileSync(join(root, "remote-test", "rows.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as ResultRow);
    const key = (r: ResultRow) => `${r.test_id} ${r.variant} ${r.rep} ${r.valid ? "valid" : r.invalid_reason}`;
    expect(rows.map(key).sort()).toEqual([
      "R2 relay:floor 1 valid", "R2 relay:floor 2 valid",
      "R2 relay:p50 1 valid", "R2 relay:p50 2 valid",
      "R2 relay:p95 1 valid", "R2 relay:p95 2 valid",
      "R2 vpn 1 not measured: VPN is off on the client",
      "R3 relay:p50 1 valid", "R3 relay:p50 2 valid",
      "R3 relay:p95 1 valid", "R3 relay:p95 2 valid",
      "R3 vpn 1 not measured: VPN is off on the client",
      "R4 relay 1 not measured: no --freeze given",
      "R4 vpn 1 not measured: VPN is off on the client",
      "R5 relay:first 1 not supported",
      "R5 vpn 1 not measured: VPN is off on the client",
    ].sort());
    // Each round's receipt holds every timed sample: 5 for R2, 3 for R3.
    const lines = (test: string) => readFileSync(join(root, "remote-test", "fake", test, "rep-02", "relay.csv"), "utf8").trim().split("\n").length - 1;
    expect([lines("R2"), lines("R3")]).toEqual([5, 3]);
    expect(JSON.parse(readFileSync(join(root, "remote-test", "summary.json"), "utf8")).ades.fake.tests["R2/relay:p50"].n).toBe(2);
  });
});

describe("setup readers", () => {
  const config = {
    remoteDaemon: {
      client: {
        profiles: [
          { id: "relay-abc", label: "Studio Mac", baseUrl: "https://abc.runpane.net", token: "x", relay: { fingerprint: "f" } },
          { id: "relay-def", label: "Parsa-DevBox", baseUrl: "https://def.runpane.net", token: "y", relay: { fingerprint: "g" } },
          { id: "tailnet-x", label: "Parsa-DevBox (Tailscale)", baseUrl: "https://x.ts.net:8443", token: "" },
        ],
      },
    },
  };

  test("finds the linked computer by the start of its label, ignoring case", () => {
    expect(findProfile(config, "parsa-devbox").id).toBe("relay-def");
  });

  test("refuses a name that matches no linked computer", () => {
    expect(() => findProfile(config, "laptop")).toThrow('no linked computer matches "laptop" (linked: Studio Mac, Parsa-DevBox)');
  });

  test("reads Tailscale's route from its ping", () => {
    expect(parseTailscalePing("pong from devbox (100.65.125.102) via 203.0.113.9:41641 in 33ms")).toEqual({ ms: 33, via: "direct" });
    expect(parseTailscalePing("pong from devbox (100.65.125.102) via DERP(sfo) in 61ms")).toEqual({ ms: 61, via: "derp DERP(sfo)" });
  });

  test("a peer's process tree is every process under its root", () => {
    const table = "  1     0\n 10     1\n 11    10\n 12    11\n 20     1\n";
    expect(withDescendants([10], table).sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  test("a process-level drop stops a process and resumes it", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    const state = () => Bun.spawnSync(["ps", "-o", "stat=", "-p", String(child.pid)]).stdout.toString().trim()[0];
    const drop = processFreeze.apply([child.pid], 0.5);
    await new Promise((done) => setTimeout(done, 200));
    const during = state();
    await drop;
    const after = state();
    child.kill();
    expect([during, after]).toEqual(["T", "S"]);
  });
});

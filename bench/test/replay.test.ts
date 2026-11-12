import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReplay } from "../core/replay.ts";

const FAKE_SERVER = `Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.argv[process.argv.indexOf("--port") + 1]),
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/_ademark/health") return Response.json({ ok: true });
    if (url.pathname === "/_ademark/stats")
      return Response.json({ requests: 3, by_session: { hi: 3 }, unknown: 0, rewrite_misses: 1 });
    return new Response("not found", { status: 404 });
  },
});
`;

const BROKEN_SERVER = `console.error("boom"); process.exit(1);\n`;

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function port(): number {
  // Pick a free high port; the fake server binds immediately and the harness retries.
  return 20000 + Math.floor(Math.random() * 20000);
}

describe("startReplay", () => {
  test("waits for health and exposes stats and stop", async () => {
    dir = mkdtempSync(join(tmpdir(), "ademark-replay-"));
    const serverPath = join(dir, "server.ts");
    writeFileSync(serverPath, FAKE_SERVER);
    const handle = await startReplay({
      port: port(),
      sessions: join(dir, "sessions"),
      log: join(dir, "requests.jsonl"),
      serverPath,
      timeoutMs: 5000,
    });
    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(await handle.stats()).toEqual({
        requests: 3,
        by_session: { hi: 3 },
        unknown: 0,
        rewrite_misses: 1,
      });
    } finally {
      await handle.stop();
    }
  }, 15000);

  test("names the missing server file", async () => {
    dir = mkdtempSync(join(tmpdir(), "ademark-replay-"));
    const error = (await startReplay({
      port: port(),
      sessions: dir,
      log: join(dir, "requests.jsonl"),
      serverPath: join(dir, "nope.ts"),
    }).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("replay server not found");
    expect(error.message).toContain("ADEMARK-2");
  });

  test("reports a server that exits early", async () => {
    dir = mkdtempSync(join(tmpdir(), "ademark-replay-"));
    const serverPath = join(dir, "server.ts");
    writeFileSync(serverPath, BROKEN_SERVER);
    const error = (await startReplay({
      port: port(),
      sessions: dir,
      log: join(dir, "requests.jsonl"),
      serverPath,
      timeoutMs: 3000,
    }).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("exited early");
    expect(error.message).toContain("boom");
  }, 15000);
});

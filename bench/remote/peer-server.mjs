// R5 peer server: a stand-in dev server on the peer, the same for every ADE (TESTS.md §6, R5).
// Runs with Node 18+ or Bun on macOS, Linux and Windows: `node bench/remote/peer-server.mjs --port 47801`.
// Answers every GET with 200 and the fixed body below, keep-alive, and nothing else.
import { createServer } from "node:http";

export const PEER_BODY = "ademark-r5\n";

const index = process.argv.indexOf("--port");
const port = index >= 0 ? Number(process.argv[index + 1]) : 47801;
const host = process.argv.includes("--all") ? "0.0.0.0" : "127.0.0.1";

createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(PEER_BODY), "Cache-Control": "no-store" });
  response.end(request.method === "HEAD" ? undefined : PEER_BODY);
}).listen(port, host, () => {
  console.log(JSON.stringify({ t: "ready", host, port }));
});

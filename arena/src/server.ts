import { createServer } from "node:http";
import { createApp } from "./api.ts";

const app = createApp();
const port = Number(process.env.PORT ?? 3000);

createServer((incoming, outgoing) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
  }
  const response = app.handle({ method: incoming.method ?? "GET", path: incoming.url ?? "/", headers });
  outgoing.writeHead(response.status, response.headers);
  outgoing.end(JSON.stringify(response.body));
}).listen(port, () => {
  console.log(`ledger listening on http://localhost:${port}`);
});

// Track R transport: one HTTP/1.1 connection over TLS (or plain TCP), kept alive, with an optional key pin.
// Every path of every remote adapter is measured with this one client, so the request bytes are the same everywhere.
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export interface Endpoint {
  /** Where the socket connects: a public host, or 127.0.0.1 for a local helper that carries the bytes. */
  host: string;
  port: number;
  /** TLS server name. null = plain TCP (a VPN path that is already encrypted, or a local test server). */
  servername: string | null;
  /** base64url SHA-256 of the server's SPKI DER. When set, any other key is refused, whatever the CA says. */
  pin?: string;
  /** Extra CA, for tests. */
  ca?: string;
}

export interface Request {
  method: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface Response {
  status: number;
  body: string;
}

export function spkiPin(der: Buffer): string {
  const key = new X509Certificate(der).publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(key).digest("base64url");
}

const CONNECT_TIMEOUT_MS = 15_000;

export class Http1Connection {
  private buffer = Buffer.alloc(0);
  private waiting: ((error: Error | null) => void) | null = null;
  private closed = false;

  private constructor(private readonly socket: Socket | TLSSocket, private readonly hostHeader: string) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.waiting?.(null);
    });
    const end = (error?: Error) => {
      this.closed = true;
      this.waiting?.(error ?? new Error("connection closed"));
    };
    socket.on("error", end);
    socket.on("close", () => end());
  }

  static open(endpoint: Endpoint): Promise<Http1Connection> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`connect to ${endpoint.host}:${endpoint.port} timed out after ${CONNECT_TIMEOUT_MS} ms`));
      }, CONNECT_TIMEOUT_MS);
      const hostHeader = endpoint.servername ?? endpoint.host;
      const done = (error: Error | null) => {
        clearTimeout(timer);
        if (error) {
          socket.destroy();
          reject(error);
          return;
        }
        socket.setNoDelay(true);
        resolve(new Http1Connection(socket, hostHeader));
      };
      let socket: Socket | TLSSocket;
      if (endpoint.servername === null) {
        socket = netConnect({ host: endpoint.host, port: endpoint.port }, () => done(null));
      } else {
        const tls = tlsConnect({
          host: endpoint.host,
          port: endpoint.port,
          servername: endpoint.servername,
          ca: endpoint.ca,
          ALPNProtocols: ["http/1.1"],
        });
        tls.once("secureConnect", () => {
          if (endpoint.pin !== undefined) {
            const raw = tls.getPeerCertificate(false)?.raw;
            const seen = raw ? spkiPin(raw) : "none";
            if (seen !== endpoint.pin) {
              done(new Error(`key pin mismatch for ${endpoint.servername}: expected ${endpoint.pin}, got ${seen}`));
              return;
            }
          }
          done(null);
        });
        socket = tls;
      }
      socket.once("error", (error) => done(error));
    });
  }

  /** Sends one request and resolves with the whole response. Requests on one connection never overlap. */
  async send(request: Request): Promise<Response> {
    if (this.closed) throw new Error("connection closed");
    const headers: Record<string, string> = { Host: this.hostHeader, Connection: "keep-alive", ...request.headers };
    if (request.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(request.body));
    const head = [`${request.method} ${request.path} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    this.socket.write(`${head.join("\r\n")}\r\n\r\n${request.body ?? ""}`);
    for (;;) {
      const parsed = parseResponse(this.buffer);
      if (parsed) {
        this.buffer = this.buffer.subarray(parsed.consumed);
        return parsed.response;
      }
      await this.more();
    }
  }

  /** Upgrades this connection to a WebSocket and returns a byte tunnel over it (R5 port forwards). */
  async upgrade(path: string, headers: Record<string, string> = {}): Promise<WsTunnel> {
    const key = randomBytes(16).toString("base64");
    const head = [
      `GET ${path} HTTP/1.1`,
      `Host: ${this.hostHeader}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ];
    this.socket.write(`${head.join("\r\n")}\r\n\r\n`);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end >= 0) {
        const status = Number(this.buffer.subarray(0, end).toString("latin1").split(" ")[1]);
        if (status !== 101) {
          const parsed = parseResponse(this.buffer);
          throw new Error(`upgrade to ${path} answered ${status}${parsed ? `: ${parsed.response.body.slice(0, 200)}` : ""}`);
        }
        this.buffer = this.buffer.subarray(end + 4);
        return new WsTunnel(this);
      }
      await this.more();
    }
  }

  /** @internal Bytes received and not yet read. */
  take(): Buffer {
    const out = this.buffer;
    this.buffer = Buffer.alloc(0);
    return out;
  }

  /** @internal Puts back bytes that were taken but not used. */
  unshift(bytes: Buffer): void {
    this.buffer = Buffer.concat([bytes, this.buffer]);
  }

  /** @internal */
  write(bytes: Buffer): void {
    this.socket.write(bytes);
  }

  /** @internal Waits for more bytes. */
  more(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    return new Promise<void>((resolve, reject) => {
      this.waiting = (error) => {
        this.waiting = null;
        if (error) reject(error);
        else resolve();
      };
    });
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }
}

/** Raw bytes in binary WebSocket frames, client side (masked), as a port forward carries a TCP stream. */
export class WsTunnel {
  private payload = Buffer.alloc(0);

  constructor(private readonly conn: Http1Connection) {}

  send(bytes: Buffer): void {
    const mask = randomBytes(4);
    const length = bytes.length;
    const header = length < 126 ? Buffer.from([0x82, 0x80 | length])
      : length < 65536 ? Buffer.from([0x82, 0x80 | 126, length >> 8, length & 0xff])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x82; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(length), 2); return h; })();
    const body = Buffer.alloc(length);
    for (let i = 0; i < length; i++) body[i] = bytes[i]! ^ mask[i % 4]!;
    this.conn.write(Buffer.concat([header, mask, body]));
  }

  /** Reads frames until `done(payload so far)` is true, then returns the payload and clears it. */
  async receive(done: (payload: Buffer) => boolean): Promise<Buffer> {
    for (;;) {
      this.drainFrames();
      if (done(this.payload)) {
        const out = this.payload;
        this.payload = Buffer.alloc(0);
        return out;
      }
      await this.conn.more();
    }
  }

  close(): void {
    this.conn.close();
  }

  private drainFrames(): void {
    let bytes = this.conn.take();
    for (;;) {
      if (bytes.length < 2) break;
      const opcode = bytes[0]! & 0x0f;
      let length = bytes[1]! & 0x7f;
      let at = 2;
      if (length === 126) {
        if (bytes.length < 4) break;
        length = bytes.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (bytes.length < 10) break;
        length = Number(bytes.readBigUInt64BE(2));
        at = 10;
      }
      if (bytes.length < at + length) break;
      const data = bytes.subarray(at, at + length);
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) this.payload = Buffer.concat([this.payload, data]);
      if (opcode === 0x8) throw new Error("tunnel closed by the peer");
      bytes = bytes.subarray(at + length);
    }
    this.conn.unshift(bytes);
  }
}

/** One HTTP/1.1 response from the front of `buffer`, or null when more bytes are needed. Content-Length, chunked, or no body. */
export function parseResponse(buffer: Buffer): { response: Response; consumed: number } | null {
  const headEnd = buffer.indexOf("\r\n\r\n");
  if (headEnd < 0) return null;
  const lines = buffer.subarray(0, headEnd).toString("latin1").split("\r\n");
  const status = Number(lines[0]?.split(" ")[1]);
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const start = headEnd + 4;
  if (status === 204 || status === 304 || (status >= 100 && status < 200)) {
    return { response: { status, body: "" }, consumed: start };
  }
  if ((headers.get("transfer-encoding") ?? "").toLowerCase().includes("chunked")) {
    let at = start;
    const parts: Buffer[] = [];
    for (;;) {
      const lineEnd = buffer.indexOf("\r\n", at);
      if (lineEnd < 0) return null;
      const size = Number.parseInt(buffer.subarray(at, lineEnd).toString("latin1"), 16);
      if (Number.isNaN(size)) throw new Error("bad chunk size");
      const dataStart = lineEnd + 2;
      if (size === 0) {
        if (buffer.length < dataStart + 2) return null;
        return { response: { status, body: Buffer.concat(parts).toString("utf8") }, consumed: dataStart + 2 };
      }
      if (buffer.length < dataStart + size + 2) return null;
      parts.push(buffer.subarray(dataStart, dataStart + size));
      at = dataStart + size + 2;
    }
  }
  const length = Number(headers.get("content-length") ?? "0");
  if (buffer.length < start + length) return null;
  return { response: { status, body: buffer.subarray(start, start + length).toString("utf8") }, consumed: start + length };
}

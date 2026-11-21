// Track R (remote access) contracts. TESTS.md §6 is the source for every field.
// Track R runs on two machines: the client, where the harness runs, and the peer, where the ADE hosts its agents.
import type { Family } from "../core/contracts.ts";
import type { Endpoint, Request } from "./http1.ts";

/** How the client reaches the peer. Every adapter names its paths with these ids, so rows compare across ADEs. */
export type PathId =
  // A peer-to-peer path the ADE sets up itself (QUIC hole punching, LAN).
  | "direct"
  // The ADE vendor's relay or cloud carries every byte.
  | "relay"
  // A VPN the user runs (Tailscale, WireGuard); the ADE listens on the VPN address.
  | "vpn";

/** One way to the peer, opened for the length of a test. */
export interface OpenPath {
  /** Where an HTTP/1.1 connection goes for this path. A local helper may carry it (`127.0.0.1:<port>`). */
  endpoint: Endpoint;
  /** What the path really used, when the ADE reports it (for example "direct" or "relay" from its helper). */
  observed(): string | null;
  /** R4: client-side processes that carry this path (the ADE's helper), stopped during the drop. */
  clientPids?(): number[];
  /** The same path with nothing of the ADE on it: a round trip of the transport alone, in ms (TESTS.md R2 floor). */
  floorMs?(): Promise<number | null>;
  close(): Promise<void>;
}

export interface RemotePath {
  id: PathId;
  /** What this path is, in words, for the receipt. */
  label: string;
  open(): Promise<OpenPath>;
}

/** Raw TCP bytes to a port on the peer, carried however the ADE carries them. */
export interface ByteTunnel {
  send(bytes: Buffer): void;
  /** Reads until `done(bytes so far)` is true. */
  receive(done: (bytes: Buffer) => boolean): Promise<Buffer>;
  close(): void;
}

/** Facts for R6, each with its source: a link, or "observed in vX.Y.Z on YYYY-MM-DD". */
export interface RemoteFact {
  value: string;
  source: string;
}

export interface RemoteFacts {
  mechanism: RemoteFact;
  whoCanRead: RemoteFact;
  pairing: RemoteFact;
  perDeviceRevoke: RemoteFact;
  previews: RemoteFact;
  withoutVpn: RemoteFact;
}

export interface RemoteContext {
  /** The peer's name as the ADE knows it. */
  peer: string;
  log(message: string): void;
}

export interface RemoteAdapter {
  /** Same id as the ADE's adapter in bench/adapters when it has one. */
  id: string;
  name: string;
  /** Family from METHODOLOGY.md §2. */
  family: Family;
  /** The ADE's version on the client, for the row. */
  version(): Promise<string>;
  /** Paths the ADE offers, in the order the tests run them. */
  paths(ctx: RemoteContext): Promise<RemotePath[]>;
  /** The authenticated request R2 and R3 time: the cheapest call the peer answers only after it checked the caller. */
  probe(ctx: RemoteContext): Promise<Request>;
  /** Status the probe must return. */
  probeStatus: number;
  /** R5: a byte stream from the client to `port` on the peer over `path`. Missing = the ADE forwards no ports. */
  forwardPort?(ctx: RemoteContext, path: OpenPath, port: number): Promise<ByteTunnel>;
  facts: RemoteFacts;
}

// Track R adapters (TESTS.md §6). One file per ADE under bench/remote/adapters; vendors add theirs by pull request.
import type { RemoteAdapter } from "../contracts.ts";
import { pane } from "./pane.ts";

export const REMOTE_ADAPTERS: readonly RemoteAdapter[] = [pane];

export function getRemoteAdapter(id: string): RemoteAdapter {
  const adapter = REMOTE_ADAPTERS.find((a) => a.id === id);
  if (!adapter) throw new Error(`no remote adapter "${id}"; have: ${REMOTE_ADAPTERS.map((a) => a.id).join(", ")}`);
  return adapter;
}

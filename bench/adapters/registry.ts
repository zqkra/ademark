// The adapter registry: one module per ADE in ADES.md 3.0-3.17 (18 adapter IDs).
import type { Adapter } from "../core/contracts.ts";
import { bareCli } from "./bare-cli.ts";
import { t3code } from "./t3code.ts";
import { bb } from "./bb.ts";
import { paseo } from "./paseo.ts";
import { synara } from "./synara.ts";
import { traycer } from "./traycer.ts";
import { cloudroom } from "./cloudroom.ts";
import { superset } from "./superset.ts";
import { orca } from "./orca.ts";
import { emdash } from "./emdash.ts";
import { zeron } from "./zeron.ts";
import { diri } from "./diri.ts";
import { monocode } from "./monocode.ts";
import { superEngineering } from "./super-engineering.ts";
import { conductor } from "./conductor.ts";
import { capy } from "./capy.ts";
import { claudeDesktop } from "./claude-desktop.ts";
import { codexApp } from "./codex-app.ts";

export const adapters: Record<string, Adapter> = {
  "bare-cli": bareCli,
  t3code,
  bb,
  paseo,
  synara,
  traycer,
  cloudroom,
  superset,
  orca,
  emdash,
  zeron,
  diri,
  monocode,
  "super-engineering": superEngineering,
  conductor,
  capy,
  "claude-desktop": claudeDesktop,
  "codex-app": codexApp,
};

export const ADAPTER_IDS = Object.keys(adapters);

export function listAdapters(): Adapter[] {
  return ADAPTER_IDS.map((id) => adapters[id]!);
}

export function getAdapter(id: string): Adapter {
  const adapter = adapters[id];
  if (!adapter) {
    throw new Error(`unknown adapter "${id}"; known: ${ADAPTER_IDS.join(", ")}`);
  }
  return adapter;
}

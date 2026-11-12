// The pinned models of METHODOLOGY.md §4 and the per-agent measurement blocks of one ADE.
import type { Adapter, Agent, RunOptions } from "../core/contracts.ts";
import type { TrackLetter } from "./registry.ts";

export interface ModelPin {
  model: string | null;
  effort: string | null;
}

export const MODEL_PINS: Record<Agent, ModelPin> = {
  claude: { model: "claude-opus-5-5", effort: "high" },
  // exact Codex model ID confirmed in the pilot (METHODOLOGY.md §4)
  codex: { model: "gpt-6.1-sol", effort: "high" },
  own: { model: null, effort: null },
};

const AGENT_PRIORITY: readonly Agent[] = ["claude", "codex", "own"];

export function firstAgent(adapter: Adapter): Agent {
  return AGENT_PRIORITY.find((agent) => adapter.agents.includes(agent)) ?? adapter.agents[0] ?? "own";
}

// TESTS.md §0.1: the control writes bare-cli-claude or bare-cli-codex, every other ADE its own id.
export function rowAdeFor(adapter: Adapter, agent: Agent): string {
  return adapter.id === "bare-cli" ? `bare-cli-${agent}` : adapter.id;
}

function block(agent: Agent, server: RunOptions["server"]): RunOptions {
  return { agent, model: MODEL_PINS[agent].model, effort: MODEL_PINS[agent].effort, server };
}

// METHODOLOGY.md §4: the model is fixed in every ADE. The replay server answers whatever model is asked for, but the
// pin still applies. Pilot 2026-10-20: left unset, T3 Code ran its factory Fable 5.1 at medium while the others ran
// Opus 5.5 at high, so the ADEs were not configured alike.
function trackABlocks(adapter: Adapter): RunOptions[] {
  if (adapter.id === "bare-cli") return [block("claude", "replay"), block("codex", "replay")];
  return [block(firstAgent(adapter), "replay")];
}

function trackBBlocks(adapter: Adapter): RunOptions[] {
  return adapter.agents.map((agent) => block(agent, "live"));
}

function trackCBlocks(adapter: Adapter): RunOptions[] {
  if (adapter.id === "bare-cli") return [block("claude", "live"), block("codex", "live")];
  if (adapter.id === "codex-app") return [block("codex", "live")];
  const agent = adapter.agents.includes("claude") ? "claude" : firstAgent(adapter);
  return [block(agent, "live")];
}

// One block per agent and model: each block is one reset, arena, seeding and test run of the ADE.
export function blocksFor(adapter: Adapter, track: TrackLetter): RunOptions[] {
  if (track === "A") return trackABlocks(adapter);
  if (track === "B") return trackBBlocks(adapter);
  return trackCBlocks(adapter);
}

// True when that row ade runs this track once: the only case where the old `<track>.done` marker names one block
// (ADEMARK-17 retry).
export function singleBlockFor(adapter: Adapter, track: TrackLetter, rowAde: string): boolean {
  return blocksFor(adapter, track).filter((options) => rowAdeFor(adapter, options.agent) === rowAde).length === 1;
}

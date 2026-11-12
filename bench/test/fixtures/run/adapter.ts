// A fixture ADE for the run-core tests: every method resolves at once and reports its call to the plan.
import type { Adapter, Agent } from "../../../core/contracts.ts";

export interface FixtureAdapterOptions {
  id?: string;
  /** The agents this fixture ADE supports: Track B and C run one block per agent. Defaults to Claude only. */
  agents?: Agent[];
  onCall?: (call: string, args: Record<string, unknown>) => void;
}

export function makeFixtureAdapter(options: FixtureAdapterOptions = {}): Adapter {
  const id = options.id ?? "fixture-ade";
  const mark = (call: string, args: Record<string, unknown> = {}): void => options.onCall?.(`adapter.${call}`, args);
  return {
    id,
    name: "Fixture ADE",
    family: "EL-SDK",
    agents: options.agents ?? ["claude"],
    calibration: {
      appName: "Fixture App",
      bundleId: null,
      composerRect: null,
      threadRect: null,
      focusClick: null,
      masks: [],
      drive: "cdp",
      dataDirs: [],
      launchAgents: [],
    },
    timed: { launch: [], newThread: [], send: [] },
    installCheck: async () => ({
      installed: true,
      version: "1.0.0",
      path: "/Applications/Fixture.app",
      binarySha256: "a".repeat(64),
    }),
    reset: async () => mark("reset"),
    configure: async () => mark("configure"),
    launch: async () => {
      mark("launch");
      return { pid: 4242 };
    },
    newThread: async () => mark("newThread"),
    send: async (_ctx, text) => mark("send", { text }),
    waitDone: async () => ({ done: true, reason: "fixture" }),
    quit: async () => mark("quit"),
    processes: () => ({
      bundlePaths: [],
      vendorDirs: [],
      launchAgentLabels: [],
      teamId: null,
      agentExecutables: [],
    }),
  };
}

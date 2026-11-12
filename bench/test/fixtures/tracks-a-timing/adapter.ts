// A fully calibrated fixture ADE for the Track A timing tests: every method resolves at once.
import type { Adapter } from "../../../core/contracts.ts";

export interface TimingAdapterOptions {
  id?: string;
  /** False makes A11's long-thread build report "not done" (TESTS.md A11). */
  waitDone?: boolean;
  onCall?: (call: string, args: Record<string, unknown>) => void;
}

export function makeTimingAdapter(options: TimingAdapterOptions = {}): Adapter {
  const id = options.id ?? "fixture-timing";
  const mark = (call: string, args: Record<string, unknown> = {}): void => options.onCall?.(`adapter.${call}`, args);
  return {
    id,
    name: "Fixture Timing ADE",
    family: "EL-SDK",
    agents: ["claude"],
    calibration: {
      appName: "Fixture Timing",
      bundleId: "com.fixture.timing",
      composerRect: { x: 0, y: 800, w: 1200, h: 200 },
      threadRect: { x: 0, y: 100, w: 1200, h: 600 },
      focusClick: { x: 600, y: 900 },
      masks: [{ x: 10, y: 10, w: 20, h: 20 }],
      drive: "keys",
      dataDirs: [],
      launchAgents: ["com.fixture.timing.helper"],
    },
    timed: {
      launch: [{ kind: "open", bundleId: "com.fixture.timing" }],
      newThread: [{ kind: "keys", combo: "cmd+n" }],
      send: [{ kind: "enter" }],
      longThread: [{ kind: "click", point: { x: 30, y: 120 } }],
      shortThread: [{ kind: "click", point: { x: 30, y: 160 } }],
    },
    installCheck: async () => ({
      installed: true,
      version: "1.0.0",
      path: "/Applications/Fixture Timing.app",
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
    waitDone: async (_ctx, timeoutMs) => {
      mark("waitDone", { timeoutMs });
      const done = options.waitDone ?? true;
      return { done, reason: done ? "fixture" : "fixture: long thread did not finish" };
    },
    quit: async () => mark("quit"),
    processes: () => ({
      bundlePaths: ["/Applications/Fixture Timing.app"],
      vendorDirs: ["~/.fixture-timing"],
      launchAgentLabels: [],
      teamId: null,
      agentExecutables: ["claude"],
    }),
  };
}

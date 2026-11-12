// Test double for the macOS runner: records every system command, key post and window call, executes nothing.
import type { AdapterContext } from "../core/contracts.ts";
import type { KeysOptions, WindowOptions } from "../core/native.ts";
import type { MacosRunner } from "../adapters/macos.ts";

export const FIXED_NOW = Date.UTC(2026, 9, 19, 3, 4, 5, 123);

export interface FakeRunner extends MacosRunner {
  commands: string[][];
  inputs: Array<Uint8Array | undefined>;
  keysCalls: KeysOptions[];
  windowCalls: WindowOptions[];
}

export function fakeRunner(username: string, overrides: Partial<MacosRunner> = {}): FakeRunner {
  const commands: string[][] = [];
  const inputs: Array<Uint8Array | undefined> = [];
  const keysCalls: KeysOptions[] = [];
  const windowCalls: WindowOptions[] = [];
  return {
    commands,
    inputs,
    keysCalls,
    windowCalls,
    username: () => username,
    uid: () => 501,
    now: () => FIXED_NOW,
    run: (argv, input) => {
      commands.push(argv);
      inputs.push(input);
      return { code: 0, stdout: "", stderr: "" };
    },
    procs: async () => [],
    keys: async (options) => {
      keysCalls.push(options);
      return { t_ns: 0 };
    },
    window: async (options) => {
      windowCalls.push(options);
      return { window_id: 1, frame: { x: 0, y: 0, w: options.size.w, h: options.size.h } };
    },
    watch: async () => ({ seen_ns: 1, timed_out: false }),
    screenshot: async () => ({ path: "" }),
    ocr: async () => ({ lines: [] }),
    sleep: async () => {},
    ...overrides,
  };
}

export interface CapturedContext {
  ctx: AdapterContext;
  lines: string[];
}

export function captureContext(overrides: Partial<AdapterContext> = {}): CapturedContext {
  const lines: string[] = [];
  const ctx: AdapterContext = {
    runDir: "/tmp/ademark-run",
    arenaPath: "/tmp/ademark-arena",
    worktree: "/tmp/work",
    home: "/tmp/home",
    env: {},
    dryRun: true,
    log: (message: string) => {
      lines.push(message);
    },
    ...overrides,
  };
  return { ctx, lines };
}

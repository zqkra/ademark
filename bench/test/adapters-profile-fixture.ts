// A complete, valid ADE profile for tests. Mutate a copy of profileJson() to build a bad one.
import type { AdeProfile } from "../core/contracts.ts";

export const PROFILE_ID = "demo-ade";

export function validProfile(): AdeProfile {
  return {
    schema: 1,
    ade: PROFILE_ID,
    app: {
      path: "/Applications/Demo.app",
      version: "1.0.0",
      bundleSha256: null,
      processNames: ["Demo"],
    },
    window: { w: 1600, h: 1000 },
    calibration: {
      appName: "Demo",
      bundleId: "dev.demo.app",
      composerRect: { x: 600, y: 800, w: 400, h: 100 },
      activeComposerRect: { x: 600, y: 850, w: 400, h: 100 },
      launchComposerRect: null,
      clearKeys: ["cmd+a", "delete"],
      threadRect: { x: 400, y: 100, w: 700, h: 600 },
      focusClick: { x: 700, y: 900 },
      masks: [{ x: 1500, y: 0, w: 100, h: 60 }],
      drive: "keys",
      dataDirs: ["~/.demo"],
      launchAgents: ["dev.demo.ShipIt"],
    },
    login: {
      kind: "app",
      files: ["~/.demo/login.json"],
      signIn: "Sign in with the demo account",
    },
    reset: {
      seeds: [".demo"],
      jsonKeys: [{ file: "~/.demo/settings.json", keys: { sidebarSort: "created" } }],
    },
    steps: {
      afterLaunch: [{ kind: "keys", combo: "enter" }],
      openProject: [
        { kind: "keys", combo: "cmd+shift+n" },
        { kind: "type", text: "${worktree}" },
        { kind: "enter" },
      ],
      configure: {
        claude: [
          { kind: "run", argv: ["demo", "config", "--model", "${model}"], timeoutMs: 30_000 },
          { kind: "keys", combo: "cmd+shift+p" },
        ],
        codex: [
          { kind: "paste", text: "${agent}" },
          {
            kind: "expectText",
            region: { x: 400, y: 100, w: 700, h: 600 },
            text: "ready",
            timeoutMs: 5000,
          },
        ],
      },
      quit: [],
    },
    timed: {
      launch: [{ kind: "open", bundleId: "dev.demo.app" }],
      newThread: [
        { kind: "keys", combo: "cmd+n" },
        { kind: "wait", ms: 200 },
      ],
      send: [{ kind: "enter" }],
      longThread: [{ kind: "keys", combo: "cmd+1" }],
      shortThread: [{ kind: "click", point: { x: 10, y: 20 } }],
    },
    waitDone: { cwd: "worktree", idleFallback: false },
    processes: {
      vendorDirs: ["~/.demo"],
      launchAgentLabels: ["dev.demo.ShipIt"],
      teamId: null,
      agentExecutables: ["claude", "codex"],
    },
    orchestrationTrigger: null,
    notes: ["fixture"],
  };
}

export function profileJson(): Record<string, unknown> {
  return structuredClone(validProfile()) as unknown as Record<string, unknown>;
}

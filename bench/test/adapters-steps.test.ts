import { describe, expect, test } from "bun:test";
import { replacePlaceholders, runSteps, type StepVars } from "../adapters/profile-steps.ts";
import type { ProfileStep } from "../core/contracts.ts";
import { captureContext } from "./adapters-fake.ts";

const VARS: StepVars = {
  worktree: "/tmp/work/arena",
  home: "/tmp/home",
  model: "model-1",
  effort: "high",
  agent: "codex",
};

const STEPS: ProfileStep[] = [
  { kind: "keys", combo: "cmd+n" },
  { kind: "type", text: "hello ${model}" },
  { kind: "enter" },
  { kind: "click", point: { x: 10, y: 20 } },
  { kind: "wait", ms: 100 },
  { kind: "open", bundleId: "dev.demo.app" },
  { kind: "open", appPath: "/Applications/Demo.app", args: ["--profile", "${home}"] },
  { kind: "paste", text: "hi ${agent}" },
  {
    kind: "expectText",
    region: { x: 400, y: 100, w: 700, h: 600 },
    text: "ready ${effort}",
    timeoutMs: 5000,
  },
  { kind: "run", argv: ["/bin/echo", "${worktree}"], timeoutMs: 30_000 },
];

describe("runSteps in a dry run", () => {
  test("plans every step kind with the placeholders replaced", async () => {
    const { ctx, lines } = captureContext();
    await runSteps(ctx, 0, STEPS, VARS, "steps.openProject");

    expect(lines).toEqual([
      "plan: press pid=0 combo=cmd+n",
      "plan: typeText pid=0 text=hello model-1",
      "plan: press pid=0 combo=enter",
      "plan: click pid=0 at=10,20 count=1",
      "plan: pause ms=100",
      "plan: openBundle dev.demo.app",
      "plan: run open /Applications/Demo.app --profile /tmp/home",
      "plan: paste pid=0 text=hi codex",
      "plan: waitForText pid=0 text=ready high",
      "plan: run /bin/echo /tmp/work/arena timeoutMs=30000",
    ]);
  });

  test("names the list and index of a failing step", async () => {
    const { ctx } = captureContext();
    const steps = [{ kind: "open" } as ProfileStep];
    await expect(runSteps(ctx, 0, steps, VARS, "timed.send")).rejects.toThrow(
      "step timed.send[0] (open): open needs a bundleId or an appPath",
    );
  });

  test("a placeholder without a value fails the step", async () => {
    const { ctx } = captureContext();
    const steps: ProfileStep[] = [{ kind: "type", text: "${model}" }];
    await expect(runSteps(ctx, 0, steps, { ...VARS, model: null })).rejects.toThrow(
      "step steps[0] (type): ${model} is not set",
    );
  });
});

describe("replacePlaceholders", () => {
  test("replaces the five names and keeps other text", () => {
    expect(
      replacePlaceholders("${worktree}|${home}|${model}|${effort}|${agent}|plain", VARS),
    ).toBe("/tmp/work/arena|/tmp/home|model-1|high|codex|plain");
  });

  test("leaves unknown names alone", () => {
    expect(replacePlaceholders("${cwd}", VARS)).toBe("${cwd}");
  });
});

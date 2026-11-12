// Strict validation of an ADE profile (bench/adapters/profiles/<ade>.json). Pure: no file reads.
import type { Agent } from "../core/contracts.ts";

const DRIVES = new Set(["cli", "api", "cdp", "ax", "keys", "manual"]);
const AGENTS = new Set(["claude", "codex", "own"]);
const TRIGGER_KINDS = new Set(["open", "keys", "type", "click", "enter", "wait"]);
const FORBIDDEN_ARGV0 = new Set(["sudo", "su", "sh", "bash", "zsh", "env", "osascript"]);
const PLACEHOLDERS = new Set(["worktree", "home", "model", "effort", "agent"]);
const PLACEHOLDER = /\$\{([^}]*)\}/g;

const MAX_RUN_TIMEOUT_MS = 600_000;
const MAX_TEXT_TIMEOUT_MS = 120_000;
// clickIfText looks for something that is either on screen at once or not there at all, so its wait stays short.
const MAX_CLICK_IF_TEXT_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requireString(value: unknown, path: string, errors: string[]): void {
  if (!nonEmpty(value)) errors.push(`${path}: must be a non-empty string`);
}

function requireStringOrNull(value: unknown, path: string, errors: string[]): void {
  if (value !== null && !nonEmpty(value)) errors.push(`${path}: must be a string or null`);
}

// Track C only: the settings that switch orchestration on, and whether its workers are sessions of their own.
function checkOrchestration(value: unknown, errors: string[]): void {
  const root = asObject(value);
  if (root === null) {
    errors.push("orchestration: must be an object");
    return;
  }
  for (const key of Object.keys(root)) if (key !== "settings" && key !== "workers") errors.push(`orchestration.${key}: unknown key`);
  if (root.workers !== undefined && root.workers !== "sessions") errors.push('orchestration.workers: must be "sessions" or absent');
  if (root.settings === undefined) return;
  if (!Array.isArray(root.settings)) {
    errors.push("orchestration.settings: must be an array");
    return;
  }
  root.settings.forEach((entry, index) => {
    const at = `orchestration.settings[${index}]`;
    const setting = asObject(entry);
    if (setting === null) {
      errors.push(`${at}: must be an object`);
      return;
    }
    if (typeof setting.file !== "string" || !setting.file.startsWith("~/") || !setting.file.endsWith(".json")) errors.push(`${at}.file: must be a .json path under ~/`);
    if (!Array.isArray(setting.path) || setting.path.length === 0 || !setting.path.every((key) => typeof key === "string" && key.length > 0)) {
      errors.push(`${at}.path: must be a non-empty array of keys`);
    }
    if (!["boolean", "string", "number"].includes(typeof setting.value)) errors.push(`${at}.value: must be a boolean, a string or a number`);
  });
}

// null is a fact about the ADE (no orchestration); an ADE with orchestration and no proven trigger says what is missing.
function checkOrchestrationTrigger(value: unknown, errors: string[]): void {
  if (value === null || nonEmpty(value)) return;
  const object = asObject(value);
  if (object !== null && Object.keys(object).length === 1 && nonEmpty(object.notCalibrated)) return;
  errors.push('orchestrationTrigger: must be a non-empty string, null or { "notCalibrated": "<what is missing>" }');
}

function checkStringArray(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be an array of strings`);
    return;
  }
  value.forEach((item, index) => requireString(item, `${path}[${index}]`, errors));
}

function checkTextList(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path}: must be a non-empty array of strings`);
    return;
  }
  value.forEach((item, index) => requireString(item, `${path}[${index}]`, errors));
}

function checkHomePath(value: unknown, path: string, errors: string[]): void {
  if (!nonEmpty(value)) {
    errors.push(`${path}: must be a non-empty string`);
    return;
  }
  if (!value.startsWith("~/")) errors.push(`${path}: must be a path under ~ (start with "~/")`);
}

interface WindowSize {
  w: number;
  h: number;
}

function checkWindow(value: unknown, errors: string[]): WindowSize | null {
  const window = asObject(value);
  if (window === null) {
    errors.push("window: must be an object");
    return null;
  }
  let ok = true;
  if (!isPositiveInt(window.w)) {
    errors.push("window.w: must be a positive integer");
    ok = false;
  }
  if (!isPositiveInt(window.h)) {
    errors.push("window.h: must be a positive integer");
    ok = false;
  }
  return ok ? { w: window.w as number, h: window.h as number } : null;
}

function checkRect(value: unknown, path: string, window: WindowSize | null, errors: string[], allowNull = false): void {
  if (value === null) {
    if (!allowNull) errors.push(`${path}: must not be null`);
    return;
  }
  const rect = asObject(value);
  if (rect === null) {
    errors.push(`${path}: must be an object {x,y,w,h}`);
    return;
  }
  for (const key of ["x", "y", "w", "h"]) {
    if (!isNumber(rect[key])) {
      errors.push(`${path}.${key}: must be a number`);
      return;
    }
  }
  const { x, y, w, h } = rect as unknown as { x: number; y: number; w: number; h: number };
  if (w <= 0 || h <= 0) {
    errors.push(`${path}: must have a positive size`);
    return;
  }
  if (window === null) return;
  if (x < 0 || y < 0 || x + w > window.w || y + h > window.h) {
    errors.push(`${path}: must lie inside the ${window.w}x${window.h} window`);
  }
}

function checkPoint(value: unknown, path: string, window: WindowSize | null, errors: string[], allowNull = false): void {
  if (value === null) {
    if (!allowNull) errors.push(`${path}: must not be null`);
    return;
  }
  const point = asObject(value);
  if (point === null) {
    errors.push(`${path}: must be an object {x,y}`);
    return;
  }
  if (!isNumber(point.x) || !isNumber(point.y)) {
    errors.push(`${path}: must have numeric x and y`);
    return;
  }
  const { x, y } = point as unknown as { x: number; y: number };
  if (window === null) return;
  if (x < 0 || y < 0 || x > window.w || y > window.h) {
    errors.push(`${path}: must lie inside the ${window.w}x${window.h} window`);
  }
}

function checkApp(value: unknown, errors: string[]): void {
  const app = asObject(value);
  if (app === null) {
    errors.push("app: must be an object");
    return;
  }
  requireString(app.path, "app.path", errors);
  requireString(app.version, "app.version", errors);
  requireStringOrNull(app.bundleSha256, "app.bundleSha256", errors);
  checkStringArray(app.processNames, "app.processNames", errors);
}

function checkCalibration(value: unknown, window: WindowSize | null, errors: string[]): void {
  const calibration = asObject(value);
  if (calibration === null) {
    errors.push("calibration: must be an object");
    return;
  }
  requireString(calibration.appName, "calibration.appName", errors);
  if (!("bundleId" in calibration)) errors.push("calibration.bundleId: must be a string or null");
  else requireStringOrNull(calibration.bundleId, "calibration.bundleId", errors);
  checkRect(calibration.composerRect, "calibration.composerRect", window, errors);
  checkRect(calibration.threadRect, "calibration.threadRect", window, errors);
  if ("activeComposerRect" in calibration) {
    checkRect(calibration.activeComposerRect, "calibration.activeComposerRect", window, errors, true);
  }
  if ("launchComposerRect" in calibration) {
    checkRect(calibration.launchComposerRect, "calibration.launchComposerRect", window, errors, true);
  }
  checkPoint(calibration.focusClick, "calibration.focusClick", window, errors, true);
  if (calibration.probe !== undefined && !(typeof calibration.probe === "string" && /^[a-z]{4,12}$/.test(calibration.probe) && new Set(calibration.probe).size === calibration.probe.length)) {
    errors.push("calibration.probe: must be 4 to 12 different lowercase letters");
  }
  if (!Array.isArray(calibration.masks)) {
    errors.push("calibration.masks: must be an array of rects");
  } else {
    calibration.masks.forEach((mask, index) => checkRect(mask, `calibration.masks[${index}]`, window, errors));
  }
  if (typeof calibration.drive !== "string" || !DRIVES.has(calibration.drive)) {
    errors.push(`calibration.drive: must be one of ${[...DRIVES].join(", ")}`);
  }
  checkStringArray(calibration.dataDirs, "calibration.dataDirs", errors);
  checkStringArray(calibration.launchAgents, "calibration.launchAgents", errors);
  if ("clearKeys" in calibration) checkStringArray(calibration.clearKeys, "calibration.clearKeys", errors);
}

function checkLogin(value: unknown, errors: string[]): void {
  const login = asObject(value);
  if (login === null) {
    errors.push("login: must be an object");
    return;
  }
  const kind = login.kind;
  if (kind !== "app" && kind !== "agent-cli") {
    errors.push('login.kind: must be "app" or "agent-cli"');
  }
  if (!Array.isArray(login.files)) {
    errors.push("login.files: must be an array of paths");
  } else {
    login.files.forEach((file, index) => checkHomePath(file, `login.files[${index}]`, errors));
    if (kind === "app" && login.files.length === 0) errors.push('login.files: must not be empty for kind "app"');
  }
  if (kind === "app") {
    if (!nonEmpty(login.signIn)) errors.push('login.signIn: must be a non-empty string for kind "app"');
  } else if (kind === "agent-cli" && login.signIn !== null) {
    errors.push('login.signIn: must be null for kind "agent-cli"');
  }
}

function checkReset(value: unknown, errors: string[]): void {
  const reset = asObject(value);
  if (reset === null) {
    errors.push("reset: must be an object");
    return;
  }
  checkStringArray(reset.seeds, "reset.seeds", errors);
  if (reset.warmLaunchMs !== undefined && !(isPositiveInt(reset.warmLaunchMs) && (reset.warmLaunchMs as number) <= 120_000)) {
    errors.push("reset.warmLaunchMs: must be an integer from 1 to 120000");
  }
  if (!Array.isArray(reset.jsonKeys)) {
    errors.push("reset.jsonKeys: must be an array");
    return;
  }
  reset.jsonKeys.forEach((raw, index) => {
    const path = `reset.jsonKeys[${index}]`;
    const entry = asObject(raw);
    if (entry === null) {
      errors.push(`${path}: must be an object`);
      return;
    }
    checkHomePath(entry.file, `${path}.file`, errors);
    if (asObject(entry.keys) === null) errors.push(`${path}.keys: must be an object`);
  });
}

function checkOpen(step: Json, path: string, errors: string[]): void {
  if (step.bundleId === undefined && step.appPath === undefined) {
    errors.push(`${path}: open needs a bundleId or an appPath`);
  }
  if (step.bundleId !== undefined) requireString(step.bundleId, `${path}.bundleId`, errors);
  if (step.appPath !== undefined) requireString(step.appPath, `${path}.appPath`, errors);
  if (step.args !== undefined) checkStringArray(step.args, `${path}.args`, errors);
}

function checkTimeout(value: unknown, path: string, max: number, errors: string[]): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    errors.push(`${path}: must be an integer from 1 to ${max}`);
  }
}

function checkPlaceholders(value: unknown, path: string, errors: string[]): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(PLACEHOLDER)) {
      const name = match[1] ?? "";
      if (!PLACEHOLDERS.has(name)) {
        errors.push(
          `${path}: placeholder "\${${name}}" is not allowed; use \${worktree}, \${home}, \${model}, ` +
            "\${effort} or \${agent}",
        );
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkPlaceholders(item, `${path}[${index}]`, errors));
    return;
  }
  const object = asObject(value);
  if (object !== null) {
    for (const [key, item] of Object.entries(object)) checkPlaceholders(item, `${path}.${key}`, errors);
  }
}

function checkStep(value: unknown, path: string, window: WindowSize | null, errors: string[]): void {
  const step = asObject(value);
  if (step === null) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const kind = step.kind;
  if (typeof kind !== "string") {
    errors.push(`${path}.kind: must be a string`);
    return;
  }
  switch (kind) {
    case "keys":
      requireString(step.combo, `${path}.combo`, errors);
      break;
    case "type":
      requireString(step.text, `${path}.text`, errors);
      break;
    case "enter":
      break;
    case "click":
      checkPoint(step.point, `${path}.point`, window, errors);
      break;
    case "wait":
      if (!isNonNegativeInt(step.ms)) errors.push(`${path}.ms: must be a non-negative integer`);
      break;
    case "open":
      checkOpen(step, path, errors);
      break;
    case "paste":
      requireString(step.text, `${path}.text`, errors);
      break;
    case "expectText":
      checkRect(step.region, `${path}.region`, window, errors);
      if (step.text !== undefined && step.texts !== undefined) errors.push(`${path}: set text or texts, not both`);
      else if (step.texts !== undefined) checkTextList(step.texts, `${path}.texts`, errors);
      else requireString(step.text, `${path}.text`, errors);
      checkTimeout(step.timeoutMs, `${path}.timeoutMs`, MAX_TEXT_TIMEOUT_MS, errors);
      break;
    case "clickIfText":
      checkRect(step.region, `${path}.region`, window, errors);
      checkTextList(step.texts, `${path}.texts`, errors);
      checkPoint(step.point, `${path}.point`, window, errors);
      checkTimeout(step.timeoutMs, `${path}.timeoutMs`, MAX_CLICK_IF_TEXT_TIMEOUT_MS, errors);
      if (step.confirmGone !== undefined && typeof step.confirmGone !== "boolean") {
        errors.push(`${path}.confirmGone: must be a boolean`);
      }
      break;
    case "run":
      if (!Array.isArray(step.argv) || step.argv.length === 0) {
        errors.push(`${path}.argv: must be a non-empty array of strings`);
      } else {
        step.argv.forEach((arg, index) => requireString(arg, `${path}.argv[${index}]`, errors));
        const first = step.argv[0];
        if (typeof first === "string" && FORBIDDEN_ARGV0.has(first.split("/").pop() ?? first)) {
          errors.push(`${path}.argv[0]: "${first}" is not allowed`);
        }
      }
      checkTimeout(step.timeoutMs, `${path}.timeoutMs`, MAX_RUN_TIMEOUT_MS, errors);
      break;
    case "goal":
      requireString(step.goal, `${path}.goal`, errors);
      if (step.maxActions !== undefined && (!Number.isInteger(step.maxActions) || (step.maxActions as number) < 1 || (step.maxActions as number) > 20)) {
        errors.push(`${path}.maxActions: must be an integer from 1 to 20`);
      }
      if (step.allowKeys !== undefined && !(Array.isArray(step.allowKeys) && step.allowKeys.every((key) => key === "cmd+a"))) {
        errors.push(`${path}.allowKeys: only "cmd+a" can be allowed`);
      }
      break;
    case "setJsonKeys":
      errors.push(`${path}.kind: "setJsonKeys" is not a ProfileStep; use reset.jsonKeys`);
      return;
    default:
      errors.push(`${path}.kind: "${kind}" is not a ProfileStep`);
      return;
  }
  checkPlaceholders(step, path, errors);
}

function checkStepList(value: unknown, path: string, window: WindowSize | null, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be an array of steps`);
    return;
  }
  value.forEach((step, index) => checkStep(step, `${path}[${index}]`, window, errors));
}

function checkSteps(value: unknown, window: WindowSize | null, agents: readonly Agent[], errors: string[]): void {
  const steps = asObject(value);
  if (steps === null) {
    errors.push("steps: must be an object");
    return;
  }
  for (const key of ["afterLaunch", "openProject", "quit"] as const) {
    checkStepList(steps[key], `steps.${key}`, window, errors);
  }
  for (const key of ["beforeRelaunchQuit", "beforeColdQuit", "returnToThread"] as const) {
    if (steps[key] !== undefined) checkStepList(steps[key], `steps.${key}`, window, errors);
  }
  const configure = asObject(steps.configure);
  if (configure === null) {
    errors.push("steps.configure: must be an object");
    return;
  }
  for (const [agent, list] of Object.entries(configure)) {
    if (!AGENTS.has(agent)) {
      errors.push(`steps.configure.${agent}: unknown agent`);
      continue;
    }
    checkStepList(list, `steps.configure.${agent}`, window, errors);
  }
  for (const agent of agents) {
    if (!Object.hasOwn(configure, agent)) {
      errors.push(`steps.configure.${agent}: must be a list for the adapter's agent "${agent}"`);
    }
  }
}

function checkTrigger(value: unknown, path: string, window: WindowSize | null, errors: string[]): void {
  const trigger = asObject(value);
  if (trigger === null) {
    errors.push(`${path}: must be an object`);
    return;
  }
  if (typeof trigger.kind !== "string" || !TRIGGER_KINDS.has(trigger.kind)) {
    errors.push(
      `${path}.kind: "${String(trigger.kind)}" is not a trigger (open, keys, type, click, enter, wait)`,
    );
    return;
  }
  checkStep(trigger, path, window, errors);
}

function checkTimed(value: unknown, window: WindowSize | null, errors: string[]): void {
  const timed = asObject(value);
  if (timed === null) {
    errors.push("timed: must be an object");
    return;
  }
  for (const key of ["launch", "newThread", "send"] as const) {
    const list = timed[key];
    if (!Array.isArray(list)) {
      errors.push(`timed.${key}: must be an array of triggers`);
      continue;
    }
    if (list.length === 0) errors.push(`timed.${key}: must not be empty`);
    list.forEach((trigger, index) => checkTrigger(trigger, `timed.${key}[${index}]`, window, errors));
  }
  for (const key of ["longThread", "shortThread"] as const) {
    if (!(key in timed)) continue;
    const list = timed[key];
    if (!Array.isArray(list)) {
      errors.push(`timed.${key}: must be an array of triggers`);
      continue;
    }
    list.forEach((trigger, index) => checkTrigger(trigger, `timed.${key}[${index}]`, window, errors));
  }
}

function checkWaitDone(value: unknown, errors: string[]): void {
  const waitDone = asObject(value);
  if (waitDone === null) {
    errors.push("waitDone: must be an object");
    return;
  }
  if (waitDone.cwd !== "worktree" && waitDone.cwd !== "any") {
    errors.push('waitDone.cwd: must be "worktree" or "any"');
  }
  if (typeof waitDone.idleFallback !== "boolean") errors.push("waitDone.idleFallback: must be a boolean");
}

function checkProcesses(value: unknown, errors: string[]): void {
  const processes = asObject(value);
  if (processes === null) {
    errors.push("processes: must be an object");
    return;
  }
  checkStringArray(processes.vendorDirs, "processes.vendorDirs", errors);
  checkStringArray(processes.launchAgentLabels, "processes.launchAgentLabels", errors);
  if (!("teamId" in processes)) errors.push("processes.teamId: must be a string or null");
  else requireStringOrNull(processes.teamId, "processes.teamId", errors);
  checkStringArray(processes.agentExecutables, "processes.agentExecutables", errors);
}

// `agents` is the adapter's own list, so a profile must configure every agent the adapter can run.
export function validateProfile(raw: unknown, id: string, agents: readonly Agent[] = []): string[] {
  const errors: string[] = [];
  const root = asObject(raw);
  if (root === null) return ["profile: must be a JSON object"];

  if (root.schema !== 1) errors.push("schema: must be 1");
  if (!nonEmpty(root.ade)) errors.push("ade: must be a non-empty string");
  else if (root.ade !== id) errors.push(`ade: "${root.ade}" does not match the adapter id "${id}"`);

  const window = checkWindow(root.window, errors);
  checkApp(root.app, errors);
  checkCalibration(root.calibration, window, errors);
  checkLogin(root.login, errors);
  checkReset(root.reset, errors);
  if (root.blankRelaunchMs !== undefined && !(isPositiveInt(root.blankRelaunchMs) && (root.blankRelaunchMs as number) <= 60_000)) {
    errors.push("blankRelaunchMs: must be an integer from 1 to 60000");
  }
  checkSteps(root.steps, window, agents, errors);
  checkTimed(root.timed, window, errors);
  checkWaitDone(root.waitDone, errors);
  checkProcesses(root.processes, errors);
  if (!("orchestrationTrigger" in root)) {
    errors.push('orchestrationTrigger: must be a non-empty string, null or { "notCalibrated": "<what is missing>" }');
  } else checkOrchestrationTrigger(root.orchestrationTrigger, errors);
  if (root.orchestration !== undefined) checkOrchestration(root.orchestration, errors);
  checkStringArray(root.notes, "notes", errors);
  if (root.agentGuide !== undefined) requireString(root.agentGuide, "agentGuide", errors);
  if (root.excludeTests !== undefined) {
    const excluded = asObject(root.excludeTests);
    if (excluded === null) errors.push("excludeTests: must be an object of test ID to reason");
    else for (const [id, why] of Object.entries(excluded)) {
      if (!/^[ABC]\d{1,2}(:[a-z0-9-]+)?$/.test(id)) errors.push(`excludeTests.${id}: not a test ID or test:part`);
      requireString(why, `excludeTests.${id}`, errors);
    }
  }

  return errors;
}

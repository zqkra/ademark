import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  base32,
  generateHandoffCodes,
  loadTask,
  parseFaults,
  parseFollowups,
  parseFollowupPolicy,
  parseModel,
  parseRecovery,
  renderHandoffCodes,
} from "../core/tasks.ts";
import { tasksRoot } from "../core/paths.ts";

const REAL_TASKS = [
  "B1-hello",
  "B3-real-prompt",
  "C1-orchestrated-build",
  "C1-solo",
  "C2-message-delivery",
  "C4-agent-killed",
  "C5-network-cut",
  "C6-app-restart",
];

describe("loadTask on the real task folders", () => {
  test("all 8 folders load and fill every TaskSpec field", () => {
    for (const id of REAL_TASKS) {
      const task = loadTask(id);
      expect(task.id).toBe(id);
      expect(task.version).toBe("1.0.0");
      expect(task.time_cap_s).toBeGreaterThan(0);
      expect(task.prompt.length).toBeGreaterThan(0);
      expect(["claude", "codex", "both"]).toContain(task.model);
      expect(Array.isArray(task.grade_groups)).toBe(true);
      expect(Array.isArray(task.followups)).toBe(true);
      expect(Array.isArray(task.faults)).toBe(true);
    }
  });

  test("B1-hello repeats 3 with model both", () => {
    const task = loadTask("B1-hello");
    expect(task.test_id).toBe("B1");
    expect(task.repeats).toBe(3);
    expect(task.model).toBe("both");
    expect(task.chat_lock_probe).toBe(false);
    expect(task.followup_policy).toBeNull();
    expect(task.recovery).toBeNull();
    expect(task.faults).toEqual([]);
  });

  test("C1-orchestrated-build has the chat-lock probe and 8 grade groups", () => {
    const task = loadTask("C1-orchestrated-build");
    expect(task.chat_lock_probe).toBe(true);
    expect(task.grade_groups.length).toBe(8);
    expect(task.grade_groups).toContain("W1-limiter");
    expect(task.grade_groups).toContain("C1-handoff");
  });

  test("C2 follow-ups carry ids, times, byte-for-byte text and the policy", () => {
    const task = loadTask("C2-message-delivery");
    expect(task.followups.map((follow) => follow.id)).toEqual(["C2-F1", "C2-F2", "C2-F3"]);
    expect(task.followups.map((follow) => follow.at_s)).toEqual([30, 90, 150]);
    for (const follow of task.followups) {
      const path = join(tasksRoot(), "C2-message-delivery", follow.file);
      expect(follow.text).toBe(readFileSync(path, "utf8"));
    }
    expect(task.followup_policy).toEqual({ refused_retry_every_s: 1, refused_give_up_s: 10 });
  });

  test("C4 kills the agent at 90 s with no cut duration and a recovery", () => {
    const task = loadTask("C4-agent-killed");
    expect(task.faults).toEqual([{ kind: "kill-agent", at_s: 90, duration_s: null }]);
    expect(task.recovery).toEqual({ wait_s: 60, message: "continue" });
  });

  test("C5 cuts the network for 30 s and still has the recovery", () => {
    const task = loadTask("C5-network-cut");
    expect(task.faults).toEqual([{ kind: "cut-network", at_s: 90, duration_s: 30 }]);
    expect(task.recovery).toEqual({ wait_s: 60, message: "continue" });
  });

  test("C6 restarts the app with no duration", () => {
    expect(loadTask("C6-app-restart").faults).toEqual([{ kind: "restart-app", at_s: 90, duration_s: null }]);
  });
});

let root: string;

function makeTask(id: string, toml: string, prompt = "prompt body\n"): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.toml"), toml);
  writeFileSync(join(dir, "prompt.md"), prompt);
}

const BASE = `id = "C4-agent-killed"
version = "1.0.0"
track = "C"
model = "claude"
time_cap_s = 900
grade_groups = ["W3-cursor"]
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ademark-tasks-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadTask validation", () => {
  test("defaults: repeats 1, probe off, no follow-up policy and no recovery", () => {
    makeTask("B1-hello", 'id = "B1-hello"\nversion = "1.0.0"\nmodel = "both"\ntime_cap_s = 120\n');
    const task = loadTask("B1-hello", root);
    expect(task.repeats).toBe(1);
    expect(task.chat_lock_probe).toBe(false);
    expect(task.followup_policy).toBeNull();
    expect(task.recovery).toBeNull();
    expect(task.grade_groups).toEqual([]);
  });

  test("a hyphenated fault kind throws", () => {
    makeTask("C4-agent-killed", `${BASE}\n[fault]\nkind = "kill-agent"\nat_s = 90\n`);
    expect(() => loadTask("C4-agent-killed", root)).toThrow(/unknown fault kind kill-agent/);
  });

  test("another unknown fault kind throws", () => {
    makeTask("C4-agent-killed", `${BASE}\n[fault]\nkind = "explode"\nat_s = 90\n`);
    expect(() => loadTask("C4-agent-killed", root)).toThrow(/unknown fault kind explode/);
  });

  test("a bad model throws", () => {
    makeTask("B1-hello", 'id = "B1-hello"\nversion = "1.0.0"\nmodel = "gpt"\ntime_cap_s = 120\n');
    expect(() => loadTask("B1-hello", root)).toThrow(/model must be one of claude, codex, both/);
  });

  test("a missing version throws", () => {
    makeTask("B1-hello", 'id = "B1-hello"\nmodel = "both"\ntime_cap_s = 120\n');
    expect(() => loadTask("B1-hello", root)).toThrow(/version/);
  });

  test("repeats must be a whole number >= 1", () => {
    makeTask("B1-hello", 'id = "B1-hello"\nversion = "1.0.0"\nmodel = "both"\ntime_cap_s = 120\nrepeats = 0\n');
    expect(() => loadTask("B1-hello", root)).toThrow(/repeats/);
  });

  test("a missing follow-up file throws", () => {
    makeTask(
      "C2-message-delivery",
      `id = "C2-message-delivery"\nversion = "1.0.0"\nmodel = "claude"\ntime_cap_s = 900\n\n[[followup]]\nid = "C2-F1"\nat_s = 30\nfile = "followups/F1.md"\n`,
    );
    expect(() => loadTask("C2-message-delivery", root)).toThrow(/missing .*F1\.md/);
  });

  test("a follow-up reads its text byte for byte", () => {
    makeTask("C2-message-delivery", `id = "C2-message-delivery"\nversion = "1.0.0"\nmodel = "claude"\ntime_cap_s = 900\n\n[[followup]]\nid = "C2-F1"\nat_s = 30\nfile = "followups/F1.md"\n`);
    mkdirSync(join(root, "C2-message-delivery", "followups"), { recursive: true });
    writeFileSync(join(root, "C2-message-delivery", "followups", "F1.md"), "line one\nline two\n");
    const task = loadTask("C2-message-delivery", root);
    expect(task.followups[0]!.text).toBe("line one\nline two\n");
  });

  test("duration_s never comes from recovery.wait_s", () => {
    makeTask("C4-agent-killed", `${BASE}\n[fault]\nkind = "agent_kill"\nat_s = 90\n\n[recovery]\nwait_s = 45\nmessage = "go"\n`);
    const task = loadTask("C4-agent-killed", root);
    expect(task.faults[0]!.duration_s).toBeNull();
    expect(task.recovery).toEqual({ wait_s: 45, message: "go" });
  });

  test("fault duration_s is read from the fault table", () => {
    makeTask("C5-network-cut", `id = "C5-network-cut"\nversion = "1.0.0"\nmodel = "claude"\ntime_cap_s = 900\n\n[fault]\nkind = "network_cut"\nat_s = 90\nduration_s = 30\n`);
    expect(loadTask("C5-network-cut", root).faults[0]!.duration_s).toBe(30);
  });

  test("throws for a missing task.toml", () => {
    expect(() => loadTask("nope", root)).toThrow(/missing/);
  });

  test("throws for a missing prompt file", () => {
    mkdirSync(join(root, "B1-hello"), { recursive: true });
    writeFileSync(join(root, "B1-hello/task.toml"), 'id = "B1-hello"\nversion = "1.0.0"\nmodel = "both"\ntime_cap_s = 120\n');
    expect(() => loadTask("B1-hello", root)).toThrow(/missing .*prompt\.md/);
  });
});

describe("table parsers", () => {
  test("an absent table means no follow-ups, faults, policy or recovery", () => {
    expect(parseFollowups(undefined, root)).toEqual([]);
    expect(parseFaults(undefined)).toEqual([]);
    expect(parseFollowupPolicy(undefined)).toBeNull();
    expect(parseRecovery(undefined)).toBeNull();
  });

  test("parseFaults rejects a bad at_s", () => {
    expect(() => parseFaults({ kind: "agent_kill", at_s: -1 })).toThrow(/at_s/);
  });

  test("parseModel accepts only claude, codex and both", () => {
    expect(parseModel("claude")).toBe("claude");
    expect(parseModel("both")).toBe("both");
    expect(() => parseModel("")).toThrow(/model/);
  });

  test("parseFollowupPolicy requires both keys", () => {
    expect(() => parseFollowupPolicy({ refused_retry_every_s: 1 })).toThrow(/refused_give_up_s/);
  });

  test("parseRecovery requires a message", () => {
    expect(() => parseRecovery({ wait_s: 60 })).toThrow(/message/);
  });
});

describe("handoff codes", () => {
  const pattern = /^ADM-W[1-4]-[A-Z2-7]{6}$/;

  test("generateHandoffCodes is deterministic and matches the format", () => {
    const first = generateHandoffCodes("ademark-validation");
    const second = generateHandoffCodes("ademark-validation");
    expect(second).toEqual(first);
    for (const code of Object.values(first)) expect(code).toMatch(pattern);
  });

  test("renderHandoffCodes fills all four placeholders", () => {
    const prompt = "Codes: {{W1_CODE}} {{W2_CODE}} {{W3_CODE}} {{W4_CODE}}";
    const rendered = renderHandoffCodes(prompt, "seed-1");
    expect(rendered).not.toContain("{{");
    const codes = rendered.match(/ADM-W[1-4]-[A-Z2-7]{6}/g) ?? [];
    expect(codes.length).toBe(4);
    expect(renderHandoffCodes(prompt, "seed-1")).toBe(rendered);
  });

  test("the C1 prompt's placeholders are all filled", () => {
    const rendered = renderHandoffCodes(loadTask("C1-orchestrated-build").prompt, "ademark-validation");
    expect(rendered).not.toContain("{{");
  });

  test("a different seed gives different codes", () => {
    expect(generateHandoffCodes("seed-a")).not.toEqual(generateHandoffCodes("seed-b"));
  });

  test("leaves a prompt without placeholders unchanged", () => {
    expect(renderHandoffCodes("plain prompt\n", "seed")).toBe("plain prompt\n");
  });

  test("base32 uses the RFC 4648 alphabet", () => {
    expect(base32(new Uint8Array([0, 0, 0, 0, 0]), 6)).toBe("AAAAAA");
    expect(base32(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]), 6)).toBe("777777");
    expect(base32(new Uint8Array([0, 1, 2, 3, 4]), 6)).toMatch(/^[A-Z2-7]{6}$/);
  });

  test("rejects an empty seed", () => {
    expect(() => generateHandoffCodes("")).toThrow(/seed/);
  });

  test("the default tasks root is the repo's tasks folder", () => {
    expect(readFileSync(join(tasksRoot(), "B1-hello", "task.toml"), "utf8")).toContain("repeats = 3");
  });
});

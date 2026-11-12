import { describe, expect, test } from "bun:test";
import { getAdapter } from "../adapters/registry.ts";
import { blocksFor, rowAdeFor, singleBlockFor } from "../run/models.ts";

const NO_PINS = { model: null, effort: null };

describe("blocksFor", () => {
  test("Track A: the bare CLI is two controls, every other ADE one replay block, all with pinned models", () => {
    expect(blocksFor(getAdapter("bare-cli"), "A")).toEqual([
      { agent: "claude", model: "claude-opus-5-5", effort: "high", server: "replay" },
      { agent: "codex", model: "gpt-6.1-sol", effort: "high", server: "replay" },
    ]);
    expect(blocksFor(getAdapter("t3code"), "A")).toEqual([
      { agent: "claude", model: "claude-opus-5-5", effort: "high", server: "replay" },
    ]);
    expect(blocksFor(getAdapter("codex-app"), "A")).toEqual([
      { agent: "codex", model: "gpt-6.1-sol", effort: "high", server: "replay" },
    ]);
    expect(blocksFor(getAdapter("capy"), "A")).toEqual([{ agent: "own", ...NO_PINS, server: "replay" }]);
  });

  test("Track B: one live block per agent with its pinned model", () => {
    expect(blocksFor(getAdapter("t3code"), "B")).toEqual([
      { agent: "claude", model: "claude-opus-5-5", effort: "high", server: "live" },
      { agent: "codex", model: "gpt-6.1-sol", effort: "high", server: "live" },
    ]);
    expect(blocksFor(getAdapter("bare-cli"), "B")).toEqual([
      { agent: "claude", model: "claude-opus-5-5", effort: "high", server: "live" },
      { agent: "codex", model: "gpt-6.1-sol", effort: "high", server: "live" },
    ]);
    expect(blocksFor(getAdapter("codex-app"), "B")).toEqual([
      { agent: "codex", model: "gpt-6.1-sol", effort: "high", server: "live" },
    ]);
    expect(blocksFor(getAdapter("capy"), "B")).toEqual([{ agent: "own", ...NO_PINS, server: "live" }]);
  });

  test("Track C: two controls, codex-app alone, otherwise claude or the first agent", () => {
    expect(blocksFor(getAdapter("bare-cli"), "C").map((block) => block.agent)).toEqual(["claude", "codex"]);
    expect(blocksFor(getAdapter("t3code"), "C")).toEqual([
      { agent: "claude", model: "claude-opus-5-5", effort: "high", server: "live" },
    ]);
    expect(blocksFor(getAdapter("codex-app"), "C")).toEqual([
      { agent: "codex", model: "gpt-6.1-sol", effort: "high", server: "live" },
    ]);
    expect(blocksFor(getAdapter("capy"), "C")).toEqual([{ agent: "own", ...NO_PINS, server: "live" }]);
  });

  test("rowAdeFor names the control by agent", () => {
    expect(rowAdeFor(getAdapter("bare-cli"), "claude")).toBe("bare-cli-claude");
    expect(rowAdeFor(getAdapter("bare-cli"), "codex")).toBe("bare-cli-codex");
    expect(rowAdeFor(getAdapter("t3code"), "codex")).toBe("t3code");
  });

  test("singleBlockFor: the Bare CLI control is one block per row ade, t3code Track B is two", () => {
    expect(singleBlockFor(getAdapter("bare-cli"), "A", "bare-cli-claude")).toBe(true);
    expect(singleBlockFor(getAdapter("bare-cli"), "B", "bare-cli-codex")).toBe(true);
    expect(singleBlockFor(getAdapter("t3code"), "A", "t3code")).toBe(true);
    expect(singleBlockFor(getAdapter("t3code"), "B", "t3code")).toBe(false);
    expect(singleBlockFor(getAdapter("codex-app"), "B", "codex-app")).toBe(true);
    expect(singleBlockFor(getAdapter("capy"), "C", "capy")).toBe(true);
  });
});

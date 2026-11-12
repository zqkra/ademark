import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { ANCHOR_NAME, API_HOSTS, cutNetwork, parseDig, planCommands, renderAnchor, resolveHost } from "../fault/cut-network.ts";
import { MACHINE_BIN } from "../ops/machine-state.ts";
import { quitScript } from "../fault/restart-app.ts";
import { assertApplyAllowed } from "../fault/kill-agent.ts";

// As the "ademark" user these guards let --apply through, so a refusal test would run the real fault
// (pilot 2026-10-20: the cut-network one cut the network). They only run in other accounts.
const AS_APPLY_USER = userInfo().username === "ademark";

describe("parseDig", () => {
  test("keeps A records only", () => {
    expect(parseDig("160.79.104.10\n2607:6bc0::10\n", "A")).toEqual(["160.79.104.10"]);
  });

  test("keeps AAAA records only", () => {
    expect(parseDig("160.79.104.10\n2607:6bc0::10\n", "AAAA")).toEqual(["2607:6bc0::10"]);
  });

  test("ignores empty lines and comments", () => {
    expect(parseDig("\n\n", "A")).toEqual([]);
  });
});

describe("renderAnchor", () => {
  const template = "v4 { {{V4_ADDRESSES}} }\nv6 { {{V6_ADDRESSES}} }";

  test("renders every address into the tables", () => {
    const rendered = renderAnchor(template, [
      { host: "a", v4: ["1.1.1.1"], v6: ["::1"] },
      { host: "b", v4: ["2.2.2.2"], v6: ["::2"] },
    ]);
    expect(rendered).toContain("1.1.1.1, 2.2.2.2");
    expect(rendered).toContain("::1, ::2");
    expect(rendered).not.toContain("{{");
  });

  test("deduplicates repeated addresses", () => {
    const rendered = renderAnchor(template, [
      { host: "a", v4: ["1.1.1.1"], v6: [] },
      { host: "b", v4: ["1.1.1.1"], v6: [] },
    ]);
    expect(rendered).toContain("v4 { 1.1.1.1 }");
  });
});

describe("planCommands", () => {
  test("uses the anchor the main ruleset evaluates", () => {
    expect(ANCHOR_NAME).toBe("com.apple/ademark");
  });

  test("loads the addresses through the root script and clears the anchor afterwards", () => {
    const commands = planCommands(["1.1.1.1", "2606:4700::1111"]);
    expect(commands[0]).toBe(`sudo -n ${MACHINE_BIN} pf-block 1.1.1.1 2606:4700::1111`);
    expect(commands[1]).toBe(`sudo -n ${MACHINE_BIN} pf-clear`);
    expect(commands.length).toBe(2);
  });

  test("covers the three API hosts from TESTS.md 1.6", () => {
    expect([...API_HOSTS]).toEqual(["api.anthropic.com", "api.openai.com", "chatgpt.com"]);
  });
});

describe("cutNetwork dry run", () => {
  test("resolves, plans the root-script commands and writes nothing", async () => {
    const result = await cutNetwork({ durationS: 1, outDir: "/tmp/ademark-fault-test" });
    expect(result.applied).toBe(false);
    expect(result.anchor).toBe(ANCHOR_NAME);
    expect(result.commands.length).toBe(2);
    expect(result.commands[0]!.startsWith(`sudo -n ${MACHINE_BIN} pf-block `)).toBe(true);
    expect(result.commands[1]).toBe(`sudo -n ${MACHINE_BIN} pf-clear`);
    expect(result.rendered).toContain("table <ademark_v4>");
    expect(result.rendered).not.toContain("{{");
  }, 30000);

  test.skipIf(AS_APPLY_USER)("refuses --apply for a non-ademark user", async () => {
    const error = (await cutNetwork({ apply: true }).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/ademark/);
  }, 30000);
});

describe("resolveHost", () => {
  test("resolves api.anthropic.com through dig", () => {
    const result = resolveHost("api.anthropic.com");
    expect(result.host).toBe("api.anthropic.com");
    expect(result.v4.length + result.v6.length).toBeGreaterThan(0);
  });
});

describe("fault safety", () => {
  test.skipIf(AS_APPLY_USER)("cut-network refuses --apply for a non-ademark user", () => {
    expect(() => assertApplyAllowed({ apply: true }, "fault cut-network")).toThrow(/ademark/);
  });

  test.skipIf(AS_APPLY_USER)("restart-app refuses --apply for a non-ademark user", () => {
    expect(() => assertApplyAllowed({ apply: true }, "fault restart-app")).toThrow(/ademark/);
  });

  test("dry runs are always allowed", () => {
    expect(() => assertApplyAllowed({}, "fault cut-network")).not.toThrow();
  });

  test("the quit script is a plain AppleScript quit", () => {
    expect(quitScript("T3 Code (Beta)")).toBe('quit app "T3 Code (Beta)"');
  });
});

describe("block.conf.template", () => {
  test("is a pf anchor with both address tables and placeholders", () => {
    const template = readFileSync(resolve(import.meta.dir, "../fault/block.conf.template"), "utf8");
    expect(template).toContain("com.apple/ademark");
    expect(template).toContain("{{V4_ADDRESSES}}");
    expect(template).toContain("{{V6_ADDRESSES}}");
    const rendered = renderAnchor(template, [{ host: "a", v4: ["1.2.3.4"], v6: ["::1"] }]);
    expect(rendered).toContain("1.2.3.4");
    expect(rendered).not.toContain("{{");
  });
});

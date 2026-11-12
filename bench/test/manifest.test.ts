import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectManifest,
  defaultMachineId,
  parseCliVersion,
  parseDisplay,
  parseHardware,
  writeManifest,
} from "../core/manifest.ts";
import type { Manifest } from "../core/contracts.ts";

const DISPLAY_JSON = JSON.stringify({
  SPDisplaysDataType: [
    {
      _name: "Apple M4",
      spdisplays_ndrvs: [
        {
          _name: "LG ULTRAGEAR",
          _spdisplays_pixels: "2560 x 1440",
          _spdisplays_resolution: "2560 x 1440 @ 144.00Hz",
          spdisplays_main: "spdisplays_yes",
        },
      ],
    },
  ],
});

describe("parseDisplay", () => {
  test("reads resolution, scale and refresh from system_profiler", () => {
    expect(parseDisplay(DISPLAY_JSON)).toEqual({ width: 2560, height: 1440, scale: 1, refresh_hz: 144 });
  });

  test("defaults the refresh rate to 60 when it is absent", () => {
    const json = JSON.stringify({ SPDisplaysDataType: [{ spdisplays_ndrvs: [{ _spdisplays_resolution: "1920 x 1080" }] }] });
    expect(parseDisplay(json).refresh_hz).toBe(60);
  });

  test("derives a retina scale of 2 from the pixel size", () => {
    const json = JSON.stringify({
      SPDisplaysDataType: [
        { spdisplays_ndrvs: [{ _spdisplays_resolution: "1512 x 982 @ 60.00Hz", _spdisplays_pixels: "3024 x 1964" }] },
      ],
    });
    expect(parseDisplay(json).scale).toBe(2);
  });

  test("throws when no display is reported", () => {
    expect(() => parseDisplay(JSON.stringify({ SPDisplaysDataType: [] }))).toThrow(/no display/);
  });
});

describe("parseHardware", () => {
  test("rounds RAM to whole GB", () => {
    expect(parseHardware("Mac16,10", "17179869184", "Apple M4")).toEqual({
      model: "Mac16,10",
      chip: "Apple M4",
      ram_gb: 16,
    });
  });

  test("throws on a bad memsize", () => {
    expect(() => parseHardware("Mac16,10", "zero", "Apple M4")).toThrow(/hw.memsize/);
  });

  test("names the reference machine", () => {
    const hardware: Manifest["hardware"] = { model: "Mac16,10", chip: "Apple M4", ram_gb: 16 };
    expect(defaultMachineId(hardware)).toBe("ref-mac-mini-m4-16gb");
  });

  test("slugs any other machine", () => {
    expect(defaultMachineId({ model: "Mac14,2", chip: "Apple M2", ram_gb: 8 })).toBe("mac14-2-apple-m2-8gb");
  });
});

describe("parseCliVersion", () => {
  test("keeps the raw version line", () => {
    expect(parseCliVersion("claude", "2.1.303 (Claude Code)\n")).toEqual(["claude", "2.1.303 (Claude Code)"]);
  });
});

describe("collectManifest", () => {
  test("collects this machine without writing anything", async () => {
    const manifest = await collectManifest({ runId: "check-1", orderSeed: "test", reference: false });
    expect(manifest.run_id).toBe("check-1");
    expect(manifest.machine_id).toBe("ref-mac-mini-m4-16gb");
    expect(manifest.verified).toBe(false);
    expect(manifest.hardware.ram_gb).toBe(16);
    expect(manifest.macos_build.length).toBeGreaterThan(0);
    expect(manifest.display.width).toBeGreaterThan(0);
    expect(manifest.order.length).toBe(18);
    expect(manifest.order_seed).toBe("test");
    expect(manifest.harness_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.cli_versions.claude).toContain("Claude Code");
  }, 60000);

  test("only reference:true sets verified", async () => {
    const manifest = await collectManifest({ runId: "check-2", orderSeed: "s", reference: true });
    expect(manifest.verified).toBe(true);
  }, 60000);

  test("accepts an explicit order and ade versions", async () => {
    const manifest = await collectManifest({
      runId: "check-3",
      orderSeed: "s",
      order: ["bb", "t3code"],
      adeVersions: { bb: { version: "0.46.1", sha256: null } },
    });
    expect(manifest.order).toEqual(["bb", "t3code"]);
    expect(manifest.ade_versions.bb!.version).toBe("0.46.1");
  }, 60000);

  test("writeManifest creates the run folder and writes manifest.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ademark-manifest-"));
    try {
      const manifest = await collectManifest({ runId: "check-4", orderSeed: "s", order: [] });
      const path = writeManifest(join(dir, "run-4"), manifest);
      expect(path).toBe(join(dir, "run-4", "manifest.json"));
      expect(JSON.parse(readFileSync(path, "utf8")).run_id).toBe("check-4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

// `ademark adapter new <id>`: scaffolds an adapter from _template.ts plus an agent brief (ADES.md 3, AGENT_GUIDE.md).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { benchRoot } from "../core/paths.ts";

export const ADAPTER_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface ScaffoldResult {
  id: string;
  adapterPath: string;
  briefPath: string;
}

export function renderBrief(id: string): string {
  return `# Adapter brief: ${id}

You are adding the ADE \`${id}\` to ADEMark. Read, in this order:

1. \`ADES.md\`, section 3 (the family procedure for this ADE, then the ADE's own section and fact table).
2. \`bench/core/contracts.ts\`, the "Adapters" section: \`Adapter\`, \`Calibration\`, \`InstallInfo\`, \`ProcessHints\`,
   \`Trigger\`.
3. \`bench/adapters/AGENT_GUIDE.md\`.
4. \`bench/adapters/${id}.ts\`, scaffolded from \`_template.ts\`.

Then fill \`bench/adapters/${id}.ts\`:

- \`id\`, \`name\`, \`family\`, \`agents\`: copy them from the ADES.md fact table exactly.
- \`calibration\`: \`appName\`, \`bundleId\`, \`dataDirs\`, \`launchAgents\` from ADES.md. Where ADES.md says
  "unknown, find in pilot", leave \`null\` or \`[]\` and keep the ADES.md wording in a one-line comment. Never guess.
- \`timed.launch\`, \`timed.newThread\`, \`timed.send\`: the \`Trigger\` arrays the echo timer executes. Timing comes
  only from \`ademark-native echo\`; an adapter never measures.
- \`installCheck()\`: read \`CFBundleShortVersionString\` and the SHA-256 of the main executable.
- \`reset\`, \`configure\`, \`launch\`, \`newThread\`, \`send\`, \`waitDone\`, \`quit\`, \`processes()\`: drive the ADE and
  return the hints; do not compute any number that goes into a result row.

Rules:

- **Adapters drive the ADE; they never measure.** Every timing number comes from \`ademark-native echo\`, every RAM
  and CPU number from the sampler.
- All timed actions are synthetic OS input (TESTS.md 1.3). CDP, HTTP, CLI and Accessibility calls are setup only.
- \`--remote-debugging-port\` is setup only; never use it for a launch that is measured.

Loop: edit the file, then run \`ademark adapter check ${id}\` until it prints "conforms". Missing calibration values
are warnings; a missing member is an error. Finish by running \`cd bench && bun test\`.

When the pilot finds an unknown value, record it in ADES.md and fill the adapter in the same change.
`;
}

export function scaffoldAdapter(id: string, dir: string = resolve(benchRoot, "adapters")): ScaffoldResult {
  if (!ADAPTER_ID.test(id)) {
    throw new Error(`invalid adapter id "${id}": use lowercase letters, digits and single dashes (e.g. my-ade)`);
  }
  const templatePath = resolve(dir, "_template.ts");
  const adapterPath = resolve(dir, `${id}.ts`);
  const briefPath = resolve(dir, `${id}.AGENT_BRIEF.md`);
  if (!existsSync(templatePath)) throw new Error(`template not found: ${templatePath}`);
  if (existsSync(adapterPath)) throw new Error(`refusing to overwrite ${adapterPath}`);
  if (existsSync(briefPath)) throw new Error(`refusing to overwrite ${briefPath}`);

  const source = readFileSync(templatePath, "utf8").split('id: "template"').join(`id: "${id}"`);
  writeFileSync(adapterPath, source);
  writeFileSync(briefPath, renderBrief(id));
  return { id, adapterPath, briefPath };
}

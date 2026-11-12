// Copy of this file is the starting point for a new ADE (`ademark adapter new <id>`).
// Fill it from ADES.md, then run `ademark adapter check <id>` until it passes. See AGENT_GUIDE.md.
// Every calibration field below maps to a key of the calibration table in TESTS.md 1.7.
import type { Adapter } from "../core/contracts.ts";
import { checkApp, notCalibrated } from "./support.ts";

export const template: Adapter = {
  // Adapter ID from ADES.md, e.g. `t3code`; also the file name and the `ade` field of every result row.
  id: "template",
  // Product name as ADES.md prints it.
  name: "Template ADE",
  // Family from METHODOLOGY.md 2: control | EL-SDK | EL-PTY | NATIVE | OWN | FIRST.
  family: "EL-SDK",
  // Which agents the ADE can run: claude, codex, own.
  agents: ["claude", "codex"],
  calibration: {
    // ADES.md: "Bundle id, appName | For launch and quit".
    appName: "",
    // ADES.md: bundle id, or null when the section says "unknown, find in pilot".
    bundleId: null,
    // ADES.md: composerRect | Region for OCR, relative to the window. null until the pilot measures it.
    composerRect: null,
    // ADES.md: threadRect | Region for OCR, relative to the window.
    threadRect: null,
    // ADES.md: focusClick | Point to click when the composer is not focused.
    focusClick: null,
    // ADES.md: masks | Rectangles ignored by "visually settled".
    masks: [],
    // ADES.md: drive | cli, api, cdp, ax or keys.
    drive: "keys",
    // ADES.md: dataDirs | What reset() and attribution must handle.
    dataDirs: [],
    // ADES.md: launchAgents | Launch-agent labels to boot out.
    launchAgents: [],
  },
  // ADES.md: newThread | The timed trigger of A3. Empty until the pilot records it.
  timed: { launch: [], newThread: [], send: [] },
  installCheck: () => checkApp("Template ADE"),
  reset: notCalibrated("reset"),
  configure: notCalibrated("configure"),
  launch: notCalibrated("launch"),
  newThread: notCalibrated("newThread"),
  send: notCalibrated("send"),
  waitDone: notCalibrated("waitDone"),
  quit: notCalibrated("quit"),
  // Every method throws "not calibrated" until the pilot fills it; processes() is the only sync one.
  processes: () => {
    throw new Error("not calibrated: processes");
  },
};

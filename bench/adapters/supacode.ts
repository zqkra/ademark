// NATIVE: Swift, libghostty; the agent's own TUI in a terminal tab, sessions held by the bundled `zmx` (ADES.md 3.18).
import { profileAdapter } from "./profile.ts";

export const supacode = profileAdapter({
  id: "supacode",
  name: "Supacode",
  family: "NATIVE",
  agents: ["claude"],
  appName: "supacode",
  bundleId: "app.supabit.supacode",
  drive: "cli",
  dataDirs: [
    "~/.supacode",
    "~/.config/supacode",
    "~/Library/Preferences/app.supabit.supacode.plist",
    "~/Library/Application Support/app.supabit.supacode",
    "~/Library/Caches/app.supabit.supacode",
  ],
  launchAgents: [],
  vendorDirs: ["~/.supacode", "~/.config/supacode"],
});

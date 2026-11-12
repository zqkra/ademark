// The 17 ADEs in the v1 field (METHODOLOGY.md §2), in alphabetical order, with each maker's own mark (logo without background).
export interface FieldAde {
  name: string;
  icon: string;
}

export const FIELD: FieldAde[] = [
  { name: "bb", icon: "/marks/bb.svg" },
  { name: "Capy", icon: "/marks/capy.svg" },
  { name: "Claude desktop", icon: "/marks/claude.svg" },
  { name: "Cloudroom", icon: "/marks/cloudroom.png" },
  { name: "Codex app", icon: "/marks/codex-app.svg" },
  { name: "Conductor", icon: "/marks/conductor.svg" },
  { name: "Diri", icon: "/marks/diri.png" },
  { name: "Emdash", icon: "/marks/emdash.svg" },
  { name: "MonoCode", icon: "/marks/monocode.png" },
  { name: "Orca", icon: "/marks/orca.svg" },
  { name: "Paseo", icon: "/marks/paseo.svg" },
  { name: "super.engineering", icon: "/marks/super-engineering.png" },
  { name: "Superset", icon: "/marks/superset.png" },
  { name: "Synara", icon: "/marks/synara.svg" },
  { name: "T3 Code", icon: "/marks/t3code.svg" },
  { name: "Traycer", icon: "/marks/traycer.svg" },
  { name: "Zeron", icon: "/marks/zeron.png" },
];

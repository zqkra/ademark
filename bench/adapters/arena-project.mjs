#!/usr/bin/env node
// Keeps the "arena" project of a bb-app host (Cloudroom's room-cli, bb's bb) on the worktree the
// block opened.
//
// project create --name arena makes a second project when one already exists, and the picker cannot
// tell two "arena" entries apart. On 2026-11-12 the Cloudroom C1 threads ran in the Track A copy
// ~/arena/cloudroom while the graded ~/arena/cloudroom-C1-1 stayed empty, and bb's data folder held
// three arena projects (~/arena/bb, bb-C1-1, bb-C1-2) whose fixed picker click always took the
// first, again the Track A copy.
//
//   free <cli> [hide]   rename every project named arena to prior-<id>; with "hide" also run
//                       project hide (room-cli has it, bb does not)
//   front <cli>         move the arena project to the front of the project list, for pickers that
//                       click the first row
//   verify <cli> <wt>   exit 1 unless exactly one project named arena sources <worktree>
//
// The CLIs answer only while their app is running, so the profiles call this from steps.openProject,
// never from reset or quit. Plain node on purpose: the profiles already need /opt/homebrew/bin/node
// for the CLIs themselves.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

const NODE = "/opt/homebrew/bin/node";
const [mode, cli, ...rest] = process.argv.slice(2);

function usage() {
  console.error("usage: arena-project.mjs free <cli> [hide] | front <cli> | verify <cli> <worktree>");
  process.exit(2);
}

let worktree;
let hide = false;
if (mode === "free") {
  if (cli === undefined || rest.length > 1 || (rest.length === 1 && rest[0] !== "hide")) usage();
  hide = rest[0] === "hide";
} else if (mode === "front") {
  if (cli === undefined || rest.length !== 0) usage();
} else if (mode === "verify") {
  worktree = rest[0];
  if (cli === undefined || worktree === undefined || rest.length !== 1) usage();
} else {
  usage();
}

function runCli(args) {
  const result = spawnSync(NODE, [cli, ...args, "--json"], { encoding: "utf8", timeout: 120000 });
  if (result.error) throw new Error(`${args.join(" ")}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "no output").trim();
    throw new Error(`${args.join(" ")} failed (exit ${result.status}): ${detail}`);
  }
  return parseJson(result.stdout);
}

function parseJson(stdout) {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[{[]/);
    if (start === -1) throw new Error(`no JSON in cli output: ${text.slice(0, 200)}`);
    return JSON.parse(text.slice(start));
  }
}

function projectList() {
  const data = runCli(["project", "list"]);
  const list = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : data === null ? [] : [data];
  return list.filter((project) => project && typeof project === "object" && typeof project.id === "string");
}

function arenaProjects(list = projectList()) {
  return list.filter((project) => project.name === "arena");
}

// project list already carries sources: [{path, isDefault}]. A clone source has no plain local path,
// and a project with several sources and none default is ambiguous, so both read as no source.
function effectiveSource(sources) {
  if (!Array.isArray(sources)) return null;
  const local = sources.filter(
    (source) => source && typeof source.path === "string" && (source.type === undefined || source.type === "local_path"),
  );
  const pick = local.find((source) => source.isDefault === true) ?? (local.length === 1 ? local[0] : null);
  return pick === null ? null : pick.path;
}

function localSources(node) {
  const sources = [];
  const walk = (item) => {
    if (Array.isArray(item)) return item.forEach(walk);
    if (item === null || typeof item !== "object") return;
    if (item.type === "local_path" && typeof item.path === "string") sources.push(item);
    for (const value of Object.values(item)) walk(value);
  };
  walk(node);
  return sources;
}

function samePath(a, b) {
  const strip = (p) => p.replace(/\/+$/, "");
  if (strip(a) === strip(b)) return true;
  try {
    return strip(realpathSync(a)) === strip(realpathSync(b));
  } catch {
    return false;
  }
}

if (mode === "free") {
  for (const project of arenaProjects()) {
    const renamed = `prior-${project.id}`;
    runCli(["project", "update", project.id, "--name", renamed]);
    console.log(`arena-project: renamed arena ${project.id} to ${renamed}`);
    if (hide) {
      runCli(["project", "hide", project.id]);
      console.log(`arena-project: hid ${renamed}`);
    }
  }
  process.exit(0);
}

if (mode === "front") {
  const list = projectList();
  const arenas = arenaProjects(list);
  if (arenas.length !== 1) {
    console.log(`arena-project: ${arenas.length} projects named arena; front skipped, verify reports the count`);
    process.exit(0);
  }
  const first = list[0];
  if (first === undefined || first.id === arenas[0].id) {
    console.log("arena-project: arena is already first in the project list");
    process.exit(0);
  }
  runCli(["project", "reorder", arenas[0].id, "--before", first.id]);
  console.log(`arena-project: moved arena ${arenas[0].id} before ${first.id}`);
  process.exit(0);
}

const wanted = worktree;
const arenas = arenaProjects();
if (arenas.length !== 1) {
  console.error(`arena-project: expected exactly one project named arena, found ${arenas.length}`);
  process.exit(1);
}
const project = arenas[0];
let sourcePath = effectiveSource(project.sources);
if (sourcePath === null) {
  const detail = runCli(["project", "show", project.id]);
  sourcePath = effectiveSource(localSources(detail));
}
if (sourcePath === null) {
  console.error(`arena-project: arena ${project.id} has no single default local source`);
  process.exit(1);
}
if (!samePath(sourcePath, wanted)) {
  console.error(`arena-project: arena ${project.id} sources ${sourcePath}, not ${wanted}`);
  process.exit(1);
}
console.log(`arena-project: arena ${project.id} sources ${sourcePath}`);
process.exit(0);

#!/usr/bin/env node
// Fake bb-app project CLI for the arena-project.mjs tests. It keeps its state in the JSON file
// named by ARENA_PROJECT_FAKE_STATE and answers the same subcommands the helper uses:
// project list|update|hide|reorder|show, each with --json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.ARENA_PROJECT_FAKE_STATE;
if (statePath === undefined) {
  console.error("ARENA_PROJECT_FAKE_STATE is not set");
  process.exit(2);
}

function load() {
  if (!existsSync(statePath)) return { projects: [] };
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function save(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

const args = process.argv.slice(2).filter((arg) => arg !== "--json");
const [group, command, ...rest] = args;
const state = load();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (group !== "project") fail(`unknown command ${args.join(" ")}`);

if (command === "list") {
  const hiddenOnly = args.includes("--hidden");
  const visible = state.projects.filter((project) => (hiddenOnly ? project.hidden : !project.hidden));
  console.log(JSON.stringify(visible.map(({ hidden, ...project }) => project)));
  process.exit(0);
}

if (command === "create") {
  const name = flag(rest, "--name");
  const root = flag(rest, "--root");
  const project = {
    id: `proj_fake${state.projects.length}`,
    kind: "standard",
    name,
    sources: [{ id: `src_fake${state.projects.length}`, hostId: "local", type: "local_path", path: root, isDefault: true }],
  };
  state.projects.push(project);
  save(state);
  console.log(JSON.stringify(project));
  process.exit(0);
}

if (command === "update") {
  const project = state.projects.find((item) => item.id === rest[0]);
  if (project === undefined) fail(`no project ${rest[0]}`);
  project.name = flag(rest, "--name");
  save(state);
  console.log(JSON.stringify(project));
  process.exit(0);
}

if (command === "hide") {
  const project = state.projects.find((item) => item.id === rest[0]);
  if (project === undefined) fail(`no project ${rest[0]}`);
  project.hidden = true;
  save(state);
  console.log(JSON.stringify({ id: project.id, hidden: true }));
  process.exit(0);
}

if (command === "reorder") {
  const id = rest[0];
  const index = state.projects.findIndex((item) => item.id === id);
  if (index === -1) fail(`no project ${id}`);
  const [project] = state.projects.splice(index, 1);
  const beforeIndex = state.projects.findIndex((item) => item.id === flag(rest, "--before"));
  const afterIndex = state.projects.findIndex((item) => item.id === flag(rest, "--after"));
  if (beforeIndex !== -1) state.projects.splice(beforeIndex, 0, project);
  else if (afterIndex !== -1) state.projects.splice(afterIndex + 1, 0, project);
  else state.projects.unshift(project);
  save(state);
  console.log(JSON.stringify({ id: project.id, reordered: true }));
  process.exit(0);
}

if (command === "show") {
  const project = state.projects.find((item) => item.id === rest[0]);
  if (project === undefined) fail(`no project ${rest[0]}`);
  console.log(JSON.stringify(project));
  process.exit(0);
}

fail(`unknown project command ${command}`);

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

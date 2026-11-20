#!/usr/bin/env node
// Copies the factory's files into a repository checkout.
//
//   node skill/scripts/install-factory.mjs --into PATH [--force] [--dry-run]
//
// Mechanical on purpose. Everything this copies is the factory's own
// machinery — the runner, the role and pipeline workflows, the definition
// templates — which is identical for every repo. What is specific to a repo
// (the context files, the sandbox, the guardrail baselines) is written by the
// setup agent after this runs, by reading the repo.
//
// It never overwrites an existing file without --force: a repo that already
// has a .factory/ was set up before, and its definition is the user's.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, chmodSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skill = join(here, "..");
const repoRoot = join(skill, "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const into = arg("into");
const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");
if (into === undefined) {
  console.error("usage: install-factory.mjs --into PATH [--force] [--dry-run]");
  process.exit(2);
}
if (!existsSync(join(into, ".git"))) {
  console.error(`${into} is not a git checkout`);
  process.exit(2);
}

/** [source, destination-in-repo]. Directories are copied file by file. */
const PLAN = [
  [join(skill, "runner"), ".factory/bin"],
  [join(repoRoot, "templates/definition"), ".factory/definition"],
  [join(repoRoot, "templates/guardrails"), ".factory/guardrails"],
  [join(repoRoot, "templates/workflows"), ".github/workflows"],
  [join(repoRoot, "templates/compiled"), ".github/workflows"],
];

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

const written = [];
const kept = [];
for (const [src, dest] of PLAN) {
  if (!existsSync(src)) {
    console.error(`missing ${relative(repoRoot, src)}; build it first`);
    process.exit(1);
  }
  for (const file of files(src)) {
    const target = join(into, dest, relative(src, file));
    if (existsSync(target) && !force) {
      kept.push(relative(into, target));
      continue;
    }
    written.push(relative(into, target));
    if (dryRun) continue;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target);
  }
}
if (!dryRun) {
  for (const f of ["bsf"]) {
    const p = join(into, ".factory/bin", f);
    if (existsSync(p)) chmodSync(p, 0o755);
  }
}

console.log(`${dryRun ? "would write" : "wrote"} ${written.length} file(s) into ${into}`);
if (kept.length > 0) {
  console.log(`kept ${kept.length} existing file(s); pass --force to replace them:`);
  for (const k of kept.slice(0, 20)) console.log(`  ${k}`);
  if (kept.length > 20) console.log(`  … and ${kept.length - 20} more`);
}

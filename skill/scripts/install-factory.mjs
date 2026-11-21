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
// The runner and the factory-* workflows are the factory's own, so they are
// replaced whole on every install, upgrades included. Anything else that
// already exists — the definition, the context, the guardrails — is the
// user's, and is kept unless --force.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, chmodSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skill = join(here, "..");
const repoRoot = join(skill, "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Copy the factory's own files into a repository checkout.

  node skill/scripts/install-factory.mjs --into PATH [--force] [--dry-run]

The runner (.factory/bin) and the factory-* workflows are the factory's own:
they are replaced whole, and files the new version no longer ships are
removed. The definition, context and guardrails are the user's once written,
and are kept unless --force. Repo-specific content — the context files and the
sandbox — is written afterwards by the setup agent, by reading the repo.`);
  process.exit(0);
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
  // The rule packs setup installs from: each rule with the code it must fail
  // on and the code it must pass.
  [join(repoRoot, "rules"), ".factory/rules"],
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

/**
 * What the factory owns outright, and so replaces whole on an upgrade:
 * anything here that the new version no longer ships is removed, or an
 * upgrade would leave the old runner's JavaScript in the user's tree for
 * their tools to trip on. Everything else — the definition, the context
 * files, the guardrails — is the user's once written, and is never deleted.
 */
const OWNED = [
  { dir: ".factory/bin", match: () => true },
  { dir: ".factory/rules", match: (name) => /\.ya?ml$/.test(name) },
  { dir: ".github/workflows", match: (name) => /^factory-.*\.(md|ya?ml)$/.test(name) },
];

const shipped = new Set();
for (const [src, dest] of PLAN) {
  if (!existsSync(src)) continue;
  for (const file of files(src)) shipped.add(join(dest, relative(src, file)));
}

const removed = [];
for (const { dir, match } of OWNED) {
  const abs = join(into, dir);
  if (!existsSync(abs)) continue;
  for (const file of files(abs)) {
    const rel = relative(into, file);
    if (!match(relative(abs, file)) || shipped.has(rel)) continue;
    removed.push(rel);
    if (!dryRun) rmSync(file);
  }
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
    // Owned files always take the new version; the user's are kept unless --force.
    const owned = OWNED.some(({ dir, match }) => target.startsWith(join(into, dir) + "/") && match(relative(join(into, dir), target)));
    if (existsSync(target) && !force && !owned) {
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
if (removed.length > 0) {
  console.log(`${dryRun ? "would remove" : "removed"} ${removed.length} file(s) the factory no longer ships:`);
  for (const r of removed.slice(0, 20)) console.log(`  ${r}`);
}
if (kept.length > 0) {
  console.log(`kept ${kept.length} existing file(s); pass --force to replace them:`);
  for (const k of kept.slice(0, 20)) console.log(`  ${k}`);
  if (kept.length > 20) console.log(`  … and ${kept.length - 20} more`);
}

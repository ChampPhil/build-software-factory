#!/usr/bin/env node
// Copies the factory's files into a repository checkout.
//
//   node skill/scripts/install-factory.mjs --into PATH [--harness ID] [--force] [--dry-run]
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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, chmodSync, rmSync, writeFileSync } from "node:fs";
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

  node skill/scripts/install-factory.mjs --into PATH [--harness ID] [--force] [--dry-run]

--harness picks the agent CLI the role workflows are compiled for:
claude-code (the default) or cursor-cli. Without it, the harness already named
in the repo's .factory/definition/factory.yaml is kept.

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

/**
 * The harness: the flag, else what the repo's factory.yaml already says, else
 * Claude Code. gh-aw fixes the engine at compile time, so another harness
 * ships its own compiled set (templates/harness/<id>), laid over the default.
 */
function currentHarness() {
  const flag = arg("harness");
  if (flag !== undefined) return flag;
  const cfg = join(into, ".factory/definition/factory.yaml");
  if (!existsSync(cfg)) return "claude-code";
  const m = /^harness:\s*([\w-]+)/m.exec(readFileSync(cfg, "utf8"));
  return m === null ? "claude-code" : m[1];
}
const harness = currentHarness();
const harnessDir = join(repoRoot, "templates/harness", harness);
if (harness !== "claude-code" && !existsSync(join(harnessDir, "compiled"))) {
  console.error(`no compiled workflows for harness ${harness}; known: claude-code, ${readdirSync(join(repoRoot, "templates/harness")).join(", ")}`);
  process.exit(2);
}

/** [source, destination-in-repo]. Directories are copied file by file; later entries win. */
const PLAN = [
  [join(skill, "runner"), ".factory/bin"],
  [join(repoRoot, "templates/definition"), ".factory/definition"],
  [join(repoRoot, "templates/guardrails"), ".factory/guardrails"],
  // The rule packs setup installs from: each rule with the code it must fail
  // on and the code it must pass.
  [join(repoRoot, "rules"), ".factory/rules"],
  [join(repoRoot, "templates/workflows"), ".github/workflows"],
  [join(repoRoot, "templates/compiled"), ".github/workflows"],
  ...(harness === "claude-code"
    ? []
    : [
        [join(harnessDir, "workflows"), ".github/workflows"],
        [join(harnessDir, "compiled"), ".github/workflows"],
      ]),
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

// A harness named on the command line is recorded in factory.yaml, which is
// what the runner and the dashboard read it from.
const cfgPath = join(into, ".factory/definition/factory.yaml");
if (arg("harness") !== undefined && existsSync(cfgPath) && !dryRun) {
  const text = readFileSync(cfgPath, "utf8");
  const next = text.replace(/^harness:\s*[\w-]+/m, `harness: ${harness}`);
  if (next !== text) writeFileSync(cfgPath, next);
}

console.log(`${dryRun ? "would write" : "wrote"} ${written.length} file(s) into ${into} (harness: ${harness})`);
if (removed.length > 0) {
  console.log(`${dryRun ? "would remove" : "removed"} ${removed.length} file(s) the factory no longer ships:`);
  for (const r of removed.slice(0, 20)) console.log(`  ${r}`);
}
if (kept.length > 0) {
  console.log(`kept ${kept.length} existing file(s); pass --force to replace them:`);
  for (const k of kept.slice(0, 20)) console.log(`  ${k}`);
  if (kept.length > 20) console.log(`  … and ${kept.length - 20} more`);
}

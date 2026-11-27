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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, chmodSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

The factory runs its agents on Claude Code only: it is the one harness whose
spend gh-aw's per-step cap is proven to stop, and the budget is built on that
cap. A factory.yaml that names another harness is switched back to Claude Code.

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

/** [source, destination-in-repo]. Directories are copied file by file; later entries win. */
const PLAN = [
  [join(skill, "runner"), ".factory/bin"],
  [join(repoRoot, "templates/definition"), ".factory/definition"],
  [join(repoRoot, "templates/guardrails"), ".factory/guardrails"],
  // The rule packs setup installs from: each rule with the code it must fail
  // on and the code it must pass.
  [join(repoRoot, "rules"), ".factory/rules"],
  // The four request forms: a form field replaces the label a person would
  // otherwise have to know.
  [join(repoRoot, "templates/issue-forms"), ".github/ISSUE_TEMPLATE"],
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
// The runner upgrade path (docs/Architecture.md, "Upgrades open themselves"). The pin
// workflow and the Dependabot entry exist only for a published release: a pin
// has to name a commit that is on GitHub, and one that is not would fail every
// run. skill/RUNNER_PIN holds "<owner/repo> <40-hex sha> <version>" once a
// release has been cut (scripts/pin-release.mjs), and "unreleased" before.
const pinFile = arg("pin-file") ?? join(skill, "RUNNER_PIN");
const pinWorkflow = join(into, ".github/workflows/factory-runner-pin.yml");
const pinText = existsSync(pinFile) ? readFileSync(pinFile, "utf8").trim() : "unreleased";
const pin = /^([\w.-]+\/[\w.-]+) ([0-9a-f]{40}) (v\d+\.\d+\.\d+\S*)$/.exec(pinText);
if (pin === null) {
  if (!dryRun && existsSync(pinWorkflow)) rmSync(pinWorkflow);
  console.log(
    "no runner release is pinned yet (skill/RUNNER_PIN says \"unreleased\"), so the runner upgrade path " +
      "(factory-runner-pin.yml and a Dependabot entry) was not installed",
  );
} else if (!dryRun) {
  const [, repo, sha, version] = pin;
  const tmpl = readFileSync(join(repoRoot, "templates/runner-pin/factory-runner-pin.yml"), "utf8");
  mkdirSync(dirname(pinWorkflow), { recursive: true });
  writeFileSync(pinWorkflow, tmpl.replaceAll("__RUNNER_REPO__", repo).replaceAll("__RUNNER_SHA__", sha).replaceAll("__RUNNER_VERSION__", version));
  console.log(`pinned the runner at ${repo}@${sha.slice(0, 12)} (${version}) in ${relative(into, pinWorkflow)}`);
  console.log(addDependabotEntry(join(into, ".github/dependabot.yml"), repo));
}

/**
 * Dependabot's half: a github-actions entry limited to the runner, with a
 * cooldown so a bad or compromised release has time to be caught and pulled.
 * An existing file is added to and never rewritten: the entry is appended to
 * the end of `updates:`, and if `updates:` is not the last top-level key the
 * file is left alone and the person is told, because guessing where to put it
 * in someone else's configuration is worse than asking.
 */
function addDependabotEntry(path, repo) {
  const entry = [
    "  # Added by the factory: opens a pull request when a new runner release is",
    "  # published. Only the runner; your other dependencies are not touched.",
    "  - package-ecosystem: github-actions",
    "    directory: /",
    "    allow:",
    `      - dependency-name: "${repo}*"`,
    "    schedule:",
    "      interval: daily",
    "    cooldown:",
    "      default-days: 3",
    "    labels:",
    "      - factory-runner-upgrade",
    "    commit-message:",
    '      prefix: "Upgrade the factory runner"',
    "",
  ].join("\n");
  if (!existsSync(path)) {
    writeFileSync(path, `version: 2\nupdates:\n${entry}`);
    return "wrote .github/dependabot.yml";
  }
  const text = readFileSync(path, "utf8");
  if (text.includes(`"${repo}*"`)) return ".github/dependabot.yml already has the runner entry";
  const tops = text.split("\n").filter((l) => /^[A-Za-z_][\w-]*:/.test(l));
  if (tops.length === 0 || !tops[tops.length - 1].startsWith("updates:")) {
    return (
      "left .github/dependabot.yml alone: `updates:` is not its last section, so the entry has to be added by hand. " +
      "Copy the entry from templates/runner-pin/dependabot-entry.md in the factory's repository."
    );
  }
  writeFileSync(path, `${text.endsWith("\n") ? text : `${text}\n`}${entry}`);
  return "added the runner entry to the existing .github/dependabot.yml (the other entries are untouched)";
}

// The launcher has to be executable on GitHub's Linux runners, where every
// pipeline step calls it. `chmod` alone is not enough: on Windows the
// filesystem carries no execute bit for git to read, so git stages the file
// 100644 and the runner fails with exit 126 ("Permission denied") on a step
// that has nothing to do with the user's change. `git update-index --chmod=+x`
// sets the bit in the index itself, which is what gets committed, and is
// harmless where chmod already worked. Then it is verified, because a silent
// 100644 here is a setup failure three steps later.
if (!dryRun) {
  for (const f of ["bsf"]) {
    const p = join(into, ".factory/bin", f);
    if (!existsSync(p)) continue;
    chmodSync(p, 0o755);
    const tracked = `.factory/bin/${f}`;
    try {
      // Retried once: on Windows an antivirus scanner or the search indexer can
      // hold a file under .git/objects for a moment, and the first add fails
      // with "Permission denied" or "failed to insert into database".
      try {
        execFileSync("git", ["-C", into, "add", "--", tracked], { stdio: "pipe" });
      } catch {
        execFileSync("git", ["-C", into, "add", "--", tracked], { stdio: "pipe" });
      }
      execFileSync("git", ["-C", into, "update-index", "--chmod=+x", "--", tracked], { stdio: "pipe" });
    } catch (e) {
      console.error(`could not mark ${tracked} executable in the git index: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    const mode = execFileSync("git", ["-C", into, "ls-files", "-s", "--", tracked], { encoding: "utf8" }).trim().split(/\s+/)[0];
    if (mode !== "100755") {
      console.error(
        `${tracked} is staged as ${mode === undefined || mode === "" ? "untracked" : mode}, not 100755. ` +
          `The Linux runner would fail with exit 126 on it. Fix with:\n` +
          `  git -C ${into} update-index --chmod=+x -- ${tracked}`,
      );
      process.exit(1);
    }
    console.log(`${tracked} is executable in the index (100755)`);
  }
}

// Claude Code is the only harness the budget can stop (doc 07, §Agent CLI
// adapters). A factory.yaml left on another one, from an earlier version, is
// switched back, models included: Cursor's "auto" names no Claude model.
const cfgPath = join(into, ".factory/definition/factory.yaml");
if (existsSync(cfgPath) && !dryRun) {
  const text = readFileSync(cfgPath, "utf8");
  const was = /^harness:\s*([\w-]+)/m.exec(text)?.[1];
  if (was !== undefined && was !== "claude-code") {
    const next = text
      .replace(/^harness:\s*[\w-]+/m, "harness: claude-code")
      .replace(/^(  (triage|verifier|scorer): )(?!claude-)\S+$/gm, "$1claude-haiku-5-5")
      .replace(/^(  spec: )(?!claude-)\S+$/gm, "$1claude-opus-5-5")
      .replace(/^(  (builder|gardener|hardener): )(?!claude-)\S+$/gm, "$1claude-sonnet-5-5");
    writeFileSync(cfgPath, next);
    console.log(`switched the harness from ${was} to claude-code: only Claude Code's spend can be capped`);
  }
}

// The bootstrap PR's body, written here rather than composed by the agent.
//
// It used to be a description in the skill's prose — "end the body with this
// line, exactly" — and the agent wrote the rest freehand. On the first live
// install that produced a mangled link to assessment.md ("assetmnet", with
// stray slashes and a question mark) and an attribution whose link text had
// drifted from the one place it is defined. A body nobody types cannot be
// mistyped, and the attribution comes from `bsf attribution`, so adding a
// product to PRODUCTS reaches this PR too.
if (!dryRun) {
  const bodyPath = join(into, ".factory/bootstrap-pr.md");
  let attribution = "";
  try {
    attribution = execFileSync(join(into, ".factory/bin/bsf"), ["attribution"], { encoding: "utf8" }).trim();
  } catch {
    attribution = "";
  }
  const body = [
    "## The factory, installed but not running",
    "",
    "This adds the factory to the repository: the packed runner in `.factory/bin`,",
    "its definition and guardrails under `.factory/`, and the workflows that run it.",
    "Nothing runs until this is merged.",
    "",
    "**Merging this is the approval.** It touches protected paths, so no check can",
    "stand in for a person reading it.",
    "",
    "### What to look at",
    "",
    "- `assessment.md` — what the factory found in this repository, and what it",
    "  concluded. It is deleted when the setup PR merges, so read it here.",
    "- `.factory/definition/context/practices.md` — the product answers, in your",
    "  words. Everything the factory builds is judged against these.",
    "- `.factory/definition/policy.yaml` — what the factory may change, and what",
    "  is protected from it.",
    "",
    "### What happens when you merge",
    "",
    "`factory-setup` starts by itself and designs the sandbox: it reads the",
    "repository, brings up what it declares, measures how far verification can",
    "actually go, and opens a second pull request with the result. That one is the",
    "factory switching on.",
    "",
    attribution,
    "",
  ].join("\n");
  writeFileSync(bodyPath, body);
  console.log(`wrote the bootstrap PR body to ${relative(into, bodyPath)}`);
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

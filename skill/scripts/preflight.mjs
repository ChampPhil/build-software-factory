#!/usr/bin/env node
/**
 * Checks everything setup needs before it changes anything, and says exactly
 * what is missing rather than failing halfway through phase 3.
 *
 * Exits 0 when setup can proceed, 1 when something blocks it, 2 on a bad
 * invocation. Prints JSON with --json so the skill can read the findings.
 *
 * Usage: node preflight.mjs [--repo owner/name] [--json]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LANGUAGES = {
  typescript: { files: ["tsconfig.json"], ext: [".ts", ".tsx", ".mts", ".cts"] },
  javascript: { files: ["package.json"], ext: [".js", ".jsx", ".mjs", ".cjs"] },
  python: { files: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"], ext: [".py"] },
  go: { files: ["go.mod"], ext: [".go"] },
  java: { files: ["pom.xml", "build.gradle", "build.gradle.kts"], ext: [".java"] },
  rust: { files: ["Cargo.toml"], ext: [".rs"] },
  csharp: { files: [], ext: [".cs"] },
  ruby: { files: ["Gemfile"], ext: [".rb"] },
};

function parseArgs(argv) {
  const args = { json: false, skipDocker: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i];
    else if (a === "--json") args.json = true;
    // --skip-docker is accepted for old instructions; there is no Docker check.
    else if (a === "--skip-docker") args.skipDocker = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      process.stderr.write(`preflight: unknown argument ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function run(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

const checks = [];
function record(id, ok, detail, fix) {
  checks.push({ id, ok, detail, ...(fix === undefined ? {} : { fix }) });
}

/* --------------------------------------------------------------------- repo */

function checkGit() {
  const inside = run("git", ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") {
    record("git-repo", false, "not inside a git repository", "cd to the repo and run setup from there");
    return null;
  }
  const remote = run("git", ["remote", "get-url", "origin"]);
  if (remote === null) {
    record("git-repo", false, "no `origin` remote", "add a GitHub remote named origin");
    return null;
  }
  const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  if (m === null) {
    record("git-repo", false, `origin is not a GitHub remote: ${remote}`, "the factory runs on GitHub Actions, so the repo has to be on GitHub");
    return null;
  }
  const repo = `${m[1]}/${m[2]}`;
  record("git-repo", true, `GitHub repo ${repo}`);
  return repo;
}

function checkCleanTree() {
  const status = run("git", ["status", "--porcelain"]);
  if (status === null) {
    record("clean-tree", false, "could not read the working tree");
    return;
  }
  if (status !== "") {
    const n = status.split("\n").length;
    record(
      "clean-tree",
      false,
      `${n} uncommitted change(s)`,
      "commit or stash them — setup builds a branch from the current state, and a dirty tree makes the setup PR unreviewable",
    );
    return;
  }
  record("clean-tree", true, "working tree is clean");
}

function checkOnDefaultBranch(repo) {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) {
    record("default-branch", false, "could not read the current branch");
    return;
  }
  const remoteDefault =
    repo === null ? null : run("gh", ["api", `repos/${repo}`, "--jq", ".default_branch"]);
  if (remoteDefault === null) {
    record("default-branch", true, `on ${branch} (could not confirm the default branch)`);
    return;
  }
  if (branch !== remoteDefault) {
    record(
      "default-branch",
      false,
      `on ${branch}, but the default branch is ${remoteDefault}`,
      `git switch ${remoteDefault}`,
    );
    return;
  }
  record("default-branch", true, `on ${branch}, the default branch`);
}


/* --------------------------------------------------------------------- node */

/** The oldest Node the runner and these scripts are written against. */
const MIN_NODE_MAJOR = 20;

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    record(
      "node",
      false,
      `Node ${process.versions.node}; the runner needs ${MIN_NODE_MAJOR} or newer`,
      "install a current Node from https://nodejs.org, then run this again",
    );
    return;
  }
  record("node", true, `Node ${process.versions.node}`);
}

/* ------------------------------------------------------------------ browser */

/**
 * Creating the GitHub App needs a browser on *this* machine.
 *
 * GitHub's App Manifest flow redirects to localhost, so a browser on another
 * machine cannot complete it — and the private key arrives in that redirect,
 * which is why it works this way rather than through a hosted page. A headless
 * box therefore cannot finish phase 6, and finding that out at phase 6 is a
 * waste of the five phases before it.
 */
function checkBrowser() {
  if (process.platform === "darwin" || process.platform === "win32") {
    record("browser", true, `a desktop session on ${process.platform}`);
    return;
  }
  const display = process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY ?? "";
  if (display !== "") {
    record("browser", true, "a graphical session is available");
    return;
  }
  if (run("which", ["xdg-open"]) !== null) {
    record("browser", true, "xdg-open is present, so a browser can probably be opened");
    return;
  }
  record(
    "browser",
    false,
    "no graphical session found, and creating the GitHub App needs a browser on this machine",
    "run setup from a machine with a desktop, or finish just the App step there: GitHub's " +
      "manifest flow redirects to localhost, so the browser has to be the one on this computer",
  );
}

/* ----------------------------------------------------------------------- gh */

function checkGh(repo) {
  if (run("gh", ["--version"]) === null) {
    record("gh-cli", false, "the GitHub CLI is not installed", "install it from https://cli.github.com");
    return;
  }
  // `gh api user` rather than `gh auth status`: what matters is whether API
  // calls work, and in some setups the token comes from the environment and
  // `auth status` reports nothing.
  const login = run("gh", ["api", "user", "--jq", ".login"]);
  if (login === null) {
    record("gh-auth", false, "the GitHub CLI cannot reach the API", "gh auth login");
    return;
  }
  record("gh-auth", true, `signed in as ${login}`);

  if (repo === null) return;
  const perm = run("gh", ["api", `repos/${repo}`, "--jq", ".permissions.admin"]);
  if (perm === null) {
    record("repo-admin", false, `cannot read ${repo}`, "check the repo name and your access");
    return;
  }
  if (perm !== "true") {
    record(
      "repo-admin",
      false,
      "you are not an admin on this repo",
      "setup installs an App, sets secrets and adjusts protection, all of which need admin",
    );
    return;
  }
  record("repo-admin", true, "you have admin on this repo");
}

function checkPlanAndVisibility(repo) {
  if (repo === null) return null;
  const json = run("gh", ["api", `repos/${repo}`]);
  if (json === null) return null;
  let info;
  try {
    info = JSON.parse(json);
  } catch {
    return null;
  }
  const isPrivate = info.private === true;
  const plan = info.owner?.type === "Organization" ? "organization" : "user";
  // The plan name is only exposed on some tokens, so treat its absence as
  // unknown rather than as free.
  const planName = info.owner?.plan?.name ?? null;

  const enforcement =
    !isPrivate || (planName !== null && planName !== "free") ? "branch_protection" : "audit";

  record(
    "enforcement",
    true,
    enforcement === "branch_protection"
      ? `${isPrivate ? "private" : "public"} repo${planName === null ? "" : ` on ${planName}`}: branch protection, hard enforcement`
      : "private repo on Free: the audit fallback, since branch protection needs a paid plan",
  );

  if (!isPrivate) {
    record(
      "session-capture",
      true,
      "public repo: local session transcripts are only captured if you choose the private data repo in phase 6",
    );
  }

  return { private: isPrivate, plan, planName, enforcement };
}

/* ----------------------------------------------------------------- language */

function detectLanguages(root = process.cwd()) {
  const found = new Set();
  for (const [lang, spec] of Object.entries(LANGUAGES)) {
    for (const f of spec.files) {
      if (existsSync(join(root, f))) found.add(lang);
    }
  }
  // Extensions, over a bounded walk — enough to classify, not a full scan.
  const counts = {};
  walk(root, 0, counts);
  for (const [lang, spec] of Object.entries(LANGUAGES)) {
    for (const ext of spec.ext) {
      if ((counts[ext] ?? 0) > 0) found.add(lang);
    }
  }
  // package.json alone is javascript; with a tsconfig it is typescript.
  if (found.has("typescript")) found.delete("javascript");
  return [...found];
}

const SKIP = new Set([
  "node_modules", ".git", "dist", "build", "target", "vendor", ".venv", "venv",
  "__pycache__", ".next", "coverage", ".bsf-rule-check",
]);

function walk(dir, depth, counts, budget = { files: 4000 }) {
  if (depth > 4 || budget.files <= 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.files <= 0) return;
    if (e.name.startsWith(".") && e.name !== ".github") {
      if (SKIP.has(e.name)) continue;
    }
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, depth + 1, counts, budget);
    } else if (e.isFile()) {
      budget.files--;
      const dot = e.name.lastIndexOf(".");
      if (dot > 0) {
        const ext = e.name.slice(dot);
        counts[ext] = (counts[ext] ?? 0) + 1;
      }
    }
  }
}

function checkLanguage() {
  const langs = detectLanguages();
  if (langs.length === 0) {
    record(
      "language",
      false,
      "no supported language detected",
      "supported: TypeScript, JavaScript, Python, Go, Java, Rust, C#, Ruby",
    );
    return [];
  }
  record("language", true, `detected: ${langs.join(", ")}`);
  return langs;
}

/* ------------------------------------------------------- existing factory */

function checkExistingFactory() {
  const marker = join(process.cwd(), ".factory", "definition", "factory.yaml");
  if (existsSync(marker) && statSync(marker).isFile()) {
    record("existing-factory", true, "this repo already has a factory — switch to update mode");
    return true;
  }
  record("existing-factory", true, "no existing factory; this is a first install");
  return false;
}

/* --------------------------------------------------------------------- main */

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`
Check everything setup needs before it changes anything.

  --repo owner/name   Override the repo detected from the origin remote
  --json              Print the findings as JSON
`);
  process.exit(0);
}

const repo = args.repo ?? checkGit();
checkNode();
checkBrowser();
checkCleanTree();
checkOnDefaultBranch(repo ?? null);
checkGh(repo ?? null);
const plan = checkPlanAndVisibility(repo ?? null);
const languages = checkLanguage();
const existing = checkExistingFactory();

const blocking = checks.filter((c) => !c.ok);

if (args.json) {
  process.stdout.write(
    `${JSON.stringify({ repo: repo ?? null, languages, plan, existingFactory: existing, checks, ok: blocking.length === 0 }, null, 2)}\n`,
  );
} else {
  process.stdout.write("\nPreflight\n\n");
  for (const c of checks) {
    process.stdout.write(`  ${(c.ok ? "ok" : "BLOCK").padEnd(5)}  ${c.id.padEnd(18)} ${c.detail}\n`);
    if (!c.ok && c.fix !== undefined) process.stdout.write(`${" ".repeat(27)}→ ${c.fix}\n`);
  }
  process.stdout.write(
    blocking.length === 0
      ? "\nSetup can proceed.\n\n"
      : `\n${blocking.length} thing(s) to fix before setup can start.\n\n`,
  );
}

process.exit(blocking.length === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * The one screen, on the person's machine, before any setup cloud job.
 *
 * Purpose:
 *     Find every configuration name the code reads, compare it with the
 *     local env files, and save those files as the GitHub secret
 *     FACTORY_SANDBOX_ENV. It never prints a value. A name that is not in
 *     the files is printed as a name, with the file and line it came from.
 *
 * Key terms:
 *     - Development: every local value is for development. The screen marks
 *       nothing to fake and does not ask. A name that is still missing
 *       blocks the cloud job.
 *     - Use it: the value is already in a local env file, and the whole
 *       file is saved into the secret.
 *     - Ignore this key: the name is not an app setting. That choice is
 *       remembered by `bsf env apply`, not by this script's printout.
 *
 * Non-obvious behavior:
 *     - Example files are not uploaded. They are names the scan reads.
 *       A value lives only in .env, .env.local, .env.development, or
 *       .env.development.local.
 *     - The secret is written from a pipe. The value is not a command
 *       argument, so it does not show up in the process list.
 *
 *     node env-screen.mjs --development --repo owner/name
 *
 * Exits 0 when every name is covered. Exits 2 when names are still waiting.
 * Exits 1 when the secret could not be saved.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "out", "vendor", "target", ".next", ".factory", "coverage", "__pycache__", ".venv", "venv"]);
const ENV_NAMES = new Set([".env", ".env.local", ".env.development", ".env.development.local"]);

/**
 * The runner next to this skill. Windows uses the cmd launcher.
 *
 * Returns the path of the bsf program.
 */
function runnerPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  const name = process.platform === "win32" ? "bsf.cmd" : "bsf";
  return join(here, "..", "runner", name);
}

/**
 * Env files the app loads for local development, shallowest first.
 *
 * root: the checkout. A dependency directory is not walked.
 * Returns the file paths. Example files are not included.
 */
function envFiles(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIR.has(name) || name.startsWith(".")) {
        if (!ENV_NAMES.has(name)) continue;
      }
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIR.has(name) && !name.startsWith(".")) walk(path, depth + 1);
        continue;
      }
      if (ENV_NAMES.has(name)) found.push(path);
    }
  };
  walk(root, 0);
  return found.sort();
}

/**
 * The names in one env file. The values are dropped.
 *
 * text: the file. A line that is not KEY=value is skipped.
 * Returns the names.
 */
function keysOf(text) {
  const keys = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    keys.push(trimmed.slice(0, eq).trim());
  }
  return keys;
}

/**
 * Run bsf and keep its text. The text is names, not values.
 *
 * args: the bsf arguments.
 * Returns the status and the text it wrote.
 */
function bsf(args) {
  const run = spawnSync(runnerPath(), args, {
    encoding: "utf8",
    // Windows only runs the .cmd launcher through a shell. The arguments stay
    // a list, and the output is names, never values.
    shell: process.platform === "win32",
  });
  return { status: run.status ?? 1, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: node env-screen.mjs --development --repo owner/name\nSaves the local env files as FACTORY_SANDBOX_ENV. Prints names only.");
  process.exit(0);
}
const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const development = argv.includes("--development");
const root = at("--root") ?? process.cwd();
let repo = at("--repo");
if (repo === undefined) {
  const viewed = spawnSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { encoding: "utf8" });
  repo = (viewed.stdout ?? "").trim();
}

const files = envFiles(root);
const dir = mkdtempSync(join(tmpdir(), "bsf-env-"));
const namesFile = join(dir, "names.txt");
const keyLines = [];
for (const file of files) {
  for (const key of keysOf(readFileSync(file, "utf8"))) {
    if (!keyLines.includes(key)) keyLines.push(key);
  }
}
writeFileSync(namesFile, `${keyLines.join("\n")}\n`);

const scan = bsf(["env", "scan", "--root", root, "--names-file", namesFile]);
if (scan.status === 0 || development) {
  const merged = files.map((file) => readFileSync(file, "utf8")).join("\n");
  if (repo !== undefined && repo !== "" && files.length > 0) {
    const set = spawnSync("gh", ["secret", "set", "FACTORY_SANDBOX_ENV", "--repo", repo], {
      input: merged,
      encoding: "utf8",
    });
    if (set.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      console.error("The development environment could not be saved on GitHub.");
      process.exit(1);
    }
  }
}
rmSync(dir, { recursive: true, force: true });

if (scan.status === 0) {
  console.log("Every setting the code reads is in the development environment.");
  process.exit(0);
}
console.log("These settings have no decision yet. A value is not shown.");
for (const line of scan.out.split(/\r?\n/)) {
  if (line.trim() !== "") console.log(line);
}
process.exit(2);

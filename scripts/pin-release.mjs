#!/usr/bin/env node
// Cut the runner pin for a release.
//
//   node scripts/pin-release.mjs v0.1.0
//
// Run after tagging the release commit and pushing the tag. Writes
// skill/RUNNER_PIN as "<owner/repo> <sha of the tag's commit> <tag>", which is
// what the installer pins in every user's factory-runner-pin.yml and what
// Dependabot then keeps current. The pin has to name a commit that is on GitHub
// and that holds the packed runner a user would install, so this refuses a tag
// whose skill/runner differs from the working tree's: the skill would install
// one runner and pin another.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const tag = process.argv[2];
if (tag === undefined || !/^v\d+\.\d+\.\d+\S*$/.test(tag)) {
  console.error("usage: node scripts/pin-release.mjs vX.Y.Z   (the tag must already exist)");
  process.exit(2);
}
const sha = git("rev-list", "-n1", tag);
const remote = git("remote", "get-url", "origin").replace(/\.git$/, "");
const repo = /github\.com[:/]([\w.-]+\/[\w.-]+)$/.exec(remote)?.[1];
if (repo === undefined) {
  console.error(`cannot read owner/repo from the origin remote: ${remote}`);
  process.exit(1);
}
for (const f of ["runner/action.yml", "skill/runner/VERSION", "skill/runner/runner.tgz"]) {
  try {
    git("cat-file", "-e", `${sha}:${f}`);
  } catch {
    console.error(`${tag} (${sha.slice(0, 12)}) has no ${f}`);
    process.exit(1);
  }
}
const tagged = git("show", `${sha}:skill/runner/VERSION`);
const here = readFileSync(join(root, "skill/runner/VERSION"), "utf8").trim();
if (tagged.split("\n")[0] !== here.split("\n")[0]) {
  console.error(`${tag} ships runner "${tagged.split("\n")[0]}" but the working tree has "${here.split("\n")[0]}"; rebuild or check out the tag`);
  process.exit(1);
}
writeFileSync(join(root, "skill/RUNNER_PIN"), `${repo} ${sha} ${tag}\n`);
console.log(`skill/RUNNER_PIN: ${repo} ${sha} ${tag}`);

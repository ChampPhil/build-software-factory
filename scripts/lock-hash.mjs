#!/usr/bin/env node
/**
 * lock-hash.mjs — keep each compiled role's recorded hashes in step with its prompt.
 *
 * WHAT THIS IS FOR
 *
 * Every role the factory runs is written as a markdown file in
 * `templates/workflows/` (for example `factory-setup-agent.md`). gh-aw, the
 * compiler, turns each one into a "lock file" in `templates/compiled/`
 * (`factory-setup-agent.lock.yml`). The first line of a lock file is a comment
 * that records two fingerprints of the markdown it was compiled from:
 *
 *   - `frontmatter_hash`: a fingerprint of the settings block between the two
 *     `---` lines at the top of the markdown file (the "frontmatter").
 *   - `body_hash`: a fingerprint of everything below that block (the "body",
 *     which is the prompt the agent reads).
 *
 * At run time gh-aw compares both fingerprints with the markdown file and
 * refuses to start the role when either one differs.
 *
 * The body is read at run time and is not copied into the lock file, so a
 * change to the prompt alone needs only a new `body_hash`. Until now that was
 * a pasted one-off command each time, and a forgotten one shipped a role that
 * would not start. This script is that command, written down once.
 *
 * A change to the frontmatter is different: the lock file's contents depend
 * on it, so the compiler has to run. This script never rewrites
 * `frontmatter_hash`. It reports the mismatch and says where the compiled
 * file comes from (the `ghaw-compiled` artifact of the pull request's
 * `gh-aw compile` run).
 *
 * HOW TO USE IT
 *
 *   node scripts/lock-hash.mjs            Check. Exit 1 and list what is stale.
 *   node scripts/lock-hash.mjs --write    Rewrite every stale `body_hash`.
 *
 * Both walk the same two pairs of folders: the role templates and their
 * compiled locks, and the live tests and theirs. `--root PATH` checks a copy
 * of the repository somewhere else instead of this one.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The tree to check. `--root PATH` points it at a copy, which the tests use. */
const ROOT = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : HERE;
const require_ = createRequire(import.meta.url);
/** gh-aw's own hashing code, vendored so the numbers match the compiler's. */
const hashes = require_(join(HERE, "runner/vendor/gh-aw/frontmatter_hash_pure.cjs"));

/** Each folder of markdown sources and the folder that holds its lock files. */
const PAIRS = [
  { sources: "templates/workflows", locks: "templates/compiled" },
  { sources: "tests/live/workflows", locks: "tests/live/compiled" },
];

/**
 * Compare one markdown source with its lock file.
 *
 * source: absolute path of the `.md` file.
 * lock: absolute path of its `.lock.yml` file.
 * Returns the recorded and the computed value of both fingerprints.
 */
async function compare(source, lock) {
  const text = readFileSync(lock, "utf8");
  return {
    text,
    body: { recorded: hashes.extractBodyHashFromLockFile(text), computed: await hashes.computeBodyHash(source, {}) },
    frontmatter: {
      recorded: hashes.extractHashFromLockFile(text),
      computed: await hashes.computeFrontmatterHash(source, {}),
    },
  };
}

/**
 * Check every pair, and rewrite stale body hashes when asked.
 *
 * write: true to rewrite `body_hash` in place, false to only report.
 * Returns the process exit code: 0 when nothing is left stale, 1 otherwise.
 */
async function main(write) {
  const problems = [];
  let checked = 0;
  for (const pair of PAIRS) {
    const dir = join(ROOT, pair.sources);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
      const lockName = file.replace(/\.md$/, ".lock.yml");
      const lock = join(ROOT, pair.locks, lockName);
      const shown = `${pair.locks}/${lockName}`;
      if (!existsSync(lock)) {
        problems.push(`${shown}: missing. ${pair.sources}/${file} has never been compiled.`);
        continue;
      }
      checked += 1;
      const got = await compare(join(dir, file), lock);
      if (got.frontmatter.recorded !== got.frontmatter.computed) {
        problems.push(
          `${shown}: the settings block of ${file} changed, so the role has to be recompiled. ` +
            "Take the lock file from the ghaw-compiled artifact of this pull request's gh-aw compile run.",
        );
        continue;
      }
      if (got.body.recorded === got.body.computed) continue;
      if (!write) {
        problems.push(`${shown}: the prompt in ${file} changed. Run: node scripts/lock-hash.mjs --write`);
        continue;
      }
      if (got.body.recorded === "" || !got.text.includes(`"body_hash":"${got.body.recorded}"`)) {
        problems.push(`${shown}: no body_hash on its first line to rewrite. Recompile it.`);
        continue;
      }
      writeFileSync(
        lock,
        got.text.replace(`"body_hash":"${got.body.recorded}"`, `"body_hash":"${got.body.computed}"`),
      );
      process.stdout.write(`${shown}: body_hash is now ${got.body.computed}\n`);
    }
  }
  for (const p of problems) process.stderr.write(`${p}\n`);
  if (problems.length === 0) process.stdout.write(`${checked} lock file(s) match their prompts\n`);
  return problems.length === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.includes("--write"));

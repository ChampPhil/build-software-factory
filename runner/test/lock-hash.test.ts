/**
 * lock-hash.test.ts — the compiled roles record the prompts they were compiled from.
 *
 * WHAT IS BEING TESTED
 *
 * Each role is a markdown file in `templates/workflows/`. Its compiled form,
 * a "lock file" in `templates/compiled/`, records a fingerprint of the prompt
 * (`body_hash`). gh-aw refuses to start a role whose prompt no longer matches
 * that fingerprint. `scripts/lock-hash.mjs` checks the fingerprints and, with
 * `--write`, rewrites a stale one.
 *
 * Two things are checked here:
 *
 *   1. The repository as committed is in step, so a prompt edit that forgot
 *      the fingerprint fails in CI instead of in a user's repository.
 *   2. The script itself: on a copy with an edited prompt it reports the file,
 *      `--write` repairs it, and an edited settings block is reported as
 *      needing the compiler instead of being papered over.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts/lock-hash.mjs");
const ROLE = "factory-role-triage";

/**
 * Run the script and keep what it printed.
 *
 * args: the flags to pass after the script path.
 */
function run(args: string[]): { code: number; out: string } {
  const done = spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  return { code: done.status ?? 1, out: `${done.stdout}${done.stderr}` };
}

/** A temporary tree holding one role and its lock file, copied from this repository. */
function copyOfOneRole(): string {
  const dir = mkdtempSync(join(tmpdir(), "bsf-lock-hash-"));
  mkdirSync(join(dir, "templates/workflows"), { recursive: true });
  mkdirSync(join(dir, "templates/compiled"), { recursive: true });
  cpSync(join(ROOT, `templates/workflows/${ROLE}.md`), join(dir, `templates/workflows/${ROLE}.md`));
  cpSync(join(ROOT, `templates/compiled/${ROLE}.lock.yml`), join(dir, `templates/compiled/${ROLE}.lock.yml`));
  return dir;
}

describe("the compiled roles match their prompts", () => {
  it("every lock file in this repository is in step", () => {
    const done = run([]);
    expect(done.out).toContain("match their prompts");
    expect(done.code).toBe(0);
  });

  it("reports an edited prompt, and --write repairs it", () => {
    const dir = copyOfOneRole();
    const md = join(dir, `templates/workflows/${ROLE}.md`);
    writeFileSync(md, `${readFileSync(md, "utf8")}\nOne more sentence in the prompt.\n`);

    const stale = run(["--root", dir]);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain(`${ROLE}.lock.yml: the prompt in ${ROLE}.md changed`);

    const lock = join(dir, `templates/compiled/${ROLE}.lock.yml`);
    const before = readFileSync(lock, "utf8");
    expect(run(["--root", dir, "--write"]).code).toBe(0);
    const after = readFileSync(lock, "utf8");
    // Only the fingerprint moved: one line differs and nothing else.
    const changed = after.split("\n").filter((line, i) => line !== before.split("\n")[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain("body_hash");
    expect(run(["--root", dir]).code).toBe(0);
  });

  it("says an edited settings block needs the compiler, and does not rewrite it", () => {
    const dir = copyOfOneRole();
    const md = join(dir, `templates/workflows/${ROLE}.md`);
    writeFileSync(md, readFileSync(md, "utf8").replace(/^---\n/, "---\ntimeout-minutes: 999\n"));
    const lock = join(dir, `templates/compiled/${ROLE}.lock.yml`);
    const before = readFileSync(lock, "utf8");

    const done = run(["--root", dir, "--write"]);
    expect(done.code).toBe(1);
    expect(done.out).toContain("has to be recompiled");
    expect(readFileSync(lock, "utf8")).toBe(before);
  });

  it("reports a role that has no lock file", () => {
    const dir = copyOfOneRole();
    writeFileSync(join(dir, "templates/workflows/factory-role-new.md"), "---\non: push\n---\nA prompt.\n");
    const done = run(["--root", dir]);
    expect(done.code).toBe(1);
    expect(done.out).toContain("factory-role-new.lock.yml: missing");
  });
});

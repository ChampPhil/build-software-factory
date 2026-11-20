import { describe, it, expect, beforeAll } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { staleLockFiles } from "../src/commands/audit.js";

/**
 * The staleness check is only worth anything if it agrees with gh-aw's own
 * compiler. So it is tested against a real gh-aw workflow and its real lock
 * file, vendored into the fixtures: unchanged must be clean, and an edit to
 * either half must be caught.
 */

function fixtureDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "fixtures/ghaw-lock");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("test/fixtures/ghaw-lock not found");
}

describe("staleLockFiles", () => {
  let root: string;
  let md: string;
  let original: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "audit-"));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    cpSync(fixtureDir(), join(root, ".github/workflows"), { recursive: true });
    md = join(root, ".github/workflows/factory-role-probe.md");
    original = readFileSync(md, "utf8");
  });

  it("the fixture really is a matched pair, so a clean result means something", () => {
    const files = readdirSync(join(root, ".github/workflows"));
    expect(files).toContain("factory-role-probe.md");
    expect(files).toContain("factory-role-probe.lock.yml");
    expect(readFileSync(join(root, ".github/workflows/factory-role-probe.lock.yml"), "utf8"))
      .toContain("gh-aw-metadata");
  });

  it("reports nothing for an unmodified pair", async () => {
    writeFileSync(md, original);
    expect(await staleLockFiles(root, ".github/workflows")).toHaveLength(0);
  });

  it("catches an edit to the prompt, which is the body half", async () => {
    writeFileSync(md, `${original}\nOne extra instruction the compiler never saw.\n`);
    const findings = await staleLockFiles(root, ".github/workflows");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("lock_file_stale");
    expect(findings[0]?.detail).toContain("body");
  });

  it("catches an edit to the frontmatter, which is the configuration half", async () => {
    writeFileSync(md, original.replace(/^---\n/, "---\ntimeout-minutes: 45\n"));
    const findings = await staleLockFiles(root, ".github/workflows");
    expect(findings[0]?.detail).toContain("frontmatter");
  });

  it("reports a source that has never been compiled", async () => {
    writeFileSync(md, original);
    const lock = join(root, ".github/workflows/factory-role-probe.lock.yml");
    const keep = readFileSync(lock, "utf8");
    rmSync(lock);
    const findings = await staleLockFiles(root, ".github/workflows");
    expect(findings[0]?.kind).toBe("lock_file_missing");
    writeFileSync(lock, keep);
  });

  it("does not use timestamps, which a fresh clone would make useless", async () => {
    // Touching the source without changing it must stay clean: git does not
    // preserve mtimes, so an mtime check would cry stale on every checkout.
    writeFileSync(md, original);
    expect(await staleLockFiles(root, ".github/workflows")).toHaveLength(0);
  });
});

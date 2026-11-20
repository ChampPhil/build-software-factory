import { describe, it, expect, beforeAll } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { staleLockFiles, runAuditCommand } from "../src/commands/audit.js";
import type { GitHub as GitHubLike } from "../src/lib/github.js";

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

describe("the App-rename check", () => {
  const gh = (slug: string | null): GitHubLike =>
    ({
      repo: "owner/repo",
      get: async (path: string) => {
        if (path === "app") {
          if (slug === null) throw new Error("not the App");
          return { slug };
        }
        if (path.includes("/check-runs")) return { check_runs: [] };
        if (path.includes("/commits/")) return { parents: [], commit: { message: "x" } };
        if (path.startsWith("search/issues")) return { total_count: 1, items: [{ number: 1 }] };
        throw new Error(`unexpected ${path}`);
      },
    }) as unknown as GitHubLike;

  it("says nothing when the configured login matches the App", async () => {
    const r = await runAuditCommand({
      gh: gh("factory-bsf"),
      commit: "abc1234",
      root: "/nonexistent",
      configuredAppLogins: ["factory-bsf[bot]"],
    });
    expect(r.findings.filter((f) => f.kind === "app_login_stale")).toHaveLength(0);
  });

  it("reports a rename, because the slug changes with the name", async () => {
    // Renaming the App in GitHub's settings changes its slug and therefore
    // its login. Nothing breaks loudly — the [bot] suffix check still stops
    // an App approval counting as a human's — but an App's request for
    // changes stops being read as a gate signal.
    const r = await runAuditCommand({
      gh: gh("build-software-factory-bsf-fixtures"),
      commit: "abc1234",
      root: "/nonexistent",
      configuredAppLogins: ["factory-bsf[bot]"],
    });
    const f = r.findings.find((x) => x.kind === "app_login_stale");
    expect(f?.detail).toContain("build-software-factory-bsf-fixtures[bot]");
    expect(f?.detail).toContain("Renaming a GitHub App changes its slug");
  });

  it("reports an unset variable rather than assuming it is fine", async () => {
    const r = await runAuditCommand({
      gh: gh("factory-bsf"),
      commit: "abc1234",
      root: "/nonexistent",
      configuredAppLogins: [],
    });
    expect(r.findings.find((x) => x.kind === "app_login_stale")?.detail).toContain(
      "FACTORY_APP_LOGINS was not passed to this step",
    );
  });

  it("says nothing when running as a user, where there is no App to ask about", async () => {
    const r = await runAuditCommand({
      gh: gh(null),
      commit: "abc1234",
      root: "/nonexistent",
      configuredAppLogins: ["factory-bsf[bot]"],
    });
    expect(r.findings.filter((f) => f.kind === "app_login_stale")).toHaveLength(0);
  });
});

describe("a lock file with no gh-aw metadata", () => {
  it("is named as uncompiled-by-an-older-gh-aw, not reported as drift", async () => {
    // The extractor returns "" rather than null for a lock file with no
    // metadata comment, so a null-only check fell through to the hash
    // comparison. Both verdicts are "do not trust this lock file", but only
    // one of them tells the user why.
    const dir = mkdtempSync(join(tmpdir(), "bsf-lock-"));
    const wf = join(dir, ".github/workflows");
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, "factory-role-spec.md"), "---\non: issues\n---\n\nA prompt.\n");
    writeFileSync(join(wf, "factory-role-spec.lock.yml"), "name: x\non: {}\njobs: {}\n");
    const findings = await staleLockFiles(dir, ".github/workflows");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("no gh-aw-metadata hashes");
    rmSync(dir, { recursive: true, force: true });
  });
});

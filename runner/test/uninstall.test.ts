import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  factoryPaths, checksToDrop, formatPlan, removeLocalFactory, removeLocalFactoryBranches,
  isFactoryIssueForm, isFactoryBranchName, isFactoryTrackingName, stripFactoryDependabot, dataRepoFromFactoryYaml,
  type UninstallPlan, type InstallRecord,
} from "../src/commands/uninstall.js";

/**
 * Nobody installs something into their repository that they cannot get out
 * again, and "how do I remove this?" is the first question a careful
 * developer asks. The shape that matters: uninstall takes the machinery out
 * and leaves everything the factory built, because the merged pull requests,
 * the commits and the run history are the repository's, not the factory's.
 */

const record = (over: Partial<InstallRecord> = {}): InstallRecord => ({
  schema: "install-record/1",
  branch_protection_existed: false,
  added_checks: ["factory/gates", "factory/policy"],
  created_labels: [],
  recorded_at: "2026-11-24T00:00:00Z",
  ...over,
});

describe("what uninstall removes", () => {
  it("takes the machinery and leaves the work", () => {
    const files = factoryPaths([
      ".factory/bin/bsf",
      ".factory/definition/factory.yaml",
      ".github/workflows/factory-run.lock.yml",
      ".github/workflows/factory-intake.lock.yml",
      // A form is not removed by filename. The repository may already have had one.
      ".github/ISSUE_TEMPLATE/bug.yml",
      "src/index.js",
      ".github/workflows/ci.yml",
      "docs/how-we-work.md",
    ]);
    expect(files).toEqual([
      ".factory/bin/bsf",
      ".factory/definition/factory.yaml",
      ".github/workflows/factory-run.lock.yml",
      ".github/workflows/factory-intake.lock.yml",
    ]);
  });

  it("never touches a workflow that merely starts with the same letters", () => {
    expect(factoryPaths([".github/workflows/factorial-build.yml"])).toEqual([]);
  });
});

describe("the pieces setup added under ordinary names", () => {
  const forms = join(dirname(fileURLToPath(import.meta.url)), "../../templates/issue-forms");

  it("recognises the forms setup copies, and leaves a form the repository already had", () => {
    const feature = readFileSync(join(forms, "feature.yml"), "utf8");
    const bug = readFileSync(join(forms, "bug.yml"), "utf8");
    const harden = readFileSync(join(forms, "harden.yml"), "utf8");
    const tidy = readFileSync(join(forms, "tidy.yml"), "utf8");
    expect(isFactoryIssueForm(".github/ISSUE_TEMPLATE/feature.yml", feature)).toBe(true);
    expect(isFactoryIssueForm(".github/ISSUE_TEMPLATE/bug.yml", bug)).toBe(true);
    expect(isFactoryIssueForm(".github/ISSUE_TEMPLATE/harden.yml", harden)).toBe(true);
    expect(isFactoryIssueForm(".github/ISSUE_TEMPLATE/tidy.yml", tidy)).toBe(true);
    expect(isFactoryIssueForm(".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: true\n")).toBe(true);
    expect(isFactoryIssueForm(".github/ISSUE_TEMPLATE/bug.yml", "name: Bug\ndescription: Something our customers reported.\n")).toBe(false);
    expect(isFactoryIssueForm(".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: false\n")).toBe(false);
  });

  it("drops the runner entry and keeps the repository's other Dependabot entries", () => {
    const own = [
      "version: 2",
      "updates:",
      "  - package-ecosystem: npm",
      "    directory: /",
      "    schedule:",
      "      interval: weekly",
      "  # Added by the factory: opens a pull request when a new runner release is",
      "  # published. Only the runner; your other dependencies are not touched.",
      "  - package-ecosystem: github-actions",
      "    directory: /",
      "    labels:",
      "      - factory-runner-upgrade",
      '    commit-message:',
      '      prefix: "Upgrade the factory runner"',
      "",
    ].join("\n");
    const stripped = stripFactoryDependabot(own);
    expect(stripped.removed).toBe(true);
    expect(stripped.text).toContain("package-ecosystem: npm");
    expect(stripped.text).not.toContain("factory-runner-upgrade");
    expect(stripped.text).not.toContain("Added by the factory");
  });

  it("deletes a Dependabot file that only existed to track the runner", () => {
    const only = [
      "version: 2",
      "updates:",
      "  # Added by the factory: opens a pull request when a new runner release is",
      "  # published. Only the runner; your other dependencies are not touched.",
      "  - package-ecosystem: github-actions",
      '    commit-message:',
      '      prefix: "Upgrade the factory runner"',
      "",
    ].join("\n");
    expect(stripFactoryDependabot(only)).toEqual({ text: "", removed: true });
    expect(stripFactoryDependabot("version: 2\nupdates:\n  - package-ecosystem: npm\n")).toEqual({
      text: "version: 2\nupdates:\n  - package-ecosystem: npm\n",
      removed: false,
    });
  });

  it("reads the private data repository from factory.yaml", () => {
    expect(dataRepoFromFactoryYaml("data:\n  location: same_repo\n  repo: null\n")).toBe(null);
    expect(dataRepoFromFactoryYaml("data:\n  location: repo\n  repo: owner/factory-data\n")).toBe("owner/factory-data");
  });
});

describe("factory branches on this computer", () => {
  it("names a factory branch and a bookmark, and skips everything else", () => {
    expect(isFactoryBranchName("factory/setup")).toBe(true);
    expect(isFactoryBranchName("factory/fix-login")).toBe(true);
    expect(isFactoryBranchName("main")).toBe(false);
    expect(isFactoryBranchName("factory")).toBe(false);
    expect(isFactoryTrackingName("origin/factory/setup")).toBe(true);
    expect(isFactoryTrackingName("origin/main")).toBe(false);
  });

  it("deletes local factory branches and bookmarks, and leaves the one checked out", () => {
    const root = mkdtempSync(join(tmpdir(), "bsf-branches-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "--quiet", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(root, "README.md"), "keep\n");
    git("add", "README.md");
    git("commit", "--quiet", "-m", "init");
    git("branch", "factory/setup");
    git("branch", "factory/fix-login");
    git("update-ref", "refs/remotes/origin/factory/setup", "HEAD");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-b", "factory/uninstall");

    const removed = removeLocalFactoryBranches(root);
    expect(removed.deletedLocal).toEqual(["factory/fix-login", "factory/setup"]);
    expect(removed.deletedTracking).toEqual(["origin/factory/setup"]);
    expect(removed.keptCurrent).toBe("factory/uninstall");
    const left = execFileSync("git", ["-C", root, "branch"], { encoding: "utf8" });
    expect(left).toContain("factory/uninstall");
    expect(left).toContain("main");
    expect(left).not.toContain("factory/setup");
    expect(left).not.toContain("factory/fix-login");
    const bookmarks = execFileSync("git", ["-C", root, "branch", "-r"], { encoding: "utf8" });
    expect(bookmarks).toContain("origin/main");
    expect(bookmarks).not.toContain("origin/factory/setup");

    rmSync(root, { recursive: true, force: true });
  });
});

describe("the folder on this computer", () => {
  it("deletes .factory/, including files that were never committed", () => {
    const root = mkdtempSync(join(tmpdir(), "bsf-uninstall-"));
    mkdirSync(join(root, ".factory", "bin"), { recursive: true });
    mkdirSync(join(root, ".factory", "sandbox"), { recursive: true });
    writeFileSync(join(root, ".factory", "bin", "bsf"), "launcher");
    writeFileSync(join(root, ".factory", ".setup-state.json"), "{}");
    writeFileSync(join(root, ".factory", "sandbox", "local.json"), "{}");
    writeFileSync(join(root, "README.md"), "keep");

    expect(removeLocalFactory(root)).toBe(join(root, ".factory"));
    expect(existsSync(join(root, ".factory"))).toBe(false);
    expect(existsSync(join(root, "README.md"))).toBe(true);
    expect(removeLocalFactory(root)).toBe(null);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("branch protection", () => {
  it("removes only the checks the factory added", () => {
    // A check somebody else added is theirs. sync-settings only ever adds, so
    // whatever the factory put there is identified by name and nothing else
    // is disturbed.
    const drop = checksToDrop(record(), ["build", "factory/gates", "factory/policy", "lint"]);
    expect(drop).toEqual(["factory/gates", "factory/policy"]);
  });

  it("falls back to the known names when there is no install record", () => {
    expect(checksToDrop(null, ["factory/gates", "build"])).toEqual(["factory/gates"]);
  });

  it("leaves a check the record does not claim", () => {
    const drop = checksToDrop(record({ added_checks: ["factory/gates"] }), ["factory/gates", "factory/policy"]);
    expect(drop).toEqual(["factory/gates"]);
  });
});

describe("what it says to the person", () => {
  const plan = (over: Partial<UninstallPlan> = {}): UninstallPlan => ({
    files: [".factory/bin/bsf"],
    labels: ["factory:accept"],
    checksToDrop: ["factory/gates"],
    dropProtectionEntirely: false,
    dataRef: "kept",
    appInstallationId: 42,
    appSettingsUrl: "https://github.com/settings/installations/42",
    secrets: ["ANTHROPIC_API_KEY"],
    variables: ["FACTORY_APP_ID"],
    dependabot: { action: "keep" },
    localHook: false,
    dataRepo: null,
    localBranches: [],
    trackingBranches: [],
    currentFactoryBranch: null,
    leftForYou: ["Uninstall the GitHub App."],
    ...over,
  });

  it("promises plainly that the work survives", () => {
    const out = formatPlan(plan(), false);
    expect(out).toContain("Your pull requests, commits and issues are untouched");
    expect(out).toContain("Keeping the run record");
    expect(out).toContain("ANTHROPIC_API_KEY");
    expect(out).toContain("Would remove the .factory/ folder on this computer");
  });

  it("says the folder on this computer was removed once it has run", () => {
    expect(formatPlan(plan(), true)).toContain("Removed the .factory/ folder on this computer");
  });

  it("says what is left for a person, since the App is not ours to remove", () => {
    expect(formatPlan(plan(), true)).toContain("Uninstall the GitHub App.");
  });

  it("is explicit when the run history really is being deleted", () => {
    expect(formatPlan(plan({ dataRef: "purged" }), true)).toContain("refs/factory/media");
  });

  it("reads as a plan, not as a result, until it has run", () => {
    expect(formatPlan(plan(), false)).toContain("Would remove");
    expect(formatPlan(plan(), true)).toContain("Removed");
  });
});

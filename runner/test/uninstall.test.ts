import { describe, it, expect } from "vitest";
import { factoryPaths, checksToDrop, formatPlan, type UninstallPlan, type InstallRecord } from "../src/commands/uninstall.js";

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
      ".github/ISSUE_TEMPLATE/factory-request.yml",
      // Not the factory's to remove:
      "src/index.js",
      ".github/workflows/ci.yml",
      ".github/ISSUE_TEMPLATE/bug.yml",
      "docs/how-we-work.md",
    ]);
    expect(files).toEqual([
      ".factory/bin/bsf",
      ".factory/definition/factory.yaml",
      ".github/workflows/factory-run.lock.yml",
      ".github/workflows/factory-intake.lock.yml",
      ".github/ISSUE_TEMPLATE/factory-request.yml",
    ]);
  });

  it("never touches a workflow that merely starts with the same letters", () => {
    expect(factoryPaths([".github/workflows/factorial-build.yml"])).toEqual([]);
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
    leftForYou: ["Uninstall the GitHub App."],
    ...over,
  });

  it("promises plainly that the work survives", () => {
    const out = formatPlan(plan(), false);
    expect(out).toContain("Your pull requests, commits and issues are untouched");
    expect(out).toContain("Keeping refs/factory/data");
  });

  it("says what is left for a person, since the App is not ours to remove", () => {
    expect(formatPlan(plan(), true)).toContain("Uninstall the GitHub App.");
  });

  it("is explicit when the run history really is being deleted", () => {
    expect(formatPlan(plan({ dataRef: "purged" }), true)).toContain("record of every run");
  });

  it("reads as a plan, not as a result, until it has run", () => {
    expect(formatPlan(plan(), false)).toContain("Would remove");
    expect(formatPlan(plan(), true)).toContain("Removed");
  });
});

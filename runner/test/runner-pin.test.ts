import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Dependabot can only upgrade what it can see, and it sees `uses:` lines. The
 * runner a workflow executes is the vendored copy in .factory/bin, taken from
 * the default branch, so the pin is a separate, deliberately inert reference:
 * an action that reads two values and a workflow that compares them. These
 * tests hold the properties that make that safe, and the installer that puts it
 * in a repository.
 */
const root = resolve(__dirname, "../..");
const action = readFileSync(join(root, "runner/action.yml"), "utf8");
const template = readFileSync(join(root, "templates/runner-pin/factory-runner-pin.yml"), "utf8");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PIN = `ChampPhil/build-software-factory ${SHA} v0.1.0`;

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "bsf-pin-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(d, "a"), "x");
  git("add", "a");
  git("commit", "-qm", "i");
  return d;
}
function install(into: string, pin: string): string {
  const pinFile = join(into, "..", `pin-${Math.random().toString(36).slice(2)}`);
  writeFileSync(pinFile, pin);
  return execFileSync("node", [join(root, "skill/scripts/install-factory.mjs"), "--into", into, "--pin-file", pinFile], { encoding: "utf8" });
}

describe("the pinned action is inert", () => {
  it("reads two values and does nothing else", () => {
    expect(action).toContain("using: composite");
    // No network, no secrets, no writes outside its own outputs.
    for (const forbidden of ["curl", "wget", "secrets.", "github.token", "git push", "gh api", "npm ", "node "]) {
      expect(action, forbidden).not.toContain(forbidden);
    }
    expect(action).toContain("sha256sum");
    expect(action).toContain("GITHUB_OUTPUT");
  });
});

describe("the pin workflow", () => {
  it("only reads in the job that runs the pinned action", () => {
    expect(template).toMatch(/^permissions:\n {2}contents: read$/m);
    // Nothing a pull request controls may run with a token or a secret.
    const check = template.slice(template.indexOf("  check:"), template.indexOf("  sync:"));
    expect(check).not.toContain("secrets.");
    expect(check).not.toContain("create-github-app-token");
    expect(template).not.toContain("pull_request_target");
  });

  it("opens the runner pull request only after the pin is on the default branch", () => {
    const sync = template.slice(template.indexOf("  sync:"));
    expect(sync).toContain("github.event_name == 'push'");
    expect(sync).toContain("needs.check.outputs.stale == 'true'");
  });

  it("copies the new release's files and never runs them", () => {
    const sync = template.slice(template.indexOf("  sync:"));
    const copy = sync.slice(sync.indexOf("Copy it over .factory/bin"), sync.indexOf("Mint the recompiler"));
    expect(copy).toContain("cp -R");
    expect(copy).not.toMatch(/\bbsf\b.*--version|\.factory\/bin\/bsf |node /);
  });

  it("pins every other action by SHA, and only the runner by placeholder", () => {
    const uses = [...template.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] ?? "");
    for (const u of uses) {
      if (u.includes("__RUNNER_SHA__")) continue;
      expect(u, u).toMatch(/@[0-9a-f]{40}$/);
    }
    expect(uses.filter((u) => u.includes("__RUNNER_SHA__"))).toHaveLength(1);
  });
});

describe("installing the upgrade path", () => {
  it("pins the release and writes the Dependabot entry", () => {
    const d = repo();
    install(d, PIN);
    const wf = readFileSync(join(d, ".github/workflows/factory-runner-pin.yml"), "utf8");
    expect(wf).toContain(`uses: ChampPhil/build-software-factory/runner@${SHA} # v0.1.0`);
    expect(wf).not.toContain("__RUNNER_");
    const dep = readFileSync(join(d, ".github/dependabot.yml"), "utf8");
    expect(dep).toContain("package-ecosystem: github-actions");
    expect(dep).toContain('dependency-name: "ChampPhil/build-software-factory*"');
    expect(dep).toContain("default-days: 3");
  });

  it("adds to an existing dependabot.yml without touching the other entries", () => {
    const d = repo();
    mkdirSync(join(d, ".github"), { recursive: true });
    const mine = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n';
    writeFileSync(join(d, ".github/dependabot.yml"), mine);
    install(d, PIN);
    const dep = readFileSync(join(d, ".github/dependabot.yml"), "utf8");
    expect(dep.startsWith(mine)).toBe(true);
    expect(dep).toContain("ChampPhil/build-software-factory*");
  });

  it("is idempotent", () => {
    const d = repo();
    install(d, PIN);
    const once = readFileSync(join(d, ".github/dependabot.yml"), "utf8");
    install(d, PIN);
    expect(readFileSync(join(d, ".github/dependabot.yml"), "utf8")).toBe(once);
  });

  it("leaves a file alone when it cannot say where the entry goes", () => {
    const d = repo();
    mkdirSync(join(d, ".github"), { recursive: true });
    const odd = "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\nregistries:\n  npm-x:\n    type: npm-registry\n";
    writeFileSync(join(d, ".github/dependabot.yml"), odd);
    const out = install(d, PIN);
    expect(readFileSync(join(d, ".github/dependabot.yml"), "utf8")).toBe(odd);
    expect(out).toContain("has to be added by hand");
  });

  it("installs nothing, and says so, before a release is pinned", () => {
    const d = repo();
    const out = install(d, "unreleased");
    expect(existsSync(join(d, ".github/workflows/factory-runner-pin.yml"))).toBe(false);
    expect(existsSync(join(d, ".github/dependabot.yml"))).toBe(false);
    expect(out).toContain("no runner release is pinned yet");
  });
});

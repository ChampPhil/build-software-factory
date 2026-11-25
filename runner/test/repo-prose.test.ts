import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  proseEvidence,
  PROSE_EVIDENCE_MINIMUM,
  scanProse,
  renderProse,
  isProsePath,
  eligible,
  budgetVerdict,
  budgetBytes,
  alwaysLoaded,
  DEFAULT_BUDGET_BYTES,
} from "../src/commands/repo-prose.js";
import type { Policy } from "../src/lib/types.js";
import { proseNote } from "../src/commands/role-steps.js";

/**
 * Every role read `.factory/definition/context/` and nothing else, so a repo
 * with an `AGENTS.md` stating its house style had that file ignored by every
 * build while the factory consulted its own paraphrase, written once at setup
 * and never since. The owners maintain `AGENTS.md`; nobody maintains the
 * paraphrase.
 */

let root: string;

const policyWith = (prose: unknown): Policy =>
  ({
    schema: "policy/1",
    trust: { associations: ["OWNER"], accept_label: "factory:accept" },
    paths: { definition: [".factory/definition/**"], guardrails: [], tests: [], protected: [] },
    pipelines: {},
    tests: { declared_edits: "off" },
    weakening: { requires: "trusted_human_approval", detects: ["rule_removed"] },
    prose,
  }) as unknown as Policy;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "prose-"));
  mkdirSync(join(root, ".claude", "skills", "deploy"), { recursive: true });
  mkdirSync(join(root, ".factory", "definition"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# House style\nUse the api client.\n");
  writeFileSync(join(root, "CLAUDE.md"), "Notes for Claude.\n");
  writeFileSync(join(root, "CONTRIBUTING.md"), "How to contribute.\n");
  writeFileSync(join(root, ".claude", "skills", "deploy", "SKILL.md"), "How we deploy.\n");
  writeFileSync(join(root, "docs", "house.md"), "Our own conventions.\n");
  writeFileSync(join(root, ".factory", "definition", "practices.md"), "factory-owned\n");
  writeFileSync(join(root, "README.md"), "a readme is not a convention\n");
});

describe("finding the repo's own prose", () => {
  it("reads the names agents already read, with no setup step", () => {
    const paths = scanProse(root).docs.map((d) => d.path);
    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain("CONTRIBUTING.md");
    expect(paths).toContain(".claude/skills/deploy/SKILL.md");
  });

  it("separates what is in every run's context from what is read on demand", () => {
    const scan = scanProse(root);
    const always = alwaysLoaded(scan).map((d) => d.path);
    expect(always).toContain("AGENTS.md");
    expect(always).toContain("CLAUDE.md");
    // A long contributing guide costs nothing until something needs it, so it
    // is not in the budget and not in every prompt.
    expect(always).not.toContain("CONTRIBUTING.md");
    expect(always).not.toContain(".claude/skills/deploy/SKILL.md");
  });

  it("leaves the README alone", () => {
    // A README is for people and says what the project is, not how work is
    // done here. Reading it as house style puts marketing in the builder's
    // context on every run.
    expect(scanProse(root).docs.map((d) => d.path)).not.toContain("README.md");
  });

  it("never offers anything under .factory, which is what governs the roles", () => {
    const paths = scanProse(root).docs.map((d) => d.path);
    expect(paths.some((p) => p.startsWith(".factory/"))).toBe(false);
  });

  it("picks up a path the repo declares for itself", () => {
    const scan = scanProse(root, policyWith({ targets: ["docs/house.md"] }));
    const doc = scan.docs.find((d) => d.path === "docs/house.md");
    expect(doc?.source).toBe("declared");
    // Declared means the owners named it as their house style, so it is read
    // every run and it is under budget.
    expect(doc?.load).toBe("always");
  });

  it("says when a declared path has gone", () => {
    const scan = scanProse(root, policyWith({ targets: ["docs/moved-away.md"] }));
    expect(scan.missing).toEqual(["docs/moved-away.md"]);
  });

  it("refuses a declared path under .factory even so", () => {
    // The schema refuses this at validation; this is the second line of
    // defence, for a path that reaches here by another route.
    const scan = scanProse(root, policyWith({ targets: [".factory/definition/practices.md"] }));
    expect(scan.refused).toEqual([".factory/definition/practices.md"]);
    expect(scan.docs.map((d) => d.path)).not.toContain(".factory/definition/practices.md");
  });

  it("refuses a declared path that climbs out of the repo", () => {
    const scan = scanProse(root, policyWith({ targets: ["../../etc/passwd"] }));
    expect(scan.refused).toEqual(["../../etc/passwd"]);
  });

  it("reads every file in a declared directory, on demand", () => {
    const scan = scanProse(root, policyWith({ targets: ["docs"] }));
    const doc = scan.docs.find((d) => d.path === "docs/house.md");
    expect(doc?.source).toBe("declared");
    expect(doc?.load).toBe("on_demand");
  });
});

describe("eligibility, by path alone", () => {
  it("keeps the roles' own instructions out of reach", () => {
    expect(eligible(".factory/definition/policy.yaml")).toBe(false);
    expect(eligible(".factory/guardrails/rules.json")).toBe(false);
    expect(eligible(".github/workflows/factory-run.yml")).toBe(false);
    expect(eligible(".git/config")).toBe(false);
  });

  it("allows ordinary repo prose", () => {
    expect(eligible("AGENTS.md")).toBe(true);
    expect(eligible(".github/CONTRIBUTING.md")).toBe(true);
  });
});

describe("isProsePath, which the gates use", () => {
  it("answers from the path, with no checkout to look at", () => {
    // The policy gate judges a pull request from its list of changed files.
    expect(isProsePath("AGENTS.md")).toBe(true);
    expect(isProsePath("./AGENTS.md")).toBe(true);
    expect(isProsePath(".claude/skills/anything/SKILL.md")).toBe(true);
    expect(isProsePath("src/index.ts")).toBe(false);
  });

  it("holds for a prose file the change is creating", () => {
    // scanProse can only see what exists; a hardening PR that adds the repo's
    // first AGENTS.md has to be judged as prose too.
    expect(isProsePath("AGENTS.md", policyWith({}))).toBe(true);
  });

  it("covers a declared directory and its children", () => {
    const p = policyWith({ targets: ["docs/standards"] });
    expect(isProsePath("docs/standards/naming.md", p)).toBe(true);
    expect(isProsePath("docs/standards", p)).toBe(true);
    expect(isProsePath("docs/other.md", p)).toBe(false);
  });

  it("refuses .factory however it is declared", () => {
    const p = policyWith({ targets: [".factory/definition/"] });
    expect(isProsePath(".factory/definition/practices.md", p)).toBe(false);
  });
});

describe("the budget on always-loaded prose", () => {
  it("passes a repo whose conventions are a reasonable size", () => {
    expect(budgetVerdict(scanProse(root)).ok).toBe(true);
  });

  it("fails one file over the cap, and names it", () => {
    const big = mkdtempSync(join(tmpdir(), "prose-big-"));
    writeFileSync(join(big, "AGENTS.md"), "x".repeat(DEFAULT_BUDGET_BYTES + 1));
    const verdict = budgetVerdict(scanProse(big));
    expect(verdict.ok).toBe(false);
    expect(verdict.over.map((o) => o.path)).toEqual(["AGENTS.md"]);
  });

  it("is per file, not a total", () => {
    // A total would let one file grow without limit as long as another shrank,
    // and what costs every run is how much any single file adds to it.
    const many = mkdtempSync(join(tmpdir(), "prose-many-"));
    const each = Math.floor(DEFAULT_BUDGET_BYTES * 0.7);
    writeFileSync(join(many, "AGENTS.md"), "x".repeat(each));
    writeFileSync(join(many, "CLAUDE.md"), "y".repeat(each));
    expect(budgetVerdict(scanProse(many)).ok).toBe(true);
  });

  it("ignores on-demand prose, however long", () => {
    const d = mkdtempSync(join(tmpdir(), "prose-demand-"));
    writeFileSync(join(d, "CONTRIBUTING.md"), "x".repeat(DEFAULT_BUDGET_BYTES * 4));
    expect(budgetVerdict(scanProse(d)).ok).toBe(true);
  });

  it("takes the repo's own cap when it sets one", () => {
    expect(budgetBytes(policyWith({ budget_bytes: 4096 }))).toBe(4096);
    expect(budgetBytes(policyWith({}))).toBe(DEFAULT_BUDGET_BYTES);
    expect(budgetBytes(null)).toBe(DEFAULT_BUDGET_BYTES);
    // A nonsense cap is not a cap of zero, which would fail every repo.
    expect(budgetBytes(policyWith({ budget_bytes: 0 }))).toBe(DEFAULT_BUDGET_BYTES);
  });
});

describe("what a role is handed", () => {
  it("says the repo's own prose wins over the factory's notes", () => {
    const text = renderProse(scanProse(root));
    expect(text).toMatch(/\*\*these win\*\*/i);
    expect(text).toContain("AGENTS.md");
  });

  it("lists paths and not contents", () => {
    // A role reads the files itself, so a long one costs the role that needs
    // it rather than every role.
    const text = renderProse(scanProse(root));
    expect(text).not.toContain("Use the api client.");
  });

  it("tells a repo with no conventions not to invent any", () => {
    const bare = mkdtempSync(join(tmpdir(), "prose-bare-"));
    const text = renderProse(scanProse(bare));
    expect(text).toMatch(/no conventions of its own/i);
    expect(text).toMatch(/Do not invent a/i);
  });

  it("surfaces a stale declared pointer to whoever is reading", () => {
    const text = renderProse(scanProse(root, policyWith({ targets: ["docs/gone.md"] })));
    expect(text).toContain("docs/gone.md");
    expect(text).toMatch(/something has moved/i);
  });
});

describe("the evidence a written practice has to carry", () => {
  const body = (...lines: string[]): string => lines.join("\n");

  it("counts the instances under the heading", () => {
    const text = body("## Why a practice", "", "- one", "- two", "- three");
    expect(proseEvidence(text)).toEqual({ found: true, instances: 3 });
  });

  it("takes two as the bar", () => {
    expect(PROSE_EVIDENCE_MINIMUM).toBe(2);
  });

  it("stops at the next heading, so a later list is not evidence", () => {
    const text = body(
      "## Why a practice",
      "",
      "- one",
      "",
      "## What changed",
      "",
      "- a line in AGENTS.md",
      "- another line",
    );
    expect(proseEvidence(text).instances).toBe(1);
  });

  it("accepts any list marker and any heading depth", () => {
    for (const marker of ["-", "*", "+", "1.", "2)"]) {
      const text = body("#### Why a practice, and not a check", "", `${marker} one`, `${marker} two`);
      expect(proseEvidence(text).instances, marker).toBe(2);
    }
  });

  it("says when there is no such heading, which reads differently to zero instances", () => {
    expect(proseEvidence("Tidied up the conventions.")).toEqual({ found: false, instances: 0 });
    expect(proseEvidence(body("## Why a practice", "", "no list here"))).toEqual({ found: true, instances: 0 });
  });

  it("treats a missing or empty body as no evidence", () => {
    expect(proseEvidence(null).found).toBe(false);
    expect(proseEvidence(undefined).found).toBe(false);
    expect(proseEvidence("   ").found).toBe(false);
  });

  it("does not care about case or trailing words in the heading", () => {
    expect(proseEvidence(body("## WHY A PRACTICE AND NOT A RULE", "", "- a", "- b")).instances).toBe(2);
  });
});

/**
 * A repo that installed the factory before this lever existed has a policy
 * that predates the choice, and `policy.yaml` is the owners' file — an upgrade
 * does not rewrite it. So the lever stays off there until someone grants it,
 * and the hardener is told that up front rather than spending a model on a
 * change the gate will refuse.
 */
describe("telling the hardener whether the lever is available", () => {
  it("says it is off when the policy has not granted it", () => {
    const note = proseNote({
      pipelines: { hardening: { may_change: ["code", "tests", "guardrails:tighten"] } },
    } as unknown as Policy);
    expect(note).toMatch(/has not granted/i);
    expect(note).toMatch(/refused at the gate/i);
  });

  it("is off for a repo with no policy at all", () => {
    expect(proseNote(null)).toMatch(/has not granted/i);
    expect(proseNote(undefined)).toMatch(/has not granted/i);
  });

  it("states the bar when it is granted", () => {
    const note = proseNote({
      pipelines: { hardening: { may_change: ["code", "prose"] } },
    } as unknown as Policy);
    expect(note).toContain("repo-prose.md");
    expect(note).toContain("Why a practice");
    expect(note).toMatch(/\.factory\//);
  });
});

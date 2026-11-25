import { describe, it, expect } from "vitest";
import { runPolicy, isTrustedActor, hasTrustedHumanApproval, appRequestedChanges, type PolicyContext } from "../src/commands/policy.js";
import { toReview } from "../src/commands/policy-run.js";
import type { Policy, PullRequestFacts, Review } from "../src/lib/types.js";
import { withOverride, type Override } from "./helpers/override.js";

const policy: Policy = {
  schema: "policy/1",
  trust: {
    associations: ["OWNER", "MEMBER", "COLLABORATOR"],
    accept_label: "factory:accept",
    harden_label: "factory:harden",
    integration_bots: ["linear[bot]", "sentry-io[bot]"],
  },
  paths: {
    definition: [".factory/definition/**"],
    guardrails: [".factory/guardrails/**", ".eslintrc*", "pyproject.toml#tool.ruff"],
    tests: ["**/*.test.*", "**/test_*.py", "tests/**"],
    protected: [".github/workflows/**", ".github/dependabot.yml"],
    baselines: [".factory/guardrails/baselines.json"],
    coverage: [".factory/guardrails/coverage.json"],
  },
  pipelines: {
    product_work: { may_change: ["code", "tests"] },
    gardening: { may_change: ["code", "tests"] },
    hardening: { may_change: ["code", "tests", "guardrails:tighten"] },
    definition: { may_change: ["definition"], requires: "trusted_human_approval" },
  },
  tests: { declared_edits: "required" },
  runner_upgrades: { author: "dependabot[bot]", may_change: "runner_pin", requires: "trusted_human_approval" },
  weakening: {
    requires: "trusted_human_approval",
    detects: ["rule_removed", "rule_loosened", "baseline_raised", "coverage_floor_lowered", "skip_without_reason"],
  },
};

const HEAD = "abc1234";

function pr(over: Override<PullRequestFacts> = {}): PullRequestFacts {
  return withOverride<PullRequestFacts>({
    number: 311,
    head_sha: HEAD,
    base_ref: "main",
    author: "factory-app[bot]",
    author_association: "NONE",
    from_fork: false,
    labels: [],
    changed_files: ["src/export/download.ts"],
    added_files: [],
    reviews: [],
    draft: true,
    pipeline: "product_work",
    declared_test_edits: [],
  }, over);
}

const humanApproval: Review = {
  author: "philip",
  author_association: "OWNER",
  state: "APPROVED",
  submitted_at: "2026-11-19T00:00:00Z",
  commit_sha: HEAD,
};

function ctx(over: Override<PullRequestFacts> = {}): PolicyContext {
  return { policy, pr: pr(over), appLogins: ["factory-app[bot]", "factory-recompiler[bot]"] };
}

describe("trust at intake", () => {
  it("trusts owners, members and collaborators", () => {
    expect(isTrustedActor(policy, "philip", "OWNER")).toBe(true);
    expect(isTrustedActor(policy, "teammate", "MEMBER")).toBe(true);
    expect(isTrustedActor(policy, "contractor", "COLLABORATOR")).toBe(true);
  });

  it("does not trust an outside account", () => {
    expect(isTrustedActor(policy, "stranger", "NONE")).toBe(false);
    expect(isTrustedActor(policy, "driveby", "FIRST_TIME_CONTRIBUTOR")).toBe(false);
  });

  it("never trusts an integration's bot, however its association reads", () => {
    // Trust belongs to people, never integrations (doc 02).
    expect(isTrustedActor(policy, "linear[bot]", "MEMBER")).toBe(false);
    expect(isTrustedActor(policy, "sentry-io[bot]", "OWNER")).toBe(false);
  });

  it("never trusts any bot login, even one not listed", () => {
    expect(isTrustedActor(policy, "some-new-integration[bot]", "MEMBER")).toBe(false);
  });
});

describe("approvals", () => {
  it("accepts a trusted human's approval on the head commit", () => {
    expect(hasTrustedHumanApproval(ctx({ reviews: [humanApproval] }))).toBe(true);
  });

  it("ignores an approval from the factory App", () => {
    const appApproval: Review = { ...humanApproval, author: "factory-app[bot]", is_app: true };
    expect(hasTrustedHumanApproval(ctx({ reviews: [appApproval] }))).toBe(false);
  });

  it("ignores an approval from an untrusted human", () => {
    expect(hasTrustedHumanApproval(ctx({ reviews: [{ ...humanApproval, author: "stranger", author_association: "NONE" }] }))).toBe(false);
  });

  it("does not carry an approval from an older commit to new code", () => {
    expect(hasTrustedHumanApproval(ctx({ reviews: [{ ...humanApproval, commit_sha: "oldersha" }] }))).toBe(false);
  });

  it("reports an App's REQUEST_CHANGES as gh-aw's protected-file check, not a human objection", () => {
    const appBlock: Review = {
      author: "factory-app[bot]", author_association: "NONE",
      state: "CHANGES_REQUESTED", submitted_at: "2026-11-19T00:00:00Z", is_app: true,
    };
    const c = ctx({ reviews: [appBlock] });
    expect(appRequestedChanges(c)).toHaveLength(1);
    const res = runPolicy(c);
    expect(res.notes.join(" ")).toContain("gh-aw's protected-file check");
  });
});

describe("criterion: a PR that edits .factory/definition/ from the product pipeline fails", () => {
  it("fails, naming the offending files", () => {
    const res = runPolicy(ctx({
      pipeline: "product_work",
      changed_files: ["src/a.ts", ".factory/definition/factory.yaml"],
    }));
    expect(res.conclusion).toBe("failure");
    if (res.conclusion === "failure") {
      const f = res.failures.find((x) => x.kind === "path_not_allowed_for_pipeline");
      expect(f).toBeDefined();
      expect(f?.files).toContain(".factory/definition/factory.yaml");
    }
  });

  it("fails even with a human approval, because the product pipeline may never change the definition", () => {
    const res = runPolicy(ctx({
      pipeline: "product_work",
      changed_files: [".factory/definition/roles/builder.yaml"],
      reviews: [humanApproval],
    }));
    expect(res.conclusion).toBe("failure");
  });

  it("a definition-pipeline PR passes only with a trusted human's approval", () => {
    const files = [".factory/definition/context/runbook.md"];
    const without = runPolicy(ctx({ pipeline: "definition", changed_files: files }));
    expect(without.conclusion).toBe("failure");
    if (without.conclusion === "failure") {
      expect(without.failures.some((f) => f.kind === "definition_without_approval")).toBe(true);
    }
    const withApproval = runPolicy(ctx({ pipeline: "definition", changed_files: files, reviews: [humanApproval] }));
    expect(withApproval.conclusion).toBe("success");
  });

  it("a PR from no pipeline (a person's, or setup's) is held to the same approval, not refused outright", () => {
    // The setup PR wrote the context files and was failed as "the unknown
    // pipeline", which no approval could fix.
    const files = [".factory/definition/context/runbook.md"];
    const without = runPolicy(ctx({ pipeline: undefined, author: "philip", author_association: "OWNER", changed_files: files }));
    expect(without.conclusion).toBe("failure");
    if (without.conclusion === "failure") {
      expect(without.failures.map((f) => f.kind)).toEqual(["definition_without_approval"]);
    }
    expect(runPolicy(ctx({ pipeline: undefined, author: "philip", author_association: "OWNER", changed_files: files, reviews: [humanApproval] })).conclusion).toBe("success");
  });
});

describe("criterion: a fork PR that edits factory-gates.yml to always pass still fails", () => {
  it("fails on the protected path and on being a fork", () => {
    const res = runPolicy(ctx({
      from_fork: true,
      author: "stranger",
      author_association: "NONE",
      pipeline: "product_work",
      changed_files: [".github/workflows/factory-gates.yml"],
    }));
    expect(res.conclusion).toBe("failure");
    if (res.conclusion === "failure") {
      expect(res.failures.some((f) => f.kind === "protected_path")).toBe(true);
      expect(res.failures.some((f) => f.kind === "fork_agent_work")).toBe(true);
    }
  });

  it("cannot be cleared by anything inside the PR, only by a trusted human's approval", () => {
    // The check runs from main's copy of the workflow, so the PR's own edit to
    // the gates is irrelevant to this verdict.
    const res = runPolicy(ctx({
      pipeline: undefined,
      author: "stranger",
      author_association: "NONE",
      from_fork: true,
      changed_files: [".github/workflows/factory-gates.yml"],
      reviews: [{ ...humanApproval, author: "stranger", author_association: "NONE" }],
    }));
    expect(res.conclusion).toBe("failure");
  });
});

describe("criterion: a factory PR that edits an undeclared existing test fails", () => {
  it("fails when the spec did not declare the test file", () => {
    const res = runPolicy(ctx({
      changed_files: ["src/a.ts", "src/a.test.ts"],
      added_files: [],
      declared_test_edits: [],
    }));
    expect(res.conclusion).toBe("failure");
    if (res.conclusion === "failure") {
      const f = res.failures.find((x) => x.kind === "undeclared_test_edit");
      expect(f?.files).toEqual(["src/a.test.ts"]);
    }
  });

  it("passes when the spec declared it", () => {
    const res = runPolicy(ctx({
      changed_files: ["src/a.ts", "src/a.test.ts"],
      declared_test_edits: ["src/a.test.ts"],
    }));
    expect(res.conclusion).toBe("success");
  });

  it("always allows a new test file, declared or not", () => {
    const res = runPolicy(ctx({
      changed_files: ["src/b.ts", "src/b.test.ts"],
      added_files: ["src/b.test.ts"],
      declared_test_edits: [],
    }));
    expect(res.conclusion).toBe("success");
  });

  it("covers python test naming too", () => {
    const res = runPolicy(ctx({ changed_files: ["app/test_export.py"], declared_test_edits: [] }));
    expect(res.conclusion).toBe("failure");
  });
});

describe("guardrail paths per pipeline", () => {
  it("product work may not change guardrails", () => {
    const res = runPolicy(ctx({ pipeline: "product_work", changed_files: [".factory/guardrails/rules/no-raw-fetch.yml"] }));
    expect(res.conclusion).toBe("failure");
    if (res.conclusion === "failure") {
      expect(res.failures.some((f) => f.kind === "guardrail_change_not_allowed")).toBe(true);
    }
  });

  it("hardening may add or tighten guardrails", () => {
    const res = runPolicy(ctx({ pipeline: "hardening", changed_files: [".factory/guardrails/rules/no-raw-fetch.yml"] }));
    expect(res.conclusion).toBe("success");
  });

  it("an existing tool config counts as a guardrail", () => {
    const res = runPolicy(ctx({ pipeline: "product_work", changed_files: [".eslintrc.json"] }));
    expect(res.conclusion).toBe("failure");
  });

  it("a guardrail pattern with a section fragment matches the file", () => {
    // pyproject.toml#tool.ruff — the fragment documents the section; matching uses the file.
    const res = runPolicy(ctx({ pipeline: "product_work", changed_files: ["pyproject.toml"] }));
    expect(res.conclusion).toBe("failure");
  });

  it("every pipeline may lower a baseline count and raise the coverage floor", () => {
    const res = runPolicy(ctx({
      pipeline: "product_work",
      changed_files: ["src/a.ts", ".factory/guardrails/baselines.json", ".factory/guardrails/coverage.json"],
    }));
    expect(res.conclusion).toBe("success");
  });
});

describe("runner upgrade PRs", () => {
  it("need a trusted human's approval, whatever the toggles say", () => {
    const res = runPolicy(ctx({
      author: "dependabot[bot]",
      pipeline: undefined,
      changed_files: [".github/workflows/factory-run.yml"],
    }));
    expect(res.conclusion).toBe("failure");
    if (res.conclusion === "failure") {
      expect(res.failures.some((f) => f.kind === "definition_without_approval")).toBe(true);
    }
  });

  it("may change only the pin, not other files", () => {
    const res = runPolicy(ctx({
      author: "dependabot[bot]",
      pipeline: undefined,
      changed_files: [".github/workflows/factory-run.yml", "src/sneaky.ts"],
      reviews: [humanApproval],
    }));
    expect(res.conclusion).toBe("failure");
    if (res.conclusion === "failure") {
      expect(res.failures.some((f) => f.kind === "runner_upgrade_scope")).toBe(true);
    }
  });

  it("passes when scoped to workflow pins and approved", () => {
    const res = runPolicy(ctx({
      author: "dependabot[bot]",
      pipeline: undefined,
      changed_files: [".github/workflows/factory-run.yml", ".github/workflows/factory-gates.yml"],
      reviews: [humanApproval],
    }));
    expect(res.conclusion).toBe("success");
  });
});

describe("the ordinary case", () => {
  it("a product PR touching only code and declared tests passes", () => {
    const res = runPolicy(ctx({
      changed_files: ["src/export/download.ts", "src/export/download.test.ts"],
      added_files: ["src/export/download.test.ts"],
    }));
    expect(res.conclusion).toBe("success");
  });

  it("a human PR touching only code passes with no pipeline set", () => {
    const res = runPolicy(ctx({
      pipeline: undefined,
      author: "philip",
      author_association: "OWNER",
      changed_files: ["src/export/download.ts"],
      declared_test_edits: undefined,
    }));
    expect(res.conclusion).toBe("success");
  });
});

describe("the review mapper both commands share", () => {
  it("maps GitHub's commit_id to commit_sha, so a stale approval cannot count", () => {
    // This is the regression test for a real bug: the merge queue had its own
    // mapping that set `commit_id` and `author_is_bot` where the type wants
    // `commit_sha` and `is_app`. The effect was that the "an approval does not
    // carry to a later commit" check silently did nothing — in the one place
    // that decides whether to merge.
    const r = toReview({
      user: { login: "alice", type: "User" },
      author_association: "MEMBER",
      state: "APPROVED",
      submitted_at: "2026-11-19T00:00:00Z",
      commit_id: "oldsha",
    });
    expect(r.commit_sha).toBe("oldsha");
    expect(r).not.toHaveProperty("commit_id");
    expect(r.is_app).toBe(false);
  });

  it("marks an App's review as an App's, by type and by login", () => {
    for (const user of [
      { login: "alice", type: "Bot" },
      { login: "factory-bsf[bot]", type: "User" },
    ]) {
      const r = toReview({
        user,
        author_association: "NONE",
        state: "APPROVED",
        submitted_at: "t",
      } as never);
      expect(r.is_app, user.login).toBe(true);
    }
  });

  it("an approval mapped this way does not satisfy the gate on a newer commit", () => {
    const reviews = [
      toReview({
        user: { login: "alice", type: "User" },
        author_association: "MEMBER",
        state: "APPROVED",
        submitted_at: "t",
        commit_id: "old",
      }),
    ];
    const base = {
      policy,
      pr: { ...pr(), head_sha: "new", reviews },
      appLogins: [],
    };
    expect(hasTrustedHumanApproval(base as never)).toBe(false);
    const onSame = { ...base, pr: { ...base.pr, head_sha: "old" } };
    expect(hasTrustedHumanApproval(onSame as never)).toBe(true);
  });
});

/**
 * The repo's own prose — AGENTS.md and its kind — is a lever of its own.
 *
 * A rule proves itself by failing on the bad example; a paragraph cannot be run
 * against anything, so the only evidence a written practice has is that the
 * thing came up more than once. Without that bar, one passing remark becomes a
 * standing instruction in a file every run reads and every contributor
 * inherits.
 */
describe("writing a practice into the repo's own conventions", () => {
  const proseAllowed: Policy = {
    ...policy,
    pipelines: { ...policy.pipelines, hardening: { may_change: ["code", "tests", "guardrails:tighten", "prose"] } },
  };
  const evidence = [
    "## Why a practice",
    "",
    '- 2026-11-02 #41 — "we say members, not users"',
    '- 2026-11-18 #67 — "members, not users, again"',
  ].join("\n");

  const run = (over: Override<PullRequestFacts>, p: Policy = proseAllowed) =>
    runPolicy({ policy: p, pr: pr(over), appLogins: ["factory-app[bot]"] });

  it("lets hardening write one when the evidence is there", () => {
    const r = run({ pipeline: "hardening", changed_files: ["AGENTS.md"], body: evidence });
    expect(r.conclusion).toBe("success");
  });

  it("refuses a practice with only one instance", () => {
    const thin = ["## Why a practice", "", '- 2026-11-02 #41 — "we say members"'].join("\n");
    const r = run({ pipeline: "hardening", changed_files: ["AGENTS.md"], body: thin });
    expect(r.conclusion).toBe("failure");
    if (r.conclusion !== "failure") return;
    expect(r.failures.map((f) => f.kind)).toContain("prose_without_evidence");
    expect(r.failures.find((f) => f.kind === "prose_without_evidence")?.message).toMatch(/lists 1/);
  });

  it("refuses a practice with no evidence section at all", () => {
    const r = run({ pipeline: "hardening", changed_files: ["AGENTS.md"], body: "Tidied the conventions." });
    expect(r.conclusion).toBe("failure");
    if (r.conclusion !== "failure") return;
    expect(r.failures.find((f) => f.kind === "prose_without_evidence")?.message).toMatch(/no such heading/);
  });

  it("refuses a practice when the body is empty", () => {
    const r = run({ pipeline: "hardening", changed_files: ["CLAUDE.md"], body: null });
    expect(r.conclusion).toBe("failure");
  });

  it("refuses the lever outright to a pipeline that was not granted it", () => {
    // product_work builds features; it does not get to rewrite house style.
    const r = run({ pipeline: "product_work", changed_files: ["AGENTS.md"], body: evidence });
    expect(r.conclusion).toBe("failure");
    if (r.conclusion !== "failure") return;
    expect(r.failures.map((f) => f.kind)).toContain("path_not_allowed_for_pipeline");
  });

  it("refuses it to hardening too where the repo has not granted it", () => {
    const r = run({ pipeline: "hardening", changed_files: ["AGENTS.md"], body: evidence }, policy);
    expect(r.conclusion).toBe("failure");
    if (r.conclusion !== "failure") return;
    expect(r.failures.map((f) => f.kind)).toContain("path_not_allowed_for_pipeline");
  });

  it("asks nothing extra of a change that touches no prose", () => {
    const r = run({ pipeline: "hardening", changed_files: ["src/export/download.ts"] });
    expect(r.conclusion).toBe("success");
  });

  it("does not let prose count as code, or code as prose", () => {
    // A pipeline with code but not prose may still not touch AGENTS.md, and the
    // reverse: the two are judged separately on purpose.
    const codeOnly: Policy = {
      ...policy,
      pipelines: { ...policy.pipelines, hardening: { may_change: ["code"] } },
    };
    const r = run({ pipeline: "hardening", changed_files: ["AGENTS.md"], body: evidence }, codeOnly);
    expect(r.conclusion).toBe("failure");

    const proseOnly: Policy = {
      ...policy,
      pipelines: { ...policy.pipelines, hardening: { may_change: ["prose"] } },
    };
    const r2 = run({ pipeline: "hardening", changed_files: ["src/a.ts"] }, proseOnly);
    expect(r2.conclusion).toBe("failure");
  });

  it("still protects .factory, which is the text that governs the roles", () => {
    // Declaring it as prose cannot launder it: the definition rules decide, and
    // they need a trusted human.
    const sneaky: Policy = {
      ...proseAllowed,
      prose: { targets: [".factory/definition/context/fundamentals.md"] },
    };
    const r = run(
      { pipeline: "hardening", changed_files: [".factory/definition/context/fundamentals.md"], body: evidence },
      sneaky,
    );
    expect(r.conclusion).toBe("failure");
  });

  it("holds a human PR to none of this", () => {
    // No pipeline means a person, and a person edits their own conventions.
    const r = run({ pipeline: undefined, changed_files: ["AGENTS.md"], author: "philip", author_association: "OWNER" });
    expect(r.conclusion).toBe("success");
  });
});

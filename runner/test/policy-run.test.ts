import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gatherPullFacts, pipelineFromLabels, summarize, policyCheckReport } from "../src/commands/policy-run.js";
import type { GitHub, PullResponse, PullFile, ReviewResponse } from "../src/lib/github.js";
import { runPolicy } from "../src/commands/policy.js";
import { loadPolicy, type Loader } from "../src/lib/config.js";
import type { Policy } from "../src/lib/types.js";
import { SCHEMA_NAMES } from "../src/lib/schema.js";

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "templates")) && existsSync(join(dir, "runner"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}
const ROOT = repoRoot();

/** A GitHub stand-in, so the wiring is tested without the network. */
function stubGitHub(opts: {
  pull?: Partial<PullResponse>;
  files?: PullFile[];
  reviews?: ReviewResponse[];
}): GitHub {
  const pull: PullResponse = {
    number: 42,
    draft: true,
    head: { sha: "headsha", repo: { full_name: "owner/repo" } },
    base: { ref: "main", repo: { full_name: "owner/repo" } },
    user: { login: "factory-app[bot]", type: "Bot" },
    author_association: "NONE",
    labels: [],
    ...opts.pull,
  };
  return {
    pull: async () => pull,
    pullFiles: async () => opts.files ?? [],
    pullReviews: async () => opts.reviews ?? [],
  } as unknown as GitHub;
}

const file = (filename: string, status: PullFile["status"] = "modified", previous?: string): PullFile =>
  previous === undefined ? { filename, status } : { filename, status, previous_filename: previous };

describe("pipelineFromLabels", () => {
  it("reads the pipeline off a factory label", () => {
    expect(pipelineFromLabels(["factory:in-progress", "factory:hardening"])).toBe("hardening");
    expect(pipelineFromLabels(["factory:product-work"])).toBe("product_work");
  });

  it("is undefined for a human PR with no factory label", () => {
    expect(pipelineFromLabels(["bug", "needs-review"])).toBeUndefined();
  });
});

describe("gatherPullFacts", () => {
  it("spots a fork by comparing head and base repos", async () => {
    const gh = stubGitHub({
      pull: { head: { sha: "s", repo: { full_name: "stranger/repo" } } },
    });
    expect((await gatherPullFacts(gh, 42)).from_fork).toBe(true);
  });

  it("treats a PR whose head repo is gone as a fork, not as same-repo", async () => {
    // head.repo is null once a fork is deleted, and only a fork's head repo
    // can be null. Reading it as same-repo is the one direction that matters:
    // it would let a PR from outside past the fork check.
    const gh = stubGitHub({ pull: { head: { sha: "s", repo: null } } });
    expect((await gatherPullFacts(gh, 42)).from_fork).toBe(true);
  });

  it("does not call a same-repo PR a fork", async () => {
    const gh = stubGitHub({ pull: { head: { sha: "s", repo: { full_name: "owner/repo" } } } });
    expect((await gatherPullFacts(gh, 42)).from_fork).toBe(false);
  });

  it("includes both paths of a rename, so moving a protected file is still caught", async () => {
    const gh = stubGitHub({
      files: [file(".github/workflows/renamed.yml", "renamed", ".github/workflows/factory-gates.yml")],
    });
    const facts = await gatherPullFacts(gh, 42);
    expect(facts.changed_files).toContain(".github/workflows/factory-gates.yml");
    expect(facts.changed_files).toContain(".github/workflows/renamed.yml");
  });

  it("records which files are new, so a new test needs no declaration", async () => {
    const gh = stubGitHub({
      files: [file("a.test.ts", "added"), file("b.test.ts", "modified")],
    });
    const facts = await gatherPullFacts(gh, 42);
    expect(facts.added_files).toEqual(["a.test.ts"]);
  });

  it("marks a Bot reviewer as an App, whose approval never counts", async () => {
    const gh = stubGitHub({
      reviews: [{
        user: { login: "factory-app[bot]", type: "Bot" },
        author_association: "NONE", state: "APPROVED",
        submitted_at: "2026-11-19T00:00:00Z", commit_id: "headsha",
      }],
    });
    const facts = await gatherPullFacts(gh, 42);
    expect(facts.reviews[0]?.is_app).toBe(true);
  });

  it("keeps the commit a review was submitted on", async () => {
    const gh = stubGitHub({
      reviews: [{
        user: { login: "philip", type: "User" },
        author_association: "OWNER", state: "APPROVED",
        submitted_at: "2026-11-19T00:00:00Z", commit_id: "oldersha",
      }],
    });
    const facts = await gatherPullFacts(gh, 42);
    expect(facts.reviews[0]?.commit_sha).toBe("oldersha");
  });
});

describe("the shipped policy.yaml, against real PR shapes", () => {
  const loader: Loader = {
    read: async (p) =>
      p === ".factory/definition/policy.yaml"
        ? (await import("node:fs")).readFileSync(join(ROOT, "templates/definition/policy.yaml"), "utf8")
        : null,
  };

  it("loads and validates", async () => {
    const policy = await loadPolicy(loader);
    expect(policy.schema).toBe("policy/1");
  });

  it("fails a fork PR that rewrites the gates", async () => {
    const policy: Policy = await loadPolicy(loader);
    const gh = stubGitHub({
      pull: {
        head: { sha: "s", repo: { full_name: "stranger/repo" } },
        user: { login: "stranger", type: "User" },
        labels: [{ name: "factory:product-work" }],
      },
      files: [file(".github/workflows/factory-gates.yml")],
    });
    const result = runPolicy({ policy, pr: await gatherPullFacts(gh, 42) });
    expect(result.conclusion).toBe("failure");
  });

  it("passes an ordinary product PR touching code and a new test", async () => {
    const policy = await loadPolicy(loader);
    const gh = stubGitHub({
      pull: { labels: [{ name: "factory:product-work" }] },
      files: [file("src/export/download.ts"), file("src/export/download.test.ts", "added")],
    });
    const result = runPolicy({ policy, pr: await gatherPullFacts(gh, 42) });
    expect(result.conclusion).toBe("success");
  });

  it("fails a hardening PR that reaches into the definition", async () => {
    const policy = await loadPolicy(loader);
    const gh = stubGitHub({
      pull: { labels: [{ name: "factory:hardening" }] },
      files: [file(".factory/definition/factory.yaml")],
    });
    const result = runPolicy({ policy, pr: await gatherPullFacts(gh, 42) });
    expect(result.conclusion).toBe("failure");
  });

  it("passes a hardening PR adding a guardrail rule", async () => {
    const policy = await loadPolicy(loader);
    const gh = stubGitHub({
      pull: { labels: [{ name: "factory:hardening" }] },
      files: [file(".factory/guardrails/rules/no-raw-fetch.yml", "added")],
    });
    const result = runPolicy({ policy, pr: await gatherPullFacts(gh, 42) });
    expect(result.conclusion).toBe("success");
  });

  it("refuses to run at all when policy.yaml is missing, rather than passing", async () => {
    const empty: Loader = { read: async () => null };
    await expect(loadPolicy(empty)).rejects.toThrow(/missing/);
  });
});

describe("the check-run summary", () => {
  it("names each failure and lists its files", () => {
    const text = summarize({
      conclusion: "failure",
      failures: [{ kind: "undeclared_test_edit", files: [".github/workflows/x.yml"], message: "nope" }],
      notes: [],
    });
    expect(text).toContain("undeclared_test_edit");
    expect(text).toContain(".github/workflows/x.yml");
  });

  it("truncates a very long file list rather than blowing the size limit", () => {
    const files = Array.from({ length: 120 }, (_, i) => `src/f${i}.ts`);
    const text = summarize({
      conclusion: "failure",
      failures: [{ kind: "path_not_allowed_for_pipeline", files, message: "nope" }],
      notes: [],
    });
    expect(text).toContain("and 70 more");
  });
});

describe("the bsf CLI", () => {
  const cli = join(ROOT, "runner/dist/cli.js");

  it("is built", () => {
    expect(existsSync(cli), "run `npm -w @bsf/runner run build` first").toBe(true);
  });

  it("prints its version", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "runner/package.json"), "utf8")) as { version: string };
    expect(execFileSync("node", [cli, "version"], { encoding: "utf8" }).trim()).toBe(pkg.version);
  });

  it("lists the schemas it reads and writes", () => {
    // Counted from the registry rather than written down: a hardcoded number
    // breaks on every schema added and teaches nothing when it does.
    const out = execFileSync("node", [cli, "schemas"], { encoding: "utf8" });
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(SCHEMA_NAMES.length);
    for (const name of SCHEMA_NAMES) expect(lines).toContain(`${name}/1`);
  });

  it("validates a good file", () => {
    const out = execFileSync("node", [cli, "validate", "coverage", join(ROOT, "templates/guardrails/coverage.json")], {
      encoding: "utf8",
    });
    expect(out).toContain("is a valid coverage");
  });

  it("exits non-zero on a file that does not match its schema", () => {
    let code = 0;
    try {
      execFileSync("node", [cli, "validate", "factory", join(ROOT, "templates/guardrails/coverage.json")], {
        encoding: "utf8", stdio: "pipe",
      });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(1);
  });

  it("refuses an unknown schema name", () => {
    let code = 0;
    try {
      execFileSync("node", [cli, "validate", "nonsense", "x.json"], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(2);
  });

  it("refuses `policy` without a PR number", () => {
    let code = 0;
    try {
      execFileSync("node", [cli, "policy"], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(2);
  });
});

describe("factory/policy on a repository that cannot require checks", () => {
  const waiting = {
    conclusion: "failure" as const,
    failures: [{ kind: "definition_without_approval" as const, files: [".factory/definition/factory.yaml"], message: "needs a person" }],
    notes: [],
  };

  it("finishes as not required instead of staying yellow", () => {
    const r = policyCheckReport(waiting, false);
    expect(r.conclusion).toBe("neutral");
    expect(r.title).toBe("Not required on this repository");
    expect(r.summary).toMatch(/factory\/gates/);
  });

  it("stays yellow where checks can be required", () => {
    expect(policyCheckReport(waiting, true).conclusion).toBe("pending");
  });
});

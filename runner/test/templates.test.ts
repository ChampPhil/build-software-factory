import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { assertValid, validate } from "../src/lib/schema.js";
import type { Policy } from "../src/lib/types.js";

/**
 * The shipped defaults are validated here, so templates and schemas cannot
 * drift apart silently: a change to either that breaks the other fails a test
 * rather than a user's setup.
 */

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "templates")) && existsSync(join(dir, "schema"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}

const ROOT = repoRoot();
const TEMPLATES = join(ROOT, "templates");
const WORKFLOWS = join(TEMPLATES, "workflows");

const ROLES = ["triage", "spec", "builder", "verifier", "gardener", "hardener", "scorer"] as const;

describe("default factory.yaml", () => {
  const doc = parseYaml(readFileSync(join(TEMPLATES, "definition/factory.yaml"), "utf8")) as unknown;

  it("validates against the factory schema", () => {
    const res = validate("factory", doc);
    if (!res.ok) throw new Error(JSON.stringify(res.errors, null, 2));
    expect(res.ok).toBe(true);
  });

  it("names a model for every one of the seven roles", () => {
    const models = (doc as { models: Record<string, string> }).models;
    for (const r of ROLES) expect(models[r], `no model for ${r}`).toBeTruthy();
  });

  it("starts with every auto-merge toggle off", () => {
    const p = (doc as { pipelines: Record<string, { auto_merge: boolean }> }).pipelines;
    expect(p["product_work"]?.auto_merge).toBe(false);
    expect(p["gardening"]?.auto_merge).toBe(false);
    expect(p["hardening"]?.auto_merge).toBe(false);
  });

  it("budget shares add up to 100", () => {
    const s = (doc as { budget: { shares: Record<string, number> } }).budget.shares;
    expect(s["product_work"]! + s["gardening"]! + s["review_and_benchmarks"]!).toBe(100);
  });

  it("defaults to the stronger sandbox profile", () => {
    // docker-sudo-iptables runs AWF with host privileges, so it is opt-in at
    // setup for repos whose app needs a services: sidecar (spike §4a).
    expect((doc as { sandbox?: { agent_runtime?: string } }).sandbox?.agent_runtime).toBe("docker");
  });

  it("spends nothing on models for human PRs by default", () => {
    expect((doc as { human_prs: { gates: string } }).human_prs.gates).toBe("deterministic");
  });
});

describe("default policy.yaml", () => {
  const doc = parseYaml(readFileSync(join(TEMPLATES, "definition/policy.yaml"), "utf8")) as Policy;

  it("validates against the policy schema", () => {
    const res = validate("policy", doc);
    if (!res.ok) throw new Error(JSON.stringify(res.errors, null, 2));
    expect(res.ok).toBe(true);
  });

  it("protects the workflows and the dependabot config", () => {
    expect(doc.paths.protected).toContain(".github/workflows/**");
    expect(doc.paths.protected).toContain(".github/dependabot.yml");
  });

  it("lets only hardening tighten guardrails, and only definition change the definition", () => {
    expect(doc.pipelines["product_work"]?.may_change).not.toContain("guardrails:tighten");
    expect(doc.pipelines["gardening"]?.may_change).not.toContain("guardrails:tighten");
    expect(doc.pipelines["hardening"]?.may_change).toContain("guardrails:tighten");
    expect(doc.pipelines["definition"]?.may_change).toContain("definition");
    expect(doc.pipelines["definition"]?.requires).toBe("trusted_human_approval");
  });

  it("requires a trusted human for a runner upgrade, and scopes it to the pin", () => {
    expect(doc.runner_upgrades?.requires).toBe("trusted_human_approval");
    expect(doc.runner_upgrades?.may_change).toBe("runner_pin");
  });

  it("detects all seven kinds of weakening", () => {
    expect(doc.weakening.detects).toHaveLength(7);
  });

  it("treats integration bots as untrusted", () => {
    expect(doc.trust.integration_bots).toContain("linear[bot]");
    expect(doc.trust.integration_bots).toContain("sentry-io[bot]");
  });

  it("never excludes .github/ from gh-aw's protected files, in any pipeline", () => {
    const exclude = doc.protected_files?.exclude ?? {};
    for (const [pipeline, list] of Object.entries(exclude)) {
      for (const entry of list) {
        expect(entry.startsWith(".github/"), `${pipeline} excludes ${entry}`).toBe(false);
      }
    }
  });

  it("excludes .factory/guardrails/ for hardening only, so its PRs are not auto-rejected", () => {
    const exclude = doc.protected_files?.exclude ?? {};
    expect(exclude["hardening"]).toContain(".factory/guardrails/");
    expect(exclude["product_work"] ?? []).toHaveLength(0);
    expect(exclude["gardening"] ?? []).toHaveLength(0);
  });
});

describe("default guardrail files", () => {
  it("baselines.json, coverage.json and candidates.json are valid and empty", () => {
    const read = (f: string): unknown => JSON.parse(readFileSync(join(TEMPLATES, "guardrails", f), "utf8"));
    assertValid("baselines", read("baselines.json"));
    assertValid("coverage", read("coverage.json"));
    assertValid("candidates", read("candidates.json"));
  });

  it("the coverage default makes diff coverage the main check", () => {
    const cov = JSON.parse(readFileSync(join(TEMPLATES, "guardrails/coverage.json"), "utf8")) as { diff_min_pct: number };
    expect(cov.diff_min_pct).toBe(80);
  });
});

describe("role workflows", () => {
  const frontmatter = (role: string): Record<string, unknown> => {
    const text = readFileSync(join(WORKFLOWS, `factory-role-${role}.md`), "utf8");
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    if (m?.[1] === undefined) throw new Error(`no frontmatter in ${role}`);
    return parseYaml(m[1]) as Record<string, unknown>;
  };

  it("there is one workflow per role", () => {
    const files = readdirSync(WORKFLOWS).filter((f) => f.startsWith("factory-role-"));
    expect(files).toHaveLength(ROLES.length);
    for (const r of ROLES) expect(files).toContain(`factory-role-${r}.md`);
  });

  for (const role of ROLES) {
    describe(role, () => {
      const fm = frontmatter(role);

      it("is a workflow_call reusable workflow, not a dispatched one", () => {
        // The spike's finding: as jobs, nothing polls and nothing is billed
        // while waiting, and transcript isolation becomes structural.
        const on = fm["on"] as Record<string, unknown>;
        expect(on).toHaveProperty("workflow_call");
        expect(on).not.toHaveProperty("workflow_dispatch");
      });

      it("mints safe-output tokens from the factory App, so its pushes start the gates", () => {
        expect(fm["github-app"]).toBeDefined();
      });

      it("runs the agent in AWF's read-only sandbox", () => {
        const sandbox = fm["sandbox"] as { agent?: { id?: string } } | undefined;
        expect(sandbox?.agent?.id).toBe("awf");
      });

      it("holds no write permission on the agent job", () => {
        const perms = fm["permissions"] as Record<string, string>;
        for (const [scope, level] of Object.entries(perms)) {
          expect(level, `${role} has ${scope}: ${level}`).toBe("read");
        }
      });

      it("restricts the network to the model API and package registries", () => {
        const net = fm["network"] as { allowed?: string[] } | undefined;
        expect(net?.allowed).toBeDefined();
        expect(net?.allowed).toContain("api.anthropic.com");
      });

      it("stays within the step time budget, well under the 6-hour job limit", () => {
        expect(fm["timeout-minutes"]).toBe(45);
      });
    });
  }

  it("only the builder and the hardener may open or push to a PR", () => {
    for (const role of ROLES) {
      const fm = frontmatter(role);
      const so = (fm["safe-outputs"] ?? {}) as Record<string, unknown>;
      const writes = "create-pull-request" in so || "push-to-pull-request-branch" in so;
      const expected = role === "builder" || role === "hardener";
      expect(writes, `${role} write access`).toBe(expected);
    }
  });

  it("every role that can write code passes a protected-files policy from its caller", () => {
    for (const role of ["builder", "hardener"] as const) {
      const fm = frontmatter(role);
      const so = fm["safe-outputs"] as Record<string, Record<string, unknown>>;
      const cpr = so["create-pull-request"]!;
      expect(cpr["protected-files"]).toBeDefined();
      expect(JSON.stringify(cpr["protected-files"])).toContain("protected_files_policy");
    }
  });

  it("every role runs threat detection on its safe outputs", () => {
    for (const role of ROLES) {
      const so = (frontmatter(role)["safe-outputs"] ?? {}) as Record<string, unknown>;
      expect(so["threat-detection"], `${role} has no threat detection`).toBeDefined();
    }
  });

  it("the verifier takes a commit, so its results are keyed by commit", () => {
    const on = frontmatter("verifier")["on"] as { workflow_call: { inputs: Record<string, unknown> } };
    expect(on.workflow_call.inputs["commit"]).toBeDefined();
  });

  it("the verifier never pushes code: its outputs are a verdict and evidence", () => {
    const on = frontmatter("verifier")["on"] as { workflow_call: { outputs: Record<string, unknown> } };
    expect(Object.keys(on.workflow_call.outputs)).toEqual(["verdict", "evidence"]);
  });

  it("every role can be run in staged mode, so acceptance tests need not spend on writes", () => {
    for (const role of ROLES) {
      const on = frontmatter(role)["on"] as { workflow_call: { inputs: Record<string, unknown> } };
      expect(on.workflow_call.inputs["staged"], `${role} has no staged input`).toBeDefined();
    }
  });
});

describe("trigger workflows", () => {
  const load = (f: string): Record<string, unknown> =>
    parseYaml(readFileSync(join(WORKFLOWS, f), "utf8")) as Record<string, unknown>;

  it("factory-policy runs on pull_request_target, so it always uses main's copy", () => {
    const on = load("factory-policy.yml")["on"] as Record<string, unknown>;
    expect(on).toHaveProperty("pull_request_target");
    expect(on).not.toHaveProperty("pull_request");
  });

  it("factory-policy checks out the default branch, never the PR's head", () => {
    const doc = load("factory-policy.yml") as { jobs: Record<string, { steps: { with?: Record<string, unknown> }[] }> };
    const checkout = doc.jobs["policy"]!.steps.find((s) => s.with?.["ref"] !== undefined);
    expect(String(checkout?.with?.["ref"])).toContain("default_branch");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("factory-run calls the roles as jobs rather than dispatching them", () => {
    const doc = load("factory-run.yml") as { jobs: Record<string, { uses?: string }> };
    const roleJobs = Object.values(doc.jobs).filter((j) => j.uses?.includes("factory-role-") === true);
    expect(roleJobs.length).toBeGreaterThanOrEqual(3);
    for (const j of roleJobs) expect(j.uses).toContain(".lock.yml");
  });

  it("factory-run sequences the roles with needs, so nothing polls", () => {
    const doc = load("factory-run.yml") as { jobs: Record<string, { needs?: unknown }> };
    expect(doc.jobs["build"]?.needs).toBeDefined();
    expect(doc.jobs["spec"]?.needs).toBeDefined();
  });

  it("factory-gates runs on merge_group, for repos with the native merge queue", () => {
    const on = load("factory-gates.yml")["on"] as Record<string, unknown>;
    expect(on).toHaveProperty("merge_group");
    expect(on).toHaveProperty("push");
  });

  it("no trigger workflow runs on a polling timer", () => {
    // An idle factory should cost almost nothing: only gardening, the review
    // check and the rollup sweep are scheduled, and none of those is here.
    for (const f of readdirSync(WORKFLOWS).filter((x) => x.endsWith(".yml"))) {
      const on = load(f)["on"] as Record<string, unknown>;
      expect(on, `${f} runs on a schedule`).not.toHaveProperty("schedule");
    }
  });
});

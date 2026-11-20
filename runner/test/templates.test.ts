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

      it("reaches the model API and every common package ecosystem", () => {
        // npm and PyPI only meant a Go, Rust, Ruby, Java or .NET repo could
        // not install its own dependencies inside the agent's sandbox.
        const net = fm["network"] as { allowed?: string[] } | undefined;
        expect(net?.allowed).toContain("api.anthropic.com");
        for (const eco of ["node", "python", "go", "rust", "ruby", "java", "dotnet"]) {
          expect(net?.allowed, eco).toContain(eco);
        }
      });

      it("stays within factory.yaml's step time budget, well under the 6-hour job limit", () => {
        const factory = parseYaml(readFileSync(join(TEMPLATES, "definition/factory.yaml"), "utf8")) as {
          limits: { step_time_budget_sec: number };
        };
        const minutes = fm["timeout-minutes"] as number;
        expect(minutes * 60).toBeLessThanOrEqual(factory.limits.step_time_budget_sec);
        expect(minutes).toBeLessThan(360);
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

  it("no role declares workflow_call outputs, because gh-aw does not accept them", () => {
    // gh-aw's workflow_call takes inputs and secrets only. So roles cannot
    // return a value as a job output; they exchange results by uploading an
    // artifact under a deterministic name within the run, which the next
    // role's pre-agent-steps downloads.
    for (const role of ROLES) {
      const on = frontmatter(role)["on"] as { workflow_call: Record<string, unknown> };
      expect(Object.keys(on.workflow_call), `${role} declares outputs`).not.toContain("outputs");
    }
  });

  it("every role uploads its step report as an artifact, which is how results travel", () => {
    for (const role of ROLES) {
      const post = frontmatter(role)["post-steps"] as { run?: string; uses?: string }[] | undefined;
      const text = JSON.stringify(post ?? []);
      expect(text, `${role} writes no step report`).toContain("step-report");
    }
  });

  it("the verifier never pushes code: it has no PR-writing safe output", () => {
    const so = frontmatter("verifier")["safe-outputs"] as Record<string, unknown>;
    expect(so).not.toHaveProperty("create-pull-request");
    expect(so).not.toHaveProperty("push-to-pull-request-branch");
    expect(so).toHaveProperty("upload-artifact");
  });

  it("the sandbox runtime is a literal, since gh-aw takes no expression there", () => {
    // Posture is therefore a compile-time decision: phase 2 picks it, phase 6
    // writes it in before compiling, and changing it later needs a recompile.
    for (const role of ROLES) {
      const sandbox = frontmatter(role)["sandbox"] as { agent?: { runtime?: string } } | undefined;
      const runtime = sandbox?.agent?.runtime;
      if (runtime !== undefined) {
        expect(runtime, `${role} runtime is an expression`).not.toContain("${{");
        expect(["docker", "docker-sudo-iptables", "cloud-hypervisor", "nvx"]).toContain(runtime);
      }
    }
  });

  it("no role sets allowed-files, which is an exclusive allowlist that would refuse normal source files", () => {
    for (const role of ROLES) {
      const so = (frontmatter(role)["safe-outputs"] ?? {}) as Record<string, Record<string, unknown>>;
      for (const [name, cfg] of Object.entries(so)) {
        if (cfg !== null && typeof cfg === "object") {
          expect(cfg["allowed-files"], `${role}.${name} sets allowed-files`).toBeUndefined();
        }
      }
    }
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

  it("only three workflows run on a timer, and they are the three doc 07 names", () => {
    // An idle factory should cost almost nothing. Nightly gardening, the
    // daily review check and the daily rollup sweep are the only schedules;
    // anything else on a timer would burn minutes doing nothing.
    const scheduled = readdirSync(WORKFLOWS)
      .filter((x) => x.endsWith(".yml"))
      .filter((f) => Object.prototype.hasOwnProperty.call(load(f)["on"] as object, "schedule"))
      .sort();
    expect(scheduled).toEqual(["factory-garden.yml", "factory-review.yml", "factory-rollup.yml"]);
  });

  it("there is one trigger workflow per row of doc 07's table", () => {
    const expected = [
      "factory-audit.yml", "factory-conflicts.yml", "factory-garden.yml", "factory-gates.yml",
      "factory-intake.yml", "factory-merge.yml", "factory-policy.yml", "factory-review.yml",
      "factory-rollup.yml", "factory-run.yml", "factory-setup-trial.yml", "factory-setup.yml", "factory-sync.yml",
    ];
    expect(readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml")).sort()).toEqual(expected);
  });

  it("every trigger workflow calls exactly one bsf command", () => {
    // The thin-trigger shape from doc 07: a workflow that did its own logic in
    // YAML would be logic nothing can test.
    for (const f of readdirSync(WORKFLOWS).filter((x) => x.endsWith(".yml"))) {
      const text = readFileSync(join(WORKFLOWS, f), "utf8");
      expect(/\bbsf [a-z-]+/.test(text), `${f} calls no bsf command`).toBe(true);
    }
  });

  it("each scheduled workflow can also be started by hand, so nobody waits a day to test it", () => {
    for (const f of ["factory-garden.yml", "factory-review.yml", "factory-rollup.yml"]) {
      expect(load(f)["on"]).toHaveProperty("workflow_dispatch");
    }
  });

  it("the single-concurrency workflows declare a concurrency group", () => {
    // intake, merge, rollup and sync must never run twice at once (doc 07).
    for (const f of ["factory-intake.yml", "factory-merge.yml", "factory-rollup.yml", "factory-sync.yml"]) {
      const doc = load(f) as { concurrency?: unknown; jobs?: Record<string, { concurrency?: unknown }> };
      const atJob = Object.values(doc.jobs ?? {}).some((j) => j.concurrency !== undefined);
      expect(doc.concurrency !== undefined || atJob, `${f} has no concurrency group`).toBe(true);
    }
  });

  it("intake queues pending runs rather than cancelling them, so no request is lost", () => {
    const text = readFileSync(join(WORKFLOWS, "factory-intake.yml"), "utf8");
    expect(text).toContain("cancel-in-progress: false");
  });
});

describe("definition templates", () => {
  const DEF = join(TEMPLATES, "definition");

  it("there is one role file per role, and each validates", () => {
    const files = readdirSync(join(DEF, "roles")).filter((f) => f.endsWith(".yaml")).sort();
    expect(files).toEqual([...ROLES].sort().map((r) => `${r}.yaml`));
    for (const f of files) {
      const doc = parseYaml(readFileSync(join(DEF, "roles", f), "utf8")) as unknown;
      const res = validate("role", doc);
      if (!res.ok) throw new Error(`${f}: ${JSON.stringify(res.errors, null, 2)}`);
    }
  });

  it("no role file is told it may read the builder's transcript", () => {
    // The verifier grading its own work is the failure this prevents, and it
    // is structural: separate jobs, separate filesystems (doc 06).
    for (const f of readdirSync(join(DEF, "roles")).filter((x) => x.endsWith(".yaml"))) {
      const doc = parseYaml(readFileSync(join(DEF, "roles", f), "utf8")) as { sees_builder_transcript?: boolean };
      expect(doc.sees_builder_transcript, `${f}`).toBe(false);
    }
  });

  it("there is a rubric per pipeline plus the shared one, and each validates", () => {
    const files = readdirSync(join(DEF, "rubrics")).filter((f) => f.endsWith(".yaml")).sort();
    expect(files).toEqual(["definition.yaml", "gardening.yaml", "hardening.yaml", "product_work.yaml", "shared.yaml"]);
    for (const f of files) {
      const doc = parseYaml(readFileSync(join(DEF, "rubrics", f), "utf8")) as unknown;
      const res = validate("rubric", doc);
      if (!res.ok) throw new Error(`${f}: ${JSON.stringify(res.errors, null, 2)}`);
    }
  });

  it("every rubric's failure tags are the vocabulary the review routes on", () => {
    // review.ts routes a problem by its tag, so a tag no rubric emits is a
    // route nothing can reach, and a tag the router has never heard of
    // silently defaults to hardening.
    const tags = new Set<string>();
    for (const f of readdirSync(join(DEF, "rubrics")).filter((x) => x.endsWith(".yaml"))) {
      const doc = parseYaml(readFileSync(join(DEF, "rubrics", f), "utf8")) as { failure_tags?: string[] };
      for (const t of doc.failure_tags ?? []) tags.add(t);
    }
    expect(tags.size).toBeGreaterThan(5);
    for (const t of tags) expect(t).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("the context templates exist, practices included, because roles read them", () => {
    const files = readdirSync(join(DEF, "context")).sort();
    expect(files).toEqual(["feature-map.md", "fundamentals.md", "history.md", "practices.md", "runbook.md"]);
  });

  it("the runbook template warns that the sandbox reads no .env file", () => {
    // This is the trinsports hazard generalized: a documented build command
    // that migrates a real database if a developer's .env is present.
    const text = readFileSync(join(DEF, "context/runbook.md"), "utf8");
    expect(text).toMatch(/\.env/);
    expect(text.toLowerCase()).toContain("persistent state");
  });
});

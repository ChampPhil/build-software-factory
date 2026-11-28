import { execFileSync, spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
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

// Ajv is CommonJS. createRequire is how an ESM test loads it without a
// bundler. The validator is built from the packed schema, not the source one.
const require = createRequire(import.meta.url);

/** The slice of Ajv this test calls. The full class is the CJS export. */
interface AjvLike {
  addSchema(schema: object, key: string): void;
  getSchema(key: string): ((data: unknown) => boolean) & { errors?: unknown } | undefined;
}

const ROOT = repoRoot();
const TEMPLATES = join(ROOT, "templates");
const WORKFLOWS = join(TEMPLATES, "workflows");

/** Every role with a workflow of its own. */
const ROLES = ["triage", "brainstorm", "spec", "builder", "verifier", "gardener", "hardener", "scorer"] as const;

/**
 * The roles a factory configures: a model in factory.yaml, a role file, a
 * rubric. The conversation is not one of them — it shares triage's model and
 * writes nothing for a rubric to judge, so requiring an entry for it would
 * make every factory that predates it fail its own doctor.
 */
const CONFIGURED_ROLES = ROLES.filter((r) => r !== "brainstorm");

describe("default factory.yaml", () => {
  const doc = parseYaml(readFileSync(join(TEMPLATES, "definition/factory.yaml"), "utf8")) as unknown;

  it("validates against the factory schema", () => {
    const res = validate("factory", doc);
    if (!res.ok) throw new Error(JSON.stringify(res.errors, null, 2));
    expect(res.ok).toBe(true);
  });

  it("validates against the schema packed in the runner the install copies", () => {
    // Source schema and the tarball can drift: the unit test above reads
    // schema/factory.json, and `bsf models` on a user's machine reads the
    // copy inside skill/runner/runner.tgz.
    const dir = mkdtempSync(join(tmpdir(), "bsf-packed-schema-"));
    execFileSync("tar", ["-xzf", join(ROOT, "skill/runner/runner.tgz"), "-C", dir, "schema"]);
    const ajvMod = require("ajv/dist/2020.js") as { default?: new (opts: object) => AjvLike } | (new (opts: object) => AjvLike);
    const Ajv2020 = typeof ajvMod === "function" ? ajvMod : ajvMod.default;
    if (Ajv2020 === undefined) throw new Error("ajv did not export a constructor");
    const formatsMod = require("ajv-formats") as { default?: (ajv: AjvLike) => void } | ((ajv: AjvLike) => void);
    const addFormats = typeof formatsMod === "function" ? formatsMod : formatsMod.default;
    if (addFormats === undefined) throw new Error("ajv-formats did not export a function");
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const schemaDir = join(dir, "schema");
    for (const file of readdirSync(schemaDir)) {
      if (!file.endsWith(".json") || file === "SURFACE.json") continue;
      ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, file), "utf8")) as object, file);
    }
    const check = ajv.getSchema("factory.json");
    if (check === undefined) throw new Error("packed schema/factory.json did not register");
    if (!check(doc)) throw new Error(JSON.stringify(check.errors, null, 2));
  });

  it("names a model for every role a factory configures", () => {
    const models = (doc as { models: Record<string, string> }).models;
    for (const r of CONFIGURED_ROLES) expect(models[r], `no model for ${r}`).toBeTruthy();
  });

  it("starts with every auto-merge toggle off", () => {
    const p = (doc as { pipelines: Record<string, { auto_merge: boolean }> }).pipelines;
    expect(p["product_work"]?.auto_merge).toBe(false);
    expect(p["gardening"]?.auto_merge).toBe(false);
    expect(p["hardening"]?.auto_merge).toBe(false);
    expect(p["definition_change"]?.auto_merge).toBe(false);
    expect(p["conflict_fix"]?.auto_merge).toBe(false);
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
    // Plus the host-access variants, which are derived, not separate roles.
    const files = readdirSync(WORKFLOWS).filter((f) => f.startsWith("factory-role-") && !f.endsWith("-host.md"));
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
    expect(on).toHaveProperty("pull_request");
    // Not push as well: the same commit was judged twice, once without its PR.
    expect(on).not.toHaveProperty("push");
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
      "factory-audit.yml", "factory-budget-settle.yml", "factory-conflicts.yml", "factory-drop.yml", "factory-garden.yml", "factory-gates.yml",
      "factory-intake.yml", "factory-journeys.yml", "factory-merge.yml", "factory-policy.yml", "factory-recompile.yml",
      "factory-review.yml", "factory-rollup.yml", "factory-run.yml", "factory-setup-boot.yml", "factory-setup-journeys.yml", "factory-setup-pr.yml", "factory-setup-recipe.yml", "factory-setup-rules.yml", "factory-setup-save.yml", "factory-setup-trial.yml", "factory-setup.yml", "factory-sync.yml",
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

  it("every action is pinned to a commit SHA, in workflows this repo runs and workflows it ships", () => {
    // An action referenced by a moving tag is whatever that tag points at the
    // next time the workflow runs. These workflows are installed into other
    // people's repositories and mint tokens, so a tag that moves under them is
    // a supply-chain hole in every factory at once, not just in this repo.
    //
    // The compiled gh-aw locks are pinned by the compiler, which is why this was
    // invisible for so long: `.lock.yml` looked fine while the plain `.yml` that
    // actually runs did not. The `.md` sources are pinned too, so a lock
    // compiled by hand matches the one CI compiles.
    const uses = /uses: *([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)@([A-Za-z0-9._-]+)/g;
    const dirs = [WORKFLOWS, join(repoRoot(), ".github", "workflows")];
    let checked = 0;
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".yml") || x.endsWith(".md"))) {
        const text = readFileSync(join(dir, f), "utf8");
        for (const m of text.matchAll(uses)) {
          checked += 1;
          expect(
            /^[0-9a-f]{40}$/.test(m[2] ?? ""),
            `${f}: ${m[1]}@${m[2]} is not pinned to a commit SHA. ` +
              "Resolve the tag (git ls-remote --tags https://github.com/" +
              `${m[1]}) and write it as ${m[1]}@<sha> # ${m[2]}.`,
          ).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
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
    expect(files).toEqual([...CONFIGURED_ROLES].sort().map((r) => `${r}.yaml`));
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

  it("there is a rubric for each pipeline the review grades plus the shared one, and each validates", () => {
    const files = readdirSync(join(DEF, "rubrics")).filter((f) => f.endsWith(".yaml")).sort();
    // No definition rubric: /practice runs are a person's own change and are not graded.
    expect(files).toEqual(["gardening.yaml", "hardening.yaml", "product_work.yaml", "shared.yaml"]);
    for (const f of files) {
      const doc = parseYaml(readFileSync(join(DEF, "rubrics", f), "utf8")) as unknown;
      const res = validate("rubric", doc);
      if (!res.ok) throw new Error(`${f}: ${JSON.stringify(res.errors, null, 2)}`);
    }
  });

  it("every rubric's failure tags are the vocabulary the review groups on", () => {
    // review.ts groups problems by tag, so a tag must be a plain identifier.
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

describe("factory-gates on the PR that installs the factory", () => {
  it("stands down instead of failing when the default branch has no runner yet", () => {
    const text = readFileSync(join(TEMPLATES, "workflows", "factory-gates.yml"), "utf8");
    const plan = text.slice(text.indexOf("\n  plan:\n"), text.indexOf("\n  static:\n"));
    expect(plan).toMatch(/if \[ ! -f \.factory-trusted\/\.factory\/bin\/bsf \]; then[\s\S]*installed=false[\s\S]*exit 0/);
    expect(plan).toContain("if: steps.trusted.outputs.installed == 'true'");
    expect(plan).toContain("judge: ${{ steps.trusted.outputs.installed == 'false' && 'false' ||");
  });

  it("judges by default: only an explicit 'false' skips the gates, so an older runner without the output still judges", () => {
    const text = readFileSync(join(TEMPLATES, "workflows", "factory-gates.yml"), "utf8");
    expect(text).not.toContain("outputs.judge == 'true'");
    expect(text.match(/outputs\.judge != 'false'/g)?.length).toBe(5);
  });
});

describe("factory-gates on a PR that upgrades the factory", () => {
  // trinsports#4: the default branch's runner, older than the PR's workflows,
  // failed every gate on a PR that changed nothing but the factory's files.
  const text = readFileSync(join(TEMPLATES, "workflows", "factory-gates.yml"), "utf8");
  const doc = parseYaml(text) as { jobs: { plan: { steps: { id?: string; run?: string }[] } } };
  const script = doc.jobs.plan.steps.find((st) => st.id === "trusted")!.run!;

  function runPlanStep(change: (dir: string) => void): string {
    const dir = mkdtempSync(join(tmpdir(), "bsf-upgrade-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir });
    git("init", "-q");
    mkdirSync(join(dir, ".factory/bin"), { recursive: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, ".factory/bin/VERSION"), "0.1.0 aaa\n");
    writeFileSync(join(dir, ".factory/bin/bsf"), "#!/bin/sh\necho bsf\n", { mode: 0o755 });
    writeFileSync(join(dir, "src/a.js"), "1\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    mkdirSync(join(dir, ".factory-trusted/.factory/bin"), { recursive: true });
    writeFileSync(join(dir, ".factory-trusted/.factory/bin/VERSION"), "0.1.0 aaa\n");
    writeFileSync(join(dir, ".factory-trusted/.factory/bin/bsf"), "#!/bin/sh\necho bsf\n", { mode: 0o755 });
    change(dir);
    git("add", "src", ".factory/bin");
    git("commit", "-qm", "change");
    const out = join(dir, "out");
    writeFileSync(out, "");
    const body = script
      .replaceAll("${{ github.event_name }}", "pull_request")
      .replaceAll("${{ github.event.pull_request.base.sha }}", base);
    spawnSync("bash", ["-c", body], {
      cwd: dir,
      env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_ENV: join(dir, "env"), GITHUB_PATH: join(dir, "path"), GITHUB_STEP_SUMMARY: join(dir, "sum"), RUNNER_TEMP: join(dir, "tmp") },
    });
    return readFileSync(out, "utf8");
  }

  it("stands down, and says why, when the PR changes only the runner and the factory's files", () => {
    const out = runPlanStep((d) => writeFileSync(join(d, ".factory/bin/VERSION"), "0.2.0 bbb\n"));
    expect(out).toContain("installed=false");
    expect(out).toContain("upgrade=true");
    expect(out).toMatch(/upgrades the factory from 0\.1\.0 aaa to 0\.2\.0 bbb/);
  });

  it("still judges a PR that changes the runner and app code together", () => {
    const out = runPlanStep((d) => {
      writeFileSync(join(d, ".factory/bin/VERSION"), "0.2.0 bbb\n");
      writeFileSync(join(d, "src/a.js"), "2\n");
    });
    expect(out).toContain("installed=true");
    expect(out).not.toContain("upgrade=true");
  });
});

describe("host-access role variants", () => {
  it("are exactly what scripts/host-variants.mjs derives from the base roles", () => {
    const r = spawnSync(process.execPath, [join(ROOT, "runner/scripts/host-variants.mjs"), "--check"], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

describe("installer and the harness", () => {
  it("switches a repo left on Cursor back to Claude Code, models included", () => {
    const root = repoRoot();
    const dir = mkdtempSync(join(tmpdir(), "bsf-harness-"));
    execFileSync("git", ["init", "-q", dir]);
    mkdirSync(join(dir, ".factory/definition"), { recursive: true });
    const cursorCfg = readFileSync(join(root, "templates/definition/factory.yaml"), "utf8")
      .replace("harness: claude-code", "harness: cursor-cli")
      .replace(/^(  \w+: )claude-[\w.-]+$/gm, "$1auto");
    writeFileSync(join(dir, ".factory/definition/factory.yaml"), cursorCfg);
    execFileSync("node", [join(root, "skill/scripts/install-factory.mjs"), "--into", dir], { encoding: "utf8" });
    const cfg = parseYaml(readFileSync(join(dir, ".factory/definition/factory.yaml"), "utf8")) as { harness: string; models: Record<string, string> };
    expect(cfg.harness).toBe("claude-code");
    expect(cfg.models).toMatchObject({ spec: "claude-opus-5-5", builder: "claude-sonnet-5-5", verifier: "claude-haiku-5-5", triage: "claude-haiku-5-5" });
    expect(readFileSync(join(dir, ".github/workflows/factory-role-builder.md"), "utf8")).toContain("id: claude");
  });

  it("stages the launcher executable in the git index, not just on disk", () => {
    // `chmod` alone is what the first live install did, and on Windows the
    // filesystem carries no execute bit for git to read: the file was
    // committed 100644 and every pipeline step died with exit 126 on a Linux
    // runner, in a step that had nothing to do with the user's change.
    const root = repoRoot();
    const dir = mkdtempSync(join(tmpdir(), "bsf-mode-"));
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("node", [join(root, "skill/scripts/install-factory.mjs"), "--into", dir], { encoding: "utf8" });
    const staged = execFileSync("git", ["-C", dir, "ls-files", "-s", "--", ".factory/bin/bsf"], { encoding: "utf8" }).trim();
    expect(staged.split(/\s+/)[0]).toBe("100755");
  });

  it("installs a launcher for Windows beside the POSIX one", () => {
    // Setup runs on the user's own machine, which is as often Windows as not.
    // A `sh` script there runs as nothing and exits 0, so `bsf dashboard-link`
    // and `bsf mine-corrections --list` both "succeeded" silently — and the
    // skill, told never to invent a dashboard link, said nothing about the
    // dashboard at all.
    const root = repoRoot();
    const dir = mkdtempSync(join(tmpdir(), "bsf-win-"));
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("node", [join(root, "skill/scripts/install-factory.mjs"), "--into", dir], { encoding: "utf8" });
    const cmd = readFileSync(join(dir, ".factory/bin/bsf.cmd"), "utf8");
    expect(cmd.startsWith("@echo off")).toBe(true);
    // `cmd` mis-parses a batch file whose lines end with LF alone.
    expect(cmd).toContain("\r\n");
    expect(cmd).not.toMatch(/[^\r]\n/);
    // Both launchers must unpack the same runner.
    const sh = readFileSync(join(dir, ".factory/bin/bsf"), "utf8");
    const digest = /bsf-([0-9a-f]{12})/.exec(sh)?.[1];
    expect(digest, "the POSIX launcher names a cache directory").toBeDefined();
    expect(cmd).toContain(`bsf-${digest ?? ""}`);
  });
});

describe("the budget in the workflows", () => {
  const AGENT_FILES = readdirSync(WORKFLOWS).filter((f) => /^factory-(role-.*|setup-agent)\.md$/.test(f));
  const fm = (f: string): Record<string, unknown> => {
    const text = readFileSync(join(WORKFLOWS, f), "utf8");
    return parseYaml(text.slice(4, text.indexOf("\n---\n", 4))) as Record<string, unknown>;
  };

  it("every agent step holds its budget before the agent, with its own cap", () => {
    for (const f of AGENT_FILES) {
      const doc = fm(f);
      const pre = (doc["pre-agent-steps"] as { run?: string }[]).map((s) => s.run ?? "").join("\n");
      const m = /bsf budget reserve .*--cap (\d+) --detection-model ([\w.-]+) --detection-cap (\d+)/.exec(pre);
      expect(m, `${f} holds no budget`).not.toBeNull();
      expect(Number(m![1]), `${f}: --cap differs from max-ai-credits`).toBe(doc["max-ai-credits"]);
      const det = (doc["safe-outputs"] as { "threat-detection": { engine: { model: string }; "max-ai-credits": number } })["threat-detection"];
      expect(m![2], f).toBe(det.engine.model);
      expect(Number(m![3]), `${f}: --detection-cap differs`).toBe(det["max-ai-credits"]);
      // The hold comes before the sandbox starts or anything is fetched.
      const steps = doc["pre-agent-steps"] as { name: string }[];
      const hold = steps.findIndex((s) => s.name === "Hold this step's budget");
      const sandbox = steps.findIndex((s) => s.name === "Start the sandbox");
      if (sandbox >= 0) expect(hold, f).toBeLessThan(sandbox);
    }
  });

  it("the setup agent's daily credit cap is above the default that skipped computers on a zero spend", () => {
    const doc = fm("factory-setup-agent.md");
    expect(doc["max-daily-ai-credits"]).toBe(50000);
    const lock = readFileSync(join(ROOT, "templates/compiled/factory-setup-agent.lock.yml"), "utf8");
    expect(lock).toContain('GH_AW_MAX_DAILY_AI_CREDITS: "50000"');
    expect(lock).not.toContain("|| '5000'");
    // Each computer in one setup run calls this workflow. A group that is only
    // the parent run id makes them wait on each other.
    expect(lock).toContain("gh-aw-factory-setup-agent-${{ github.run_id }}-${{ inputs.budget_key }}");
    expect(lock).toContain("gh-aw-claude-factory-setup-agent-${{ inputs.budget_key }}");
    expect(lock).toContain("gh-aw-conclusion-factory-setup-agent-${{ inputs.budget_key }}");
    expect(lock).not.toContain('group: "gh-aw-factory-setup-agent-${{ github.run_id }}"');
  });

  it("the budget's table of caps matches every role workflow", async () => {
    const { ROLE_CAPS, DETECTION } = await import("../src/commands/budget.js");
    for (const f of AGENT_FILES) {
      const doc = fm(f);
      const role = f.replace(/^factory-(role-)?/, "").replace(/(-host)?\.md$/, "").replace("setup-agent", "setup");
      expect(ROLE_CAPS[role], `${f}: no cap for ${role}`).toBe(doc["max-ai-credits"]);
      const det = (doc["safe-outputs"] as { "threat-detection": { engine: { model: string }; "max-ai-credits": number } })["threat-detection"];
      expect(det["max-ai-credits"], f).toBe(DETECTION.capCredits);
      expect(det.engine.model, f).toBe(DETECTION.model);
    }
  });

  it("every agent step is capped, and bounds each request the way the budget's margin assumes", () => {
    for (const f of AGENT_FILES) {
      const doc = fm(f);
      expect(typeof doc["max-ai-credits"], `${f} has no credit cap`).toBe("number");
      const env = (doc["engine"] as { env: Record<string, string> }).env;
      expect(env["CLAUDE_CODE_DISABLE_1M_CONTEXT"], f).toBe("1");
      expect(env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], f).toBe("32000");
      const det = (doc["safe-outputs"] as { "threat-detection": { engine: { env: Record<string, string> }; "max-ai-credits": number } })["threat-detection"];
      expect(typeof det["max-ai-credits"], `${f}: detection is uncapped`).toBe("number");
      expect(det.engine.env["CLAUDE_CODE_DISABLE_1M_CONTEXT"], f).toBe("1");
      expect(det.engine.env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], f).toBe("32000");
    }
  });

  it("every agent step runs on a model the budget can price", async () => {
    const { PRICES } = await import("../src/lib/prices.js");
    const cfg = parseYaml(readFileSync(join(repoRoot(), "templates/definition/factory.yaml"), "utf8")) as { models: Record<string, string> };
    for (const [role, model] of Object.entries(cfg.models)) expect(PRICES[model], `${role}: ${model} has no price`).toBeDefined();
    for (const f of AGENT_FILES) {
      const det = (fm(f)["safe-outputs"] as { "threat-detection": { engine: { model: string } } })["threat-detection"];
      expect(PRICES[det.engine.model], f).toBeDefined();
    }
  });

  it("every agent step passes the model its caller was given, so factory.yaml decides it", () => {
    for (const f of AGENT_FILES) {
      expect((fm(f)["engine"] as { model: string }).model, f).toBe("${{ inputs.model }}");
    }
  });

  it("every role call is settled with the same key, before the next agent step", () => {
    for (const f of readdirSync(WORKFLOWS).filter((x) => x.endsWith(".yml"))) {
      const wf = parseYaml(readFileSync(join(WORKFLOWS, f), "utf8")) as {
        jobs: Record<string, { uses?: string; needs?: string | string[]; with?: Record<string, string> }>;
      };
      for (const [id, job] of Object.entries(wf.jobs ?? {})) {
        if (!/factory-(role-|setup-agent)/.test(job.uses ?? "")) continue;
        const key = job.with?.["budget_key"];
        expect(key, `${f}:${id} passes no budget_key`).toBe(`\${{ github.run_id }}-\${{ github.run_attempt }}-${id}`);
        const settle = wf.jobs[`${id}-budget`];
        expect(settle?.uses, `${f}:${id} is never settled`).toBe("./.github/workflows/factory-budget-settle.yml");
        expect(settle!.with!["key"], f).toBe(key);
        for (const [other, j] of Object.entries(wf.jobs)) {
          const needs = ([] as string[]).concat(j.needs ?? []);
          if (other !== `${id}-budget` && needs.includes(id)) {
            expect(needs, `${f}:${other} starts before ${id}'s hold is settled`).toContain(`${id}-budget`);
          }
        }
      }
    }
  });
  it("a trial replaces the stubs folder instead of copying into it (an amendment's new stubs must land at the path the manifest names)", () => {
    for (const f of ["factory-setup-trial.yml", "factory-setup.yml"]) {
      const text = readFileSync(join(TEMPLATES, "workflows", f), "utf8");
      const copy = text.split("\n").find((l) => l.includes("cp -R") && l.toLowerCase().includes("design") && l.includes("/stubs"));
      expect(copy, `${f} copies no stubs`).toBeDefined();
      expect(copy, `${f} copies stubs without clearing the old folder first`).toMatch(/rm -rf \.factory\/sandbox\/stubs/);
    }
  });
  it("a factory upgrade does not design setup again once a sandbox is frozen, but a manual run still can", () => {
    const wf = parseYaml(readFileSync(join(TEMPLATES, "workflows/factory-setup.yml"), "utf8")) as {
      jobs: { ready: { steps: { name?: string; id?: string; if?: string; run?: string }[] } };
    };
    const steps = wf.jobs.ready.steps;
    const guard = steps.find((st) => st.id === "finished");
    expect(guard, "no finished-check step").toBeDefined();
    expect(guard?.if).toBe("github.event_name == 'push'");
    for (const id of ["doctor"]) {
      expect(steps.find((st) => st.id === id)?.if).toBe("steps.finished.outputs.done != 'true'");
    }
    const run = (withManifest: boolean): string => {
      const dir = mkdtempSync(join(tmpdir(), "bsf-fin-"));
      mkdirSync(join(dir, ".factory-trusted/.factory/sandbox"), { recursive: true });
      if (withManifest) writeFileSync(join(dir, ".factory-trusted/.factory/sandbox/manifest.json"), "{}");
      const out = join(dir, "out");
      writeFileSync(out, "");
      writeFileSync(join(dir, "summary"), "");
      spawnSync("bash", ["-c", guard?.run ?? ""], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(dir, "summary") } });
      return readFileSync(out, "utf8");
    };
    expect(run(true)).toContain("done=true");
    expect(run(false)).not.toContain("done=true");
  });
});

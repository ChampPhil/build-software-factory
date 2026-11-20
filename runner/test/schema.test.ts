import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validate, assertValid, checkSchemaTag, SchemaError,
  SCHEMA_NAMES, SCHEMA_DIR, type SchemaName,
  isSchemaFile,
} from "../src/lib/schema.js";

/** Every doc-09 example, as a valid fixture per schema. */
const valid: Record<SchemaName, unknown> = {
  "work-item": {
    schema: "work-item/1",
    id: "wi_01JD8Z0000000000000000000A",
    created_at: "2026-11-18T23:40:00Z",
    source: { kind: "issue", ref: "#142", actor: "philip", via: "slack" },
    trigger_class: "signal",
    pipeline: "product_work",
    title: "Export button downloads an empty file",
    body: "steps to reproduce…",
    priority: "normal",
    fingerprint: "sha256:" + "a".repeat(64),
    status: "queued",
    runs: [],
    pr: null,
    parent: null,
    related: [],
    spec: null,
  },
  run: {
    schema: "run/1",
    id: "run_01JD9A000000000000000000AB",
    work_item: "wi_01JD8Z0000000000000000000A",
    pipeline: "product_work",
    actor: { kind: "agent", harness: "claude-code" },
    started_at: "2026-11-18T23:40:00Z",
    ended_at: "2026-11-19T00:10:40Z",
    duration_sec: 1840,
    outcome: "draft_pr",
    pr: 311,
    steps: [
      { role: "triage", model: "m", duration_sec: 120, tokens: { in: 41000, out: 2100, cached: 30000 }, cost_usd: 0.21, transcript: "sessions/x.jsonl" },
      { role: "builder", attempt: 2, model: "m", duration_sec: 500, tokens: { in: 1, out: 1 }, cost_usd: 1.63, exit: "ok", transcript: null },
    ],
    gates: [
      { gate: "static", attempt: 1, result: "fail", failures: [{ rule: "no-raw-fetch", file: "src/export/download.ts", line: 42 }] },
      { gate: "static", attempt: 2, result: "pass" },
      { gate: "verification", attempt: 1, result: "pass", coverage: { diff_pct: 94, total_pct: 81.2 } },
    ],
    artifacts: {
      stored: [{ kind: "screenshot", path: "media/run_x/export-ok.png", caption: "Non-empty CSV downloads", expires_at: "2027-11-18" }],
      expiring: [{ kind: "video", artifact_id: 88213, expires_at: "2027-02-16" }],
    },
    cost_usd: 1.84,
    escalated: false,
  },
  ledger: {
    schema: "ledger/1",
    updated_at: "2026-11-18T23:45:00Z",
    open: [{ work_item: "wi_01JD8Z0000000000000000000A", pipeline: "product_work", status: "running", fingerprint: "sha256:" + "b".repeat(64), pr: 311, fixes: ["rule:no-raw-fetch@src/export"] }],
    recent: [{ work_item: "wi_01JD8Z0000000000000000000B", status: "merged", merged_at: "2026-11-17T10:00:00Z", fingerprint: "sha256:" + "c".repeat(64) }],
    merge_queue: [{ pr: 309, eligible_at: "2026-11-18T23:30:00Z" }],
  },
  index: {
    schema: "index/1",
    updated_at: "2026-11-18T23:45:00Z",
    factory: { runner: "v1.0.3", harness: "claude-code", setup_completed_at: "2026-11-01T00:00:00Z" },
    metrics: {
      window_days: 30, automation_rate: 0.62, cycle_time_p50_sec: 5400, cycle_time_p90_sec: 21600,
      spend_usd: 141.2, budget_usd: 200, runs: 214, merged: 131, escalated: 9, revert_rate: 0.008,
      by_pipeline: { product_work: { runs: 120, merged: 80, spend_usd: 98.4 } },
    },
    daily: [{ date: "2026-11-18", runs: 9, merged: 6, spend_usd: 5.1 }],
    recent_runs: ["run_01JD9A000000000000000000AB"],
    guardrails: { rules: 47, baselined: 3, coverage_floor_pct: 81, candidates_pending: 4 },
    health: { gardening_schedule_active: true, last_review: "rev_20261118", lock_files_current: true },
  },
  live: {
    schema: "live/1", run: "run_01JD9A000000000000000000AB", work_item: "wi_01JD8Z0000000000000000000A",
    pipeline: "product_work", step: "gate", gate: "static", attempt: 2, of: 3,
    started_at: "2026-11-18T23:40:00Z", cost_usd_so_far: 0.92,
  },
  baselines: {
    schema: "baselines/1",
    rules: {
      "no-raw-fetch": { count: 37, recorded_at: "2026-11-18T00:00:00Z", by_file: { "src/export/download.ts": 3, "src/billing/api.ts": 2 } },
      "one-folder-per-feature": { count: 0, retired: true },
    },
  },
  coverage: { schema: "coverage/1", high_pct: 82, floor_pct: 81, tolerance_pts: 1, diff_min_pct: 80, skips: { count: 4, cap: 10 } },
  candidates: {
    schema: "candidates/1",
    candidates: [{
      id: "cand_01JD000000000000000000000A",
      problem_class: "Network calls bypass apiClient",
      occurrences: 15,
      sources: [
        { kind: "agent_chat", harness: "claude-code", session: "s1", quote: "no, use apiClient instead" },
        { kind: "review_comment", pr: 87 },
        { kind: "revert", commit: "a1b2c3d" },
      ],
      proposed_fix: "static_rule",
      status: "pending",
    }],
  },
  "step-report": {
    schema: "step-report/1", harness: "kilo-code", role: "builder", model: "m", exit: "ok",
    duration_sec: 512, tokens: { in: 182000, out: 9400, cached: 120000 }, cost_usd: 0.94,
    files_changed: ["src/export/download.ts"], transcript: "/tmp/bsf/run/builder-2.jsonl",
  },
  factory: {
    schema: "factory/1", harness: "claude-code",
    models: { triage: "m", spec: "m", builder: "m", verifier: "m", gardener: "m", hardener: "m", scorer: "m" },
    pipelines: {
      product_work: { auto_merge: false },
      gardening: { auto_merge: false, schedule: "0 6 * * *", max_prs_per_run: 5 },
      hardening: { auto_merge: false },
    },
    review: { every_days: 3, run_early_at_runs: 50, skip_below_runs: 10 },
    limits: { retry_cap: 3, step_time_budget_sec: 2700, concurrency: { max_runs: 5 } },
    budget: { monthly_usd: 200, monthly_actions_minutes: 2000, shares: { product_work: 60, gardening: 25, review_and_benchmarks: 15 }, product_work_hard_stop_pct: 110 },
    triggers: { issues: true, comments: true, ci_failure_on_main: true, dashboard_dispatch: true },
    data: { location: "same_repo", repo: null, sessions: "auto", media_retention_months: 12 },
    enforcement: { merge_queue: "auto", branch_protection: "auto", audit_revert_pr: false },
    human_prs: { gates: "deterministic", verify_label: "factory:verify" },
    existing_ci: { test_check: null, wait_minutes: 15 },
  },
  policy: {
    schema: "policy/1",
    trust: { associations: ["OWNER", "MEMBER", "COLLABORATOR"], accept_label: "factory:accept", integration_bots: ["linear[bot]"] },
    paths: {
      definition: [".factory/definition/**"],
      guardrails: [".factory/guardrails/**", ".eslintrc*"],
      tests: ["**/*.test.*", "**/test_*.py", "tests/**"],
      protected: [".github/workflows/**", ".github/dependabot.yml"],
    },
    pipelines: {
      product_work: { may_change: ["code", "tests"] },
      gardening: { may_change: ["code", "tests"] },
      hardening: { may_change: ["code", "tests", "guardrails:tighten"] },
      definition: { may_change: ["definition"], requires: "trusted_human_approval" },
    },
    tests: { declared_edits: "required" },
    weakening: { requires: "trusted_human_approval", detects: ["rule_removed", "baseline_raised", "coverage_floor_lowered"] },
    protected_files: {
      policy: "request-review",
      exclude: { product_work: [], gardening: [], hardening: [".factory/guardrails/", "/pyproject.toml"], definition: [".factory/definition/"] },
    },
  },
  role: {
    schema: "role/1", id: "builder",
    purpose: "Implement the spec with the smallest correct change, plus tests for new behavior.",
    reads_context: ["feature-map", "runbook", "fundamentals", "history"],
    tools: ["read", "edit", "shell", "git"],
    prompt: "You are the builder for <repo>.",
    outputs: ["diff", "tests", "notes"],
  },
  rubric: {
    schema: "rubric/1", pipeline: "product_work",
    criteria: [{ id: "followed_intent", question: "Does the change do what the work item asked, and nothing else?" }, { id: "minimal_change" }],
    scale: "1-5",
    failure_tags: ["wrong_scope", "pattern_drift", "weak_tests", "missing_evidence", "context_gap", "wrong_model_fit"],
  },
  review: {
    schema: "review/1", id: "rev_20261121",
    window: { from: "2026-11-18T00:00:00Z", to: "2026-11-21T00:00:00Z", runs: 63 },
    scores: [{ run: "run_01JD9A000000000000000000AB", criterion: "meaningful_tests", score: 2, tags: ["weak_tests"], note: "asserts on mocks" }],
    problems: [{
      title: "Builder ignores the Seed data runbook step", route: "definition", change: "context/runbook.md", pr: 330,
      benchmark: { tasks: 12, repeats: 3, failure_tasks: 4, before: { mean: 0.71, spread: 0.04 }, after: { mean: 0.83, spread: 0.03 }, failure_tasks_before: 0.4, failure_tasks_after: 0.78, regressions: 0 },
    }],
  },
  rulepack: {
    schema: "rulepack/1",
    language: "typescript",
    extensions: [".ts", ".tsx"],
    tools: [{
      id: "eslint", kind: "linter", detect: ["eslint.config.*"],
      config_file: "eslint.config.mjs", install: "npm i -D eslint",
      check: "npx eslint .", fix: "npx eslint . --fix",
      native_baseline: "eslint-suppressions.json",
      base_config: { languageOptions: { ecmaVersion: 2022, sourceType: "module" } },
    }],
    rules: [{
      id: "no-var",
      concern: "`var` is function-scoped and hoisted, so a captured loop variable is not what anyone expects.",
      tool: "eslint",
      config: { "no-var": "error" },
      bad: "var x = 1;",
      good: "const x = 1;",
      autofixable: true,
      severity: "error",
      critical_logic: false,
    }],
  },
  "benchmark-task": {
    schema: "benchmark-task/1", id: "bt_01JD000000000000000000000A",
    source_run: "run_01JD9A000000000000000000AB", origin: "succeeded", pipeline: "product_work",
    base_commit: "9f8e7d6",
    request: { title: "Export empty file", body: "…" },
    reference: { merged_commit: "1a2b3c4", tests: ["src/export/download.test.ts"] },
    grading: { must_pass: ["src/export/download.test.ts"], rubric: "product_work" },
    tags: ["representative", "export"],
  },
};

describe("schema registry", () => {
  it("has a file for every declared schema name", () => {
    const files = new Set(readdirSync(SCHEMA_DIR));
    for (const n of SCHEMA_NAMES) expect(files.has(`${n}.json`), `${n}.json missing`).toBe(true);
  });

  it("does not treat the frozen surface as a schema", () => {
    // SURFACE.json sits beside the schemas on purpose, so every reader of
    // the directory has to skip it; ajv would otherwise register it.
    expect(isSchemaFile("SURFACE.json")).toBe(false);
    expect(isSchemaFile("run.json")).toBe(true);
    expect(isSchemaFile("README.md")).toBe(false);
  });

  it("every schema file is itself valid JSON with an $id and a title", () => {
    for (const f of readdirSync(SCHEMA_DIR).filter(isSchemaFile)) {
      const doc = JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")) as Record<string, unknown>;
      expect(doc["$id"], `${f} has no $id`).toBeTypeOf("string");
      expect(doc["title"], `${f} has no title`).toBeTypeOf("string");
    }
  });

  it("has a valid fixture for every schema", () => {
    for (const n of SCHEMA_NAMES) expect(valid[n], `no fixture for ${n}`).toBeDefined();
  });
});

describe("valid fixtures", () => {
  for (const name of SCHEMA_NAMES) {
    it(`${name}: doc-09 example validates`, () => {
      const res = validate(name, valid[name]);
      if (!res.ok) throw new Error(`${name}: ${JSON.stringify(res.errors, null, 2)}`);
      expect(res.ok).toBe(true);
    });
  }
});

describe("schema tag", () => {
  it("accepts the major this runner reads", () => {
    expect(checkSchemaTag("run", valid.run).ok).toBe(true);
  });

  it("rejects a major it does not know, rather than reporting shape errors", () => {
    const res = checkSchemaTag("run", { ...(valid.run as object), schema: "run/2" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]?.message).toContain("unknown major 2");
  });

  it("rejects a tag naming another schema", () => {
    const res = checkSchemaTag("run", { schema: "index/1" });
    expect(res.ok).toBe(false);
  });

  it("rejects a missing tag", () => {
    expect(checkSchemaTag("run", {}).ok).toBe(false);
    expect(checkSchemaTag("run", null).ok).toBe(false);
  });
});

describe("invalid documents are rejected", () => {
  it("unknown properties are not silently accepted", () => {
    const res = validate("coverage", { ...(valid.coverage as object), surprise: 1 });
    expect(res.ok).toBe(false);
  });

  it("a baseline count cannot be negative", () => {
    const res = validate("baselines", {
      schema: "baselines/1", rules: { r: { count: -1 } },
    });
    expect(res.ok).toBe(false);
  });

  it("a work item needs a known pipeline", () => {
    const res = validate("work-item", { ...(valid["work-item"] as object), pipeline: "nonsense" });
    expect(res.ok).toBe(false);
  });

  it("a malformed id is rejected", () => {
    const res = validate("work-item", { ...(valid["work-item"] as object), id: "wi_lowercase" });
    expect(res.ok).toBe(false);
  });

  it("a step report with no token data is rejected, so a non-conforming harness cannot ship", () => {
    const { tokens, ...noTokens } = valid["step-report"] as Record<string, unknown>;
    expect(tokens).toBeDefined();
    expect(validate("step-report", noTokens).ok).toBe(false);
  });

  it("a role may not declare that it sees the builder's transcript", () => {
    const res = validate("role", { ...(valid.role as object), sees_builder_transcript: true });
    expect(res.ok).toBe(false);
  });

  it("policy may not exclude .github/ from gh-aw's protected files, in any pipeline", () => {
    const base = valid.policy as { protected_files: { policy: string; exclude: Record<string, string[]> } };
    const res = validate("policy", {
      ...(valid.policy as object),
      protected_files: {
        policy: base.protected_files.policy,
        exclude: { ...base.protected_files.exclude, hardening: [".github/workflows/"] },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("a rule pack rule with no bad example is rejected, so an unverifiable rule cannot ship", () => {
    const pack = JSON.parse(JSON.stringify(valid.rulepack)) as { rules: Record<string, unknown>[] };
    delete pack.rules[0]!["bad"];
    expect(validate("rulepack", pack).ok).toBe(false);
  });

  it("a rule pack naming a language with no pack is rejected", () => {
    expect(validate("rulepack", { ...(valid.rulepack as object), language: "cobol" }).ok).toBe(false);
  });

  it("a benchmark comparison under 10 tasks or 3 repeats is rejected", () => {
    const r = valid.review as { problems: { benchmark: Record<string, unknown> }[] };
    const bench = r.problems[0]?.benchmark;
    expect(bench).toBeDefined();
    const withFew = JSON.parse(JSON.stringify(valid.review)) as typeof r;
    withFew.problems[0]!.benchmark = { ...bench!, tasks: 9 };
    expect(validate("review", withFew).ok).toBe(false);
    const withFewRepeats = JSON.parse(JSON.stringify(valid.review)) as typeof r;
    withFewRepeats.problems[0]!.benchmark = { ...bench!, repeats: 2 };
    expect(validate("review", withFewRepeats).ok).toBe(false);
  });

  it("factory config with data.location=repo must name the repo", () => {
    const f = valid.factory as { data: Record<string, unknown> };
    const res = validate("factory", {
      ...(valid.factory as object),
      data: { ...f.data, location: "repo", repo: null },
    });
    expect(res.ok).toBe(false);
  });
});

describe("assertValid", () => {
  it("returns the document when it is valid", () => {
    expect(assertValid<{ id: string }>("run", valid.run).id).toBe("run_01JD9A000000000000000000AB");
  });

  it("throws a SchemaError naming the failing paths", () => {
    try {
      assertValid("coverage", { schema: "coverage/1", high_pct: 200, floor_pct: 1, tolerance_pts: 1, diff_min_pct: 80, skips: { count: 0, cap: 1 } });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaError);
      expect((e as SchemaError).message).toContain("/high_pct");
    }
  });
});

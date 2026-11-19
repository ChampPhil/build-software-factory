import { describe, it, expect } from "vitest";
import {
  checkRatchet, countsFromBaselines, checkGardeningLowersTarget,
  checkWeakening, checkCoverage, planGates,
  type RuleCounts, type WeakeningInput,
} from "../src/commands/gates.js";
import type { Baselines, Coverage, Policy } from "../src/lib/types.js";

const policy: Policy = {
  schema: "policy/1",
  trust: { associations: ["OWNER"], accept_label: "factory:accept" },
  paths: { definition: [".factory/definition/**"], guardrails: [".factory/guardrails/**"], tests: ["**/*.test.*"], protected: [".github/workflows/**"] },
  pipelines: { product_work: { may_change: ["code", "tests"] }, gardening: { may_change: ["code", "tests"] }, hardening: { may_change: ["code", "tests", "guardrails:tighten"] }, definition: { may_change: ["definition"], requires: "trusted_human_approval" } },
  tests: { declared_edits: "required" },
  weakening: {
    requires: "trusted_human_approval",
    detects: ["rule_removed", "rule_loosened", "baseline_raised", "native_suppressions_added", "unpruned_suppressions_allowed", "coverage_floor_lowered", "skip_without_reason"],
  },
};

const baselines = (rules: Baselines["rules"]): Baselines => ({ schema: "baselines/1", rules });

const coverage: Coverage = {
  schema: "coverage/1", high_pct: 82, floor_pct: 81, tolerance_pts: 1, diff_min_pct: 80,
  skips: { count: 4, cap: 10 },
};

describe("criterion: while baselines remain, a PR that adds no violations passes the ratchet", () => {
  it("passes when every per-file count is unchanged", () => {
    const before: RuleCounts = { "no-raw-fetch": { "src/export/download.ts": 3, "src/billing/api.ts": 2 } };
    const after: RuleCounts = { "no-raw-fetch": { "src/export/download.ts": 3, "src/billing/api.ts": 2 } };
    expect(checkRatchet(before, after).ok).toBe(true);
  });

  it("passes when a count falls", () => {
    const before: RuleCounts = { "no-raw-fetch": { "src/a.ts": 3 } };
    const after: RuleCounts = { "no-raw-fetch": { "src/a.ts": 1 } };
    const r = checkRatchet(before, after);
    expect(r.ok).toBe(true);
    expect(r.lowered).toEqual([{ rule: "no-raw-fetch", by: 2 }]);
  });
});

describe("criterion: fixing a violation in one file and adding one in another fails", () => {
  it("fails even though the rule's total is unchanged", () => {
    // This is exactly why counts are per file: a fix in one place must not pay
    // for a new violation in another (doc 09).
    const before: RuleCounts = { "no-raw-fetch": { "src/a.ts": 3, "src/b.ts": 0 } };
    const after: RuleCounts = { "no-raw-fetch": { "src/a.ts": 2, "src/b.ts": 1 } };
    const r = checkRatchet(before, after);
    expect(r.ok).toBe(false);
    expect(r.rises).toEqual([{ rule: "no-raw-fetch", file: "src/b.ts", before: 0, after: 1 }]);
  });

  it("fails when a violation appears in a file that had no entry at all", () => {
    const before: RuleCounts = { "no-raw-fetch": { "src/a.ts": 3 } };
    const after: RuleCounts = { "no-raw-fetch": { "src/a.ts": 2, "src/new.ts": 1 } };
    expect(checkRatchet(before, after).ok).toBe(false);
  });

  it("fails when a new rule's violations appear", () => {
    const before: RuleCounts = {};
    const after: RuleCounts = { "new-rule": { "src/a.ts": 1 } };
    expect(checkRatchet(before, after).ok).toBe(false);
  });

  it("treats a rule missing from after as zero, so dropping its entry never reads as a pass", () => {
    const before: RuleCounts = { r: { "src/a.ts": 5 } };
    const after: RuleCounts = {};
    const r = checkRatchet(before, after);
    expect(r.ok).toBe(true);
    expect(r.lowered).toEqual([{ rule: "r", by: 5 }]);
    // The ratchet alone would read this as a win; checkWeakening is what
    // catches the removal.
    const findings = checkWeakening(
      {
        before: { baselines: baselines({ r: { count: 5 } }), coverage, rules: ["r"] },
        after: { baselines: baselines({}), coverage, rules: [] },
      },
      policy,
    );
    expect(findings.some((f) => f.kind === "rule_removed")).toBe(true);
  });
});

describe("baselines with no per-file detail", () => {
  it("compares totals when a rule has no by_file", () => {
    const before = countsFromBaselines(baselines({ r: { count: 10 } }));
    const after = countsFromBaselines(baselines({ r: { count: 11 } }));
    expect(checkRatchet(before, after).ok).toBe(false);
  });

  it("reads per-file counts when they are present", () => {
    const c = countsFromBaselines(baselines({ r: { count: 5, by_file: { "a.ts": 3, "b.ts": 2 } } }));
    expect(c["r"]).toEqual({ "a.ts": 3, "b.ts": 2 });
  });
});

describe("gardening must lower its target rule", () => {
  it("rejects a gardening PR that raises nothing but lowers nothing either", () => {
    const same: RuleCounts = { r: { "a.ts": 3 } };
    const verdict = checkGardeningLowersTarget(checkRatchet(same, same), "r");
    expect(verdict.ok).toBe(false);
  });

  it("accepts one that lowers its target", () => {
    const r = checkRatchet({ r: { "a.ts": 3 } }, { r: { "a.ts": 1 } });
    expect(checkGardeningLowersTarget(r, "r").ok).toBe(true);
  });

  it("rejects one that lowers a different rule than its target", () => {
    const r = checkRatchet({ a: { "x.ts": 2 }, b: { "y.ts": 2 } }, { a: { "x.ts": 2 }, b: { "y.ts": 1 } });
    expect(checkGardeningLowersTarget(r, "a").ok).toBe(false);
  });
});

describe("criterion: a PR that raises a baseline or lowers the coverage floor fails the weakening check", () => {
  const base: WeakeningInput["before"] = {
    baselines: baselines({ r: { count: 5, by_file: { "a.ts": 5 } } }),
    coverage, rules: ["r"],
  };

  it("catches a raised baseline count", () => {
    const f = checkWeakening({ before: base, after: { ...base, baselines: baselines({ r: { count: 7, by_file: { "a.ts": 7 } } }) } }, policy);
    expect(f.some((x) => x.kind === "baseline_raised")).toBe(true);
  });

  it("catches a per-file raise even when the rule's total stays level", () => {
    const after = { ...base, baselines: baselines({ r: { count: 5, by_file: { "a.ts": 4, "b.ts": 1 } } }) };
    const f = checkWeakening({ before: base, after }, policy);
    expect(f.some((x) => x.kind === "baseline_raised")).toBe(true);
  });

  it("catches a lowered coverage floor", () => {
    const after = { ...base, coverage: { ...coverage, floor_pct: 70 } };
    const f = checkWeakening({ before: base, after }, policy);
    expect(f.some((x) => x.kind === "coverage_floor_lowered")).toBe(true);
  });

  it("catches a lowered diff-coverage minimum", () => {
    const after = { ...base, coverage: { ...coverage, diff_min_pct: 50 } };
    expect(checkWeakening({ before: base, after }, policy).some((x) => x.kind === "coverage_floor_lowered")).toBe(true);
  });

  it("catches a raised skip cap", () => {
    const after = { ...base, coverage: { ...coverage, skips: { count: 4, cap: 99 } } };
    expect(checkWeakening({ before: base, after }, policy).some((x) => x.kind === "coverage_floor_lowered")).toBe(true);
  });

  it("catches a removed rule", () => {
    const f = checkWeakening({ before: base, after: { ...base, rules: [], baselines: baselines({}) } }, policy);
    expect(f.some((x) => x.kind === "rule_removed")).toBe(true);
  });

  it("catches a loosened rule reported by the rule pack", () => {
    const f = checkWeakening({ before: base, after: base, loosenedRules: ["r"] }, policy);
    expect(f.some((x) => x.kind === "rule_loosened")).toBe(true);
  });

  it("catches added native suppressions", () => {
    const f = checkWeakening({
      before: { ...base, nativeSuppressions: { "eslint:no-explicit-any": 2 } },
      after: { ...base, nativeSuppressions: { "eslint:no-explicit-any": 9 } },
    }, policy);
    expect(f.some((x) => x.kind === "native_suppressions_added")).toBe(true);
  });

  it("catches a setting that lets stale suppressions pass", () => {
    const f = checkWeakening({
      before: { ...base, passOnUnprunedSuppressions: false },
      after: { ...base, passOnUnprunedSuppressions: true },
    }, policy);
    expect(f.some((x) => x.kind === "unpruned_suppressions_allowed")).toBe(true);
  });

  it("catches a skip with no reason", () => {
    const f = checkWeakening({ before: base, after: base, skipsWithoutReason: ["src/a.test.ts:12"] }, policy);
    expect(f.some((x) => x.kind === "skip_without_reason")).toBe(true);
  });

  it("catches a retired rule being given a baseline again", () => {
    const before = { ...base, baselines: baselines({ r: { count: 0, retired: true } }) };
    const after = { ...base, baselines: baselines({ r: { count: 4 } }) };
    expect(checkWeakening({ before, after }, policy).some((x) => x.kind === "baseline_raised")).toBe(true);
  });

  it("allows lowering a count and raising the floor: one-way for everyone", () => {
    const after = {
      ...base,
      baselines: baselines({ r: { count: 2, by_file: { "a.ts": 2 } } }),
      coverage: { ...coverage, floor_pct: 85, high_pct: 86 },
    };
    expect(checkWeakening({ before: base, after }, policy)).toHaveLength(0);
  });

  it("reports nothing a policy does not ask it to detect", () => {
    const narrow: Policy = { ...policy, weakening: { requires: "trusted_human_approval", detects: ["skip_without_reason"] } };
    const after = { ...base, coverage: { ...coverage, floor_pct: 10 } };
    expect(checkWeakening({ before: base, after }, narrow)).toHaveLength(0);
  });
});

describe("coverage ratchet", () => {
  it("fails a PR whose diff coverage is below the minimum", () => {
    const v = checkCoverage(coverage, { diff_pct: 61, total_pct: 82, skips: 4 });
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain("diff coverage");
  });

  it("passes a PR whose total dips but stays within tolerance of the high", () => {
    const v = checkCoverage(coverage, { diff_pct: 95, total_pct: 81.5, skips: 4 });
    expect(v.ok).toBe(true);
  });

  it("fails a PR whose total falls below the floor", () => {
    const v = checkCoverage(coverage, { diff_pct: 95, total_pct: 80.4, skips: 4 });
    expect(v.ok).toBe(false);
    expect(v.failures.join(" ")).toContain("below the floor");
  });

  it("raises the high mark and the floor when total coverage rises", () => {
    const v = checkCoverage(coverage, { diff_pct: 95, total_pct: 90, skips: 4 });
    expect(v.ok).toBe(true);
    expect(v.next.high_pct).toBe(90);
    expect(v.next.floor_pct).toBe(89);
  });

  it("never lowers the floor by itself", () => {
    const v = checkCoverage(coverage, { diff_pct: 95, total_pct: 81.2, skips: 4 });
    expect(v.next.floor_pct).toBe(81);
  });

  it("fails when skips exceed the cap", () => {
    const v = checkCoverage(coverage, { diff_pct: 95, total_pct: 82, skips: 11 });
    expect(v.ok).toBe(false);
    expect(v.failures.join(" ")).toContain("skips exceed the cap");
  });
});

describe("criterion: a human PR runs only the deterministic gates and spends nothing on models", () => {
  const baseReq = {
    commit: "c1", labels: [] as string[], alreadyChecked: {},
    isUpdateFromMain: false, mainTouchesFeatureFolders: false, verifyLabel: "factory:verify",
  };

  it("runs static, tests and coverage but no agent verification", () => {
    const plan = planGates({ ...baseReq, actor: "human" });
    expect(plan.static).toBe(true);
    expect(plan.tests).toBe(true);
    expect(plan.coverage).toBe(true);
    expect(plan.agentVerification).toBe(false);
  });

  it("runs agent verification once the verify label is added", () => {
    const plan = planGates({ ...baseReq, actor: "human", labels: ["factory:verify"] });
    expect(plan.agentVerification).toBe(true);
  });
});

describe("criterion: a draft PR's gates run once per commit", () => {
  it("re-runs nothing for a commit already checked", () => {
    const plan = planGates({
      commit: "c1", actor: "agent", labels: [],
      alreadyChecked: { c1: ["static", "verification"] },
      isUpdateFromMain: false, mainTouchesFeatureFolders: false, verifyLabel: "factory:verify",
    });
    expect(plan).toMatchObject({ static: false, tests: false, coverage: false, agentVerification: false });
    expect(plan.reasons.join(" ")).toContain("already checked");
  });

  it("runs only the gate that is missing", () => {
    const plan = planGates({
      commit: "c1", actor: "agent", labels: [],
      alreadyChecked: { c1: ["static"] },
      isUpdateFromMain: false, mainTouchesFeatureFolders: false, verifyLabel: "factory:verify",
    });
    expect(plan.static).toBe(false);
    expect(plan.agentVerification).toBe(true);
  });

  it("runs both gates for a commit never seen", () => {
    const plan = planGates({
      commit: "c2", actor: "agent", labels: [],
      alreadyChecked: { c1: ["static", "verification"] },
      isUpdateFromMain: false, mainTouchesFeatureFolders: false, verifyLabel: "factory:verify",
    });
    expect(plan.static).toBe(true);
    expect(plan.agentVerification).toBe(true);
  });
});

describe("a queue update re-runs the cheap gates, and agent verification only when it must", () => {
  const req = {
    commit: "merge1", actor: "agent" as const, labels: [], alreadyChecked: {},
    verifyLabel: "factory:verify",
  };

  it("skips agent verification when main's changes miss the PR's feature folders", () => {
    const plan = planGates({ ...req, isUpdateFromMain: true, mainTouchesFeatureFolders: false });
    expect(plan.static).toBe(true);
    expect(plan.tests).toBe(true);
    expect(plan.agentVerification).toBe(false);
  });

  it("runs agent verification when they overlap", () => {
    const plan = planGates({ ...req, isUpdateFromMain: true, mainTouchesFeatureFolders: true });
    expect(plan.agentVerification).toBe(true);
  });
});

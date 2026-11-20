import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runStaticGate, runCoverageGate, measuredCounts, withZeroBaselines,
  recordGateResult, readGateResults, alreadyChecked,
} from "../src/commands/gates-run.js";
import { runEslint } from "../src/lib/tools.js";
import type { Baselines, Coverage, Policy } from "../src/lib/types.js";

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "fixtures")) && existsSync(join(dir, "runner"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}
const ROOT = repoRoot();
const JS_LEGACY = join(ROOT, "fixtures/js-legacy");
const TS_WEBAPP = join(ROOT, "fixtures/ts-webapp");

const HAVE_JS_LEGACY = existsSync(join(JS_LEGACY, "node_modules/eslint/bin/eslint.js"));
const HAVE_TS_COVERAGE = existsSync(join(TS_WEBAPP, "coverage/coverage-summary.json"));

const policy: Policy = {
  schema: "policy/1",
  trust: { associations: ["OWNER"], accept_label: "factory:accept" },
  paths: {
    definition: [".factory/definition/**"], guardrails: [".factory/guardrails/**"],
    tests: ["**/*.test.*"], protected: [".github/workflows/**"],
  },
  pipelines: {
    product_work: { may_change: ["code", "tests"] },
    gardening: { may_change: ["code", "tests"] },
    hardening: { may_change: ["code", "tests", "guardrails:tighten"] },
    definition: { may_change: ["definition"], requires: "trusted_human_approval" },
  },
  tests: { declared_edits: "required" },
  weakening: {
    requires: "trusted_human_approval",
    detects: ["rule_removed", "baseline_raised", "coverage_floor_lowered", "native_suppressions_added"],
  },
};

const coverage: Coverage = {
  schema: "coverage/1", high_pct: 44.3, floor_pct: 43.3, tolerance_pts: 1,
  diff_min_pct: 80, skips: { count: 0, cap: 10 },
};

describe("measuredCounts", () => {
  it("merges several tools' counts per rule per file", () => {
    const merged = measuredCounts([
      { tool: "a", counts: { r: { "f.ts": 2 } }, findings: [], unavailable: false, detail: "" },
      { tool: "b", counts: { r: { "f.ts": 1, "g.ts": 3 } }, findings: [], unavailable: false, detail: "" },
    ]);
    expect(merged["r"]).toEqual({ "f.ts": 3, "g.ts": 3 });
  });
});

describe("withZeroBaselines", () => {
  it("gives a rule with no baseline an implicit zero, so any violation fails", () => {
    // A rule installed clean has no baseline entry. Without this, a brand new
    // violation of it would compare against nothing and pass.
    const baselines: Baselines = { schema: "baselines/1", rules: {} };
    const before = withZeroBaselines(baselines, { "new-rule": { "a.ts": 1 } });
    expect(before["new-rule"]).toEqual({});
  });

  it("keeps an existing baseline as the line to hold", () => {
    const baselines: Baselines = {
      schema: "baselines/1",
      rules: { "no-var": { count: 5, by_file: { "a.js": 5 } } },
    };
    const before = withZeroBaselines(baselines, { "no-var": { "a.js": 5 } });
    expect(before["no-var"]).toEqual({ "a.js": 5 });
  });
});

describe.skipIf(!HAVE_JS_LEGACY)("the static gate on js-legacy", () => {
  // js-legacy carries 90 violations across 8 rules and 5 files under a strict
  // config. Here it runs under its OWN config, which turns on only no-undef —
  // so the gate should find nothing, which is what a legacy repo looks like
  // before the factory installs anything.
  it("finds nothing under the repo's own minimal config", async () => {
    const res = await runEslint(JS_LEGACY, ["src"]);
    expect(res.unavailable).toBe(false);
    expect(Object.keys(res.counts)).toHaveLength(0);
  }, 60_000);

  it("passes the gate when the measured counts match the baselines exactly", async () => {
    const measured = await runEslint(JS_LEGACY, ["src"]);
    const baselines: Baselines = { schema: "baselines/1", rules: {} };
    const result = await runStaticGate({
      root: JS_LEGACY,
      policy,
      baselineBefore: baselines,
      baselineAfter: baselines,
      coverageBefore: { ...coverage, floor_pct: 0, high_pct: 0 },
      coverageAfter: { ...coverage, floor_pct: 0, high_pct: 0 },
      changedFiles: ["src/db.js"],
    });
    expect(result.conclusion).toBe("success");
    void measured;
  }, 120_000);

  it("fails when a rule's count rises in one file, and names that file", async () => {
    // The real shape of the acceptance criterion: a PR that fixes a violation
    // in one file and adds one in another.
    const baselines: Baselines = {
      schema: "baselines/1",
      rules: { "no-var": { count: 32, by_file: { "src/db.js": 6, "src/handlers.js": 12, "src/report.js": 7, "src/server.js": 5, "src/util.js": 2 } } },
    };
    const moved: Baselines = {
      schema: "baselines/1",
      rules: { "no-var": { count: 32, by_file: { "src/db.js": 5, "src/handlers.js": 13, "src/report.js": 7, "src/server.js": 5, "src/util.js": 2 } } },
    };
    const result = await runStaticGate({
      root: JS_LEGACY, policy,
      baselineBefore: baselines, baselineAfter: moved,
      coverageBefore: coverage, coverageAfter: coverage,
      changedFiles: ["src/db.js", "src/handlers.js"],
    });
    // The per-file raise is caught by the weakening check on the baseline file.
    expect(result.weakening.some((w) => w.kind === "baseline_raised")).toBe(true);
    expect(result.conclusion).toBe("failure");
    expect(result.summary).toContain("handlers.js");
  }, 120_000);

  it("reports a weakening as needing a human, in words a reviewer can act on", async () => {
    const before: Baselines = { schema: "baselines/1", rules: { "no-var": { count: 10 } } };
    const after: Baselines = { schema: "baselines/1", rules: { "no-var": { count: 20 } } };
    const result = await runStaticGate({
      root: JS_LEGACY, policy,
      baselineBefore: before, baselineAfter: after,
      coverageBefore: coverage, coverageAfter: coverage,
      changedFiles: [],
    });
    expect(result.conclusion).toBe("failure");
    expect(result.summary).toContain("trusted human's approval");
    expect(result.summary).toContain("baseline_raised");
  }, 120_000);

  it("fails a lowered coverage floor", async () => {
    const baselines: Baselines = { schema: "baselines/1", rules: {} };
    const result = await runStaticGate({
      root: JS_LEGACY, policy,
      baselineBefore: baselines, baselineAfter: baselines,
      coverageBefore: coverage,
      coverageAfter: { ...coverage, floor_pct: 10 },
      changedFiles: [],
    });
    expect(result.weakening.some((w) => w.kind === "coverage_floor_lowered")).toBe(true);
  }, 120_000);
});

describe.skipIf(!HAVE_TS_COVERAGE)("the coverage gate on ts-webapp", () => {
  it("measures diff coverage of the changed files, which is the main check", async () => {
    const res = await runCoverageGate({
      root: TS_WEBAPP,
      current: coverage,
      changedFiles: ["lib/invoices.ts"],
    });
    expect(res.diff_pct).toBe(100);
    expect(res.conclusion).toBe("success");
  }, 60_000);

  it("fails when diff coverage is below the minimum", async () => {
    const res = await runCoverageGate({
      root: TS_WEBAPP,
      current: { ...coverage, diff_min_pct: 80 },
      changedFiles: ["app/invoices/page.tsx"],
    });
    // The page component is uncovered, so a change to it fails diff coverage.
    expect(res.diff_pct).toBeLessThan(80);
    expect(res.conclusion).toBe("failure");
    expect(res.failures.join(" ")).toContain("diff coverage");
  }, 60_000);

  it("treats an unmeasurable change as nothing to measure, not as zero", async () => {
    const res = await runCoverageGate({
      root: TS_WEBAPP, current: coverage, changedFiles: ["README.md", "package.json"],
    });
    expect(res.diff_pct).toBeNull();
    expect(res.conclusion).toBe("success");
    expect(res.summary).toContain("different from measuring zero");
  }, 60_000);

  it("shows the measured and required numbers side by side", async () => {
    const res = await runCoverageGate({
      root: TS_WEBAPP, current: coverage, changedFiles: ["lib/invoices.ts"],
    });
    expect(res.summary).toContain("| diff coverage |");
    expect(res.summary).toContain("| total coverage |");
    expect(res.summary).toContain("| skipped tests |");
  }, 60_000);
});

describe("the coverage gate with no report", () => {
  it("is neutral on a repo with no tests and no floor yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-nocov-"));
    try {
      const res = await runCoverageGate({
        root: dir,
        current: { ...coverage, floor_pct: 0, high_pct: 0 },
        changedFiles: ["a.ts"],
      });
      expect(res.conclusion).toBe("neutral");
      expect(res.summary).toContain("Gardening adds tests");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when a floor exists but no report was produced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-nocov-"));
    try {
      const res = await runCoverageGate({
        root: dir, current: { ...coverage, floor_pct: 80 }, changedFiles: ["a.ts"],
      });
      expect(res.conclusion).toBe("failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a tool that cannot run is not a pass", () => {
  it("reports neutral rather than success when no tool could run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-notools-"));
    try {
      const baselines: Baselines = { schema: "baselines/1", rules: {} };
      const res = await runStaticGate({
        root: dir, policy,
        baselineBefore: baselines, baselineAfter: baselines,
        coverageBefore: coverage, coverageAfter: coverage,
        changedFiles: [],
      });
      // Nothing to run and nothing broken: the ratchet holds trivially.
      expect(res.toolsRun).toHaveLength(0);
      expect(res.summary).toContain("Ran: nothing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("commit-keyed gate results", () => {
  it("records a gate, and reads it back for that commit only", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-results-"));
    try {
      recordGateResult(dir, {
        commit: "aaa111", gate: "static", attempt: 1, result: "pass",
        recorded_at: new Date().toISOString(),
      });
      expect(readGateResults(dir, "aaa111")).toHaveLength(1);
      expect(readGateResults(dir, "bbb222")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces a gate's own earlier result rather than appending a second", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-results-"));
    try {
      const at = new Date().toISOString();
      recordGateResult(dir, { commit: "c1", gate: "static", attempt: 1, result: "fail", recorded_at: at });
      recordGateResult(dir, { commit: "c1", gate: "static", attempt: 2, result: "pass", recorded_at: at });
      const all = readGateResults(dir, "c1");
      expect(all).toHaveLength(1);
      expect(all[0]?.result).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps both gates for one commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-results-"));
    try {
      const at = new Date().toISOString();
      recordGateResult(dir, { commit: "c1", gate: "static", attempt: 1, result: "pass", recorded_at: at });
      recordGateResult(dir, { commit: "c1", gate: "verification", attempt: 1, result: "pass", recorded_at: at });
      expect([...alreadyChecked(dir, "c1")].sort()).toEqual(["static", "verification"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count a skipped gate as checked", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-results-"));
    try {
      recordGateResult(dir, {
        commit: "c1", gate: "verification", attempt: 1, result: "skipped",
        recorded_at: new Date().toISOString(),
      });
      expect(alreadyChecked(dir, "c1")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

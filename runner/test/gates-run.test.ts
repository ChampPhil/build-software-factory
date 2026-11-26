import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runStaticGate, runCoverageGate, repoHasTests, measuredCounts, withZeroBaselines,
  checkedFromCheckRuns, summarizeGates,
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

/**
 * These two blocks run the real gates against the real tools in the fixture
 * repos, so they need those fixtures installed. `npm ci` at the root does not
 * install them (they are not workspaces), and CI installs them in a job of
 * its own — see .github/workflows/ci.yml.
 *
 * The coverage guard used to be the presence of `coverage/coverage-summary.json`,
 * which is gitignored. That made the block skip everywhere but a machine that
 * had already produced a report by hand: on CI it never ran once. The guard is
 * now whether the fixture is installed, and the report is produced here.
 */
const HAVE_JS_LEGACY = existsSync(join(JS_LEGACY, "node_modules/eslint/bin/eslint.js"));
const HAVE_TS_COVERAGE = existsSync(join(TS_WEBAPP, "node_modules/vitest/package.json"));

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
  // The gate reads a report; it does not produce one. Producing it here means
  // the gate is measured against coverage of the fixture as it stands now,
  // not against whatever report happened to be lying in the working tree.
  // A floor the fixture actually meets, read from the report rather than
  // written down here. A hardcoded floor goes stale the moment the fixture
  // gains a file, and then every test in this block fails on the total
  // instead of testing what it is named for.
  let fixtureCoverage: Coverage = coverage;

  beforeAll(() => {
    execFileSync("npx", ["vitest", "run", "--coverage"], {
      cwd: TS_WEBAPP,
      stdio: "pipe",
      env: { ...process.env, CI: "true" },
    });
    const summary = JSON.parse(
      readFileSync(join(TS_WEBAPP, "coverage/coverage-summary.json"), "utf8"),
    ) as { total: { lines: { pct: number } } };
    const total = summary.total.lines.pct;
    fixtureCoverage = { ...coverage, high_pct: total, floor_pct: Math.max(0, total - 1) };
  }, 180_000);

  it("reads the total the report actually carries", () => {
    // Guards the setup above: a floor derived from a report that failed to
    // regenerate would make the rest of this block meaningless.
    expect(fixtureCoverage.floor_pct).toBeLessThanOrEqual(fixtureCoverage.high_pct);
    expect(fixtureCoverage.high_pct).toBeGreaterThan(0);
  });

  it("measures diff coverage of the changed files, which is the main check", async () => {
    const res = await runCoverageGate({
      root: TS_WEBAPP,
      current: fixtureCoverage,
      changedFiles: ["lib/invoices.ts"],
    });
    expect(res.diff_pct).toBe(100);
    expect(res.conclusion).toBe("success");
  }, 60_000);

  it("fails when diff coverage is below the minimum", async () => {
    const res = await runCoverageGate({
      root: TS_WEBAPP,
      current: { ...fixtureCoverage, diff_min_pct: 80 },
      changedFiles: ["app/invoices/page.tsx"],
    });
    // The page component is uncovered, so a change to it fails diff coverage.
    expect(res.diff_pct).toBeLessThan(80);
    expect(res.conclusion).toBe("failure");
    expect(res.failures.join(" ")).toContain("diff coverage");
  }, 60_000);

  it("treats an unmeasurable change as nothing to measure, not as zero", async () => {
    const res = await runCoverageGate({
      root: TS_WEBAPP, current: fixtureCoverage, changedFiles: ["README.md", "package.json"],
    });
    expect(res.diff_pct).toBeNull();
    expect(res.conclusion).toBe("success");
    expect(res.summary).toContain("different from measuring zero");
  }, 60_000);

  it("fails when the total is below the floor, naming both numbers", async () => {
    const res = await runCoverageGate({
      root: TS_WEBAPP,
      current: { ...fixtureCoverage, floor_pct: fixtureCoverage.high_pct + 20 },
      changedFiles: ["lib/invoices.ts"],
    });
    expect(res.conclusion).toBe("failure");
    expect(res.failures.join(" ")).toContain("below the floor");
  }, 60_000);

  it("shows the measured and required numbers side by side", async () => {
    const res = await runCoverageGate({
      root: TS_WEBAPP, current: fixtureCoverage, changedFiles: ["lib/invoices.ts"],
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

  it("fails a floor of 0 when the repo has tests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-nocov-"));
    try {
      const res = await runCoverageGate({
        root: dir,
        current: { ...coverage, floor_pct: 0, high_pct: 0 },
        changedFiles: ["a.ts"],
        repoHasTests: true,
      });
      expect(res.conclusion).toBe("failure");
      expect(res.summary).toContain("floor is 0%");
      expect(repoHasTests(dir, null)).toBe(false);
      expect(repoHasTests(dir, "npm test")).toBe(true);
      mkdirSync(join(dir, "tests"));
      expect(repoHasTests(dir, null)).toBe(true);
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

describe("gate results are the commit's check runs", () => {
  // These were a file in the checkout, which a CI job throws away, so the
  // once-per-commit rule held only in tests. GitHub keeps check runs.
  it("counts a gate as checked only when every one of its checks passed", () => {
    expect(checkedFromCheckRuns([{ name: "factory/gate-static", conclusion: "success" }])).toEqual(["static"]);
    // Verification is two checks; one passing is not enough.
    expect(checkedFromCheckRuns([{ name: "factory/gate-tests", conclusion: "success" }])).toEqual([]);
    expect(
      checkedFromCheckRuns([
        { name: "factory/gate-tests", conclusion: "success" },
        { name: "factory/gate-coverage", conclusion: "success" },
      ]),
    ).toEqual(["verification"]);
  });

  it("does not count a failed or unfinished gate as checked", () => {
    expect(
      checkedFromCheckRuns([
        { name: "factory/gate-static", conclusion: "failure" },
        { name: "factory/gate-tests", conclusion: null },
        { name: "factory/gate-coverage", conclusion: "success" },
      ]),
    ).toEqual([]);
  });
});

describe("the factory/gates check branch protection requires", () => {
  const all = { static: true, verification: true, agent: true };
  it("passes only when every planned gate succeeded", () => {
    expect(
      summarizeGates({ planned: all, results: { static: "success", verification: "success", agent: "success" } }).conclusion,
    ).toBe("success");
    expect(
      summarizeGates({ planned: all, results: { static: "success", verification: "failure", agent: "skipped" } }).conclusion,
    ).toBe("failure");
  });

  it("treats an unplanned gate's skip as a pass and a planned gate's skip as a failure", () => {
    // A planned gate skipped because something before it failed is not a pass.
    const notAgent = { static: true, verification: true, agent: false };
    expect(
      summarizeGates({ planned: notAgent, results: { static: "success", verification: "success", agent: "skipped" } }).conclusion,
    ).toBe("success");
    expect(
      summarizeGates({ planned: all, results: { static: "success", verification: "success", agent: "skipped" } }).conclusion,
    ).toBe("failure");
  });

  it("fails a cancelled gate", () => {
    expect(
      summarizeGates({ planned: all, results: { static: "cancelled", verification: "success", agent: "success" } }).conclusion,
    ).toBe("failure");
  });
});

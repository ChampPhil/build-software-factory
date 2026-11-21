import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Baselines, Coverage, Policy } from "../lib/types.js";
import {
  checkRatchet, checkWeakening, checkCoverage, countsFromBaselines,
  type RuleCounts, type RatchetResult, type WeakeningFinding,
} from "./gates.js";
import {
  runEslint,
  runRuff,
  eslintSuppressions,
  readCoverage,
  diffCoverage,
  countSkips,
  type Finding,
  type ToolRunResult,
  runClippy,
  runGoVet,
  runRubocop,
  runSemgrep,
} from "../lib/tools.js";

/**
 * Gate 1 (static) and Gate 2 (coverage), wired to the repo's own tools.
 *
 * The gates run the tools themselves, in a job with no agent in it, so an
 * agent saying "the tests pass" never counts for anything. Results are keyed
 * by commit and written to disk, so the same commit is never checked twice.
 */

export interface StaticGateInput {
  readonly root: string;
  readonly policy: Policy;
  /** Baselines from the default branch — the "before" side of the ratchet. */
  readonly baselineBefore: Baselines;
  /** Baselines as the PR leaves them, for the weakening check. */
  readonly baselineAfter: Baselines;
  readonly coverageBefore: Coverage;
  readonly coverageAfter: Coverage;
  readonly changedFiles: readonly string[];
  /** Rules whose config got less strict, where a rule pack can tell. */
  readonly loosenedRules?: readonly string[];
}

export interface StaticGateResult {
  readonly conclusion: "success" | "failure" | "neutral";
  readonly ratchet: RatchetResult;
  readonly weakening: readonly WeakeningFinding[];
  readonly findings: readonly Finding[];
  readonly toolsRun: readonly string[];
  readonly toolsUnavailable: readonly { readonly tool: string; readonly detail: string }[];
  readonly summary: string;
}

/**
 * Which rules the ratchet is responsible for.
 *
 * A rule with a baseline is in cleanup: its count may not rise. A rule with no
 * baseline was installed clean, so any violation at all fails. Both are the
 * ratchet; they differ only in where the line sits.
 */
export function measuredCounts(results: readonly ToolRunResult[]): RuleCounts {
  const merged: Record<string, Record<string, number>> = {};
  for (const r of results) {
    for (const [rule, byFile] of Object.entries(r.counts)) {
      const target = (merged[rule] ??= {});
      for (const [file, n] of Object.entries(byFile)) {
        target[file] = (target[file] ?? 0) + n;
      }
    }
  }
  return merged;
}

/**
 * A rule the repo turned on with no baseline must be at zero. Expressing that
 * as a baseline of zero lets one comparison cover both cases.
 */
export function withZeroBaselines(baselines: Baselines, measured: RuleCounts): RuleCounts {
  const before = countsFromBaselines(baselines);
  const out: Record<string, Record<string, number>> = {};
  for (const [rule, byFile] of Object.entries(before)) out[rule] = { ...byFile };
  for (const rule of Object.keys(measured)) {
    if (out[rule] === undefined) out[rule] = {};
  }
  return out;
}

/**
 * A rule the PR introduces — absent from the default branch's baselines and
 * recorded in the PR's — arrives with the violations already in the code. In
 * files the PR does not touch those are not new: the default branch has them
 * too, and the rule only now sees them. So there the PR's recorded counts are
 * the line. In any file the PR changes the line stays at zero, so a PR cannot
 * add a violation and record it in the same breath.
 */
export function withIntroducedBaselines(
  before: RuleCounts,
  baselineBefore: Baselines,
  baselineAfter: Baselines,
  changedFiles: readonly string[],
): RuleCounts {
  const had = countsFromBaselines(baselineBefore);
  const recorded = countsFromBaselines(baselineAfter);
  const changed = new Set(changedFiles);
  const out: Record<string, Record<string, number>> = {};
  for (const [rule, byFile] of Object.entries(before)) out[rule] = { ...byFile };
  for (const [rule, byFile] of Object.entries(recorded)) {
    if (had[rule] !== undefined) continue;
    const line = (out[rule] ??= {});
    for (const [file, n] of Object.entries(byFile)) {
      if (!changed.has(file)) line[file] = n;
    }
  }
  return out;
}

function gemfileHas(root: string, gem: string): boolean {
  try {
    return new RegExp(`gem\\s+["']${gem}["']`).test(readFileSync(join(root, "Gemfile"), "utf8"));
  } catch {
    return false;
  }
}

/** Every static checker that applies to this repo, run once: what the gate judges and what setup baselines. */
export async function runStaticTools(root: string): Promise<{ results: ToolRunResult[]; unavailable: { tool: string; detail: string }[] }> {
  const results: ToolRunResult[] = [];
  const unavailable: { tool: string; detail: string }[] = [];

  if (existsSync(join(root, "node_modules", "eslint", "bin", "eslint.js"))) {
    const r = await runEslint(root);
    if (r.unavailable) unavailable.push({ tool: "eslint", detail: r.detail });
    else results.push(r);
  }
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "ruff.toml"))) {
    const r = await runRuff(root);
    if (r.unavailable) unavailable.push({ tool: "ruff", detail: r.detail });
    else results.push(r);
  }
  // Each language's own linter, where the repo is in that language. Before
  // these, a Rust, Go or Ruby repo ran nothing and the gate said success.
  const native: [string, () => Promise<ToolRunResult>][] = [];
  if (existsSync(join(root, "Cargo.toml"))) native.push(["clippy", () => runClippy(root)]);
  if (existsSync(join(root, "go.mod"))) native.push(["go-vet", () => runGoVet(root)]);
  if (existsSync(join(root, "Gemfile")) && (existsSync(join(root, ".rubocop.yml")) || gemfileHas(root, "rubocop"))) {
    native.push(["rubocop", () => runRubocop(root)]);
  }
  // The repo's own semgrep rules — where declared practices that a pattern can
  // check end up — run on any language.
  const semgrepDir = join(root, ".factory/guardrails/semgrep");
  if (existsSync(semgrepDir)) native.push(["semgrep", () => runSemgrep(root, semgrepDir)]);
  for (const [tool, run] of native) {
    const r = await run();
    if (r.unavailable) unavailable.push({ tool, detail: r.detail });
    else results.push(r);
  }
  return { results, unavailable };
}

/**
 * Baselines for every rule the repo's checkers report today, per file. Setup
 * records them so the ratchet has a starting point and gardening has work;
 * a rule already baselined keeps its entry, since gardening may have lowered
 * it and re-recording would undo that.
 */
export function baselinesFrom(existing: Baselines, measured: RuleCounts, now: string): Baselines {
  const rules: Record<string, Baselines["rules"][string]> = { ...existing.rules };
  for (const [rule, byFile] of Object.entries(measured)) {
    if (rules[rule] !== undefined) continue;
    const by_file = Object.fromEntries(Object.entries(byFile).filter(([, n]) => n > 0));
    const count = Object.values(by_file).reduce((a, b) => a + b, 0);
    rules[rule] = { count, by_file, recorded_at: now };
  }
  return { ...existing, rules };
}

export async function runStaticGate(input: StaticGateInput): Promise<StaticGateResult> {
  const { root } = input;
  const { results, unavailable } = await runStaticTools(root);

  const measured = measuredCounts(results);
  const before = withIntroducedBaselines(
    withZeroBaselines(input.baselineBefore, measured),
    input.baselineBefore,
    input.baselineAfter,
    input.changedFiles,
  );
  const ratchet = checkRatchet(before, measured);

  const weakening = checkWeakening(
    {
      before: {
        baselines: input.baselineBefore,
        coverage: input.coverageBefore,
        rules: Object.keys(countsFromBaselines(input.baselineBefore)),
        nativeSuppressions: eslintSuppressions(root),
      },
      after: {
        baselines: input.baselineAfter,
        coverage: input.coverageAfter,
        rules: Object.keys(countsFromBaselines(input.baselineAfter)),
        nativeSuppressions: eslintSuppressions(root),
      },
      ...(input.loosenedRules === undefined ? {} : { loosenedRules: input.loosenedRules }),
    },
    input.policy,
  );

  // A tool that could not run is not a pass, and neither is no tool at all:
  // both are neutral, so "nothing was checked" never shows as a green tick.
  const nothingRan = results.length === 0;
  const conclusion: StaticGateResult["conclusion"] =
    ratchet.ok && weakening.length === 0 ? (nothingRan ? "neutral" : "success") : "failure";

  return {
    conclusion,
    ratchet,
    weakening,
    findings: results.flatMap((r) => r.findings),
    toolsRun: results.map((r) => r.tool),
    toolsUnavailable: unavailable,
    summary:
      nothingRan && unavailable.length === 0
        ? "Not applicable: no static checker here applies to this repo's languages, so nothing was checked. " +
          "Declared practices that a pattern can check are written as semgrep rules under .factory/guardrails/semgrep, " +
          "which run on any language.\n\n" + summarizeStatic({ ratchet, weakening, results, unavailable })
        : summarizeStatic({ ratchet, weakening, results, unavailable }),
  };
}

function summarizeStatic(args: {
  ratchet: RatchetResult;
  weakening: readonly WeakeningFinding[];
  results: readonly ToolRunResult[];
  unavailable: readonly { tool: string; detail: string }[];
}): string {
  const lines: string[] = [];

  if (args.weakening.length > 0) {
    lines.push("## A guardrail got weaker", "");
    lines.push("This needs a trusted human's approval, whatever the auto-merge toggles say.", "");
    for (const w of args.weakening) lines.push(`- **${w.kind}** — ${w.detail}`);
    lines.push("");
  }

  if (!args.ratchet.ok) {
    lines.push("## New violations", "");
    lines.push(
      "Counts are kept per file, so fixing one violation somewhere does not pay for a new one elsewhere.",
      "",
    );
    for (const r of args.ratchet.rises.slice(0, 50)) {
      lines.push(`- \`${r.file}\` — **${r.rule}** rose from ${r.before} to ${r.after}`);
    }
    if (args.ratchet.rises.length > 50) {
      lines.push(`- …and ${args.ratchet.rises.length - 50} more`);
    }
    lines.push("");
  }

  if (args.ratchet.ok && args.weakening.length === 0) {
    lines.push("No rule's count rose in any file, and no guardrail got weaker.", "");
    if (args.ratchet.lowered.length > 0) {
      lines.push("Counts that fell:", "");
      for (const l of args.ratchet.lowered) lines.push(`- **${l.rule}** down by ${l.by}`);
      lines.push("");
    }
  }

  if (args.unavailable.length > 0) {
    lines.push("## Tools that could not run", "");
    for (const u of args.unavailable) lines.push(`- **${u.tool}** — ${u.detail.split("\n")[0] ?? ""}`);
    lines.push("", "A tool that cannot run is not a pass. Fix the toolchain.", "");
  }

  lines.push(`Ran: ${args.results.map((r) => r.tool).join(", ") || "nothing"}`);
  return lines.join("\n");
}

/* ----------------------------------------------------------- coverage gate */

export interface CoverageGateResult {
  readonly conclusion: "success" | "failure" | "neutral";
  readonly diff_pct: number | null;
  readonly total_pct: number | null;
  readonly skips: number;
  readonly failures: readonly string[];
  readonly next: Coverage | null;
  readonly summary: string;
}

export async function runCoverageGate(args: {
  readonly root: string;
  readonly current: Coverage;
  readonly changedFiles: readonly string[];
}): Promise<CoverageGateResult> {
  const coverage = readCoverage(args.root);
  const skips = await countSkips(args.root);

  if (coverage === null) {
    // No report at all. On a repo with no tests this is the expected state at
    // setup, so it is reported rather than failed — the floor is 0% and
    // gardening is what adds tests.
    return {
      conclusion: args.current.floor_pct === 0 ? "neutral" : "failure",
      diff_pct: null,
      total_pct: null,
      skips,
      failures:
        args.current.floor_pct === 0
          ? []
          : [`no coverage report found, but the floor is ${args.current.floor_pct}%`],
      next: null,
      summary:
        args.current.floor_pct === 0
          ? "No coverage report, and no floor to meet yet. Gardening adds tests per feature folder."
          : `No coverage report was produced, so the ${args.current.floor_pct}% floor cannot be checked.`,
    };
  }

  const diff = diffCoverage(coverage, args.changedFiles);
  const verdict = checkCoverage(args.current, {
    // Nothing measurable in the changed files is not zero coverage: it means
    // the change touched nothing the report covers, such as a config file.
    diff_pct: diff ?? 100,
    total_pct: coverage.total_pct,
    skips,
  });

  const lines: string[] = [];
  lines.push(
    `| | measured | required |`,
    `| --- | --- | --- |`,
    `| diff coverage | ${diff === null ? "nothing measurable" : `${diff}%`} | ${args.current.diff_min_pct}% |`,
    `| total coverage | ${coverage.total_pct}% | ${args.current.floor_pct}% floor |`,
    `| skipped tests | ${skips} | ${args.current.skips.cap} cap |`,
    "",
  );
  if (diff === null) {
    lines.push(
      "None of the changed files appear in the coverage report, so there is no diff coverage to measure. That is different from measuring zero.",
      "",
    );
  }
  for (const f of verdict.failures) lines.push(`- ${f}`);
  if (verdict.ok && verdict.next.high_pct > args.current.high_pct) {
    lines.push("", `Total coverage rose, so the high mark moves to ${verdict.next.high_pct}% and the floor to ${verdict.next.floor_pct}%.`);
  }

  return {
    conclusion: verdict.ok ? "success" : "failure",
    diff_pct: diff,
    total_pct: coverage.total_pct,
    skips,
    failures: verdict.failures,
    next: verdict.next,
    summary: lines.join("\n"),
  };
}

/* --------------------------------------------------- commit-keyed results */

/**
 * The check runs each gate reports. A gate's result is its check run on the
 * commit: GitHub keeps it, branch protection reads it, and it survives the job.
 *
 * This replaced a file under the checkout, which a CI job throws away when it
 * ends, so "never re-run a gate for the same commit" persisted nothing.
 */
export const GATE_CHECKS = {
  static: ["factory/gate-static"],
  verification: ["factory/gate-tests", "factory/gate-coverage"],
} as const;

/** The single check branch protection requires; the aggregate of the gates. */
export const GATES_CHECK = "factory/gates";

export interface CheckRunSummary {
  readonly name: string;
  readonly conclusion: string | null;
}

/** Gates that already passed on this commit, from its check runs. */
export function checkedFromCheckRuns(runs: readonly CheckRunSummary[]): readonly ("static" | "verification")[] {
  const passed = (name: string): boolean =>
    runs.some((r) => r.name === name && r.conclusion === "success");
  const out: ("static" | "verification")[] = [];
  for (const gate of ["static", "verification"] as const) {
    if (GATE_CHECKS[gate].every(passed)) out.push(gate);
  }
  return out;
}

export type JobResult = "success" | "failure" | "cancelled" | "skipped" | "";

/**
 * The aggregate verdict over the gate jobs, as GitHub reports each job's
 * result to the job that needs it.
 *
 * `skipped` is a pass only when the plan did not call for that gate; a gate
 * that was planned and skipped (because something before it failed) is not.
 * A required check that only ever reported on some PRs would block the rest
 * forever, which is why this one is always reported.
 */
export function summarizeGates(input: {
  readonly planned: { readonly static: boolean; readonly verification: boolean; readonly agent: boolean };
  readonly results: { readonly static: JobResult; readonly verification: JobResult; readonly agent: JobResult };
}): { readonly conclusion: "success" | "failure"; readonly lines: readonly string[] } {
  const lines: string[] = [];
  let ok = true;
  for (const gate of ["static", "verification", "agent"] as const) {
    const planned = input.planned[gate];
    const result = input.results[gate];
    const passed = result === "success" || (!planned && (result === "skipped" || result === ""));
    if (!passed) ok = false;
    lines.push(`${gate}: ${planned ? "planned" : "not planned"}, ${result === "" ? "did not run" : result}${passed ? "" : " — FAILED"}`);
  }
  return { conclusion: ok ? "success" : "failure", lines };
}

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Baselines, Coverage, Policy } from "../lib/types.js";
import {
  checkRatchet, checkWeakening, checkCoverage, countsFromBaselines,
  type RuleCounts, type RatchetResult, type WeakeningFinding,
} from "./gates.js";
import {
  runEslint, runRuff, eslintSuppressions, readCoverage, diffCoverage, countSkips,
  type Finding, type ToolRunResult,
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

export async function runStaticGate(input: StaticGateInput): Promise<StaticGateResult> {
  const { root } = input;
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

  const measured = measuredCounts(results);
  const before = withZeroBaselines(input.baselineBefore, measured);
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

  // A tool that could not run is not a pass. It is reported as neutral, so a
  // broken toolchain shows up as something to fix rather than as a green tick.
  const conclusion: StaticGateResult["conclusion"] =
    ratchet.ok && weakening.length === 0
      ? unavailable.length > 0 && results.length === 0
        ? "neutral"
        : "success"
      : "failure";

  return {
    conclusion,
    ratchet,
    weakening,
    findings: results.flatMap((r) => r.findings),
    toolsRun: results.map((r) => r.tool),
    toolsUnavailable: unavailable,
    summary: summarizeStatic({ ratchet, weakening, results, unavailable }),
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

export interface GateRecord {
  readonly commit: string;
  readonly gate: "static" | "verification";
  readonly attempt: number;
  readonly result: "pass" | "fail" | "skipped";
  readonly recorded_at: string;
}

const RESULTS_DIR = ".factory/.gate-results";

/**
 * Gate results are keyed by commit, so opening a PR re-runs nothing and an
 * approval registers without re-running the gates.
 */
export function recordGateResult(root: string, record: GateRecord): void {
  const dir = join(root, RESULTS_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${record.commit}.json`);
  const existing = readGateResults(root, record.commit);
  const merged = [...existing.filter((r) => r.gate !== record.gate), record];
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
}

export function readGateResults(root: string, commit: string): readonly GateRecord[] {
  const file = join(root, RESULTS_DIR, `${commit}.json`);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8")) as GateRecord[];
  } catch {
    return [];
  }
}

export function alreadyChecked(root: string, commit: string): readonly ("static" | "verification")[] {
  return readGateResults(root, commit)
    .filter((r) => r.result !== "skipped")
    .map((r) => r.gate);
}

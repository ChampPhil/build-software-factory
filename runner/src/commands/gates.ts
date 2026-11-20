import type { Baselines, BaselineRule, Coverage, Policy, WeakeningKind } from "../lib/types.js";

/**
 * `bsf gates` — Gate 1 (static) and Gate 2 (verification).
 *
 * The gates run in their own job with no builder in it, so an agent's own
 * "tests pass" never counts (doc 02). Results are keyed by commit, so a
 * commit is never checked twice (doc 07).
 *
 * This module holds the deterministic judgements: the per-file ratchet, the
 * weakening check and the coverage ratchet. Running the repo's own tools is
 * orchestration around them.
 */

/* ------------------------------------------------------------------ ratchet */

export interface RuleCounts {
  /** rule -> file -> count. A rule with no per-file detail uses the "" key. */
  readonly [rule: string]: Readonly<Record<string, number>>;
}

export interface RatchetRise {
  readonly rule: string;
  readonly file: string;
  readonly before: number;
  readonly after: number;
}

export interface RatchetResult {
  readonly ok: boolean;
  /** Every place a count rose. Empty when the ratchet passes. */
  readonly rises: readonly RatchetRise[];
  /** Rules whose total count fell, with the drop. */
  readonly lowered: readonly { readonly rule: string; readonly by: number }[];
}

export function countsFromBaselines(b: Baselines): RuleCounts {
  const out: Record<string, Record<string, number>> = {};
  for (const [rule, entry] of Object.entries(b.rules)) {
    out[rule] = byFileOf(entry);
  }
  return out;
}

/**
 * Per-file counts for one rule. A rule with no per-file breakdown is kept
 * under the empty key, so the ratchet still has one number to compare.
 * Exported because the gardener needs the same reading of a baseline entry —
 * it had its own, which walked the entry's own keys as if they were file
 * names and so reported `count` and `by_file` as files to clean.
 */
export function byFileOf(entry: BaselineRule): Record<string, number> {
  if (entry.by_file !== undefined && Object.keys(entry.by_file).length > 0) {
    return { ...entry.by_file };
  }
  return { "": entry.count };
}

function totalOf(perFile: Readonly<Record<string, number>>): number {
  return Object.values(perFile).reduce((a, b) => a + b, 0);
}

/**
 * No rule's count may rise in any file.
 *
 * Counts are kept per file precisely so that fixing one violation in one file
 * cannot pay for a new one in another (doc 09). A rule absent from `after` is
 * treated as zero everywhere, not as unchanged, so deleting a rule's entry
 * can never look like a pass — `checkWeakening` is what catches that.
 */
export function checkRatchet(before: RuleCounts, after: RuleCounts): RatchetResult {
  const rises: RatchetRise[] = [];
  const lowered: { rule: string; by: number }[] = [];
  const rules = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const rule of rules) {
    const b = before[rule] ?? {};
    const a = after[rule] ?? {};
    const files = new Set([...Object.keys(b), ...Object.keys(a)]);
    for (const file of files) {
      const bc = b[file] ?? 0;
      const ac = a[file] ?? 0;
      if (ac > bc) rises.push({ rule, file, before: bc, after: ac });
    }
    const bt = totalOf(b);
    const at = totalOf(a);
    if (at < bt) lowered.push({ rule, by: bt - at });
  }

  return { ok: rises.length === 0, rises, lowered };
}

/**
 * A gardening PR for a baselined rule must also lower that rule's count
 * (doc 06). Raising nothing is not enough: the night's work has to move.
 */
export function checkGardeningLowersTarget(
  result: RatchetResult,
  targetRule: string,
): { readonly ok: boolean; readonly message?: string } {
  if (!result.ok) return { ok: false, message: "a count rose" };
  const lowered = result.lowered.some((l) => l.rule === targetRule && l.by > 0);
  return lowered
    ? { ok: true }
    : { ok: false, message: `a gardening PR for ${targetRule} must lower that rule's count` };
}

/* ---------------------------------------------------------------- weakening */

export interface WeakeningFinding {
  readonly kind: WeakeningKind;
  readonly detail: string;
}

export interface WeakeningInput {
  readonly before: {
    readonly baselines: Baselines;
    readonly coverage: Coverage;
    readonly rules: readonly string[];
    readonly nativeSuppressions?: Readonly<Record<string, number>>;
    readonly passOnUnprunedSuppressions?: boolean;
  };
  readonly after: {
    readonly baselines: Baselines;
    readonly coverage: Coverage;
    readonly rules: readonly string[];
    readonly nativeSuppressions?: Readonly<Record<string, number>>;
    readonly passOnUnprunedSuppressions?: boolean;
  };
  /** Skips added by this PR that carry no reason comment. */
  readonly skipsWithoutReason?: readonly string[];
  /** Rules whose configuration got less strict, as reported by the rule pack. */
  readonly loosenedRules?: readonly string[];
}

/**
 * Baselines and coverage are one-way for everyone: any pipeline may lower a
 * count or raise the floor, and the opposite direction is a weakening that
 * needs a trusted human (doc 09).
 */
export function checkWeakening(input: WeakeningInput, policy: Policy): readonly WeakeningFinding[] {
  const detects = new Set<WeakeningKind>(policy.weakening.detects);
  const found: WeakeningFinding[] = [];
  const { before, after } = input;

  if (detects.has("rule_removed")) {
    for (const rule of before.rules) {
      if (!after.rules.includes(rule)) {
        found.push({ kind: "rule_removed", detail: `rule ${rule} was removed` });
      }
    }
    // A rule whose baseline entry disappears is also gone, even if the rule
    // pack still lists it.
    for (const rule of Object.keys(before.baselines.rules)) {
      const wasRetired = before.baselines.rules[rule]?.retired === true;
      if (!wasRetired && after.baselines.rules[rule] === undefined && after.rules.includes(rule)) {
        found.push({ kind: "rule_removed", detail: `baseline entry for ${rule} was removed` });
      }
    }
  }

  if (detects.has("rule_loosened")) {
    for (const rule of input.loosenedRules ?? []) {
      found.push({ kind: "rule_loosened", detail: `rule ${rule} was loosened` });
    }
  }

  if (detects.has("baseline_raised")) {
    for (const [rule, afterEntry] of Object.entries(after.baselines.rules)) {
      const beforeEntry = before.baselines.rules[rule];
      if (beforeEntry === undefined) continue;
      if (afterEntry.count > beforeEntry.count) {
        found.push({
          kind: "baseline_raised",
          detail: `baseline for ${rule} rose from ${beforeEntry.count} to ${afterEntry.count}`,
        });
      }
      // A retired rule coming back un-retired with a count is a raise too.
      if (beforeEntry.retired === true && afterEntry.retired !== true && afterEntry.count > 0) {
        found.push({
          kind: "baseline_raised",
          detail: `retired rule ${rule} was given a baseline of ${afterEntry.count} again`,
        });
      }
      // Per-file raises, for rules whose total happens to stay level.
      const bf = beforeEntry.by_file ?? {};
      const af = afterEntry.by_file ?? {};
      for (const file of Object.keys(af)) {
        const b = bf[file] ?? 0;
        const a = af[file] ?? 0;
        if (a > b) {
          found.push({
            kind: "baseline_raised",
            detail: `baseline for ${rule} in ${file} rose from ${b} to ${a}`,
          });
        }
      }
    }
  }

  if (detects.has("native_suppressions_added")) {
    const b = before.nativeSuppressions ?? {};
    const a = after.nativeSuppressions ?? {};
    for (const key of Object.keys(a)) {
      const bc = b[key] ?? 0;
      const ac = a[key] ?? 0;
      if (ac > bc) {
        found.push({
          kind: "native_suppressions_added",
          detail: `native suppressions for ${key} rose from ${bc} to ${ac}`,
        });
      }
    }
  }

  if (detects.has("unpruned_suppressions_allowed")) {
    if (after.passOnUnprunedSuppressions === true && before.passOnUnprunedSuppressions !== true) {
      found.push({
        kind: "unpruned_suppressions_allowed",
        detail: "a setting now lets stale suppressions pass",
      });
    }
  }

  if (detects.has("coverage_floor_lowered")) {
    if (after.coverage.floor_pct < before.coverage.floor_pct) {
      found.push({
        kind: "coverage_floor_lowered",
        detail: `coverage floor fell from ${before.coverage.floor_pct}% to ${after.coverage.floor_pct}%`,
      });
    }
    if (after.coverage.diff_min_pct < before.coverage.diff_min_pct) {
      found.push({
        kind: "coverage_floor_lowered",
        detail: `diff-coverage minimum fell from ${before.coverage.diff_min_pct}% to ${after.coverage.diff_min_pct}%`,
      });
    }
    if (after.coverage.skips.cap > before.coverage.skips.cap) {
      found.push({
        kind: "coverage_floor_lowered",
        detail: `skip cap rose from ${before.coverage.skips.cap} to ${after.coverage.skips.cap}`,
      });
    }
  }

  if (detects.has("skip_without_reason")) {
    for (const where of input.skipsWithoutReason ?? []) {
      found.push({ kind: "skip_without_reason", detail: `skip without a reason at ${where}` });
    }
  }

  return found;
}

/* ----------------------------------------------------------------- coverage */

export interface CoverageMeasurement {
  readonly diff_pct: number;
  readonly total_pct: number;
  readonly skips: number;
}

export interface CoverageVerdict {
  readonly ok: boolean;
  readonly failures: readonly string[];
  /** The ratchet moves up when a merge raises total coverage. */
  readonly next: Coverage;
}

/**
 * Diff coverage is the main check; total coverage trails its own high mark by
 * `tolerance_pts`, so a PR fails only if total would fall below the floor
 * (doc 09).
 */
export function checkCoverage(current: Coverage, measured: CoverageMeasurement): CoverageVerdict {
  const failures: string[] = [];

  if (measured.diff_pct < current.diff_min_pct) {
    failures.push(
      `diff coverage ${measured.diff_pct}% is below the minimum ${current.diff_min_pct}%`,
    );
  }
  if (measured.total_pct < current.floor_pct) {
    failures.push(
      `total coverage ${measured.total_pct}% is below the floor ${current.floor_pct}%`,
    );
  }
  if (measured.skips > current.skips.cap) {
    failures.push(`${measured.skips} skips exceed the cap of ${current.skips.cap}`);
  }

  const high = Math.max(current.high_pct, measured.total_pct);
  const next: Coverage = {
    schema: "coverage/1",
    high_pct: high,
    floor_pct: Math.max(current.floor_pct, round1(high - current.tolerance_pts)),
    tolerance_pts: current.tolerance_pts,
    diff_min_pct: current.diff_min_pct,
    skips: { count: measured.skips, cap: current.skips.cap },
  };

  return { ok: failures.length === 0, failures, next };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/* -------------------------------------------------- which gates to run, and once */

export interface GateRunRequest {
  readonly commit: string;
  /** A factory branch, or a human's PR. */
  readonly actor: "agent" | "human";
  readonly labels: readonly string[];
  /** Commits whose gate results are already recorded. */
  readonly alreadyChecked: Readonly<Record<string, readonly ("static" | "verification")[]>>;
  /** True when this commit only merges main into the branch (the queue's update). */
  readonly isUpdateFromMain: boolean;
  /** Whether main's incoming changes touch the PR's feature folders. */
  readonly mainTouchesFeatureFolders: boolean;
  readonly verifyLabel: string;
}

export interface GatePlan {
  readonly static: boolean;
  readonly tests: boolean;
  readonly coverage: boolean;
  /** Agent runtime verification: the expensive one that spends on models. */
  readonly agentVerification: boolean;
  readonly reasons: readonly string[];
}

/**
 * A human PR runs only the deterministic gates and spends nothing on models,
 * unless someone adds the verify label (doc 02). A commit already checked is
 * not checked again. A queue update re-runs static rules and tests, and agent
 * verification only if main's incoming changes touch the PR's feature folders.
 */
export function planGates(req: GateRunRequest): GatePlan {
  const done = new Set(req.alreadyChecked[req.commit] ?? []);
  const reasons: string[] = [];

  if (done.has("static") && done.has("verification")) {
    reasons.push(`commit ${req.commit} was already checked; results are keyed by commit`);
    return { static: false, tests: false, coverage: false, agentVerification: false, reasons };
  }

  const runStatic = !done.has("static");
  const verificationDone = done.has("verification");

  if (req.actor === "human") {
    const labelled = req.labels.includes(req.verifyLabel);
    if (!labelled) reasons.push("human PR: deterministic gates only, nothing spent on models");
    else reasons.push(`human PR carries ${req.verifyLabel}: agent verification runs too`);
    return {
      static: runStatic,
      tests: !verificationDone,
      coverage: !verificationDone,
      agentVerification: labelled && !verificationDone,
      reasons,
    };
  }

  if (req.isUpdateFromMain) {
    const agentVerification = req.mainTouchesFeatureFolders && !verificationDone;
    reasons.push(
      agentVerification
        ? "queue update, and main's changes touch this PR's feature folders: agent verification re-runs"
        : "queue update: static rules and tests re-run, agent verification does not",
    );
    return { static: runStatic, tests: true, coverage: true, agentVerification, reasons };
  }

  return {
    static: runStatic,
    tests: !verificationDone,
    coverage: !verificationDone,
    agentVerification: !verificationDone,
    reasons,
  };
}

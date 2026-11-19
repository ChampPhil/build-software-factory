import type { Pipeline } from "../lib/types.js";

/**
 * `bsf merge-queue` — the fallback queue, for repos GitHub's native merge
 * queue does not cover (personal-account repos, private repos without
 * Enterprise Cloud). One approved PR at a time, started by events rather than
 * a timer (doc 02).
 *
 * The point of a queue at all: two PRs that each pass alone can break the
 * build together. The queue re-checks each against the latest main before it
 * lands, so the second one's failure is caught instead of merged.
 */

export interface QueueCandidate {
  readonly pr: number;
  readonly work_item: string;
  readonly pipeline: Pipeline;
  readonly eligible_at: string;
  /** Gates passed on this exact commit. */
  readonly gates_passed_on: string | null;
  readonly head_sha: string;
  readonly approved_by_human: boolean;
  readonly auto_merge_on: boolean;
  /** True when the PR's head already contains the latest main. */
  readonly up_to_date: boolean;
  /** Set by the weakening check or the policy check. */
  readonly needs_human_whatever_the_toggles: boolean;
  readonly conflicting?: boolean;
}

export type QueueAction =
  | { readonly kind: "not_eligible"; readonly pr: number; readonly reason: string }
  | { readonly kind: "update_from_main"; readonly pr: number; readonly reason: string }
  | { readonly kind: "recheck"; readonly pr: number; readonly reason: string }
  | { readonly kind: "merge"; readonly pr: number; readonly reason: string }
  | { readonly kind: "resolve_conflict"; readonly pr: number; readonly reason: string };

/**
 * A PR is eligible when its gates pass and either a trusted human approved it
 * or its pipeline's auto-merge toggle is on. Definition PRs and anything the
 * weakening check flagged always need a human, whatever the toggles say.
 */
export function isEligible(c: QueueCandidate): { readonly ok: boolean; readonly reason: string } {
  if (c.conflicting === true) return { ok: false, reason: "conflicting with main" };
  if (c.gates_passed_on === null) return { ok: false, reason: "gates have not passed" };
  if (c.gates_passed_on !== c.head_sha) {
    return { ok: false, reason: `gates passed on ${c.gates_passed_on}, not on the head commit ${c.head_sha}` };
  }
  if (c.needs_human_whatever_the_toggles && !c.approved_by_human) {
    return { ok: false, reason: "needs a trusted human's approval, whatever the toggles say" };
  }
  if (!c.approved_by_human && !c.auto_merge_on) {
    return { ok: false, reason: "no human approval and auto-merge is off for this pipeline" };
  }
  return { ok: true, reason: c.approved_by_human ? "approved by a trusted human" : "auto-merge is on" };
}

/** Queue order is the time each PR became eligible (doc 02). */
export function queueOrder(candidates: readonly QueueCandidate[]): readonly QueueCandidate[] {
  return candidates
    .filter((c) => isEligible(c).ok)
    .slice()
    .sort((a, b) => a.eligible_at.localeCompare(b.eligible_at) || a.pr - b.pr);
}

/**
 * One job works through the whole queue, then exits. This decides the single
 * next action, which is what makes "one approved PR at a time" true.
 */
export function nextAction(candidates: readonly QueueCandidate[]): QueueAction {
  const ordered = queueOrder(candidates);
  const head = ordered[0];
  if (head === undefined) {
    const firstBlocked = candidates[0];
    return {
      kind: "not_eligible",
      pr: firstBlocked?.pr ?? 0,
      reason: firstBlocked === undefined ? "queue is empty" : isEligible(firstBlocked).reason,
    };
  }
  if (head.conflicting === true) {
    return { kind: "resolve_conflict", pr: head.pr, reason: "conflicts with main; a resolution run rebases and re-clears" };
  }
  if (!head.up_to_date) {
    // This is the step that catches two PRs which pass alone and break together.
    return {
      kind: "update_from_main",
      pr: head.pr,
      reason: "behind main: update, then re-run the gates against the latest main before merging",
    };
  }
  return { kind: "merge", pr: head.pr, reason: "up to date with gates passed on the head commit" };
}

/**
 * A human PR must be up to date with main before it merges, so a human PR and
 * a factory PR cannot each pass alone and break main together (doc 07).
 */
export function humanPrMayMerge(pr: {
  readonly up_to_date: boolean;
  readonly deterministic_gates_passed_on: string | null;
  readonly head_sha: string;
}): { readonly ok: boolean; readonly reason: string } {
  if (!pr.up_to_date) {
    return { ok: false, reason: "behind main: update the branch so it is re-checked against the latest main" };
  }
  if (pr.deterministic_gates_passed_on !== pr.head_sha) {
    return { ok: false, reason: "the deterministic gates have not passed on the head commit" };
  }
  return { ok: true, reason: "up to date and the deterministic gates passed" };
}

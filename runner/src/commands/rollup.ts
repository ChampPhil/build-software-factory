import type { Pipeline } from "../lib/types.js";
import { chooseDispatches, type QueuedItem } from "./intake.js";

/**
 * `bsf rollup` — the last step of every factory workflow, plus a daily sweep.
 *
 * It rebuilds `index.json` and `ledger.json`, and dispatches queued work items
 * when concurrency slots are free. That second job is what stops a crashed or
 * cancelled run from stalling the queue (doc 07): the queue drains without a
 * timer, because every workflow ends here.
 */

export interface RunSummary {
  readonly id: string;
  readonly pipeline: Pipeline;
  readonly actor_kind: "agent" | "human";
  readonly started_at: string;
  readonly ended_at: string;
  readonly outcome: string;
  readonly cost_usd: number;
  readonly escalated: boolean;
  readonly pr: number | null;
  /** True when the PR merged with no human code changes. */
  readonly needed_no_human_changes?: boolean;
  /** Set when a factory PR was reverted within 14 days. */
  readonly reverted?: boolean;
  /** Counted when the PR merged; absent means not measured. */
  readonly human_interactions?: { readonly total: number };
  readonly work_item?: string;
  readonly actions_minutes?: number;
}

export interface WorkItemSummary {
  readonly id: string;
  readonly pipeline: Pipeline;
  readonly status: string;
  readonly priority: "high" | "normal";
  readonly created_at: string;
  readonly merged_at?: string;
  readonly closed_at?: string;
  readonly fingerprint?: string;
  readonly pr?: number | null;
  readonly fixes?: readonly string[];
  readonly source_ref?: string | null;
}

export interface RollupInput {
  readonly now: string;
  readonly runs: readonly RunSummary[];
  readonly workItems: readonly WorkItemSummary[];
  readonly mergeQueue: readonly { readonly pr: number; readonly eligible_at: string }[];
  readonly runningRuns: number;
  readonly maxRuns: number;
  readonly pausedPipelines: readonly Pipeline[];
  readonly windowDays: number;
  /** False until setup's PR has merged; see chooseDispatches. */
  readonly setupFinished?: boolean;
}

export interface Metrics {
  readonly window_days: number;
  readonly runs: number;
  readonly merged: number;
  readonly escalated: number;
  readonly automation_rate: number;
  readonly revert_rate: number;
  readonly spend_usd: number;
  readonly cycle_time_p50_sec: number;
  readonly cycle_time_p90_sec: number;
  readonly human_interactions_per_pr: number | null;
  readonly by_pipeline: Readonly<Record<string, { runs: number; merged: number; spend_usd: number; revert_rate: number }>>;
}

export interface RollupResult {
  readonly metrics: Metrics;
  readonly openItems: readonly WorkItemSummary[];
  readonly recentItems: readonly WorkItemSummary[];
  /** Work items to dispatch now, because slots are free. */
  readonly dispatch: readonly string[];
  readonly dispatchReason: string;
}

const OPEN_STATUSES = new Set(["queued", "running", "in_review", "queued_to_merge", "escalated", "waiting_trust", "needs_info"]);

function withinWindow(at: string, now: string, days: number): boolean {
  const t = Date.parse(at);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return false;
  return n - t <= days * 86_400_000;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

export function runRollup(input: RollupInput): RollupResult {
  const inWindow = input.runs.filter((r) => withinWindow(r.ended_at, input.now, input.windowDays));

  const merged = inWindow.filter((r) => r.outcome === "merged");
  const agentMerged = merged.filter((r) => r.actor_kind === "agent");
  const noHumanChanges = agentMerged.filter((r) => r.needed_no_human_changes === true);
  const reverted = agentMerged.filter((r) => r.reverted === true);

  // Automation rate = merged factory PRs that needed no human code changes
  // over all merged PRs (doc 09).
  const automation_rate = merged.length === 0 ? 0 : round3(noHumanChanges.length / merged.length);
  // Revert rate = factory PRs reverted within 14 days over factory PRs merged.
  const revert_rate = agentMerged.length === 0 ? 0 : round3(reverted.length / agentMerged.length);

  const byPipeline: Record<string, { runs: number; merged: number; spend_usd: number; revert_rate: number }> = {};
  for (const r of inWindow) {
    const b = (byPipeline[r.pipeline] ??= { runs: 0, merged: 0, spend_usd: 0, revert_rate: 0 });
    b.runs += 1;
    if (r.outcome === "merged") b.merged += 1;
    b.spend_usd = round2(b.spend_usd + r.cost_usd);
  }
  for (const [pipeline, b] of Object.entries(byPipeline)) {
    const pMerged = agentMerged.filter((r) => r.pipeline === pipeline);
    const pReverted = pMerged.filter((r) => r.reverted === true);
    b.revert_rate = pMerged.length === 0 ? 0 : round3(pReverted.length / pMerged.length);
  }

  // Human interactions per PR, over the merged factory PRs that recorded a
  // count. Null when none did: an unmeasured window reported as zero would
  // read as a factory nobody had to steer, which is the opposite of the truth.
  const measured = agentMerged
    .map((r) => r.human_interactions?.total)
    .filter((n): n is number => typeof n === "number");
  const human_interactions_per_pr =
    measured.length === 0 ? null : round2(measured.reduce((a, b) => a + b, 0) / measured.length);

  // Cycle time = work item created -> merged.
  const cycleTimes: number[] = [];
  for (const item of input.workItems) {
    if (item.merged_at === undefined) continue;
    if (!withinWindow(item.merged_at, input.now, input.windowDays)) continue;
    const d = (Date.parse(item.merged_at) - Date.parse(item.created_at)) / 1000;
    if (Number.isFinite(d) && d >= 0) cycleTimes.push(Math.round(d));
  }
  cycleTimes.sort((a, b) => a - b);

  const openItems = input.workItems.filter((i) => OPEN_STATUSES.has(i.status));
  // Recent: merged, or closed without merging, in the last 30 days. A closed
  // one stays visible so what waited on it (a sandbox report) can see it ended.
  const recentItems = input.workItems.filter((i) => {
    const at = i.merged_at ?? i.closed_at;
    return at !== undefined && !OPEN_STATUSES.has(i.status) && withinWindow(at, input.now, 30);
  });

  // Dispatch queued items when slots are free. This is the backstop that keeps
  // a cancelled run from stalling the queue.
  const queued: QueuedItem[] = openItems
    .filter((i) => i.status === "queued")
    .map((i) => ({ work_item: i.id, pipeline: i.pipeline, priority: i.priority, created_at: i.created_at }));

  const dispatch = chooseDispatches(queued, {
    maxRuns: input.maxRuns,
    running: input.runningRuns,
    pausedPipelines: input.pausedPipelines,
    ...(input.setupFinished === undefined ? {} : { setupFinished: input.setupFinished }),
  });

  return {
    metrics: {
      window_days: input.windowDays,
      runs: inWindow.length,
      merged: merged.length,
      escalated: inWindow.filter((r) => r.escalated).length,
      automation_rate,
      human_interactions_per_pr,
      revert_rate,
      spend_usd: round2(inWindow.reduce((a, r) => a + r.cost_usd, 0)),
      cycle_time_p50_sec: percentile(cycleTimes, 50),
      cycle_time_p90_sec: percentile(cycleTimes, 90),
      by_pipeline: byPipeline,
    },
    openItems,
    recentItems,
    dispatch: dispatch.dispatch,
    dispatchReason: dispatch.reason,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

/* ------------------------------------------------------------------- budget */

export interface BudgetState {
  readonly limitUsd: number;
  readonly limitMinutes: number | null;
  readonly shares: Readonly<Record<"product_work" | "gardening" | "review_and_benchmarks", number>>;
  readonly spentUsd: Readonly<Record<string, number>>;
  readonly spentMinutes: Readonly<Record<string, number>>;
  readonly productHardStopPct: number;
  /** When given, the pipelines that cannot start a run now, decided from the budget record. */
  readonly paused?: readonly Pipeline[];
}

const SHARE_OF: Readonly<Record<Pipeline, "product_work" | "gardening" | "review_and_benchmarks">> = {
  product_work: "product_work",
  conflict: "product_work",
  gardening: "gardening",
  hardening: "gardening",
  definition: "review_and_benchmarks",
};

/**
 * Each pipeline pauses when either of its shares is used. Product work may
 * also use what the others left unspent, up to the hard stop (doc 07).
 */
export function pausedPipelines(state: BudgetState): readonly Pipeline[] {
  if (state.paused !== undefined) return state.paused;
  const paused: Pipeline[] = [];
  const totalUsd = Object.values(state.spentUsd).reduce((a, b) => a + b, 0);
  const totalMin = Object.values(state.spentMinutes).reduce((a, b) => a + b, 0);

  for (const pipeline of Object.keys(SHARE_OF) as Pipeline[]) {
    const share = SHARE_OF[pipeline];
    const usdShare = (state.limitUsd * state.shares[share]) / 100;
    const spentUsd = state.spentUsd[share] ?? 0;

    const minShare = state.limitMinutes === null ? null : (state.limitMinutes * state.shares[share]) / 100;
    const spentMin = state.spentMinutes[share] ?? 0;

    if (share === "product_work") {
      // Product work may spend into the others' unspent shares, then stops at
      // the hard stop on either limit.
      const hardUsd = (state.limitUsd * state.productHardStopPct) / 100;
      const hardMin = state.limitMinutes === null ? null : (state.limitMinutes * state.productHardStopPct) / 100;
      if (totalUsd >= hardUsd) { paused.push(pipeline); continue; }
      if (hardMin !== null && totalMin >= hardMin) { paused.push(pipeline); continue; }
      continue;
    }

    if (spentUsd >= usdShare) { paused.push(pipeline); continue; }
    if (minShare !== null && spentMin >= minShare) { paused.push(pipeline); continue; }
  }
  return paused;
}

import { describe, it, expect } from "vitest";
import { nextAction, isEligible, queueOrder, humanPrMayMerge, type QueueCandidate } from "../src/commands/merge-queue.js";
import { runRollup, pausedPipelines, type RunSummary, type WorkItemSummary, type BudgetState } from "../src/commands/rollup.js";

function cand(over: Partial<QueueCandidate> = {}): QueueCandidate {
  return {
    pr: 1, work_item: "wi_1", pipeline: "product_work",
    eligible_at: "2026-11-19T10:00:00Z",
    gates_passed_on: "sha1", head_sha: "sha1",
    approved_by_human: true, auto_merge_on: false,
    up_to_date: true, needs_human_whatever_the_toggles: false,
    ...over,
  };
}

describe("eligibility", () => {
  it("needs gates passed on the head commit", () => {
    expect(isEligible(cand({ gates_passed_on: null })).ok).toBe(false);
    expect(isEligible(cand({ gates_passed_on: "older", head_sha: "sha1" })).ok).toBe(false);
    expect(isEligible(cand()).ok).toBe(true);
  });

  it("needs either a human approval or the pipeline's toggle", () => {
    expect(isEligible(cand({ approved_by_human: false, auto_merge_on: false })).ok).toBe(false);
    expect(isEligible(cand({ approved_by_human: false, auto_merge_on: true })).ok).toBe(true);
  });

  it("always needs a human where the weakening or policy check said so, whatever the toggles say", () => {
    const c = cand({ approved_by_human: false, auto_merge_on: true, needs_human_whatever_the_toggles: true });
    expect(isEligible(c).ok).toBe(false);
    expect(isEligible({ ...c, approved_by_human: true }).ok).toBe(true);
  });

  it("orders the queue by when each PR became eligible", () => {
    const order = queueOrder([
      cand({ pr: 3, eligible_at: "2026-11-19T12:00:00Z" }),
      cand({ pr: 1, eligible_at: "2026-11-19T10:00:00Z" }),
      cand({ pr: 2, eligible_at: "2026-11-19T11:00:00Z" }),
    ]);
    expect(order.map((c) => c.pr)).toEqual([1, 2, 3]);
  });
});

describe("criterion: two approved PRs that each pass alone but break the build together never both land", () => {
  it("merges the head of the queue, then makes the second update from main and be re-checked", () => {
    // Both passed their own gates on their own commits. The queue works one at
    // a time, so the second is re-checked against the main that now contains
    // the first — which is where the combination fails.
    const a = cand({ pr: 1, work_item: "wi_a", eligible_at: "2026-11-19T10:00:00Z", up_to_date: true });
    const b = cand({ pr: 2, work_item: "wi_b", eligible_at: "2026-11-19T10:00:30Z", up_to_date: true });

    const first = nextAction([a, b]);
    expect(first).toMatchObject({ kind: "merge", pr: 1 });

    // After #1 merges, #2 is behind main.
    const second = nextAction([{ ...b, up_to_date: false }]);
    expect(second.kind).toBe("update_from_main");
    expect(second.reason).toContain("re-run the gates against the latest main");
  });

  it("never reports merge for a PR that is behind main", () => {
    const action = nextAction([cand({ up_to_date: false })]);
    expect(action.kind).not.toBe("merge");
  });

  it("sends a conflicting PR to a resolution run instead of merging it", () => {
    const action = nextAction([cand({ conflicting: true })]);
    expect(action.kind).toBe("not_eligible");
    const onlyConflict = nextAction([cand({ conflicting: true, approved_by_human: true })]);
    expect(onlyConflict.kind).toBe("not_eligible");
  });

  it("reports the blocking reason when nothing is eligible", () => {
    const action = nextAction([cand({ gates_passed_on: null })]);
    expect(action.kind).toBe("not_eligible");
    expect(action.reason).toContain("gates have not passed");
  });

  it("reports an empty queue", () => {
    expect(nextAction([]).reason).toBe("queue is empty");
  });
});

describe("criterion: a human PR that's behind main can't merge until it's updated and re-checked", () => {
  it("blocks while behind main", () => {
    const v = humanPrMayMerge({ up_to_date: false, deterministic_gates_passed_on: "sha1", head_sha: "sha1" });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("behind main");
  });

  it("blocks when the gates have not passed on the head commit", () => {
    const v = humanPrMayMerge({ up_to_date: true, deterministic_gates_passed_on: "older", head_sha: "sha1" });
    expect(v.ok).toBe(false);
  });

  it("allows once updated and re-checked", () => {
    expect(humanPrMayMerge({ up_to_date: true, deterministic_gates_passed_on: "sha1", head_sha: "sha1" }).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------- rollup */

function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run_1", pipeline: "product_work", actor_kind: "agent",
    started_at: "2026-11-19T09:00:00Z", ended_at: "2026-11-19T10:00:00Z",
    outcome: "merged", cost_usd: 1.5, escalated: false, pr: 1,
    needed_no_human_changes: true, ...over,
  };
}

function item(over: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    id: "wi_1", pipeline: "product_work", status: "queued",
    priority: "normal", created_at: "2026-11-19T09:00:00Z", ...over,
  };
}

describe("criterion: a cancelled run doesn't stall the queue — the next rollup dispatches the next queued item", () => {
  it("dispatches a queued item even though the previous run was cancelled", () => {
    const res = runRollup({
      now: "2026-11-19T12:00:00Z",
      runs: [run({ id: "run_cancelled", outcome: "cancelled", escalated: false })],
      workItems: [
        item({ id: "wi_stuck", status: "queued", created_at: "2026-11-19T09:00:00Z" }),
        item({ id: "wi_next", status: "queued", created_at: "2026-11-19T09:30:00Z" }),
      ],
      mergeQueue: [], runningRuns: 0, maxRuns: 5, pausedPipelines: [], windowDays: 30,
    });
    expect(res.dispatch).toEqual(["wi_stuck", "wi_next"]);
  });

  it("dispatches nothing when every slot is busy, and says why", () => {
    const res = runRollup({
      now: "2026-11-19T12:00:00Z", runs: [],
      workItems: [item({ status: "queued" })],
      mergeQueue: [], runningRuns: 5, maxRuns: 5, pausedPipelines: [], windowDays: 30,
    });
    expect(res.dispatch).toEqual([]);
    expect(res.dispatchReason).toContain("no slots free");
  });

  it("counts a running item as open but does not dispatch it again", () => {
    const res = runRollup({
      now: "2026-11-19T12:00:00Z", runs: [],
      workItems: [item({ id: "wi_running", status: "running" })],
      mergeQueue: [], runningRuns: 1, maxRuns: 5, pausedPipelines: [], windowDays: 30,
    });
    expect(res.openItems.map((i) => i.id)).toEqual(["wi_running"]);
    expect(res.dispatch).toEqual([]);
  });
});

describe("metrics", () => {
  it("computes the automation rate as merged PRs needing no human code changes over all merged", () => {
    const res = runRollup({
      now: "2026-11-19T12:00:00Z",
      runs: [
        run({ id: "r1", needed_no_human_changes: true }),
        run({ id: "r2", needed_no_human_changes: true }),
        run({ id: "r3", needed_no_human_changes: false }),
        run({ id: "r4", outcome: "escalated", escalated: true }),
      ],
      workItems: [], mergeQueue: [], runningRuns: 0, maxRuns: 5, pausedPipelines: [], windowDays: 30,
    });
    expect(res.metrics.merged).toBe(3);
    expect(res.metrics.automation_rate).toBeCloseTo(2 / 3, 3);
    expect(res.metrics.escalated).toBe(1);
  });

  it("tracks the revert rate, overall and per pipeline", () => {
    const res = runRollup({
      now: "2026-11-19T12:00:00Z",
      runs: [
        run({ id: "r1", reverted: true }),
        run({ id: "r2" }), run({ id: "r3" }), run({ id: "r4" }),
        run({ id: "r5", pipeline: "gardening" }),
      ],
      workItems: [], mergeQueue: [], runningRuns: 0, maxRuns: 5, pausedPipelines: [], windowDays: 30,
    });
    expect(res.metrics.revert_rate).toBeCloseTo(1 / 5, 3);
    expect(res.metrics.by_pipeline["product_work"]?.revert_rate).toBeCloseTo(1 / 4, 3);
    expect(res.metrics.by_pipeline["gardening"]?.revert_rate).toBe(0);
  });

  it("measures cycle time from work item created to merged", () => {
    const res = runRollup({
      now: "2026-11-19T12:00:00Z", runs: [],
      workItems: [
        item({ id: "wi_1", status: "merged", created_at: "2026-11-19T09:00:00Z", merged_at: "2026-11-19T10:00:00Z" }),
        item({ id: "wi_2", status: "merged", created_at: "2026-11-19T08:00:00Z", merged_at: "2026-11-19T11:00:00Z" }),
      ],
      mergeQueue: [], runningRuns: 0, maxRuns: 5, pausedPipelines: [], windowDays: 30,
    });
    expect(res.metrics.cycle_time_p50_sec).toBe(3600);
    expect(res.metrics.cycle_time_p90_sec).toBe(10800);
  });

  it("ignores runs outside the window", () => {
    const res = runRollup({
      now: "2026-12-30T12:00:00Z",
      runs: [run({ ended_at: "2026-11-01T10:00:00Z" })],
      workItems: [], mergeQueue: [], runningRuns: 0, maxRuns: 5, pausedPipelines: [], windowDays: 30,
    });
    expect(res.metrics.runs).toBe(0);
  });

  it("sums spend per pipeline", () => {
    const res = runRollup({
      now: "2026-11-19T12:00:00Z",
      runs: [run({ id: "r1", cost_usd: 1.5 }), run({ id: "r2", cost_usd: 2.25 }), run({ id: "r3", pipeline: "gardening", cost_usd: 0.5 })],
      workItems: [], mergeQueue: [], runningRuns: 0, maxRuns: 5, pausedPipelines: [], windowDays: 30,
    });
    expect(res.metrics.spend_usd).toBeCloseTo(4.25, 2);
    expect(res.metrics.by_pipeline["product_work"]?.spend_usd).toBeCloseTo(3.75, 2);
  });
});

describe("criterion (v0.2): when gardening's budget share is used, gardening pauses while product work continues", () => {
  const base: BudgetState = {
    limitUsd: 200, limitMinutes: 2000,
    shares: { product_work: 60, gardening: 25, review_and_benchmarks: 15 },
    spentUsd: {}, spentMinutes: {}, productHardStopPct: 110,
  };

  it("pauses gardening at its share and leaves product work running", () => {
    const paused = pausedPipelines({ ...base, spentUsd: { gardening: 50, product_work: 10 } });
    expect(paused).toContain("gardening");
    expect(paused).not.toContain("product_work");
  });

  it("lets product work use unspent shares up to the hard stop", () => {
    const under = pausedPipelines({ ...base, spentUsd: { product_work: 150 } });
    expect(under).not.toContain("product_work");
    const over = pausedPipelines({ ...base, spentUsd: { product_work: 220 } });
    expect(over).toContain("product_work");
  });

  it("pauses on the minutes limit as well as the dollar limit", () => {
    const paused = pausedPipelines({ ...base, spentMinutes: { gardening: 500 } });
    expect(paused).toContain("gardening");
  });

  it("has no minutes limit on a public repo", () => {
    const paused = pausedPipelines({ ...base, limitMinutes: null, spentMinutes: { gardening: 99999 } });
    expect(paused).not.toContain("gardening");
  });

  it("counts hardening against the gardening share", () => {
    const paused = pausedPipelines({ ...base, spentUsd: { gardening: 50 } });
    expect(paused).toContain("hardening");
  });
});

describe("human interactions per PR", () => {
  const run = (over: Partial<RunSummary>): RunSummary => ({
    id: "run_01JDF8YQKX7M3N2PQRS4TVWX01",
    pipeline: "product_work",
    actor_kind: "agent",
    started_at: "2026-11-19T09:00:00Z",
    ended_at: "2026-11-19T10:00:00Z",
    outcome: "merged",
    cost_usd: 1,
    escalated: false,
    pr: 1,
    ...over,
  });

  const input = (runs: readonly RunSummary[]) => ({
    now: "2026-11-20T10:00:00Z",
    runs,
    workItems: [],
    mergeQueue: [],
    runningRuns: 0,
    maxRuns: 5,
    pausedPipelines: [],
    windowDays: 30,
  });

  it("averages over the merged factory PRs that recorded a count", () => {
    const r = runRollup(
      input([
        run({ id: "run_01JDF8YQKX7M3N2PQRS4TVWX01", human_interactions: { total: 2 } }),
        run({ id: "run_01JDF8YQKX7M3N2PQRS4TVWX02", human_interactions: { total: 5 } }),
      ]),
    );
    expect(r.metrics.human_interactions_per_pr).toBe(3.5);
  });

  it("is null when nothing recorded a count, never zero", () => {
    // Zero would read as a factory nobody had to steer, which is the opposite
    // of what an unmeasured window means.
    const r = runRollup(input([run({})]));
    expect(r.metrics.human_interactions_per_pr).toBeNull();
  });

  it("ignores a run that recorded nothing rather than counting it as zero", () => {
    const r = runRollup(
      input([
        run({ id: "run_01JDF8YQKX7M3N2PQRS4TVWX01", human_interactions: { total: 4 } }),
        run({ id: "run_01JDF8YQKX7M3N2PQRS4TVWX02" }),
      ]),
    );
    expect(r.metrics.human_interactions_per_pr).toBe(4);
  });

  it("counts only merged factory PRs, not a human's own PR", () => {
    const r = runRollup(
      input([
        run({ id: "run_01JDF8YQKX7M3N2PQRS4TVWX01", actor_kind: "human", human_interactions: { total: 9 } }),
        run({ id: "run_01JDF8YQKX7M3N2PQRS4TVWX02", human_interactions: { total: 1 } }),
      ]),
    );
    expect(r.metrics.human_interactions_per_pr).toBe(1);
  });

  it("ignores a run that did not merge", () => {
    const r = runRollup(
      input([
        run({ id: "run_01JDF8YQKX7M3N2PQRS4TVWX01", outcome: "escalated", human_interactions: { total: 9 } }),
        run({ id: "run_01JDF8YQKX7M3N2PQRS4TVWX02", human_interactions: { total: 2 } }),
      ]),
    );
    expect(r.metrics.human_interactions_per_pr).toBe(2);
  });

  it("ignores a merge outside the window", () => {
    const r = runRollup(
      input([
        run({
          id: "run_01JDF8YQKX7M3N2PQRS4TVWX01",
          ended_at: "2026-01-01T10:00:00Z",
          human_interactions: { total: 9 },
        }),
        run({ id: "run_01JDF8YQKX7M3N2PQRS4TVWX02", human_interactions: { total: 3 } }),
      ]),
    );
    expect(r.metrics.human_interactions_per_pr).toBe(3);
  });
});

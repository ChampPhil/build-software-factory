import type { GitHub } from "../lib/github.js";
import { FactoryStore, INDEX, LEDGER, json } from "../lib/store.js";
import { sweepReports } from "./sandbox-reports.js";
import type { Change } from "../lib/dataref.js";
import { MEDIA_REF } from "../lib/dataref.js";
import {
  runRollup, pausedPipelines,
  type RunSummary, type WorkItemSummary, type Metrics, type BudgetState,
} from "./rollup.js";
import type { Pipeline } from "../lib/types.js";

/**
 * `bsf rollup` — the last step of every factory workflow, and a daily sweep.
 *
 * It rebuilds the two derived files (`index.json`, `ledger.json`) from the run
 * and work-item files, so a crashed run leaves no stale state behind: the next
 * rollup recomputes everything. It also dispatches queued work when slots are
 * free, which is what stops a crashed run from stalling the queue (doc 07).
 */

export interface RollupOptions {
  readonly gh: GitHub;
  readonly now: string;
  readonly windowDays: number;
  readonly maxRuns: number;
  readonly runnerPin: string;
  readonly harness: string;
  readonly budget: BudgetState;
  /** False until setup's PR has merged; see chooseDispatches. */
  readonly setupFinished?: boolean;
  readonly guardrails: {
    readonly rules: number;
    readonly baselined: number;
    readonly coverage_floor_pct: number;
    readonly candidates_pending: number;
  };
  /** Only what was measured: a field the rollup cannot know is left out, not guessed. */
  readonly health: {
    readonly gardening_schedule_active?: boolean;
    readonly last_review?: string;
    readonly lock_files_current?: boolean;
    readonly sandbox_profile?: string;
    readonly enforcement?: "branch_protection" | "audit";
  };
  readonly runWorkflow?: string;
  readonly ref?: string;
  readonly plan?: boolean;
  /** Whether the budget has room for a sandbox amendment. */
  readonly amendmentFits?: () => Promise<{ readonly ok: boolean; readonly reason: string }>;
  /** Squash the media ref when the month changed since the last squash. */
  readonly mediaRetentionMonths?: number;
}

export interface RollupReport {
  readonly metrics: Metrics;
  readonly dispatched: readonly string[];
  readonly dispatchReason: string;
  readonly paused: readonly Pipeline[];
  readonly commit: string | null;
  /** What the sandbox-report sweep did. */
  readonly amendment?: string;
}

/** Read every run file and work item on the data ref. */
export async function readAll(store: FactoryStore): Promise<{
  runs: RunSummary[];
  workItems: WorkItemSummary[];
}> {
  const paths = await store.data.list();
  const runPaths = paths.filter((p) => /^runs\/[^/]+\.json$/.test(p));
  const itemPaths = paths.filter((p) => p.startsWith("work-items/") && p.endsWith(".json"));

  const runs: RunSummary[] = [];
  for (const p of runPaths) {
    const doc = await store.get<RunSummary & { id?: string }>(p, "run");
    if (doc !== null) runs.push(doc);
  }
  const workItems: WorkItemSummary[] = [];
  for (const p of itemPaths) {
    const doc = await store.get<WorkItemSummary & { source?: { ref?: string | null } }>(p, "work-item");
    if (doc !== null) workItems.push({ ...doc, source_ref: doc.source?.ref ?? null });
  }
  return { runs, workItems };
}

export async function runRollupCommand(opts: RollupOptions): Promise<RollupReport> {
  const store = new FactoryStore(opts.gh);
  const { runs, workItems } = await readAll(store);
  const ledger = await store.ledger(opts.now);

  const paused = pausedPipelines(opts.budget);
  const running = runs.filter((r) => r.outcome === "running").length;

  const result = runRollup({
    now: opts.now,
    runs,
    workItems,
    mergeQueue: ledger.merge_queue,
    runningRuns: running,
    maxRuns: opts.maxRuns,
    pausedPipelines: paused,
    windowDays: opts.windowDays,
    ...(opts.setupFinished === undefined ? {} : { setupFinished: opts.setupFinished }),
  });

  const index = {
    schema: "index/1",
    updated_at: opts.now,
    factory: { runner: opts.runnerPin, harness: opts.harness },
    metrics: result.metrics,
    // Run ids, as schema/index.json and the dashboard read them. The rollup
    // wrote objects here, which the schema refused, so the index never
    // updated once a factory had a run and every metric read zero.
    recent_runs: runs
      .slice()
      .sort((a, b) => b.ended_at.localeCompare(a.ended_at))
      .slice(0, 20)
      .map((r) => r.id),
    guardrails: opts.guardrails,
    health: opts.health,
  };

  const nextLedger = {
    schema: "ledger/1" as const,
    updated_at: opts.now,
    open: result.openItems.map((i) => ({
      work_item: i.id,
      pipeline: i.pipeline,
      status: i.status,
      priority: i.priority,
      created_at: i.created_at,
      ...(i.fingerprint === undefined ? {} : { fingerprint: i.fingerprint }),
      ...(i.pr == null ? {} : { pr: i.pr }),
      ...(i.fixes === undefined ? {} : { fixes: [...i.fixes] }),
      ...(i.source_ref == null ? {} : { source_ref: i.source_ref }),
    })),
    recent: result.recentItems.map((i) => ({
      work_item: i.id,
      status: i.status,
      ...(i.merged_at === undefined ? {} : { merged_at: i.merged_at }),
      ...(i.fingerprint === undefined ? {} : { fingerprint: i.fingerprint }),
      ...(i.pr == null ? {} : { pr: i.pr }),
    })),
    merge_queue: ledger.merge_queue,
  };

  const changes: Change[] = [
    { path: INDEX, content: json(index) },
    { path: LEDGER, content: json(nextLedger) },
    // budget.json is not written here: it is the reserve and settle steps'
    // record, kept by compare-and-swap. The rollup used to write back the
    // budget it had read, which is why spend never accumulated.
  ];
  const commit = await store.put(changes, `rollup: ${result.metrics.runs} run(s) in window`);

  const dispatched: string[] = [];
  if (opts.plan !== true) {
    for (const id of result.dispatch) {
      await opts.gh.dispatchWorkflow(opts.runWorkflow ?? "factory-run.yml", opts.ref, {
        work_item: id,
      });
      dispatched.push(id);
    }
  }

  // A sandbox report that waited — for its change to merge, or for the open
  // amendment to finish — goes to the next amendment from here.
  let amendment: string | undefined;
  try {
    const sweep = await sweepReports({
      gh: opts.gh, store, ledger: nextLedger, now: opts.now,
      ...(opts.plan === true ? { plan: true } : {}),
      ...(opts.amendmentFits === undefined ? {} : { fits: opts.amendmentFits }),
    });
    amendment = sweep.why;
  } catch (e) {
    amendment = `sandbox reports not swept: ${(e as Error).message}`;
  }

  return {
    metrics: result.metrics,
    amendment,
    dispatched,
    dispatchReason: result.dispatchReason,
    paused,
    commit,
  };
}

/**
 * Rewrite the media ref as a single commit without expired media, so repo size
 * stays bounded (doc 07). Monthly, because each rewrite re-uploads what it
 * keeps and that is the cost of dropping history.
 */
export async function squashMedia(
  gh: GitHub,
  now: string,
  retentionMonths: number,
): Promise<{ kept: number; dropped: number }> {
  const media = new FactoryStore(gh, MEDIA_REF);
  const paths = await media.data.list();
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - retentionMonths);

  const keep: string[] = [];
  const drop: string[] = [];
  for (const p of paths) {
    // Media is stored under a dated prefix (media/YYYY-MM-DD/...), which is
    // what makes expiry decidable without reading every blob.
    const m = /(\d{4}-\d{2}-\d{2})/.exec(p);
    const at = m?.[1] === undefined ? null : Date.parse(m[1]);
    if (at === null || Number.isNaN(at) || at >= cutoff.getTime()) keep.push(p);
    else drop.push(p);
  }
  if (drop.length === 0) return { kept: keep.length, dropped: 0 };

  await media.data.replaceWith(
    keep,
    `media: keep ${keep.length} file(s), drop ${drop.length} past ${retentionMonths} months`,
  );
  return { kept: keep.length, dropped: drop.length };
}

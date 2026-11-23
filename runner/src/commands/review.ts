import type { GitHub } from "../lib/github.js";
import { FactoryStore, LEDGER, json, workItemPath, reviewPath } from "../lib/store.js";
import type { Change } from "../lib/dataref.js";
import { readAll } from "./rollup-run.js";
import { fingerprint, sourceKind } from "./intake.js";
import { workItemId, reviewId } from "../lib/ids.js";
import type { Pipeline } from "../lib/types.js";

/**
 * `bsf review due` and `bsf review route` — the deterministic halves of the
 * scheduled review (doc 06): it scores recent runs and routes what it finds to
 * hardening. It never changes the factory's own prompts, context or models.
 *
 * The scoring itself is the scorer role's job. What is decided here is when a
 * review is worth running at all, and where each problem the scoring found
 * should go. Both are rules, not judgements, so they belong in code where they
 * can be tested — and where a review cannot talk itself into running.
 */

export interface DueInput {
  readonly now: string;
  readonly lastReviewAt: string | null;
  readonly runsSinceLastReview: number;
  /** When the factory's first reviewable run started; only read before any review has run. */
  readonly firstRunAt?: string | null;
  readonly everyDays?: number;
  readonly earlyAtRuns?: number;
  readonly minRuns?: number;
}

export interface DueResult {
  readonly due: boolean;
  readonly reason: string;
}

/** Runs the review grades: `/practice` runs are a person's own change and are not scored. */
export const isReviewable = (pipeline: string): boolean => pipeline !== "definition";

const DAY_MS = 86_400_000;

/**
 * Every 3 days, early at 50 runs, and later reviews skipped under 5 runs.
 *
 * The first review is different: it is never skipped for having few runs. Once
 * 3 days have passed since the factory's first run, one run is enough, so a
 * new factory shows scoring and hardening soon instead of waiting for volume.
 */
export function reviewDue(input: DueInput): DueResult {
  const everyDays = input.everyDays ?? 3;
  const earlyAt = input.earlyAtRuns ?? 50;
  const minRuns = input.minRuns ?? 5;
  const runs = input.runsSinceLastReview;

  if (runs >= earlyAt) {
    return { due: true, reason: `${runs} runs have piled up, which is early-trigger territory` };
  }

  if (input.lastReviewAt === null) {
    if (runs < 1) return { due: false, reason: "no runs yet, so there is nothing to grade" };
    const first = input.firstRunAt === undefined || input.firstRunAt === null ? Number.NaN : Date.parse(input.firstRunAt);
    if (Number.isNaN(first)) {
      return { due: true, reason: `first review, with ${runs} run(s) to grade (the first run's date is unreadable)` };
    }
    const days = (Date.parse(input.now) - first) / DAY_MS;
    if (Number.isNaN(days) || days >= everyDays) {
      return { due: true, reason: `first review: ${everyDays} days since the first run, with ${runs} run(s) to grade` };
    }
    return {
      due: false,
      reason: `first review waits for day ${everyDays}: ${days.toFixed(1)} days since the first run, ${runs} run(s) so far`,
    };
  }

  if (runs < minRuns) {
    return {
      due: false,
      reason: `only ${runs} run(s) since the last review; ${minRuns} are needed for the scores to mean anything`,
    };
  }
  const elapsedDays = (Date.parse(input.now) - Date.parse(input.lastReviewAt)) / DAY_MS;
  if (Number.isNaN(elapsedDays)) {
    return { due: true, reason: "the last review's date is unreadable, so treat a review as due" };
  }
  if (elapsedDays >= everyDays) {
    return { due: true, reason: `${elapsedDays.toFixed(1)} days since the last review` };
  }
  return {
    due: false,
    reason: `${elapsedDays.toFixed(1)} of ${everyDays} days since the last review, and ${runs} runs is under the early trigger`,
  };
}

/* -------------------------------------------------------------------- routing */

export interface ScoredFailure {
  readonly run: string;
  readonly role: string;
  readonly area: string;
  readonly tag: string;
  /** 1–5; 1 and 2 are failures. */
  readonly score?: number;
  readonly kind: "low_score" | "escalation" | "revert" | "human_correction";
  readonly detail?: string;
}

export interface Problem {
  readonly id: string;
  readonly tag: string;
  readonly area: string;
  readonly role: string;
  readonly occurrences: number;
  readonly runs: readonly string[];
  readonly why: string;
}

/** A failure the review saw and did not turn into work. */
export interface Unrouted {
  readonly run: string;
  readonly tag: string;
  readonly reason: string;
  readonly detail?: string;
}

export interface Routing {
  readonly problems: readonly Problem[];
  readonly unrouted: readonly Unrouted[];
}

export const HARDENING_RUN_REASON =
  "found in a hardening run: shown to a person, never hardened again, so hardening cannot feed itself";

/**
 * Every problem the review finds goes to hardening: the codebase, a static
 * rule or a verification scenario. A check outlives a paragraph of context,
 * and a wrong route costs one rejected PR. The review never changes the
 * factory's own prompts, context or models.
 *
 * One exception: a failure found in a hardening run is set aside. Otherwise a
 * bad hardening run would file another hardening item, whose own bad run
 * would file another. Those failures are recorded as `unrouted`, so a person
 * sees them on the dashboard.
 */
export function groupAndRoute(
  failures: readonly ScoredFailure[],
  opts: { readonly pipelineOf?: (run: string) => string | undefined } = {},
): Routing {
  const unrouted: Unrouted[] = [];
  const routable: ScoredFailure[] = [];
  for (const f of failures) {
    if (f.run !== "" && opts.pipelineOf?.(f.run) === "hardening") {
      unrouted.push({
        run: f.run,
        tag: f.tag,
        reason: HARDENING_RUN_REASON,
        ...(f.detail === undefined ? {} : { detail: f.detail }),
      });
    } else routable.push(f);
  }

  const groups = new Map<string, ScoredFailure[]>();
  for (const f of routable) {
    // Same tag plus same area, or same tag plus same role: one problem.
    const key = `${f.tag}::${f.area !== "" ? f.area : `role:${f.role}`}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [f]);
    else list.push(f);
  }

  const problems = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([key, list]) => {
      const first = list[0]!;
      return {
        id: `p-${fingerprint({ title: key, body: first.tag }).slice(0, 12)}`,
        tag: first.tag,
        area: first.area,
        role: first.role,
        occurrences: list.length,
        runs: [...new Set(list.map((f) => f.run))],
        why: `${first.tag} is something a check can catch, which is cheaper and permanent`,
      };
    });
  return { problems, unrouted };
}

/* ------------------------------------------------------------------- command */

export interface ReviewOptions {
  readonly gh: GitHub;
  readonly now: string;
  readonly everyDays?: number;
  readonly earlyAtRuns?: number;
  readonly minRuns?: number;
  readonly ref?: string;
  readonly plan?: boolean;
  /** Start of the window the scores cover; defaults to the last review. */
  readonly windowFrom?: string;
}

export interface ReviewDueReport extends DueResult {
  readonly runsSinceLastReview: number;
  readonly lastReviewAt: string | null;
}

export async function runReviewDue(opts: ReviewOptions): Promise<ReviewDueReport> {
  const store = new FactoryStore(opts.gh);
  const paths = await store.data.list("reviews/");
  const last = paths
    .filter((p) => p.endsWith(".json"))
    .sort()
    .pop();
  const lastReviewAt = last === undefined ? null : await lastReviewTimestamp(store, last);

  // `/practice` runs are not scored, so they neither count toward a review nor
  // start the first review's clock.
  const runs = (await readAll(store)).runs.filter((r) => isReviewable(r.pipeline));
  const since = lastReviewAt === null
    ? runs.length
    : runs.filter((r) => Date.parse(r.ended_at) > Date.parse(lastReviewAt)).length;
  const firstRunAt = runs.map((r) => r.started_at).sort()[0] ?? null;

  const result = reviewDue({
    now: opts.now,
    lastReviewAt,
    runsSinceLastReview: since,
    firstRunAt,
    ...(opts.everyDays === undefined ? {} : { everyDays: opts.everyDays }),
    ...(opts.earlyAtRuns === undefined ? {} : { earlyAtRuns: opts.earlyAtRuns }),
    ...(opts.minRuns === undefined ? {} : { minRuns: opts.minRuns }),
  });
  return { ...result, runsSinceLastReview: since, lastReviewAt };
}

async function lastReviewTimestamp(store: FactoryStore, path: string): Promise<string | null> {
  const doc = await store.data.readJson<{ at?: string; created_at?: string }>(path);
  return doc?.at ?? doc?.created_at ?? null;
}

export interface RouteReport {
  readonly problems: readonly Problem[];
  readonly unrouted: readonly Unrouted[];
  readonly filed: readonly { readonly work_item: string; readonly destination: string }[];
  readonly dispatched: readonly string[];
}

/** Turn the scored failures into work items, one per problem. */
export async function runReviewRoute(
  opts: ReviewOptions & {
    readonly failures: readonly ScoredFailure[];
    /** Every score the scorer gave, failures or not, for the review record. Defaults to the failures. */
    readonly allScores?: readonly ScoredFailure[];
  },
): Promise<RouteReport> {
  const store = new FactoryStore(opts.gh);
  const ledger = await store.ledger(opts.now);
  // Which pipeline each failing run belonged to, so a failure found in a
  // hardening run is set aside instead of hardened again.
  const pipelines = new Map<string, string>();
  for (const id of new Set(opts.failures.map((f) => f.run).filter((r) => r !== ""))) {
    const doc = await store.data.readJson<{ pipeline?: string }>(`runs/${id}.json`).catch(() => null);
    if (doc?.pipeline !== undefined) pipelines.set(id, doc.pipeline);
  }
  const { problems, unrouted } = groupAndRoute(opts.failures, { pipelineOf: (run) => pipelines.get(run) });

  const changes: Change[] = [];
  const filed: { work_item: string; destination: string }[] = [];
  const open = [...ledger.open];

  for (const p of problems) {
    const pipeline: Pipeline = "hardening";
    const id = workItemId(Date.parse(opts.now) || Date.now());
    const item = {
      schema: "work-item/1" as const,
      id,
      created_at: opts.now,
      source: { kind: sourceKind("review_routed"), ref: null, actor: "factory", via: null },
      trigger_class: "self" as const,
      pipeline,
      title: `${p.tag} in ${p.area !== "" ? p.area : p.role} (${p.occurrences}×)`,
      body: `${p.why}\n\nRuns:\n${p.runs.map((r) => `- ${r}`).join("\n")}`,
      priority: p.occurrences >= 3 ? ("high" as const) : ("normal" as const),
      fingerprint: fingerprint({ title: p.tag, body: p.area }),
      status: "queued" as const,
      runs: [...p.runs],
      pr: null,
      parent: null,
      related: [],
      spec: null,
    };
    changes.push({ path: workItemPath(id), content: json(item) });
    open.push({
      work_item: id,
      pipeline,
      status: "queued",
      fingerprint: item.fingerprint,
      priority: item.priority,
      created_at: opts.now,
      fixes: [p.tag],
    });
    filed.push({ work_item: id, destination: "hardening" });
  }

  const recorded = opts.allScores ?? opts.failures;
  // The record is written whenever anything was scored, problems or not: it
  // is how the next review knows where this one's window ended, and how the
  // dashboard shows a review that found nothing wrong.
  if (changes.length > 0 || recorded.length > 0) {
    if (changes.length > 0) changes.push({ path: LEDGER, content: json({ ...ledger, updated_at: opts.now, open }) });
    changes.push({
      path: reviewPath(opts.now.slice(0, 10)),
      content: json({
        schema: "review/1",
        id: reviewId(opts.now),
        window: {
          from: opts.windowFrom ?? opts.now,
          to: opts.now,
          runs: new Set(recorded.map((f) => f.run)).size,
        },
        // Only scored criteria go in `scores`; escalations, reverts and
        // corrections are failures without a score, and they show up in the
        // problems they caused rather than as invented 1s.
        scores: recorded
          .filter((f) => f.score !== undefined)
          .map((f) => ({
            run: f.run,
            criterion: f.role === "" ? f.tag : `${f.role}:${f.tag}`,
            score: f.score as number,
            tags: [f.tag],
            ...(f.detail === undefined ? {} : { note: f.detail }),
          })),
        ...(unrouted.length === 0 ? {} : { unrouted }),
        problems: problems.map((pr, i) => ({
          title: `${pr.tag} in ${pr.area !== "" ? pr.area : pr.role} (${pr.occurrences}×)`,
          runs: [...pr.runs],
          route: "hardening",
          work_item: filed[i]?.work_item ?? null,
          change: pr.why,
        })),
      }),
    });
    await store.put(changes, `review: ${problems.length} problem(s) routed`);
  }

  const dispatched: string[] = [];
  if (opts.plan !== true) {
    for (const f of filed) {
      await opts.gh.dispatchWorkflow("factory-run.yml", opts.ref, { work_item: f.work_item });
      dispatched.push(f.work_item);
    }
  }

  return { problems, unrouted, filed, dispatched };
}

import type { GitHub } from "../lib/github.js";
import { FactoryStore, LEDGER, json, workItemPath, reviewPath } from "../lib/store.js";
import type { Change } from "../lib/dataref.js";
import { readAll } from "./rollup-run.js";
import { fingerprint, sourceKind } from "./intake.js";
import { workItemId, reviewId } from "../lib/ids.js";
import type { Pipeline } from "../lib/types.js";

/**
 * `bsf review due` and `bsf review route` — the deterministic halves of the
 * scheduled self-improvement review (doc 06).
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
  readonly everyDays?: number;
  readonly earlyAtRuns?: number;
  readonly minRuns?: number;
}

export interface DueResult {
  readonly due: boolean;
  readonly reason: string;
}

/** Every 3 days, early at 50 runs, skipped under 10 (doc 06). */
export function reviewDue(input: DueInput): DueResult {
  const everyDays = input.everyDays ?? 3;
  const earlyAt = input.earlyAtRuns ?? 50;
  const minRuns = input.minRuns ?? 10;

  if (input.runsSinceLastReview < minRuns) {
    return {
      due: false,
      reason: `only ${input.runsSinceLastReview} run(s) since the last review; ${minRuns} are needed for the scores to mean anything`,
    };
  }
  if (input.runsSinceLastReview >= earlyAt) {
    return { due: true, reason: `${input.runsSinceLastReview} runs have piled up, which is early-trigger territory` };
  }
  if (input.lastReviewAt === null) {
    return { due: true, reason: `first review, with ${input.runsSinceLastReview} runs to grade` };
  }
  const elapsedDays = (Date.parse(input.now) - Date.parse(input.lastReviewAt)) / 86_400_000;
  if (Number.isNaN(elapsedDays)) {
    return { due: true, reason: "the last review's date is unreadable, so treat a review as due" };
  }
  if (elapsedDays >= everyDays) {
    return { due: true, reason: `${elapsedDays.toFixed(1)} days since the last review` };
  }
  return {
    due: false,
    reason: `${elapsedDays.toFixed(1)} of ${everyDays} days since the last review, and ${input.runsSinceLastReview} runs is under the early trigger`,
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
  readonly destination: "hardening" | "definition";
  readonly why: string;
}

/**
 * Where a fix belongs decides where the problem goes (doc 06): the codebase,
 * a static rule or a verification scenario is hardening; context or a step's
 * model is a definition change.
 *
 * The tags that mean "the agent did not know something" route to definition;
 * everything else is a thing code can be made to catch, so it routes to
 * hardening. Defaulting to hardening is deliberate: a check outlives a
 * paragraph of context, and a wrong hardening route costs one rejected PR
 * while a wrong definition route costs a benchmark cycle.
 */
const DEFINITION_TAGS = new Set([
  "context_gap",
  "wrong_model_fit",
  "missing_evidence",
  "vague_spec",
  "unverifiable_checks",
]);

export function groupAndRoute(failures: readonly ScoredFailure[]): readonly Problem[] {
  const groups = new Map<string, ScoredFailure[]>();
  for (const f of failures) {
    // Same tag plus same area, or same tag plus same role: one problem.
    const key = `${f.tag}::${f.area !== "" ? f.area : `role:${f.role}`}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [f]);
    else list.push(f);
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([key, list]) => {
      const first = list[0]!;
      const toDefinition = DEFINITION_TAGS.has(first.tag);
      return {
        id: `p-${fingerprint({ title: key, body: first.tag }).slice(0, 12)}`,
        tag: first.tag,
        area: first.area,
        role: first.role,
        occurrences: list.length,
        runs: [...new Set(list.map((f) => f.run))],
        destination: toDefinition ? ("definition" as const) : ("hardening" as const),
        why: toDefinition
          ? `${first.tag} is something the agent did not know, which a context or model change addresses`
          : `${first.tag} is something a check can catch, which is cheaper and permanent`,
      };
    });
}

/* ------------------------------------------------------- benchmark admission */

export interface BenchmarkComparison {
  readonly failureTaskScores: { readonly before: readonly number[]; readonly after: readonly number[] };
  readonly otherTaskScores: { readonly before: readonly number[]; readonly after: readonly number[] };
  readonly costBefore: number;
  readonly costAfter: number;
  readonly taskCount: number;
  readonly repeats: number;
}

export interface AdmissionResult {
  readonly admit: boolean;
  readonly reasons: readonly string[];
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const spread = (xs: readonly number[]): number => (xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs));

/**
 * A definition change is admitted only if the failure tasks improve, nothing
 * else regresses, the gain is larger than the run-to-run spread, and cost
 * rises by at most 20% (doc 06).
 *
 * The spread test is the one that matters: without it, every change looks
 * like an improvement about half the time.
 */
export function admitDefinitionChange(c: BenchmarkComparison): AdmissionResult {
  const reasons: string[] = [];
  if (c.taskCount < 10) reasons.push(`benchmarked on ${c.taskCount} task(s); at least 10 are needed`);
  if (c.repeats < 3) reasons.push(`${c.repeats} repeat(s) per side; at least 3 are needed to see the spread`);

  const failBefore = mean(c.failureTaskScores.before);
  const failAfter = mean(c.failureTaskScores.after);
  const gain = failAfter - failBefore;
  if (gain <= 0) reasons.push(`the failure tasks did not improve (${failBefore.toFixed(2)} → ${failAfter.toFixed(2)})`);

  const noise = Math.max(spread(c.failureTaskScores.before), spread(c.failureTaskScores.after));
  if (gain <= noise) {
    reasons.push(
      `the gain of ${gain.toFixed(2)} is inside the run-to-run spread of ${noise.toFixed(2)}, so it could be chance`,
    );
  }

  const otherBefore = mean(c.otherTaskScores.before);
  const otherAfter = mean(c.otherTaskScores.after);
  if (otherAfter < otherBefore) {
    reasons.push(`other tasks regressed (${otherBefore.toFixed(2)} → ${otherAfter.toFixed(2)})`);
  }

  if (c.costBefore > 0 && c.costAfter > c.costBefore * 1.2) {
    const pct = ((c.costAfter / c.costBefore - 1) * 100).toFixed(0);
    reasons.push(`cost rises ${pct}%, over the 20% ceiling`);
  }

  return { admit: reasons.length === 0, reasons };
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

  const { runs } = await readAll(store);
  const since = lastReviewAt === null
    ? runs.length
    : runs.filter((r) => Date.parse(r.ended_at) > Date.parse(lastReviewAt)).length;

  const result = reviewDue({
    now: opts.now,
    lastReviewAt,
    runsSinceLastReview: since,
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
  const problems = groupAndRoute(opts.failures);

  const changes: Change[] = [];
  const filed: { work_item: string; destination: string }[] = [];
  const open = [...ledger.open];

  for (const p of problems) {
    const pipeline: Pipeline = p.destination === "hardening" ? "hardening" : "definition";
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
    filed.push({ work_item: id, destination: p.destination });
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
        problems: problems.map((pr, i) => ({
          title: `${pr.tag} in ${pr.area !== "" ? pr.area : pr.role} (${pr.occurrences}×)`,
          runs: [...pr.runs],
          route: pr.destination,
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
      // Definition changes are benchmark-gated and a human approves them, so
      // they are queued rather than started here.
      if (f.destination === "definition") continue;
      await opts.gh.dispatchWorkflow("factory-run.yml", opts.ref, { work_item: f.work_item });
      dispatched.push(f.work_item);
    }
  }

  return { problems, filed, dispatched };
}

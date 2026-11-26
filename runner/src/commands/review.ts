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
  /** Whose problem this is: the repo's, or the factory's own (fix 8). Set by the review, not the scorer. */
  readonly target?: "repo" | "factory";
}

/**
 * Findings whose cause is that the factory never produced the proof, not that
 * the repo lacks it: a verifier that did not finish cannot have shown the
 * checks passing.
 */
export const FACTORY_CLASSES: ReadonlySet<string> = new Set(["missing_evidence", "unverifiable_checks", "overclaimed"]);

/** Whether a run's own record shows the factory failed to verify it. */
export function factoryCouldNotVerify(run: {
  readonly steps?: readonly { readonly role?: string; readonly exit?: string }[];
  readonly app?: { readonly url?: string | null };
  readonly gates?: { readonly verification?: string };
} | null): boolean {
  if (run === null) return false;
  if ((run.steps ?? []).some((s) => s.role === "verifier" && s.exit !== undefined && s.exit !== "ok")) return true;
  if (run.app !== undefined && run.app.url === null) return true;
  return run.gates?.verification === "not_run";
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
  /**
   * The stable problem id, so the next review can tell whether a thing it has
   * just seen once is the same thing the last one saw once.
   */
  readonly problem?: string;
}

export interface Routing {
  readonly problems: readonly Problem[];
  readonly unrouted: readonly Unrouted[];
}

export const HARDENING_RUN_REASON =
  "found in a hardening run: shown to a person, never hardened again, so hardening cannot feed itself";

export const SEEN_ONCE_REASON =
  "seen once: recorded and watched, and hardened if it happens again, because one occurrence is an incident";

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
  opts: {
    readonly pipelineOf?: (run: string) => string | undefined;
    /**
     * Problem ids an earlier review already saw once. A problem in here is
     * routed on its second sighting even though this window holds one.
     */
    readonly seenBefore?: ReadonlySet<string>;
  } = {},
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

  const grouped = [...groups.entries()]
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

  /**
   * A problem seen once is watched, not hardened.
   *
   * Every problem the review found used to become a guardrail, and a problem
   * can be one scored failure in one run. So a single bad afternoon — a flaky
   * dependency, an odd issue, a model having a bad time — could install a rule
   * that every future change is judged against forever, and the rule outlives
   * whatever caused it by years. Nobody is asked, because this path is the
   * autonomous one.
   *
   * Twice is the bar, and it is not a delay: the sighting is recorded, and if
   * the thing is real it recurs and the next review routes it. What is lost is
   * only the rules that should never have existed.
   */
  const problems = grouped.filter((p) => p.occurrences > 1 || (opts.seenBefore?.has(p.id) ?? false));
  const routed = new Set(problems.map((p) => p.id));
  for (const p of grouped) {
    if (routed.has(p.id)) continue;
    unrouted.push({
      run: p.runs[0] ?? "",
      tag: p.tag,
      reason: SEEN_ONCE_REASON,
      problem: p.id,
      ...(p.area === "" ? {} : { detail: `in ${p.area}` }),
    });
  }
  return { problems, unrouted };
}

/** Problem ids earlier reviews recorded as seen once. */
export function seenOnceIds(reviews: readonly { readonly unrouted?: readonly Unrouted[] }[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const r of reviews) {
    for (const u of r.unrouted ?? []) {
      if (u.reason === SEEN_ONCE_REASON && u.problem !== undefined) ids.add(u.problem);
    }
  }
  return ids;
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

/** The most recent review records, newest last. */
async function recentReviews(
  store: FactoryStore,
  howMany: number,
): Promise<readonly { readonly unrouted?: readonly Unrouted[] }[]> {
  const paths = (await store.data.list("reviews/").catch(() => [])).filter((p) => p.endsWith(".json")).sort();
  const out: { unrouted?: readonly Unrouted[] }[] = [];
  for (const path of paths.slice(-howMany)) {
    const doc = await store.data.readJson<{ unrouted?: readonly Unrouted[] }>(path).catch(() => null);
    if (doc !== null) out.push(doc);
  }
  return out;
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
  const cannotVerify = new Set<string>();
  for (const id of new Set(opts.failures.map((f) => f.run).filter((r) => r !== ""))) {
    const doc = await store.data
      .readJson<Parameters<typeof factoryCouldNotVerify>[0] & { pipeline?: string }>(`runs/${id}.json`)
      .catch(() => null);
    if (doc?.pipeline !== undefined) pipelines.set(id, doc.pipeline);
    if (factoryCouldNotVerify(doc)) cannotVerify.add(id);
  }
  // A finding about missing proof, on a run the factory could not verify, is
  // the factory's problem: it is filed once as a health item, never as a rule
  // to harden the repo with.
  const targetOf = (f: ScoredFailure): "repo" | "factory" =>
    f.target ?? (FACTORY_CLASSES.has(f.tag) && cannotVerify.has(f.run) ? "factory" : "repo");
  const factoryFindings = opts.failures.filter((f) => targetOf(f) === "factory");
  const repoFailures = opts.failures.filter((f) => targetOf(f) === "repo");
  // What earlier reviews saw once. A problem this window saw once is routed
  // only if one of them saw it too — twice is the bar for installing a rule
  // nobody was asked about. The last few reviews are enough: a thing that has
  // not recurred in that long is not a problem class.
  const seenBefore = seenOnceIds(await recentReviews(store, 4));

  const { problems, unrouted } = groupAndRoute(repoFailures, {
    pipelineOf: (run) => pipelines.get(run),
    seenBefore,
  });

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

  if (factoryFindings.length > 0) {
    const tags = [...new Set(factoryFindings.map((f) => f.tag))].sort();
    const runs = [...new Set(factoryFindings.map((f) => f.run))].sort();
    const fp = fingerprint({ title: "factory_health", body: tags.join(",") });
    if (!open.some((o) => o.fingerprint === fp && o.status === "queued")) {
      const id = workItemId((Date.parse(opts.now) || Date.now()) + 1);
      const doc = {
        schema: "work-item/1" as const,
        id,
        created_at: opts.now,
        source: { kind: sourceKind("review_routed"), ref: null, actor: "factory", via: null },
        trigger_class: "self" as const,
        pipeline: "factory_health" as const,
        title: `The factory could not verify ${runs.length} run${runs.length === 1 ? "" : "s"}`,
        body:
          `The review found missing proof (${tags.join(", ")}) on runs where the verifier did not finish or the app did not start. ` +
          `That is the factory's fault, not the repository's, so no rule was proposed.\n\nRuns:\n${runs.map((r) => `- ${r}`).join("\n")}`,
        priority: "high" as const,
        fingerprint: fp,
        status: "queued" as const,
        runs,
        pr: null,
        parent: null,
        related: [],
        spec: null,
      };
      changes.push({ path: workItemPath(id), content: json(doc) });
      open.push({ work_item: id, pipeline: "factory_health", status: "queued", fingerprint: fp, priority: "high", created_at: opts.now, fixes: tags });
      // Never dispatched: it is listed on the dashboard's Factory health section.
    }
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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { GitHub } from "../lib/github.js";
import { FactoryStore, json } from "../lib/store.js";
import { baselinedDrift, untestedRecent, runGardenCommand, type DriftItem } from "./garden.js";
import { readAll } from "./rollup-run.js";
import { runReviewRoute, type ScoredFailure } from "./review.js";
import type { Baselines } from "../lib/types.js";

/**
 * The gardener's, hardener's and scorer's own steps.
 *
 * Each follows the same shape: a `--out` step that hands the agent the
 * measured facts, and a `--from`/`--scores` step that takes what the agent
 * decided and does something deterministic with it. The split is what keeps
 * the measurable work out of a model's hands — a model asked to count
 * violations will approximate, and the count is the thing the ratchet is
 * compared against.
 */

/* ------------------------------------------------------------------ gardener */

export interface GardenScanReport {
  readonly measured: readonly DriftItem[];
  readonly alreadyFixing: readonly string[];
  readonly wrote: string;
}

/**
 * `bsf garden-scan` — the measurable two of gardening's three kinds of drift
 * (doc 06), handed to the gardener so it spends its run on the third.
 */
export async function gardenScan(opts: {
  readonly gh: GitHub;
  readonly now: string;
  readonly root: string;
  readonly baselines: Baselines;
  readonly out: string;
  readonly windowDays?: number;
}): Promise<GardenScanReport> {
  const store = new FactoryStore(opts.gh);
  const ledger = await store.ledger(opts.now);
  const alreadyFixing = [...new Set(ledger.open.flatMap((o) => o.fixes ?? []))];

  const measured = [
    ...baselinedDrift(opts.baselines),
    ...(await untestedRecent(opts.root, opts.windowDays ?? 14)),
  ].filter((i) => !alreadyFixing.includes(i.problem_class));

  write(
    opts.out,
    json({
      measured,
      already_fixing: alreadyFixing,
      note:
        "These two kinds were counted, not judged — baselined rule violations and " +
        "behaviour merged in the window with no test in the same commit. The third kind, " +
        "principle drift no rule catches, is yours to find. Anything in already_fixing is " +
        "covered by an open PR; filing it again would mean two PRs racing on the same files.",
    }),
  );
  return { measured, alreadyFixing, wrote: opts.out };
}

export interface GardenPick {
  readonly kind?: DriftItem["kind"];
  readonly problem_class: string;
  readonly occurrences?: number;
  readonly files?: readonly string[];
  readonly detail?: string;
  /** Set when the same drift has been seen three nights running (doc 06). */
  readonly hand_off_to_hardening?: boolean;
}

export interface GardenFileReport {
  readonly filed: readonly string[];
  readonly dispatched: readonly string[];
  readonly handedOff: readonly string[];
  readonly rejected: readonly { readonly problem_class: string; readonly why: string }[];
}

/**
 * `bsf garden-file` — turn the gardener's picks into work items.
 *
 * The picks are checked rather than trusted: a pick whose problem class an
 * open PR already fixes is rejected here, because the agent saw the ledger at
 * scan time and the ledger may have moved since.
 */
export async function gardenFile(opts: {
  readonly gh: GitHub;
  readonly now: string;
  readonly root: string;
  readonly from: string;
  readonly maxPrs: number;
  readonly freeSlots?: number;
  readonly plan?: boolean;
}): Promise<GardenFileReport> {
  const picks = JSON.parse(readFileSync(opts.from, "utf8")) as { picks?: GardenPick[] } | GardenPick[];
  const list = Array.isArray(picks) ? picks : picks.picks ?? [];

  const store = new FactoryStore(opts.gh);
  const ledger = await store.ledger(opts.now);
  const alreadyFixing = new Set(ledger.open.flatMap((o) => o.fixes ?? []));

  const rejected: { problem_class: string; why: string }[] = [];
  const accepted: DriftItem[] = [];
  const handedOff: string[] = [];

  for (const p of list) {
    if (typeof p.problem_class !== "string" || p.problem_class.trim() === "") {
      rejected.push({ problem_class: String(p.problem_class), why: "no problem class named" });
      continue;
    }
    if (alreadyFixing.has(p.problem_class)) {
      rejected.push({ problem_class: p.problem_class, why: "an open PR already fixes this" });
      continue;
    }
    if (p.hand_off_to_hardening === true) {
      // Found in three gardening runs: it becomes a rule, so gardening stops
      // having to fix it (doc 06).
      handedOff.push(p.problem_class);
      continue;
    }
    accepted.push({
      kind: p.kind ?? "principle_drift",
      problem_class: p.problem_class,
      occurrences: p.occurrences ?? 1,
      files: p.files ?? [],
      detail: p.detail ?? "found by the gardener",
    });
  }

  const report = await runGardenCommand({
    gh: opts.gh,
    now: opts.now,
    root: opts.root,
    // The measured kinds were already handed to the agent; what comes back is
    // its picks, so nothing is re-scanned here.
    baselines: { schema: "baselines/1", rules: {} },
    maxPrs: opts.maxPrs,
    extra: accepted,
    ...(opts.freeSlots === undefined ? {} : { freeSlots: opts.freeSlots }),
    ...(opts.plan === true ? { plan: true } : {}),
  });

  for (const cls of handedOff) {
    await fileHardeningItem(opts.gh, opts.now, cls, "a gardening hand-off: found in three runs");
  }

  return { filed: report.filed, dispatched: report.dispatched, handedOff, rejected };
}

/** A hardening work item, for a gardening hand-off or a routed problem. */
export async function fileHardeningItem(
  gh: GitHub,
  now: string,
  problemClass: string,
  why: string,
): Promise<readonly string[]> {
  const r = await runReviewRoute({
    gh,
    now,
    plan: true,
    failures: [
      { run: "", role: "gardener", area: "", tag: problemClass, kind: "low_score", detail: why },
    ],
  });
  return r.filed.map((f) => f.work_item);
}

/* ------------------------------------------------------------------ hardener */

export interface HardenContextReport {
  readonly wrote: string;
  readonly openRules: number;
  readonly candidates: number;
}

/**
 * `bsf harden-context` — what the hardener must check before generalizing.
 *
 * Step 1 of hardening is "check the ledger and candidates.json for an existing
 * rule or candidate first" (doc 06). Handing it those lists is the difference
 * between that being an instruction and being a fact it has.
 */
export async function hardenContext(opts: {
  readonly gh: GitHub;
  readonly now: string;
  readonly id: string;
  readonly out: string;
  readonly baselines: Baselines;
  readonly candidatesPath?: string;
}): Promise<HardenContextReport> {
  const store = new FactoryStore(opts.gh);
  const ledger = await store.ledger(opts.now);
  const item = await store.get<{ title?: string; body?: string | null; runs?: string[] }>(
    `work-items/${opts.id}.json`,
    "work-item",
  );

  const candidates =
    opts.candidatesPath !== undefined && existsSync(opts.candidatesPath)
      ? (JSON.parse(readFileSync(opts.candidatesPath, "utf8")) as { candidates?: unknown[] }).candidates ?? []
      : [];

  const existingRules = Object.keys(opts.baselines.rules ?? {});

  write(
    opts.out,
    json({
      work_item: opts.id,
      title: item?.title ?? null,
      detail: item?.body ?? null,
      existing_rules: existingRules,
      existing_candidates: candidates,
      open_work: ledger.open.map((o) => ({ work_item: o.work_item, fixes: o.fixes ?? [] })),
      note:
        "Check existing_rules and existing_candidates before proposing anything: a second rule " +
        "for a class already covered is a rule nobody can act on. The ordered check for the " +
        "strongest fix is in the role prompt; the point of this file is that you are not guessing " +
        "what already exists.",
    }),
  );
  return { wrote: opts.out, openRules: existingRules.length, candidates: candidates.length };
}

/* -------------------------------------------------------------------- scorer */

export interface ReviewCollectReport {
  readonly runs: number;
  readonly wrote: string;
  readonly since: string | null;
}

/** `bsf review-collect` — the runs to grade, with the rubrics to grade them against. */
export async function reviewCollect(opts: {
  readonly gh: GitHub;
  readonly now: string;
  readonly out: string;
  readonly rubricsDir?: string;
}): Promise<ReviewCollectReport> {
  const store = new FactoryStore(opts.gh);
  const reviews = (await store.data.list("reviews/")).filter((p) => p.endsWith(".json")).sort();
  const last = reviews[reviews.length - 1];
  const since =
    last === undefined
      ? null
      : ((await store.data.readJson<{ window?: { to?: string } }>(last))?.window?.to ?? null);

  const { runs } = await readAll(store);
  const toScore = runs
    .filter((r) => since === null || Date.parse(r.ended_at) > Date.parse(since))
    .map((r) => ({
      id: r.id,
      pipeline: r.pipeline,
      outcome: r.outcome,
      ended_at: r.ended_at,
      escalated: r.escalated,
      cost_usd: r.cost_usd,
      pr: r.pr,
    }));

  write(
    opts.out,
    json({
      since,
      runs: toScore,
      note:
        "Grade each run against its pipeline's rubric and the shared rubric, 1-5 per criterion, " +
        "with failure tags from the rubric's own list. A tag you invent routes nowhere.",
    }),
  );
  return { runs: toScore.length, wrote: opts.out, since };
}

export interface ReviewWriteReport {
  readonly scored: number;
  readonly problems: number;
  readonly filed: readonly string[];
  readonly dispatched: readonly string[];
}

/** `bsf review-write` — the scorer's scores, grouped, routed and filed. */
export async function reviewWrite(opts: {
  readonly gh: GitHub;
  readonly now: string;
  readonly scores: string;
  readonly plan?: boolean;
}): Promise<ReviewWriteReport> {
  const doc = JSON.parse(readFileSync(opts.scores, "utf8")) as
    | { failures?: ScoredFailure[]; scores?: ScoredFailure[] }
    | ScoredFailure[];
  const failures = Array.isArray(doc) ? doc : doc.failures ?? doc.scores ?? [];

  // Only 1s and 2s, escalations, reverts and corrections are failures (doc 06).
  // A 4 is not a problem, and routing one would fill the queue with noise.
  const real = failures.filter((f) => f.score === undefined || f.score <= 2);

  const r = await runReviewRoute({
    gh: opts.gh,
    now: opts.now,
    failures: real,
    ...(opts.plan === true ? { plan: true } : {}),
  });
  return {
    scored: failures.length,
    problems: r.problems.length,
    filed: r.filed.map((f) => f.work_item),
    dispatched: r.dispatched,
  };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

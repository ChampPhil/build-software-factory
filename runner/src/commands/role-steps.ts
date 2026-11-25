import { overlay, readDecisions, type CandidateLike } from "./candidate-decisions.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitHub } from "../lib/github.js";
import { FactoryStore, json, runPath, workItemPath } from "../lib/store.js";
import { baselinedDrift, untestedRecent, runGardenCommand, type DriftItem } from "./garden.js";
import { readAll } from "./rollup-run.js";
import { runReviewRoute, isReviewable, type ScoredFailure } from "./review.js";
import type { Baselines, Policy } from "../lib/types.js";
import { PROSE_EVIDENCE_MINIMUM } from "./repo-prose.js";

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
    scan: false,
    extra: accepted,
    ...(opts.freeSlots === undefined ? {} : { freeSlots: opts.freeSlots }),
    ...(opts.plan === true ? { plan: true } : {}),
  });

  for (const cls of handedOff) {
    await fileHardeningItem(opts.gh, opts.now, cls, "a gardening hand-off: found in three runs");
  }

  for (const s of report.scan.skipped) rejected.push({ problem_class: s.problem_class, why: s.reason });
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
/**
 * Whether this repo has granted hardening the written-practice lever, said
 * plainly so a run does not spend a model on a change the gate will refuse.
 *
 * It is off unless the policy says otherwise, and that is deliberate for a repo
 * that installed the factory before the lever existed: its policy predates the
 * choice, so nothing starts writing into its AGENTS.md on the strength of an
 * upgrade.
 */
export function proseNote(policy: Policy | null | undefined): string {
  const may = policy?.pipelines?.["hardening"]?.may_change ?? [];
  if (!may.includes("prose")) {
    return (
      "This repository has not granted hardening the written-practice lever, so a change to " +
      "AGENTS.md or any other conventions file will be refused at the gate. Use a static rule, " +
      "a verification requirement or a refactor. If the correction genuinely has no mechanical " +
      "home, say so in a comment on the work item and leave it to a person."
    );
  }
  return (
    "The conventions this repository keeps for agents are listed in " +
    "/tmp/gh-aw/agent/bsf/repo-prose.md, and they are the only place a written practice may go. " +
    `Writing one needs at least ${PROSE_EVIDENCE_MINIMUM} instances listed under a "## Why a practice" ` +
    "heading in the pull request, and a file already at its budget has to have a line replaced " +
    "rather than added. Nothing under .factory/ is ever a place to write prose."
  );
}

export async function hardenContext(opts: {
  readonly gh: GitHub;
  readonly now: string;
  readonly id: string;
  readonly out: string;
  readonly baselines: Baselines;
  readonly candidatesPath?: string;
  /** The policy, to say whether the written-practice lever is granted here. */
  readonly policy?: Policy | null;
}): Promise<HardenContextReport> {
  const store = new FactoryStore(opts.gh);
  const ledger = await store.ledger(opts.now);
  const item = await store.get<{ title?: string; body?: string | null; runs?: string[] }>(
    `work-items/${opts.id}.json`,
    "work-item",
  );

  const stored =
    opts.candidatesPath !== undefined && existsSync(opts.candidatesPath)
      ? (JSON.parse(readFileSync(opts.candidatesPath, "utf8")) as { candidates?: CandidateLike[] }).candidates ?? []
      : [];
  // What people decided on the dashboard is laid over the file; a candidate
  // someone rejected is not for the hardener to propose again.
  const candidates = overlay(stored, await readDecisions(store).catch(() => null)).filter((c) => c.status !== "rejected");

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
        "for a class already covered is a rule nobody can act on. The four ways to change the " +
        "codebase (a static rule, a stronger verification requirement, a refactor, or writing the " +
        "practice into the repo's own conventions) are in the role prompt, with what the fourth " +
        "costs; the point of this file is that you are not guessing what already exists.",
      prose: proseNote(opts.policy),
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

/** At most this many runs per review: the newest, so the scorer's cost stays bounded. */
const MAX_RUNS_TO_SCORE = 12;
/** And at most this much diff per run. */
const DIFF_CHARS_PER_RUN = 30_000;

/** `bsf review-collect` — the runs to grade, with what to grade them on and the rubrics. */
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
  const picked = runs
    // A `/practice` run is a person's own change; the review does not grade it.
    .filter((r) => isReviewable(r.pipeline))
    .filter((r) => since === null || Date.parse(r.ended_at) > Date.parse(since))
    .sort((a, b) => a.ended_at.localeCompare(b.ended_at))
    .slice(-MAX_RUNS_TO_SCORE);

  // Everything the scorer grades on is fetched here, by the trusted runner,
  // and handed over as a file. The scorer cannot fetch it itself: gh-aw's
  // integrity filter refuses the content of PRs the factory's own bot
  // opened, and the scorer was left grading outcomes without seeing code.
  const toScore = [];
  for (const r of picked) {
    const problems: string[] = [];
    let diff: { file: string; status: string; patch: string | null }[] = [];
    if (r.pr !== null) {
      try {
        let budget = DIFF_CHARS_PER_RUN;
        diff = (await opts.gh.pullFiles(r.pr)).map((f) => {
          const patch = f.patch === undefined ? null : f.patch.slice(0, Math.max(0, budget));
          budget -= patch?.length ?? 0;
          return { file: f.filename, status: f.status, patch };
        });
        if (budget < 0) problems.push(`the diff is longer than ${DIFF_CHARS_PER_RUN} characters and was cut`);
      } catch (e) {
        problems.push(`the diff of PR #${r.pr} could not be read: ${(e as Error).message}`);
      }
    }
    const item = r.work_item === undefined ? null : await store.get<Record<string, unknown>>(workItemPath(r.work_item), "work-item").catch(() => null);
    // The roles' PR reports: what each claimed and the proof it attached.
    const reports: unknown[] = [];
    if (r.work_item !== undefined) {
      for (const p of (await store.data.list(`reports/${r.work_item}/`).catch(() => [] as readonly string[])).filter((x) => x.endsWith(".json")).slice(0, 6)) {
        const rep = await store.data.readJson<{ role?: string; report?: unknown; problems?: unknown }>(p).catch(() => null);
        if (rep !== null) reports.push({ role: rep.role ?? null, report: rep.report ?? null, problems: rep.problems ?? [] });
      }
    }
    const run = await store.data.readJson<Record<string, unknown>>(runPath(r.id)).catch(() => null);
    toScore.push({
      id: r.id,
      pipeline: r.pipeline,
      outcome: r.outcome,
      ended_at: r.ended_at,
      escalated: r.escalated,
      cost_usd: r.cost_usd,
      pr: r.pr,
      request: item === null ? null : { title: item["title"] ?? null, body: item["body"] ?? null },
      spec: item?.["spec"] ?? null,
      gates: run?.["gates"] ?? null,
      steps: run?.["steps"] ?? null,
      reports,
      diff,
      problems,
    });
  }

  const rubrics: Record<string, string> = {};
  if (opts.rubricsDir !== undefined && existsSync(opts.rubricsDir)) {
    for (const f of readdirSync(opts.rubricsDir).filter((x) => x.endsWith(".yaml"))) {
      rubrics[f.replace(/\.yaml$/, "")] = readFileSync(join(opts.rubricsDir, f), "utf8");
    }
  }

  write(
    opts.out,
    json({
      since,
      runs: toScore,
      rubrics,
      note:
        "Grade each run against its pipeline's rubric and the shared rubric, 1-5 per criterion, " +
        "with failure tags from the rubric's own list. A tag you invent routes nowhere. " +
        "Everything to grade on is in this file: the request, the spec, the diff, the gates and the steps. " +
        "Score a criterion null when this file does not carry what it needs, and say which.",
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
  const failures = normalizeScores(JSON.parse(readFileSync(opts.scores, "utf8")) as unknown);
  // The window starts where review-collect began: the last review's end, or
  // the oldest run it handed over. It sits beside the scores.
  let windowFrom: string | undefined;
  const collected = join(dirname(opts.scores), "to-score.json");
  if (existsSync(collected)) {
    try {
      const c = JSON.parse(readFileSync(collected, "utf8")) as { since?: string | null; runs?: { ended_at?: string }[] };
      windowFrom = c.since ?? c.runs?.map((r) => r.ended_at).filter((x): x is string => typeof x === "string").sort()[0];
    } catch {
      /* no window start: the record says from = to */
    }
  }

  // Only 1s and 2s, escalations, reverts and corrections are failures (doc 06).
  // A 4 is not a problem, and routing one would fill the queue with noise.
  // A criterion left unscored (the evidence was missing) is not a failure.
  const real = failures.filter((f) => (f.kind === "low_score" ? f.score !== undefined && f.score <= 2 : true));

  const r = await runReviewRoute({
    gh: opts.gh,
    now: opts.now,
    failures: real,
    allScores: failures,
    ...(windowFrom === undefined ? {} : { windowFrom }),
    ...(opts.plan === true ? { plan: true } : {}),
  });
  return {
    scored: failures.length,
    problems: r.problems.length,
    filed: r.filed.map((f) => f.work_item),
    dispatched: r.dispatched,
  };
}

type Loose = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * The scorer's scores as flat records, one per run and criterion. The prompt
 * asks for that shape exactly; the nested shapes a model reaches for — a list
 * of runs each with its criteria, as a list or keyed by name — are read too,
 * because a review that silently finds nothing is the failure to avoid.
 */
export function normalizeScores(doc: unknown): ScoredFailure[] {
  const top: unknown[] = Array.isArray(doc) ? doc : ((doc as Loose)?.["scores"] ?? (doc as Loose)?.["failures"] ?? (doc as Loose)?.["runs"] ?? []) as unknown[];
  const out: ScoredFailure[] = [];
  const push = (run: string, role: string, area: string, c: Loose, name?: string): void => {
    const score = num(c["score"]);
    const tag = str(c["tag"]) ?? (Array.isArray(c["tags"]) ? str((c["tags"] as unknown[])[0]) : undefined) ?? str(c["failure_tag"]);
    const detail = str(c["detail"]) ?? str(c["note"]) ?? str(c["notes"]);
    out.push({
      run,
      role: str(c["role"]) ?? role,
      area: str(c["area"]) ?? area,
      tag: tag ?? (name !== undefined ? name.replace(/\s+/g, "_") : "untagged"),
      ...(score === undefined ? {} : { score }),
      kind: (str(c["kind"]) as ScoredFailure["kind"] | undefined) ?? "low_score",
      ...(detail === undefined ? {} : { detail: name === undefined ? detail : `${name}: ${detail}` }),
    });
  };
  for (const entry of Array.isArray(top) ? top : []) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Loose;
    const run = str(e["run"]) ?? str(e["run_id"]) ?? str(e["id"]) ?? "unknown";
    const role = str(e["role"]) ?? "builder";
    const area = str(e["area"]) ?? "repo";
    const nested = e["criteria"] ?? (typeof e["scores"] === "object" ? e["scores"] : undefined);
    if (num(e["score"]) !== undefined || nested === undefined) {
      push(run, role, area, e);
    } else if (Array.isArray(nested)) {
      for (const c of nested) if (c !== null && typeof c === "object") push(run, role, area, c as Loose, str((c as Loose)["criterion"]) ?? str((c as Loose)["name"]));
    } else if (nested !== null && typeof nested === "object") {
      for (const [name, c] of Object.entries(nested as Loose)) {
        if (typeof c === "number") push(run, role, area, { score: c }, name);
        else if (c !== null && typeof c === "object") push(run, role, area, c as Loose, name);
      }
    }
  }
  return out;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

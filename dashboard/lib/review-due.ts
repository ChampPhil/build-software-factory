/**
 * Whether the factory's self-review is due, with the reason, by the same rule
 * the review workflow uses (`bsf review due`, runner/src/commands/review.ts).
 * A scheduled review that is not due skips itself; "Run a review now" forces
 * one. The test compares this with the runner's own function so they cannot
 * drift apart.
 */
const DAY_MS = 86_400_000;

export interface DueInput {
  readonly now: string;
  readonly lastReviewAt: string | null;
  readonly runsSinceLastReview: number;
  readonly firstRunAt?: string | null;
  readonly everyDays?: number;
  readonly earlyAtRuns?: number;
  readonly minRuns?: number;
}

export function reviewDueNow(input: DueInput): { readonly due: boolean; readonly reason: string } {
  const everyDays = input.everyDays ?? 3;
  const earlyAt = input.earlyAtRuns ?? 50;
  const minRuns = input.minRuns ?? 5;
  const runs = input.runsSinceLastReview;

  if (runs >= earlyAt) return { due: true, reason: `${runs} runs have piled up, which is early-trigger territory` };

  if (input.lastReviewAt === null) {
    if (runs < 1) return { due: false, reason: "no runs yet, so there is nothing to grade" };
    const first = input.firstRunAt === undefined || input.firstRunAt === null ? Number.NaN : Date.parse(input.firstRunAt);
    if (Number.isNaN(first)) return { due: true, reason: `first review, with ${runs} run(s) to grade (the first run's date is unreadable)` };
    const days = (Date.parse(input.now) - first) / DAY_MS;
    if (Number.isNaN(days) || days >= everyDays) return { due: true, reason: `first review: ${everyDays} days since the first run, with ${runs} run(s) to grade` };
    return { due: false, reason: `first review waits for day ${everyDays}: ${days.toFixed(1)} days since the first run, ${runs} run(s) so far` };
  }

  if (runs < minRuns) return { due: false, reason: `only ${runs} run(s) since the last review; ${minRuns} are needed for the scores to mean anything` };
  const elapsedDays = (Date.parse(input.now) - Date.parse(input.lastReviewAt)) / DAY_MS;
  if (Number.isNaN(elapsedDays)) return { due: true, reason: "the last review's date is unreadable, so treat a review as due" };
  if (elapsedDays >= everyDays) return { due: true, reason: `${elapsedDays.toFixed(1)} days since the last review` };
  return { due: false, reason: `${elapsedDays.toFixed(1)} of ${everyDays} days since the last review, and ${runs} runs is under the early trigger` };
}

/** The runs a review would grade: everything but `/practice` runs, after the last review. */
export function reviewInputFrom(
  runs: readonly { readonly pipeline: string; readonly started_at: string; readonly ended_at: string }[],
  lastReviewAt: string | null,
  now: string,
): DueInput {
  const reviewable = runs.filter((r) => r.pipeline !== "definition");
  const since = lastReviewAt === null ? reviewable.length : reviewable.filter((r) => Date.parse(r.ended_at) > Date.parse(lastReviewAt)).length;
  const firstRunAt = reviewable.map((r) => r.started_at).sort()[0] ?? null;
  return { now, lastReviewAt, runsSinceLastReview: since, firstRunAt };
}

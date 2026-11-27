import { SHARE_OF, type ShareUse } from "./metrics";
import type { Pipeline, RunFile } from "./types";

/**
 * `budget.json` on the factory data ref (schema `budget/2`).
 *
 * This is the runner's own ledger of the month, including setup. It is not
 * the index, and it is not the per-step files.
 *
 * spent_usd: dollars charged this month, keyed by pipeline name, plus setup.
 */
export interface BudgetFile {
  readonly schema?: string;
  readonly month?: string;
  readonly spent_usd?: Readonly<Record<string, unknown>>;
}

/** One step record the runner writes at `steps/<run>/<role>-<attempt>.json`. */
export interface StepRecord {
  readonly role: string;
  readonly run_id: string;
  readonly attempt?: number;
  readonly at: string;
  readonly cost_usd: number;
  readonly duration_sec?: number;
  readonly billed_minutes?: number | null | undefined;
}

const monthOf = (iso: string): string => iso.slice(0, 7);

/** What the factory spent in a month: the sum of every step record, nothing else. */
export function spendFromSteps(steps: readonly StepRecord[], month: string): number {
  const total = steps.filter((s) => monthOf(s.at) === month).reduce((n, s) => n + (s.cost_usd ?? 0), 0);
  return Math.round(total * 100) / 100;
}

/** Billed Actions minutes for the month, counting only steps that were measured. */
export function minutesFromSteps(steps: readonly StepRecord[], month: string): number {
  return steps.filter((s) => monthOf(s.at) === month).reduce((n, s) => n + (s.billed_minutes ?? 0), 0);
}

/** A share's use is its spend divided by its slice of `monthly_usd` from budget.json. */
export function shareFraction(spentUsd: number, monthlyUsd: number, sharePercent: number): number {
  const allowance = (monthlyUsd * sharePercent) / 100;
  return allowance <= 0 ? 0 : spentUsd / allowance;
}

/** Median seconds from start to end over the runs that opened a pull request. */
export function medianRequestToPr(runs: readonly Pick<RunFile, "started_at" | "ended_at" | "pr">[]): number | null {
  const secs = runs
    .filter((r) => r.pr !== null && r.pr !== undefined)
    .map((r) => (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (secs.length === 0) return null;
  const mid = Math.floor(secs.length / 2);
  return secs.length % 2 === 1 ? secs[mid]! : (secs[mid - 1]! + secs[mid]!) / 2;
}

/** The outcome a person sees: "Opened PR #N" when the run opened one, never "Failed". */
export function outcomeLabel(run: Pick<RunFile, "outcome" | "pr">, fallback: string): string {
  if (run.pr !== null && run.pr !== undefined) return `Opened PR #${run.pr}`;
  return fallback;
}

/**
 * What each share of the budget spent this month, from the step records: every
 * step is charged to the share of the pipeline its run belongs to. A step whose
 * run is not known (older than the runs read) is left out rather than guessed.
 */
export function spentByShare(
  steps: readonly StepRecord[],
  pipelineOfRun: Readonly<Record<string, Pipeline>>,
  month: string,
): Record<ShareUse["share"], number> {
  const out: Record<ShareUse["share"], number> = { product_work: 0, gardening: 0, review_and_benchmarks: 0 };
  for (const s of steps) {
    if (monthOf(s.at) !== month) continue;
    const pipeline = pipelineOfRun[s.run_id];
    if (pipeline === undefined) continue;
    const share = SHARE_OF[pipeline];
    if (share === undefined) continue;
    out[share] += s.cost_usd ?? 0;
  }
  for (const k of Object.keys(out) as ShareUse["share"][]) out[k] = Math.round(out[k] * 100) / 100;
  return out;
}

const SHARE_KEYS = ["product_work", "gardening", "review_and_benchmarks"] as const;

/**
 * The one-time setup charge, in dollars rounded to cents.
 *
 * This is the `setup` key only. A later sandbox update is a different key
 * (`sandbox_upkeep`) and stays out of this number, so the one-time row does
 * not grow every time a journey is added. A missing or non-numeric key is
 * zero, which the page treats as "there is no setup charge to name."
 *
 * spent: the `spent_usd` object from budget.json, or null when the file has none.
 */
export function oneTimeSetupUsd(spent: Readonly<Record<string, unknown>> | null | undefined): number {
  const value = spent?.["setup"];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return cents(value);
}

/**
 * What the factory spent after the one-time setup charge.
 *
 * The pace line uses this. Setup is a single charge, so projecting the
 * month from the headline would treat it as a burn rate. Never negative:
 * a setup figure larger than the total (a partial read) contributes nothing
 * further.
 *
 * total: the headline total, in dollars.
 * setup: the one-time setup charge, in dollars.
 */
export function spendAsideFromSetup(total: number, setup: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(setup)) return 0;
  return cents(Math.max(0, total - setup));
}

const cents = (n: number): number => Math.round(n * 100) / 100;

/**
 * The month's spend from `budget.json`, in dollars rounded to cents.
 *
 * Every finite amount in `spent_usd` counts, including setup, which is not
 * one of the three share bars. A missing file or a file with no finite
 * amounts returns null, so the page can fall back instead of painting a
 * made-up zero.
 *
 * spent: the `spent_usd` object from budget.json, or null when the file has none.
 */
export function spendFromBudget(spent: Readonly<Record<string, unknown>> | null | undefined): number | null {
  if (spent == null) return null;
  let total = 0;
  let any = false;
  // Skip NaN, Infinity, and non-numbers. They are not charges.
  for (const value of Object.values(spent)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    total += value;
    any = true;
  }
  return any ? cents(total) : null;
}

/**
 * The three share bars, taken from `budget.json` when those keys exist.
 *
 * `product_work`, `gardening`, and `review_and_benchmarks` are copied when
 * at least one of them is a finite amount. A key that is missing stays at
 * zero. Setup and other pipeline names are not share bars. Undefined when
 * none of the three keys has a finite amount, so step records may fill in.
 *
 * spent: the `spent_usd` object from budget.json, or null when the file has none.
 */
export function sharesFromBudget(
  spent: Readonly<Record<string, unknown>> | null | undefined,
): Record<ShareUse["share"], number> | undefined {
  if (spent == null) return undefined;
  const out: Record<ShareUse["share"], number> = { product_work: 0, gardening: 0, review_and_benchmarks: 0 };
  let any = false;
  for (const key of SHARE_KEYS) {
    const value = spent[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[key] = cents(value);
    any = true;
  }
  return any ? out : undefined;
}

/** Where the Spend page's big number came from. */
export type SpendSource = "budget" | "steps" | "index";

export interface SpendChoice {
  readonly amount: number;
  readonly source: SpendSource;
}

/**
 * The number the Spend page shows for this month.
 *
 * `budget.json` wins whenever it has a finite total, because that file
 * includes setup and does not depend on `recent_runs`. Step records are
 * shown only when the budget file has no amounts and the index named some
 * runs. An empty recent-runs list never contributes a zero.
 *
 * budgetSpent: the cent-rounded total from budget.json, or null when that file has no amounts.
 * stepSpent: the cent-rounded total of this month's step records, or null when there are none.
 * recentRunIds: run ids from the index. Empty means step files were not a real sample.
 * indexSpent: the spend figure on index.json, used when neither record above is available.
 */
export function headlineSpend(input: {
  readonly budgetSpent: number | null;
  readonly stepSpent: number | null;
  readonly recentRunIds: readonly string[];
  readonly indexSpent: number;
}): SpendChoice {
  if (input.budgetSpent !== null && Number.isFinite(input.budgetSpent)) {
    return { amount: input.budgetSpent, source: "budget" };
  }
  // Step files are fetched only for recent_runs. An empty list must not
  // report zero while budget.json, or the index, has the real figure.
  if (input.recentRunIds.length > 0 && input.stepSpent !== null && Number.isFinite(input.stepSpent)) {
    return { amount: input.stepSpent, source: "steps" };
  }
  const index = Number.isFinite(input.indexSpent) ? input.indexSpent : 0;
  return { amount: index, source: "index" };
}

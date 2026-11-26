import type { RunFile } from "./types";

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

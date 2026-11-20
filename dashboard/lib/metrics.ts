import type {
  IndexFile, LedgerFile, LiveFile, RunFile, DailyPoint, Pipeline,
  BaselinesFile, CoverageFile,
} from "./types.js";

/**
 * What the dashboard displays, derived from the factory's own records.
 *
 * Kept apart from the components so the arithmetic can be tested: a tile that
 * silently reports 0% when it means "not measured yet" is worse than one that
 * says so, and that difference lives here rather than in the markup.
 */

/** A number the dashboard can show, or an honest absence. */
export type Measure =
  | { readonly known: true; readonly value: number }
  | { readonly known: false; readonly why: string };

export const unknown = (why: string): Measure => ({ known: false, why });
export const known = (value: number): Measure => ({ known: true, value });

export interface Headline {
  readonly autonomy: Measure;
  readonly cycleTimeP50: Measure;
  readonly cycleTimeP90: Measure;
  readonly costPerPr: Measure;
  readonly spendUsd: Measure;
  readonly budgetUsd: Measure;
  readonly actionsMinutes: Measure;
  readonly actionsMinutesLimit: Measure;
  readonly revertRate: Measure;
}

/**
 * The headline row. Every tile distinguishes "zero" from "nothing to measure",
 * because a new factory legitimately has no merged PRs and an autonomy tile
 * reading 0% would be a lie about the same situation.
 */
export function headline(index: IndexFile | null): Headline {
  if (index === null) {
    const why = "No factory data yet.";
    return {
      autonomy: unknown(why), cycleTimeP50: unknown(why), cycleTimeP90: unknown(why),
      costPerPr: unknown(why), spendUsd: unknown(why), budgetUsd: unknown(why),
      actionsMinutes: unknown(why), actionsMinutesLimit: unknown(why), revertRate: unknown(why),
    };
  }
  const m = index.metrics;
  const merged = m.merged ?? 0;

  return {
    autonomy:
      merged === 0
        ? unknown("No merged pull requests yet.")
        : known(m.automation_rate ?? 0),
    cycleTimeP50:
      m.cycle_time_p50_sec === undefined || merged === 0
        ? unknown("Nothing has been merged yet.")
        : known(m.cycle_time_p50_sec),
    cycleTimeP90:
      m.cycle_time_p90_sec === undefined || merged === 0
        ? unknown("Nothing has been merged yet.")
        : known(m.cycle_time_p90_sec),
    costPerPr:
      merged === 0 || m.spend_usd === undefined
        ? unknown("No merged pull requests yet.")
        : known(Math.round((m.spend_usd / merged) * 100) / 100),
    spendUsd: m.spend_usd === undefined ? unknown("Not recorded.") : known(m.spend_usd),
    budgetUsd: m.budget_usd === undefined ? unknown("No budget set.") : known(m.budget_usd),
    actionsMinutes:
      m.actions_minutes === undefined ? unknown("Not recorded.") : known(m.actions_minutes),
    actionsMinutesLimit:
      m.actions_minutes_limit === undefined || m.actions_minutes_limit === null
        ? unknown("Public repo: standard runners are free.")
        : known(m.actions_minutes_limit),
    revertRate:
      (m.merged ?? 0) === 0 ? unknown("No merged pull requests yet.") : known(m.revert_rate ?? 0),
  };
}

/**
 * Month-to-date spend projected to month end, straight-line from the days
 * elapsed. Deliberately simple: a cleverer projection would imply a
 * confidence the data does not support.
 */
export function projectToMonthEnd(spentSoFar: number, now: Date): Measure {
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  if (day < 3) return unknown("Too early in the month to project.");
  return known(Math.round((spentSoFar / day) * daysInMonth * 100) / 100);
}

/** Budget use per pipeline, against the share it was given. */
export interface ShareUse {
  readonly share: "product_work" | "gardening" | "review_and_benchmarks";
  readonly spentUsd: number;
  readonly allowanceUsd: number;
  readonly fraction: number;
  readonly paused: boolean;
}

const SHARE_OF: Readonly<Record<Pipeline, ShareUse["share"]>> = {
  product_work: "product_work",
  conflict: "product_work",
  gardening: "gardening",
  hardening: "gardening",
  definition: "review_and_benchmarks",
};

export function shareUse(
  index: IndexFile | null,
  shares: Readonly<Record<ShareUse["share"], number>>,
): readonly ShareUse[] {
  const budget = index?.metrics.budget_usd ?? 0;
  const byPipeline = index?.metrics.by_pipeline ?? {};

  const spent: Record<ShareUse["share"], number> = {
    product_work: 0, gardening: 0, review_and_benchmarks: 0,
  };
  const paused: Record<ShareUse["share"], boolean> = {
    product_work: false, gardening: false, review_and_benchmarks: false,
  };

  for (const [pipeline, metrics] of Object.entries(byPipeline)) {
    const share = SHARE_OF[pipeline as Pipeline];
    if (share === undefined) continue;
    spent[share] += metrics.spend_usd ?? 0;
    if (metrics.paused === true) paused[share] = true;
  }

  return (Object.keys(shares) as ShareUse["share"][]).map((share) => {
    const allowance = (budget * shares[share]) / 100;
    return {
      share,
      spentUsd: Math.round(spent[share] * 100) / 100,
      allowanceUsd: Math.round(allowance * 100) / 100,
      fraction: allowance === 0 ? 0 : Math.min(2, spent[share] / allowance),
      paused: paused[share],
    };
  });
}

/* ------------------------------------------------------------- the live board */

export const STATIONS = [
  "Queued", "Triage", "Spec", "Build", "Gates", "Draft PR", "Merge queue",
] as const;
export type Station = (typeof STATIONS)[number];

export interface BoardCard {
  readonly workItem: string;
  readonly pipeline: Pipeline;
  readonly station: Station;
  readonly step?: string;
  readonly attempt?: number;
  readonly of?: number;
  readonly startedAt?: string;
  readonly costUsd?: number;
  readonly pr?: number | null;
  readonly escalated: boolean;
}

/**
 * Places each in-flight work item at a station.
 *
 * The live files are the truth for anything running, because they are written
 * at each step change; the ledger covers what is queued or waiting, which has
 * no live file. Where both describe the same item, live wins.
 */
export function board(
  ledger: LedgerFile | null,
  live: readonly LiveFile[],
): readonly BoardCard[] {
  const cards = new Map<string, BoardCard>();

  for (const item of ledger?.open ?? []) {
    cards.set(item.work_item, {
      workItem: item.work_item,
      pipeline: item.pipeline,
      station: stationForStatus(item.status),
      ...(item.created_at === undefined ? {} : { startedAt: item.created_at }),
      pr: item.pr ?? null,
      escalated: item.status === "escalated",
    });
  }

  for (const l of live) {
    const existing = cards.get(l.work_item);
    cards.set(l.work_item, {
      workItem: l.work_item,
      pipeline: l.pipeline,
      station: stationForStep(l.step),
      step: l.step,
      ...(l.attempt === undefined ? {} : { attempt: l.attempt }),
      ...(l.of === undefined ? {} : { of: l.of }),
      startedAt: l.started_at,
      ...(l.cost_usd_so_far === undefined ? {} : { costUsd: l.cost_usd_so_far }),
      pr: existing?.pr ?? null,
      escalated: existing?.escalated ?? false,
    });
  }

  return [...cards.values()];
}

function stationForStatus(status: string): Station {
  switch (status) {
    case "queued":
    case "waiting_trust":
    case "needs_info":
      return "Queued";
    case "in_review":
      return "Draft PR";
    case "queued_to_merge":
      return "Merge queue";
    case "escalated":
      return "Draft PR";
    default:
      return "Build";
  }
}

function stationForStep(step: LiveFile["step"]): Station {
  switch (step) {
    case "triage": return "Triage";
    case "spec": return "Spec";
    case "builder":
    case "gardener":
    case "hardener":
      return "Build";
    case "gate":
    case "verifier":
    case "scorer":
      return "Gates";
    case "merge": return "Merge queue";
  }
}

export function groupByStation(cards: readonly BoardCard[]): Readonly<Record<Station, readonly BoardCard[]>> {
  const out = Object.fromEntries(STATIONS.map((s) => [s, [] as BoardCard[]])) as Record<Station, BoardCard[]>;
  for (const c of cards) out[c.station].push(c);
  for (const s of STATIONS) {
    out[s].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  }
  return out;
}

/* ------------------------------------------------------------- the ratchet */

export interface RatchetBar {
  readonly rule: string;
  readonly atSetup: number;
  readonly now: number;
  /** 0 at setup, 1 when the rule is clear. */
  readonly progress: number;
  readonly retired: boolean;
  readonly files: number;
}

/**
 * Cleanup progress per baselined rule. `atSetup` comes from the recorded
 * count, `now` from the live one, so a bar that has not moved is visible as
 * exactly that rather than as an absent bar.
 */
export function ratchetBars(
  setup: BaselinesFile | null,
  current: BaselinesFile | null,
): readonly RatchetBar[] {
  const setupRules = setup?.rules ?? {};
  const nowRules = current?.rules ?? {};
  const rules = new Set([...Object.keys(setupRules), ...Object.keys(nowRules)]);

  const bars: RatchetBar[] = [];
  for (const rule of rules) {
    const atSetup = setupRules[rule]?.count ?? 0;
    const nowEntry = nowRules[rule];
    const now = nowEntry?.count ?? 0;
    const retired = nowEntry?.retired === true || (atSetup > 0 && now === 0);
    bars.push({
      rule,
      atSetup,
      now,
      progress: atSetup === 0 ? 1 : Math.max(0, Math.min(1, (atSetup - now) / atSetup)),
      retired,
      files: Object.keys(nowEntry?.by_file ?? {}).length,
    });
  }
  // Most still to do first: that is the order someone wants to act on.
  return bars.sort((a, b) => b.now - a.now || a.rule.localeCompare(b.rule));
}

/**
 * The coverage gauge: where the floor sits, where the high mark sits, and
 * where coverage is now. The point of showing all three is that the floor only
 * ever rises, which is invisible from a single percentage.
 */
export interface CoverageGauge {
  readonly floor: number;
  readonly high: number;
  readonly diffMin: number;
  readonly skips: number;
  readonly skipCap: number;
  readonly headroom: number;
}

export function coverageGauge(coverage: CoverageFile | null): CoverageGauge | null {
  if (coverage === null) return null;
  return {
    floor: coverage.floor_pct,
    high: coverage.high_pct,
    diffMin: coverage.diff_min_pct,
    skips: coverage.skips.count,
    skipCap: coverage.skips.cap,
    headroom: Math.round((coverage.high_pct - coverage.floor_pct) * 10) / 10,
  };
}

/* ----------------------------------------------------------------- run detail */

export interface TimelineRow {
  readonly label: string;
  readonly kind: "step" | "gate";
  readonly result: "pass" | "fail" | "skipped" | "ok" | "error" | "timeout" | "refused" | "unknown";
  readonly attempt?: number;
  readonly durationSec?: number;
  readonly costUsd?: number;
  readonly model?: string;
}

/** One row per step and gate attempt, in the order they happened. */
export function timeline(run: RunFile): readonly TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const s of run.steps) {
    rows.push({
      label: s.role,
      kind: "step",
      result: s.exit ?? "unknown",
      ...(s.attempt === undefined ? {} : { attempt: s.attempt }),
      ...(s.duration_sec === undefined ? {} : { durationSec: s.duration_sec }),
      ...(s.cost_usd === undefined ? {} : { costUsd: s.cost_usd }),
      ...(s.model === undefined ? {} : { model: s.model }),
    });
  }
  for (const g of run.gates) {
    rows.push({
      label: g.gate === "static" ? "Gate 1 · static" : "Gate 2 · verification",
      kind: "gate",
      result: g.result,
      attempt: g.attempt,
    });
  }
  return rows;
}

export interface CostRow {
  readonly label: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cached: number;
  readonly costUsd: number;
}

export function costBreakdown(run: RunFile): { rows: readonly CostRow[]; total: number } {
  const rows: CostRow[] = run.steps.map((s) => ({
    label: s.attempt === undefined ? s.role : `${s.role} · attempt ${s.attempt}`,
    model: s.model ?? "—",
    tokensIn: s.tokens?.in ?? 0,
    tokensOut: s.tokens?.out ?? 0,
    cached: s.tokens?.cached ?? 0,
    costUsd: s.cost_usd ?? 0,
  }));
  // The run's own total is authoritative; the steps may not add up to it if a
  // step's cost was never recorded, and hiding that would be worse.
  return { rows, total: run.cost_usd };
}

/** True when the steps do not add up to the run's recorded total. */
export function costMismatch(run: RunFile): number | null {
  const summed = run.steps.reduce((a, s) => a + (s.cost_usd ?? 0), 0);
  const diff = Math.round((run.cost_usd - summed) * 100) / 100;
  return Math.abs(diff) < 0.01 ? null : diff;
}

/* ------------------------------------------------------------------ charts */

export interface SeriesPoint {
  readonly date: string;
  readonly value: number;
}

export function series(daily: readonly DailyPoint[] | undefined, key: keyof DailyPoint): readonly SeriesPoint[] {
  return (daily ?? [])
    .map((d) => ({ date: d.date, value: typeof d[key] === "number" ? (d[key]) : 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* ------------------------------------------------------------- formatting */

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined) return "—";
  return value < 10 ? `$${value.toFixed(2)}` : `$${Math.round(value).toLocaleString("en-US")}`;
}

export function formatPct(fraction: number | undefined, digits = 0): string {
  if (fraction === undefined) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function elapsedSince(iso: string | undefined, now: Date = new Date()): string {
  if (iso === undefined) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  return formatDuration(Math.max(0, (now.getTime() - then) / 1000));
}

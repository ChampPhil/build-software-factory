import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { worstRequestUsd, listCostUsd } from "../lib/prices.js";
import { parseJsonl, usageFromSession, type SessionUsage } from "../lib/session.js";

/**
 * The monthly budget, as a hard ceiling (doc 07, §Budget).
 *
 * The rule: an agent step starts only if
 *
 *   spent this month + the ceilings of steps still running + this step's ceiling
 *
 * fits within the budget (and within its pipeline's share). When the step
 * ends its measured cost replaces its ceiling. A step's ceiling is the most it
 * can spend: its gh-aw credit cap, plus one request past it, because gh-aw
 * checks the cap before each request and lets the one that crosses it finish.
 * Threat detection is a second agent with its own cap and is counted the same
 * way.
 *
 * So the factory may stop with money left; it cannot spend past the budget.
 * Every write is a compare-and-swap on the data ref, so two runs cannot both
 * take the last dollar.
 */

export const BUDGET_PATH = "budget.json";

/** Pipelines whose spend counts against a share. */
export type Share = "product_work" | "gardening" | "review_and_benchmarks";

export interface InFlight {
  readonly key: string;
  readonly pipeline: string;
  readonly role: string;
  readonly model: string;
  readonly agent_ceiling_usd: number;
  readonly detection_ceiling_usd: number;
  readonly started_at: string;
}

export interface BudgetDoc {
  readonly schema: "budget/2";
  /** The calendar month (UTC) `spent_usd` is for, as YYYY-MM. */
  readonly month: string;
  readonly spent_usd: Readonly<Record<string, number>>;
  readonly inflight: readonly InFlight[];
  /** Keys settled recently, so a repeated settle charges nothing twice. */
  readonly settled: readonly string[];
  readonly updated_at: string;
}

export interface BudgetLimits {
  readonly monthlyUsd: number;
  readonly shares: Readonly<Record<Share, number>>;
  readonly productHardStopPct: number;
}

export const emptyBudget = (now: string): BudgetDoc => ({
  schema: "budget/2",
  month: now.slice(0, 7),
  spent_usd: {},
  inflight: [],
  settled: [],
  updated_at: now,
});

/** Which share a pipeline's spend counts against; setup counts only against the total. */
export function shareOf(pipeline: string): Share | null {
  switch (pipeline) {
    case "product_work":
    case "conflict":
      return "product_work";
    case "gardening":
    case "hardening":
      return "gardening";
    case "review":
    case "definition":
    case "benchmark":
      return "review_and_benchmarks";
    default:
      return null;
  }
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const SETTLED_KEEP = 500;

/** A step's ceiling in dollars, or null when its model has no listed price. */
export function ceilingUsd(capCredits: number, model: string): number | null {
  const worst = worstRequestUsd(model);
  if (worst === null || !Number.isFinite(capCredits) || capCredits < 0) return null;
  return round4(capCredits / 100 + worst);
}

/** A new month starts with nothing spent; steps still running keep their hold. */
export function rollMonth(doc: BudgetDoc, now: string): BudgetDoc {
  const month = now.slice(0, 7);
  return doc.month === month ? doc : { ...doc, month, spent_usd: {}, settled: doc.settled };
}

const inflightUsd = (f: InFlight): number => f.agent_ceiling_usd + f.detection_ceiling_usd;

/** Spent plus held, in total and for one share. */
export function used(doc: BudgetDoc, share: Share | null): { total: number; share: number } {
  const spent = Object.values(doc.spent_usd);
  const held = doc.inflight.map(inflightUsd);
  const shareSpent = share === null ? 0 : sum(Object.entries(doc.spent_usd).filter(([p]) => shareOf(p) === share).map(([, v]) => v));
  const shareHeld = share === null ? 0 : sum(doc.inflight.filter((f) => shareOf(f.pipeline) === share).map(inflightUsd));
  return { total: round4(sum(spent) + sum(held)), share: round4(shareSpent + shareHeld) };
}

/** A share's limit: its percentage, with product work allowed up to its hard stop. */
export function shareLimitUsd(limits: BudgetLimits, share: Share): number {
  const pct = limits.shares[share] ?? 0;
  const base = (limits.monthlyUsd * pct) / 100;
  return share === "product_work" ? Math.min(limits.monthlyUsd, (base * limits.productHardStopPct) / 100) : base;
}

export interface ReserveRequest {
  readonly key: string;
  readonly pipeline: string;
  readonly role: string;
  readonly model: string;
  readonly capCredits: number;
  readonly detectionModel: string;
  readonly detectionCapCredits: number;
}

export type ReserveOutcome =
  | { readonly ok: true; readonly doc: BudgetDoc; readonly reason: string; readonly holdUsd: number }
  | { readonly ok: false; readonly doc: BudgetDoc; readonly reason: string };

export function reserve(current: BudgetDoc | null, req: ReserveRequest, limits: BudgetLimits, now: string): ReserveOutcome {
  const doc = rollMonth(current ?? emptyBudget(now), now);
  // The same step asking twice (a re-run of the job) holds once.
  const existing = doc.inflight.find((f) => f.key === req.key);
  if (existing !== undefined) return { ok: true, doc, reason: `${req.key} already holds its ceiling`, holdUsd: inflightUsd(existing) };
  if (doc.settled.includes(req.key)) {
    return { ok: false, doc, reason: `${req.key} has already run and been charged; it does not run twice` };
  }

  const agent = ceilingUsd(req.capCredits, req.model);
  const detection = req.detectionCapCredits > 0 ? ceilingUsd(req.detectionCapCredits, req.detectionModel) : 0;
  if (agent === null || detection === null) {
    const unknown = agent === null ? req.model : req.detectionModel;
    return { ok: false, doc, reason: `no list price for ${unknown}, so the most this step could cost is unknown; it does not start` };
  }
  const hold = round4(agent + detection);
  const share = shareOf(req.pipeline);
  const u = used(doc, share);

  if (limits.monthlyUsd <= 0) return { ok: false, doc, reason: "the monthly budget is $0; no agent step runs" };
  if (u.total + hold > limits.monthlyUsd) {
    return {
      ok: false,
      doc,
      reason:
        `this ${req.role} step could cost up to $${hold.toFixed(2)}, and $${u.total.toFixed(2)} of the ` +
        `$${limits.monthlyUsd.toFixed(2)} monthly budget is spent or held: starting it could pass the budget`,
    };
  }
  if (share !== null) {
    const cap = shareLimitUsd(limits, share);
    if (u.share + hold > cap) {
      return {
        ok: false,
        doc,
        reason:
          `this ${req.role} step could cost up to $${hold.toFixed(2)}, and ${share}'s share ` +
          `($${cap.toFixed(2)}) has $${u.share.toFixed(2)} spent or held`,
      };
    }
  }
  const entry: InFlight = {
    key: req.key,
    pipeline: req.pipeline,
    role: req.role,
    model: req.model,
    agent_ceiling_usd: agent,
    detection_ceiling_usd: detection,
    started_at: now,
  };
  return {
    ok: true,
    doc: { ...doc, inflight: [...doc.inflight, entry], updated_at: now },
    reason: `held $${hold.toFixed(2)} for ${req.role}; $${round4(limits.monthlyUsd - u.total - hold).toFixed(2)} left`,
    holdUsd: hold,
  };
}

/** gh-aw's metered AI credits, as a job output: a number, or absent. */
export function creditsToUsd(aic: string | undefined): number | null {
  if (aic === undefined || aic.trim() === "") return null;
  const n = Number(aic);
  return Number.isFinite(n) && n >= 0 ? n / 100 : null;
}

export interface SettleInput {
  readonly key: string;
  /** Measured, or null when it could not be read: then the ceiling is charged. */
  readonly agentUsd: number | null;
  readonly detectionUsd: number | null;
  /** Used only when the key was never reserved, so the charge has a home. */
  readonly pipeline?: string;
}

export function settle(current: BudgetDoc | null, input: SettleInput, now: string): { doc: BudgetDoc; chargedUsd: number; reason: string } {
  const doc = rollMonth(current ?? emptyBudget(now), now);
  if (doc.settled.includes(input.key)) return { doc, chargedUsd: 0, reason: `${input.key} was already charged` };
  const held = doc.inflight.find((f) => f.key === input.key);
  const pipeline = held?.pipeline ?? input.pipeline ?? "unknown";
  // Absence is not zero: an unread cost is charged at the most it could be.
  const agent = input.agentUsd ?? held?.agent_ceiling_usd ?? 0;
  const detection = input.detectionUsd ?? held?.detection_ceiling_usd ?? 0;
  const charged = round4(agent + detection);
  const spent = { ...doc.spent_usd, [pipeline]: round4((doc.spent_usd[pipeline] ?? 0) + charged) };
  const how =
    input.agentUsd === null || (held !== undefined && held.detection_ceiling_usd > 0 && input.detectionUsd === null)
      ? " (some of it at the ceiling, because the measured cost was missing)"
      : "";
  return {
    doc: {
      ...doc,
      spent_usd: spent,
      inflight: doc.inflight.filter((f) => f.key !== input.key),
      settled: [...doc.settled, input.key].slice(-SETTLED_KEEP),
      updated_at: now,
    },
    chargedUsd: charged,
    reason: `charged $${charged.toFixed(4)} to ${pipeline}${how}`,
  };
}

/**
 * Holds whose step never settled (its run was cancelled, its runner died)
 * are charged at their ceiling once they are older than any step can run.
 */
export function sweepStale(current: BudgetDoc | null, now: string, maxAgeSec: number): { doc: BudgetDoc; swept: readonly string[] } {
  const doc = rollMonth(current ?? emptyBudget(now), now);
  const cutoff = Date.parse(now) - maxAgeSec * 1000;
  const stale = doc.inflight.filter((f) => Date.parse(f.started_at) < cutoff);
  let next = doc;
  for (const f of stale) next = settle(next, { key: f.key, agentUsd: null, detectionUsd: null }, now).doc;
  return { doc: next, swept: stale.map((f) => f.key) };
}

/**
 * A step's measured cost: the larger of what its session reported and what
 * its tokens cost at list price, so neither an under-reporting log nor a
 * stale price table can make a step look cheaper than it was. Null when
 * there is nothing to measure.
 */
export function measuredUsd(model: string, usage: SessionUsage | null): number | null {
  if (usage === null) return null;
  const list = listCostUsd(model, usage);
  if (usage.costUsd === null && list === null) return null;
  return round4(Math.max(usage.costUsd ?? 0, list ?? 0));
}

export interface BudgetMeasure {
  readonly schema: "budget-measure/1";
  readonly key: string;
  readonly model: string;
  readonly agent_usd: number | null;
  readonly detection_artifact: string;
}

/** Every file under a directory, for an artifact whose layout gh-aw owns. */
function filesUnder(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

/**
 * What threat detection cost, from its uploaded artifact: gh-aw's own usage
 * log for the detection run first, then its proxy's metering. One source,
 * never both, since they count the same requests. Null when neither is there.
 */
export function detectionUsd(dir: string, model: string): number | null {
  const files = filesUnder(dir);
  const pick = (re: RegExp): string | undefined => files.find((f) => re.test(f));
  for (const [re, from] of [[/detection_usage\.jsonl$/, "agent_session"], [/token-usage\.jsonl$/, "token_usage"]] as const) {
    const f = pick(re);
    if (f === undefined) continue;
    const usage = usageFromSession(parseJsonl(readFileSync(f, "utf8")), from);
    const usd = measuredUsd(model, usage);
    if (usd !== null) return usd;
  }
  return null;
}

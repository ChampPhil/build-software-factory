import type { LedgerOpenItem, StandingGoalsFile, WorkItemDoc } from "./types";

/** The pipelines a request can be moved between. Mirrors the runner's ROUTABLE. */
export const MOVABLE = ["product_work", "gardening", "hardening"] as const;

/** Statuses the factory lets a person move a request from; later than these the work has started. */
const MOVABLE_STATUS = new Set(["queued", "needs_info", "waiting_trust", "escalated"]);

export function canMove(status: string): boolean {
  return MOVABLE_STATUS.has(status);
}

export function whoRouted(doc: WorkItemDoc | undefined): string | null {
  switch (doc?.routing?.by) {
    case "chief_of_staff": return "chosen by the chief of staff";
    case "person": return "moved by a person";
    case "table": return "default route";
    default: return null;
  }
}

export interface MisRoute {
  readonly routed: number;
  readonly moved: number;
  /** Moves divided by requests the chief of staff routed; null until it has routed any. */
  readonly rate: number | null;
}

/** How often a person had to undo the chief of staff. Counts only work items the dashboard has loaded. */
export function misRoute(docs: readonly WorkItemDoc[]): MisRoute {
  let routed = 0;
  let moved = 0;
  for (const d of docs) {
    const r = d.routing;
    if (r === undefined) continue;
    const overridden = (r.overrides ?? []).length > 0;
    if (r.by === "chief_of_staff" || overridden) routed += 1;
    if (overridden) moved += 1;
  }
  return { routed, moved, rate: routed === 0 ? null : moved / routed };
}

/** Ids worth reading for routing detail: every open item, in ledger order. */
export function routingCandidates(open: readonly LedgerOpenItem[]): readonly string[] {
  return open.map((o) => o.work_item);
}

export function liveGoals(file: StandingGoalsFile | null, now: Date = new Date()): StandingGoalsFile["goals"] {
  return (file?.goals ?? []).filter((g) => g.until === null || new Date(g.until) > now);
}

export const GOAL_LANES = [
  { value: "", label: "any work" },
  { value: "product_work", label: "features" },
  { value: "gardening", label: "tidying" },
  { value: "hardening", label: "hardening" },
] as const;

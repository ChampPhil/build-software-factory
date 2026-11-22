import type { CandidatesFile, DecisionsFile, LedgerOpenItem, LedgerRecentItem, WorkItemDoc } from "./types";

/** The candidates with what people decided laid over the status the file holds. */
export function overlayDecisions(candidates: CandidatesFile | null, decisions: DecisionsFile | null): CandidatesFile | null {
  if (candidates === null || decisions === null) return candidates;
  return {
    ...candidates,
    candidates: candidates.candidates.map((c) => {
      const d = decisions.decisions[c.id];
      return d === undefined ? c : { ...c, status: d.status };
    }),
  };
}

/** How many work items one read opens. A year-old factory would otherwise fetch hundreds of files. */
export const CORRECTION_READ_CAP = 25;

/**
 * Which work items might be corrections: every open hardening item, and the
 * most recent finished ones, whose pipeline is only in their own file.
 */
export function correctionCandidates(open: readonly LedgerOpenItem[], recent: readonly LedgerRecentItem[]): readonly string[] {
  const openIds = open.filter((o) => o.pipeline === "hardening").map((o) => o.work_item);
  const rest = recent.map((r) => r.work_item).filter((id) => !openIds.includes(id));
  return [...openIds, ...rest].slice(0, CORRECTION_READ_CAP);
}

/** Only the work items a person's correction started, newest first. */
export function correctionsOf(items: readonly WorkItemDoc[]): readonly WorkItemDoc[] {
  return items
    .filter((i) => i.pipeline === "hardening" && i.source.kind === "correction")
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** The link back to the person's own words, which the work item's body carries as `Source: …`. */
export function sourceLink(body: string | null): string | null {
  const m = /^Source:\s*(https?:\/\/\S+)\s*$/m.exec(body ?? "");
  return m?.[1] ?? null;
}

/** Where the correction was made, in words. */
export function whereOf(item: WorkItemDoc): string {
  const ref = item.source.ref;
  if (ref === null) return "a local session";
  if (ref.startsWith("candidate:")) return "a candidate accepted on the dashboard";
  return `PR ${ref}`;
}

/** The person's words, without the work item's framing. */
export function quoteOf(body: string | null): string {
  return (body ?? "")
    .split("\n")
    .filter((l) => l.startsWith("> "))
    .map((l) => l.slice(2))
    .join(" ")
    .trim();
}

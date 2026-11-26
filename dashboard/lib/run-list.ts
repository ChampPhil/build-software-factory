/**
 * Which runs the Runs page lists.
 *
 * Purpose:
 *   The page used to show only live jobs and run files named by the index.
 *   A pull request can exist before either of those, while the ledger still
 *   has the work item open. This module decides the rows so that moment is
 *   visible, and so the decision can be tested without rendering the page.
 *
 * Key terms:
 *   - Live row: a job that is running right now. Its status file is on the
 *     factory data ref and disappears when the job ends.
 *   - Run file: the record written when a job finishes, `runs/<id>.json`.
 *     The index lists recent ids. If that list is empty, there are no files
 *     to show even though work happened.
 *   - Ledger: `ledger.json`, the list of work still open. An open item with
 *     a pull request number is a run a person can already look at.
 *   - Work item: the request the factory is doing. One work item is one row
 *     from the ledger, even if several jobs touched it.
 *   - draft_pr: the outcome label for "a pull request exists". The Runs page
 *     filters on it under "Opened a PR".
 *
 * Exports:
 *   - ListedRun: one row of the runs table.
 *   - visibleRuns: live rows, then run files, then open ledger items that
 *     have a pull request and are not already on the page.
 */

export interface ListedRun {
  readonly id: string;
  readonly work_item: string;
  readonly pipeline: string;
  readonly outcome: string;
  readonly started_at: string;
  readonly duration_sec: number | null;
  readonly cost: number;
  readonly pr: number | null;
  /** live: still going. file: a finished record. ledger: a pull request with no run row yet. */
  readonly source: "live" | "file" | "ledger";
}

/**
 * A pull request number, or null when the field is missing or not a real PR.
 *
 * Zero, NaN, and non-numbers are not pull requests. GitHub numbers them from 1.
 *
 * pr: the ledger's `pr` field, which is sometimes null.
 */
function pullNumber(pr: number | null | undefined): number | null {
  return typeof pr === "number" && Number.isFinite(pr) && pr > 0 ? pr : null;
}

/**
 * The runs a person should see, in the order the page draws them.
 *
 * Live jobs come first, then finished run files. After those, each open
 * ledger item with a numeric pull request is added as `draft_pr`, unless
 * that work item is already on the list. A run is visible from the moment
 * a pull request exists, even when the index has no recent runs.
 *
 * live: jobs running now.
 * files: finished run records.
 * open: open items from ledger.json.
 */
export function visibleRuns(input: {
  readonly live: readonly {
    readonly run: string;
    readonly work_item: string;
    readonly pipeline: string;
    readonly started_at: string;
    readonly cost_usd_so_far?: number;
  }[];
  readonly files: readonly {
    readonly id: string;
    readonly work_item: string;
    readonly pipeline: string;
    readonly outcome: string;
    readonly started_at: string;
    readonly duration_sec?: number;
    readonly cost_usd: number;
    readonly pr?: number | null;
  }[];
  readonly open: readonly {
    readonly work_item: string;
    readonly pipeline: string;
    readonly pr?: number | null;
    readonly created_at?: string;
  }[];
}): readonly ListedRun[] {
  const rows: ListedRun[] = [];

  for (const l of input.live) {
    rows.push({
      id: l.run,
      work_item: l.work_item,
      pipeline: l.pipeline,
      outcome: "running",
      started_at: l.started_at,
      duration_sec: null,
      cost: l.cost_usd_so_far ?? 0,
      pr: null,
      source: "live",
    });
  }

  for (const r of input.files) {
    const pr = r.pr ?? null;
    // A finished run that opened a PR is not a failure. The work is waiting.
    rows.push({
      id: r.id,
      work_item: r.work_item,
      pipeline: r.pipeline,
      outcome: r.outcome === "failed" && pr !== null ? "draft_pr" : r.outcome,
      started_at: r.started_at,
      duration_sec: r.duration_sec ?? null,
      cost: r.cost_usd,
      pr,
      source: "file",
    });
  }

  // Anything already drawn, by work item, so the ledger does not repeat it.
  const shown = new Set(rows.map((r) => r.work_item));
  for (const item of input.open) {
    if (shown.has(item.work_item)) continue;
    const pr = pullNumber(item.pr);
    if (pr === null) continue;
    shown.add(item.work_item);
    rows.push({
      id: item.work_item,
      work_item: item.work_item,
      pipeline: item.pipeline,
      outcome: "draft_pr",
      started_at: item.created_at ?? "",
      duration_sec: null,
      cost: 0,
      pr,
      source: "ledger",
    });
  }

  return rows;
}

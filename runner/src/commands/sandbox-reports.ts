import type { GitHub } from "../lib/github.js";
import { FactoryStore, json, type Ledger } from "../lib/store.js";
import { inadequacyKey, type InadequacyReport } from "./sandbox.js";

/**
 * Sandbox reports: a role found the sandbox could not exercise what its change
 * needs. They are the one way the sandbox changes after setup, through an
 * amendment PR a person reviews.
 *
 * Two things decide when a report goes to an amendment. Only one amendment is
 * under way at a time, so roles working in parallel, which report the same
 * shortfall in their own words, start one redesign rather than several. And a
 * report made for a change that is still a PR waits for that change to merge:
 * the amendment reads the default branch, and until the change lands there
 * the thing it needs (a test runner the PR adds, say) is not there to find.
 * A report whose change was closed without merging is dropped with it.
 */

export const REPORTS = "sandbox-reports/";

export interface StoredReport extends InadequacyReport {
  readonly work_item?: string;
  readonly reported_at: string;
  readonly reports: number;
  readonly dispatched_at?: string;
  readonly dropped_at?: string;
  readonly dropped_why?: string;
}

export async function recordReport(
  store: FactoryStore,
  r: InadequacyReport,
  workItem: string | undefined,
  now: string,
): Promise<string> {
  const key = inadequacyKey(r);
  const path = `${REPORTS}${key}.json`;
  const seen = await store.data.readJson<StoredReport>(path);
  const entry: StoredReport = {
    role: r.role,
    needs: r.needs,
    paths: r.paths,
    why: r.why,
    ...(workItem === undefined ? (seen?.work_item === undefined ? {} : { work_item: seen.work_item }) : { work_item: workItem }),
    reported_at: seen?.reported_at ?? now,
    reports: (seen?.reports ?? 0) + 1,
    ...(seen?.dispatched_at === undefined ? {} : { dispatched_at: seen.dispatched_at }),
  };
  await store.put([{ path, content: json(entry) }], `sandbox report ${key}: ${r.needs.slice(0, 60)}`);
  return key;
}

export type ReportState = "ready" | "waits_for_merge" | "dropped" | "done";

/** Where a stored report stands, read against the ledger. */
export function reportState(d: StoredReport, ledger: Ledger): { state: ReportState; why?: string } {
  if (d.dispatched_at !== undefined || d.dropped_at !== undefined) return { state: "done" };
  if (d.work_item === undefined) return { state: "ready" };
  if (ledger.open.some((o) => o.work_item === d.work_item)) return { state: "waits_for_merge" };
  const recent = ledger.recent.find((o) => o.work_item === d.work_item);
  if (recent !== undefined && recent.merged_at === undefined) {
    return { state: "dropped", why: `its change (${d.work_item}) closed without merging` };
  }
  // Merged, or aged out of the ledger: the amendment reads main and judges.
  return { state: "ready" };
}

export interface AmendmentSweep {
  readonly dispatched: number;
  readonly waiting: number;
  readonly dropped: number;
  readonly why: string;
}

async function amendmentUnderWay(gh: GitHub): Promise<boolean> {
  const active = await Promise.all(
    ["queued", "in_progress", "waiting", "pending"].map((st) =>
      gh
        .get<{ total_count?: number }>(`repos/${gh.repo}/actions/workflows/factory-setup.yml/runs?status=${st}&per_page=1`)
        .then((x) => x.total_count ?? 0, () => 0),
    ),
  );
  const openSetupPrs = await gh
    .get<{ head: { ref: string } }[]>(`repos/${gh.repo}/pulls?state=open&per_page=100`)
    .then((ps) => ps.filter((p) => p.head.ref.startsWith("factory/setup-")).length, () => 0);
  return active.some((n) => n > 0) || openSetupPrs > 0;
}

/**
 * Hand every ready report to one amendment, if none is under way. Called after
 * each report and by the rollup, so a report that waited is picked up once its
 * change merges or the open amendment is done.
 */
export async function sweepReports(opts: {
  readonly gh: GitHub;
  readonly store: FactoryStore;
  readonly ledger: Ledger;
  readonly now: string;
  readonly plan?: boolean;
}): Promise<AmendmentSweep> {
  const ready: (InadequacyReport & { key: string; work_item?: string })[] = [];
  const marks: { path: string; content: string }[] = [];
  let waiting = 0;
  let dropped = 0;
  const pending: { path: string; d: StoredReport }[] = [];
  for (const path of await opts.store.data.list(REPORTS)) {
    const d = await opts.store.data.readJson<StoredReport>(path);
    if (d === null) continue;
    const st = reportState(d, opts.ledger);
    if (st.state === "waits_for_merge") waiting += 1;
    if (st.state === "dropped") {
      dropped += 1;
      marks.push({ path, content: json({ ...d, dropped_at: opts.now, dropped_why: st.why }) });
    }
    if (st.state === "ready") pending.push({ path, d });
  }
  const busy = pending.length > 0 && (await amendmentUnderWay(opts.gh));
  if (!busy) {
    for (const { path, d } of pending) {
      const key = path.slice(REPORTS.length).replace(/\.json$/, "");
      ready.push({
        role: d.role, needs: d.needs, paths: d.paths, why: d.why, key,
        ...(d.work_item === undefined ? {} : { work_item: d.work_item }),
      });
      marks.push({ path, content: json({ ...d, dispatched_at: opts.now }) });
    }
  }
  if (marks.length > 0 && opts.plan !== true) {
    await opts.store.put(marks, `sandbox reports: ${ready.length} to an amendment, ${dropped} dropped`);
  }
  if (ready.length > 0 && opts.plan !== true) {
    await opts.gh.dispatchWorkflow("factory-setup.yml", undefined, { amend: JSON.stringify({ reports: ready }) });
  }
  const why =
    ready.length > 0
      ? `started factory-setup to amend the sandbox for ${ready.length} report(s)`
      : busy
        ? "an amendment is already under way or awaiting review; the reports wait for the next one"
        : waiting > 0
          ? `${waiting} report(s) wait for their change to merge`
          : "no report waiting";
  return { dispatched: ready.length, waiting: busy ? waiting + pending.length : waiting, dropped, why };
}

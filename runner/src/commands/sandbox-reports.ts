import type { GitHub } from "../lib/github.js";
import { FactoryStore, json, type Ledger } from "../lib/store.js";
import { inadequacyKey, type InadequacyReport } from "./sandbox.js";

/**
 * Sandbox reports: a role found the sandbox could not exercise what its change
 * needs. They are how the sandbox repairs itself after setup: a report starts
 * an amendment, the amendment is trialled like setup was, and when it only
 * touches the sandbox and proves at least what main's sandbox did, it merges
 * itself (`bsf sandbox land`) and the changes that were stuck are verified
 * again.
 *
 * When a report goes to an amendment:
 *
 * - **At once**, unless the reporter said the need comes from the change
 *   itself (`needs_the_change`). A sandbox that cannot sign in, reach a
 *   service or trust a certificate is missing something on main already, and
 *   the change that ran into it cannot merge until it is fixed: waiting for
 *   that change would wait forever.
 * - **After its change merges**, when it does need the change: the amendment
 *   reads the default branch, and a test runner the PR adds is not there to
 *   find until it lands. A report whose change closed unmerged is dropped.
 * - **One amendment at a time**, so roles working in parallel, reporting the
 *   same shortfall in their own words, start one repair rather than several.
 *
 * And when one does not work: a need reported again after its amendment
 * landed, or whose amendment ended without landing, is tried once more. After
 * MAX_ATTEMPTS it is put to a person, once, as an issue saying what is
 * missing, and not retried.
 */

export const REPORTS = "sandbox-reports/";
export const MAX_ATTEMPTS = 2;
/** An amendment that has not landed this long after it was started has ended without landing. */
const AMENDMENT_GIVE_UP_MS = 3 * 60 * 60 * 1000;
/** Once no amendment is running or open, this long after dispatch it has ended. */
const AMENDMENT_ENDED_MS = 30 * 60 * 1000;

export interface StoredReport extends InadequacyReport {
  readonly work_item?: string;
  readonly reported_at: string;
  readonly reports: number;
  /** When it was last handed to an amendment. */
  readonly dispatched_at?: string;
  /** How many amendments it has been handed to. */
  readonly attempts?: number;
  /** When the amendment it was last handed to merged. */
  readonly landed_at?: string;
  /** When it was last reported. */
  readonly last_reported_at?: string;
  readonly dropped_at?: string;
  readonly dropped_why?: string;
  /** When it was put to a person, after MAX_ATTEMPTS. */
  readonly escalated_at?: string;
  readonly issue?: number;
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
    ...(seen ?? {}),
    role: r.role,
    needs: r.needs,
    paths: r.paths,
    why: r.why,
    ...(r.needs_the_change === true ? { needs_the_change: true } : {}),
    ...(workItem === undefined ? (seen?.work_item === undefined ? {} : { work_item: seen.work_item }) : { work_item: workItem }),
    reported_at: seen?.reported_at ?? now,
    last_reported_at: now,
    reports: (seen?.reports ?? 0) + 1,
  };
  if (r.needs_the_change !== true && "needs_the_change" in entry) delete (entry as { needs_the_change?: boolean }).needs_the_change;
  await store.put([{ path, content: json(entry) }], `sandbox report ${key}: ${r.needs.slice(0, 60)}`);
  return key;
}

export type ReportState = "ready" | "waits_for_merge" | "in_amendment" | "dropped" | "done" | "escalate";

/** Where a stored report stands, read against the ledger. */
export function reportState(
  d: StoredReport,
  ledger: Ledger,
  now: string = new Date().toISOString(),
  amendmentRunning = true,
): { state: ReportState; why?: string } {
  if (d.dropped_at !== undefined || d.escalated_at !== undefined) return { state: "done" };
  if (d.dispatched_at !== undefined) {
    const last = d.last_reported_at ?? d.reported_at;
    if (d.landed_at !== undefined) {
      // Landed, and nobody has run into it since: repaired.
      if (last <= d.landed_at) return { state: "done" };
    } else {
      const age = Date.parse(now) - Date.parse(d.dispatched_at);
      if (age < (amendmentRunning ? AMENDMENT_GIVE_UP_MS : AMENDMENT_ENDED_MS)) return { state: "in_amendment" };
    }
    // Reported again after its repair landed, or the repair never landed.
    if ((d.attempts ?? 1) >= MAX_ATTEMPTS) {
      return { state: "escalate", why: `${d.attempts ?? 1} amendment(s) did not give the sandbox what this needs` };
    }
    return { state: "ready", why: "its last amendment did not fix it" };
  }
  if (d.needs_the_change !== true || d.work_item === undefined) return { state: "ready" };
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
  readonly escalated: number;
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

/** The one issue a person gets when the sandbox cannot repair itself. */
export function escalationIssue(items: readonly (StoredReport & { key: string })[]): { title: string; body: string } {
  const needs = items.map((d) => `- **${d.needs}** (reported ${d.reports} time(s), by the ${d.role})\n  ${d.why}`).join("\n");
  return {
    title: items.length === 1 ? `The sandbox cannot repair itself: ${items[0]?.needs.slice(0, 80) ?? ""}` : `The sandbox cannot repair itself (${items.length} needs)`,
    body:
      `The factory tried ${MAX_ATTEMPTS} amendments of its sandbox for what is below, and the roles still cannot ` +
      `exercise it. It will not try again on its own.\n\n${needs}\n\n` +
      "Each amendment's run and PR are in the factory-setup workflow's history. What usually helps: a test mode or " +
      "test credential for the provider (named in `FACTORY_SANDBOX_ENV`), or a way to sign in that the app offers in " +
      "development. Once the sandbox can do it, close this issue; a new report starts a new repair.",
  };
}

/**
 * Hand every ready report to one amendment, if none is under way, and put
 * any that have used their attempts to a person. Called after each report
 * and by the rollup, so a report that waited is picked up once its change
 * merges or the amendment before it is done.
 */
export async function sweepReports(opts: {
  readonly gh: GitHub;
  readonly store: FactoryStore;
  readonly ledger: Ledger;
  readonly now: string;
  readonly plan?: boolean;
  /**
   * Whether the budget has room for an amendment's largest step. A repair
   * started without room is refused at once, and counting that as a failed
   * attempt would put a fixable sandbox to a person for want of money.
   */
  readonly fits?: () => Promise<{ readonly ok: boolean; readonly reason: string }>;
}): Promise<AmendmentSweep> {
  const ready: (InadequacyReport & { key: string; work_item?: string })[] = [];
  const marks: { path: string; content: string }[] = [];
  let waiting = 0;
  let dropped = 0;
  const pending: { path: string; d: StoredReport }[] = [];
  const escalate: { path: string; d: StoredReport }[] = [];
  const stored: { path: string; d: StoredReport }[] = [];
  for (const path of await opts.store.data.list(REPORTS)) {
    const d = await opts.store.data.readJson<StoredReport>(path);
    if (d !== null) stored.push({ path, d });
  }
  // Whether an amendment is running or awaiting merge: until one is, a
  // report handed to one that has ended without landing is free again.
  const awaiting = stored.some(({ d }) => d.dispatched_at !== undefined && d.landed_at === undefined && d.escalated_at === undefined && d.dropped_at === undefined);
  const running = awaiting ? await amendmentUnderWay(opts.gh) : false;
  for (const { path, d } of stored) {
    const st = reportState(d, opts.ledger, opts.now, running);
    if (st.state === "waits_for_merge") waiting += 1;
    if (st.state === "dropped") {
      dropped += 1;
      marks.push({ path, content: json({ ...d, dropped_at: opts.now, dropped_why: st.why }) });
    }
    if (st.state === "ready") pending.push({ path, d });
    if (st.state === "escalate") escalate.push({ path, d });
  }
  const underWay = (pending.length > 0 || escalate.length > 0) && (awaiting ? running : await amendmentUnderWay(opts.gh));
  const room = pending.length > 0 && !underWay && opts.fits !== undefined ? await opts.fits() : { ok: true, reason: "" };
  const busy = underWay;
  if (!room.ok) pending.length = 0;
  let issue: number | undefined;
  if (!busy && escalate.length > 0 && opts.plan !== true) {
    const { title, body } = escalationIssue(escalate.map(({ path, d }) => ({ ...d, key: keyOf(path) })));
    issue = await opts.gh
      .send<{ number: number }>("POST", `repos/${opts.gh.repo}/issues`, { title, body })
      .then((r) => r.number, () => undefined);
    for (const { path, d } of escalate) {
      marks.push({ path, content: json({ ...d, escalated_at: opts.now, ...(issue === undefined ? {} : { issue }) }) });
    }
  }
  if (!busy) {
    for (const { path, d } of pending) {
      ready.push({
        role: d.role, needs: d.needs, paths: d.paths, why: d.why, key: keyOf(path),
        ...(d.work_item === undefined ? {} : { work_item: d.work_item }),
      });
      const { landed_at: _landed, ...rest } = d;
      void _landed;
      marks.push({ path, content: json({ ...rest, dispatched_at: opts.now, attempts: (d.attempts ?? 0) + 1 }) });
    }
  }
  if (marks.length > 0 && opts.plan !== true) {
    await opts.store.put(marks, `sandbox reports: ${ready.length} to an amendment, ${dropped} dropped, ${busy ? 0 : escalate.length} put to a person`);
  }
  if (ready.length > 0 && opts.plan !== true) {
    await opts.gh.dispatchWorkflow("factory-setup.yml", undefined, { amend: JSON.stringify({ reports: ready }) });
  }
  const escalated = busy ? 0 : escalate.length;
  const why = [
    ready.length > 0 ? `started factory-setup to amend the sandbox for ${ready.length} report(s)` : "",
    escalated > 0 ? `put ${escalated} report(s) to a person${issue === undefined ? "" : ` in #${issue}`} after ${MAX_ATTEMPTS} amendments` : "",
    busy ? "an amendment is already under way; the reports wait for the next one" : "",
    !room.ok ? `the reports wait for budget: ${room.reason}` : "",
    ready.length === 0 && !busy && waiting > 0 ? `${waiting} report(s) wait for their change to merge` : "",
  ].filter((x) => x !== "").join("; ") || "no report waiting";
  return { dispatched: ready.length, waiting: busy ? waiting + pending.length : waiting, dropped, escalated, why };
}

function keyOf(path: string): string {
  return path.slice(REPORTS.length).replace(/\.json$/, "");
}

/** After an amendment merges: mark the reports it carried as landed, so a later report of the same need is a retry. */
export async function markLanded(store: FactoryStore, keys: readonly string[], now: string): Promise<number> {
  const marks: { path: string; content: string }[] = [];
  for (const key of keys) {
    const path = `${REPORTS}${key}.json`;
    const d = await store.data.readJson<StoredReport>(path);
    if (d === null) continue;
    marks.push({ path, content: json({ ...d, landed_at: now }) });
  }
  if (marks.length > 0) await store.put(marks, `sandbox reports: ${marks.length} repaired by an amendment`);
  return marks.length;
}

/**
 * An amendment that never got as far as a trial (refused by the budget, or a
 * runner failure) tried nothing: its reports go back to waiting, and the
 * attempt is not counted against them.
 */
export async function releaseReports(store: FactoryStore, keys: readonly string[]): Promise<number> {
  const marks: { path: string; content: string }[] = [];
  for (const key of keys) {
    const path = `${REPORTS}${key}.json`;
    const d = await store.data.readJson<StoredReport>(path);
    if (d?.dispatched_at === undefined || d.landed_at !== undefined) continue;
    const { dispatched_at: _d, ...rest } = d;
    void _d;
    marks.push({ path, content: json({ ...rest, attempts: Math.max(0, (d.attempts ?? 1) - 1) }) });
  }
  if (marks.length > 0) await store.put(marks, `sandbox reports: ${marks.length} back to waiting, their amendment never ran`);
  return marks.length;
}

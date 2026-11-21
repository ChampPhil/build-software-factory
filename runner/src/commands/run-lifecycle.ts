import { runId as newRunId } from "../lib/ids.js";
import { FactoryStore, LEDGER, json, livePath, workItemPath, type Ledger } from "../lib/store.js";
import type { GitHub } from "../lib/github.js";
import { afterGates, type AfterGates } from "./run-plan.js";
import { GATE_CHECKS, GATES_CHECK } from "./gates-run.js";

/**
 * A work item's life through one factory-run: started, gated, then cleared,
 * retried or escalated.
 *
 * Before this existed nothing moved an item off `queued`, so every intake and
 * every rollup dispatched it again, each new run cancelled the one before it
 * in the work item's concurrency group, and the running count — read from the
 * live files nobody wrote — was always zero.
 */

export const gateFailuresPath = (workItem: string): string => `gate-failures/${workItem}.json`;

type Status = "queued" | "running" | "in_review" | "escalated" | "needs_info" | "rejected" | "duplicate";

interface WorkItemDoc {
  readonly id: string;
  readonly pipeline: string;
  readonly status: string;
  readonly runs?: readonly string[];
  readonly pr?: number | null;
  readonly source?: { readonly ref?: string | null };
  readonly [k: string]: unknown;
}

/** The ledger's open list with one item's status (and PR) changed. */
export function withStatus(ledger: Ledger, item: WorkItemDoc, status: Status, pr: number | null, now: string): Ledger {
  const open = ledger.open.some((o) => o.work_item === item.id)
    ? ledger.open.map((o) => (o.work_item === item.id ? { ...o, status, ...(pr === null ? {} : { pr }) } : o))
    : [...ledger.open, { work_item: item.id, pipeline: item.pipeline, status, ...(pr === null ? {} : { pr }) }];
  return { ...ledger, updated_at: now, open };
}

/* ------------------------------------------------------------------- start */

export interface StartRunReport {
  /** Empty when the run did not claim the item. */
  readonly runId: string;
  readonly status: Status | "not_claimed";
  readonly reason?: string;
}

/**
 * Mark the item running and record the run as live, or mark it escalated when
 * the plan said this attempt is past the cap. An item that is not queued or
 * running is left alone: a dispatch that raced a human's decision loses.
 */
export async function startRun(opts: {
  readonly gh: GitHub;
  readonly workItem: string;
  readonly attempt: number;
  readonly escalate: boolean;
  readonly firstStep: string;
  readonly now: string;
  readonly runId?: string;
  /** GITHUB_RUN_ID, so the reaper can ask Actions whether the run is still going. */
  readonly actionsRun?: number;
}): Promise<StartRunReport> {
  const store = new FactoryStore(opts.gh);
  const item = await store.get<WorkItemDoc>(workItemPath(opts.workItem), "work-item");
  if (item === null) throw new Error(`${opts.workItem} is not on the data ref`);
  const id = opts.runId ?? newRunId(Date.parse(opts.now));
  // Attempt 1 claims a queued item; a retry continues one already running.
  // Anything else means another run or a person has it, and two dispatches of
  // the same item (an intake racing a rollup) must not both start.
  const claimable = opts.attempt === 1 ? item.status === "queued" : item.status === "running";
  if (!claimable && !opts.escalate) {
    return { runId: "", status: "not_claimed", reason: `${opts.workItem} is ${item.status}, so attempt ${opts.attempt} does not start it` };
  }
  const status: Status = opts.escalate ? "escalated" : "running";
  const ledger = await store.ledger(opts.now);
  const next = { ...item, status, runs: [...(item.runs ?? []), id] };
  const live = {
    schema: "live/1",
    run: id,
    work_item: item.id,
    pipeline: item.pipeline,
    step: opts.firstStep,
    attempt: opts.attempt,
    started_at: opts.now,
    ...(opts.actionsRun === undefined ? {} : { actions_run: opts.actionsRun }),
  };
  await store.put(
    [
      { path: workItemPath(item.id), content: json(next) },
      { path: LEDGER, content: json(withStatus(ledger, item, status, null, opts.now)) },
      ...(opts.escalate ? [] : [{ path: livePath(id), content: json(live) }]),
    ],
    `run ${id}: ${item.id} ${status} (attempt ${opts.attempt})`,
  );
  return { runId: id, status };
}

/* ------------------------------------------------------------- after gates */

export interface GateCheck {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly title: string | null;
  readonly summary: string | null;
  readonly text: string | null;
}

/** The two gate verdicts afterGates decides on, from a commit's check runs. */
export function gateVerdicts(checks: readonly GateCheck[]): {
  readonly staticGate: "passed" | "failed" | "skipped";
  readonly verificationGate: "passed" | "failed" | "skipped" | "not_run";
} {
  const failed = (c: GateCheck) => c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "cancelled";
  const of = (names: readonly string[]) => checks.filter((c) => names.includes(c.name));
  const agg = checks.find((c) => c.name === GATES_CHECK);
  const staticChecks = of(GATE_CHECKS.static);
  const verifyChecks = checks.filter(
    (c) => c.name.startsWith("factory/gate-") && !GATE_CHECKS.static.includes(c.name as never),
  );
  const staticGate = staticChecks.some(failed) ? "failed" : staticChecks.length === 0 ? "skipped" : "passed";
  let verificationGate: "passed" | "failed" | "skipped" | "not_run" = verifyChecks.some(failed)
    ? "failed"
    : verifyChecks.length === 0
      ? "skipped"
      : "passed";
  // The aggregate is what branch protection reads. If it failed and no
  // individual gate says why, the change still did not pass.
  if (agg !== undefined && failed(agg) && staticGate !== "failed" && verificationGate !== "failed") {
    verificationGate = "failed";
  }
  return { staticGate, verificationGate };
}

const MAX_TEXT = 6000;

/** What the builder reads on its next attempt: every gate that did not pass, in the gate's own words. */
export function gateFailures(checks: readonly GateCheck[], headSha: string, attempt: number, now: string): unknown {
  return {
    head_sha: headSha,
    attempt,
    recorded_at: now,
    items: checks
      .filter((c) => c.name.startsWith("factory/") && c.conclusion !== "success" && c.conclusion !== "neutral" && c.conclusion !== "skipped")
      .map((c) => ({
        check: c.name,
        conclusion: c.conclusion,
        title: c.title,
        summary: c.summary,
        ...(c.text === null ? {} : { text: c.text.length > MAX_TEXT ? `${c.text.slice(0, MAX_TEXT)}\n…(truncated)` : c.text }),
      })),
  };
}

interface CheckRunsResponse {
  readonly check_runs: readonly {
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly output?: { readonly title?: string | null; readonly summary?: string | null; readonly text?: string | null };
  }[];
}

async function gateChecks(gh: GitHub, sha: string): Promise<readonly GateCheck[]> {
  const r = await gh.get<CheckRunsResponse>(`repos/${gh.repo}/commits/${sha}/check-runs?per_page=100`);
  return r.check_runs
    .filter((c) => c.name.startsWith("factory/"))
    .map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      title: c.output?.title ?? null,
      summary: c.output?.summary ?? null,
      text: c.output?.text ?? null,
    }));
}

export interface AfterGatesReport {
  readonly next: AfterGates["next"] | "no_pr" | "timed_out" | "stood_down";
  readonly reason: string;
  readonly pr: number | null;
  readonly attempt: number;
}

export interface FinishRunOptions {
  readonly gh: GitHub;
  readonly workItem: string;
  readonly runId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** The PR the builder opened or pushed to; 0 or absent when it made none. */
  readonly pr: number | null;
  readonly buildResult: string;
  readonly now: () => string;
  readonly waitMs: number;
  readonly pollMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait for the gates on the PR's head, then clear, retry or escalate, and end
 * the run's live record. Whatever happens, the item leaves `running`: a run
 * that ends without saying what became of its item is how a queue stalls.
 */
export async function finishRun(opts: FinishRunOptions): Promise<AfterGatesReport> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const store = new FactoryStore(opts.gh);
  const item = await store.get<WorkItemDoc>(workItemPath(opts.workItem), "work-item");
  if (item === null) throw new Error(`${opts.workItem} is not on the data ref`);
  const pr = opts.pr !== null && opts.pr > 0 ? opts.pr : null;

  // Triage (or a person) already decided what became of the item: needs
  // info, out of scope, a duplicate. There is nothing to gate and nothing to
  // retry; the run only ends its live record.
  if (item.status !== "running") {
    await store.put([{ path: livePath(opts.runId), content: null }], `run ${opts.runId}: ${item.id} stood down (${item.status})`);
    return { next: "stood_down", reason: `${item.id} is ${item.status}`, pr, attempt: opts.attempt };
  }

  let report: AfterGatesReport;
  let failures: unknown = null;
  if (pr === null) {
    // No PR: the builder failed, or produced nothing. Another attempt is the
    // same as after a failed gate, and at the cap it is a human's.
    report =
      opts.attempt >= opts.maxAttempts
        ? { next: "escalate", reason: `the build made no PR (${opts.buildResult || "not run"}) on attempt ${opts.attempt} of ${opts.maxAttempts}`, pr, attempt: opts.attempt }
        : { next: "retry", reason: `the build made no PR (${opts.buildResult || "not run"})`, pr, attempt: opts.attempt + 1 };
  } else {
    // Link the PR to the item first: the gates' plan reads this link to
    // find the spec the verifier checks the change against.
    if (item.pr !== pr) {
      const at = opts.now();
      const ledger = await store.ledger(at);
      await store.put(
        [
          { path: workItemPath(item.id), content: json({ ...item, pr }) },
          { path: LEDGER, content: json(withStatus(ledger, item, "running", pr, at)) },
        ],
        `run ${opts.runId}: ${item.id} is PR #${pr}`,
      );
    }
    const deadline = Date.parse(opts.now()) + opts.waitMs;
    let head = (await opts.gh.pull(pr)).head.sha;
    let checks = await gateChecks(opts.gh, head);
    for (;;) {
      const agg = checks.find((c) => c.name === GATES_CHECK);
      if (agg !== undefined && agg.status === "completed") break;
      if (Date.parse(opts.now()) >= deadline) break;
      await sleep(opts.pollMs);
      head = (await opts.gh.pull(pr)).head.sha;
      checks = await gateChecks(opts.gh, head);
    }
    const agg = checks.find((c) => c.name === GATES_CHECK);
    if (agg === undefined || agg.status !== "completed") {
      report = { next: "timed_out", reason: `${GATES_CHECK} did not report on ${head.slice(0, 7)} in ${Math.round(opts.waitMs / 60000)} min`, pr, attempt: opts.attempt };
    } else {
      const d = afterGates({ ...gateVerdicts(checks), attempt: opts.attempt, maxAttempts: opts.maxAttempts });
      report = { next: d.next, reason: d.reason, pr, attempt: "attempt" in d ? d.attempt : opts.attempt };
      if (d.next === "retry" || d.next === "escalate") failures = gateFailures(checks, head, opts.attempt, opts.now());
    }
  }

  // Where the item goes. A run that timed out waiting is left in review with
  // its PR: the gates may still report, and merge reads them directly.
  const status: Status =
    report.next === "clear" || report.next === "verify" || report.next === "timed_out"
      ? "in_review"
      : report.next === "retry"
        ? "running"
        : "escalated";
  const now = opts.now();
  const ledger = await store.ledger(now);
  const next = { ...item, status, ...(pr === null ? {} : { pr }) };
  await store.put(
    [
      { path: workItemPath(item.id), content: json(next) },
      { path: LEDGER, content: json(withStatus(ledger, item, status, pr, now)) },
      { path: livePath(opts.runId), content: null },
      ...(failures === null ? [] : [{ path: gateFailuresPath(item.id), content: json(failures) }]),
    ],
    `run ${opts.runId}: ${item.id} ${report.next}`,
  );

  if (report.next === "retry") {
    await opts.gh.dispatchWorkflow("factory-run.yml", undefined, {
      work_item: item.id,
      attempt: String(report.attempt),
      pr_number: String(pr ?? 0),
    });
  }
  if (pr !== null && report.next === "clear") {
    // Merge reads only PRs that are out of draft, so clearing is what hands
    // the PR to merge (or to a person, when its pipeline needs one).
    await opts.gh.markReady(pr);
  }
  if (pr !== null && (report.next === "clear" || report.next === "escalate")) {
    const label = report.next === "clear" ? "factory:cleared" : "factory:escalated";
    await opts.gh.send("POST", `repos/${opts.gh.repo}/issues/${pr}/labels`, { labels: [label] }).catch(() => undefined);
  }
  if (report.next === "escalate") {
    const target = pr ?? issueNumber(item.source?.ref);
    if (target !== null) {
      await opts.gh
        .send("POST", `repos/${opts.gh.repo}/issues/${target}/comments`, {
          body:
            `The factory stopped on this and needs a person: ${report.reason}.\n\n` +
            `Fix what it needs (or push to the PR yourself), then comment \`/retry\` here to hand it back.`,
        })
        .catch(() => undefined);
    }
  }
  return report;
}

function issueNumber(ref: string | null | undefined): number | null {
  const m = /^#(\d+)$/.exec(ref ?? "");
  return m === null ? null : Number(m[1]);
}

/* ------------------------------------------------------------------ triage */

export const TRIAGE_OUTCOMES = ["proceed", "needs_info", "out_of_scope", "duplicate"] as const;
export type TriageOutcome = (typeof TRIAGE_OUTCOMES)[number];

export interface TriageResult {
  readonly outcome: TriageOutcome;
  readonly reason: string;
  readonly duplicate_of?: string;
}

/** Problems with a triage result, or none. */
export function triageProblems(r: unknown): readonly string[] {
  if (typeof r !== "object" || r === null) return ["the triage result is not an object"];
  const o = r as Record<string, unknown>;
  const out: string[] = [];
  if (!TRIAGE_OUTCOMES.includes(o["outcome"] as TriageOutcome)) out.push(`outcome must be one of ${TRIAGE_OUTCOMES.join(", ")}`);
  if (typeof o["reason"] !== "string" || o["reason"].trim() === "") out.push("reason is required");
  if (o["outcome"] === "duplicate" && (typeof o["duplicate_of"] !== "string" || !/^wi_[0-9A-HJKMNP-TV-Z]{26}$/.test(o["duplicate_of"]))) {
    out.push("a duplicate names the work item it duplicates in duplicate_of (wi_…)");
  }
  return out;
}

const TRIAGE_STATUS: Record<TriageOutcome, Status> = {
  proceed: "running",
  needs_info: "needs_info",
  out_of_scope: "rejected",
  duplicate: "duplicate",
};

/** Apply triage's outcome to the item, which is what tells the rest of the run whether to go on. */
export async function writeTriage(gh: GitHub, workItem: string, result: TriageResult, now: string): Promise<Status> {
  const store = new FactoryStore(gh);
  const item = await store.get<WorkItemDoc & { related?: readonly string[] }>(workItemPath(workItem), "work-item");
  if (item === null) throw new Error(`${workItem} is not on the data ref`);
  const status = TRIAGE_STATUS[result.outcome];
  if (status === item.status) return status;
  const related =
    result.duplicate_of === undefined ? item.related ?? [] : [...new Set([...(item.related ?? []), result.duplicate_of])];
  const ledger = await store.ledger(now);
  await store.put(
    [
      { path: workItemPath(item.id), content: json({ ...item, status, related }) },
      { path: LEDGER, content: json(withStatus(ledger, item, status, null, now)) },
    ],
    `triage: ${item.id} ${result.outcome}`,
  );
  return status;
}

/** Whether the run should go on past triage: the item is still the run's. */
export async function itemStatus(gh: GitHub, workItem: string): Promise<string> {
  const item = await new FactoryStore(gh).get<WorkItemDoc>(workItemPath(workItem), "work-item");
  if (item === null) throw new Error(`${workItem} is not on the data ref`);
  return item.status;
}

/* ------------------------------------------------------------------ reaper */

/** A live record older than this with no Actions run to ask about is presumed dead. */
const STALE_MS = 6 * 3_600_000;

export interface ReapReport {
  readonly reaped: readonly { readonly run: string; readonly work_item: string; readonly requeued: boolean }[];
}

/**
 * End the live records of runs that are no longer going — cancelled, crashed,
 * or superseded before after-gates could run — and put their items back in
 * the queue. Without this a cancelled run held its item in "running" for
 * ever, and its live record held a concurrency slot.
 */
export async function reapStaleRuns(gh: GitHub, now: string): Promise<ReapReport> {
  const store = new FactoryStore(gh);
  const paths = (await store.data.list("live/")).filter((p) => p.endsWith(".json"));
  const reaped: { run: string; work_item: string; requeued: boolean }[] = [];
  const changes: { path: string; content: string | null }[] = [];
  let ledger = await store.ledger(now);
  for (const p of paths) {
    const live = await store.data.readJson<{ run: string; work_item: string; started_at: string; actions_run?: number }>(p);
    if (live === null) continue;
    let dead: boolean;
    if (live.actions_run !== undefined) {
      const run = await gh
        .get<{ status?: string }>(`repos/${gh.repo}/actions/runs/${live.actions_run}`)
        .catch(() => ({ status: "completed" }));
      dead = run.status === "completed";
    } else {
      dead = Date.parse(now) - Date.parse(live.started_at) > STALE_MS;
    }
    if (!dead) continue;
    changes.push({ path: p, content: null });
    const item = await store.get<WorkItemDoc>(workItemPath(live.work_item), "work-item");
    // Requeue only if this run was the item's latest and left it running: a
    // later run, or a person, has had it since.
    const requeue = item !== null && item.status === "running" && (item.runs ?? []).at(-1) === live.run;
    if (requeue) {
      changes.push({ path: workItemPath(item.id), content: json({ ...item, status: "queued" }) });
      ledger = withStatus(ledger, item, "queued", item.pr ?? null, now);
    }
    reaped.push({ run: live.run, work_item: live.work_item, requeued: requeue });
  }
  if (changes.length > 0) {
    if (reaped.some((r) => r.requeued)) changes.push({ path: LEDGER, content: json(ledger) });
    await store.put(changes, `reap ${reaped.length} run(s) that ended without finishing`);
  }
  return { reaped };
}

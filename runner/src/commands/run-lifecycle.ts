import { scopeOf, scopesOverlap, filesNamedIn } from "../lib/scope.js";
import { closePullWithReason } from "../lib/github.js";
import { runId as newRunId } from "../lib/ids.js";
import { FactoryStore, LEDGER, json, livePath, runPath, workItemPath, type Ledger } from "../lib/store.js";
import { appendTurn, closeBrainstorm } from "./brainstorm.js";
import { reportsHolding } from "./sandbox-reports.js";
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
  readonly previous_prs?: readonly number[];
  readonly requeues?: number;
  readonly source?: { readonly ref?: string | null };
  readonly [k: string]: unknown;
}

/** Where a run parks what the gates' own workflow needs to finish it (fix 6). */
export const handoffPath = (runId: string): string => `handoff/${runId}.json`;

export interface Handoff {
  readonly run: string;
  readonly work_item: string;
  readonly pr: number;
  readonly attempt: number;
  readonly build_result: string;
  readonly steps: readonly StepReportDoc[];
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
  /** "conflict": rebuild an item whose PR conflicts with main. */
  readonly reason?: string;
  /** For a rebuild: the PR found conflicting. */
  readonly pr?: number;
}): Promise<StartRunReport> {
  const store = new FactoryStore(opts.gh);
  const item = await store.get<WorkItemDoc>(workItemPath(opts.workItem), "work-item");
  if (item === null) throw new Error(`${opts.workItem} is not on the data ref`);
  const id = opts.runId ?? newRunId(Date.parse(opts.now));
  // Attempt 1 claims a queued item; a retry continues one already running.
  // Anything else means another run or a person has it, and two dispatches of
  // the same item (an intake racing a rollup) must not both start.
  // A conflict rebuild starts from an item that already has its PR: waiting
  // for review, or escalated because an earlier rebuild could not finish.
  const claimable =
    opts.reason === "conflict"
      ? opts.attempt === 1 && (item.status === "in_review" || item.status === "escalated") && typeof item.pr === "number"
      : opts.attempt === 1 ? item.status === "queued" : item.status === "running";
  if (opts.reason === "conflict" && opts.pr !== undefined && opts.pr > 0 && item.pr !== opts.pr) {
    return { runId: "", status: "not_claimed", reason: `${opts.workItem} has moved on from #${opts.pr} to #${String(item.pr)}, so this rebuild is not needed` };
  }
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
  // The issue stops saying "queued" once a run has it (fix 3).
  const issue = issueNumber(item.source?.ref);
  if (issue !== null && !opts.escalate && opts.attempt === 1) {
    await opts.gh.send("DELETE", `repos/${opts.gh.repo}/issues/${issue}/labels/${encodeURIComponent("factory:queued")}`).catch(() => undefined);
  }
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
  // A policy failure the builder caused (an undeclared test edit, a path its
  // pipeline may not touch) is the builder's to fix, like a static rule. One
  // that only waits on a person's approval is in progress, not failed.
  const policy = checks.find((c) => c.name === "factory/policy");
  const staticGate =
    staticChecks.some(failed) || (policy !== undefined && failed(policy))
      ? "failed"
      : staticChecks.length === 0 ? "skipped" : "passed";
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
  readonly next: AfterGates["next"] | "no_pr" | "timed_out" | "stood_down" | "wait_sandbox" | "requeued" | "awaiting_gates";
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
  /** The roles' StepReports for this run, read from its artifacts. */
  readonly steps?: readonly StepReportDoc[];
}

/**
 * Wait for the gates on the PR's head, then clear, retry or escalate, and end
 * the run's live record. Whatever happens, the item leaves `running`: a run
 * that ends without saying what became of its item is how a queue stalls.
 */
export async function finishRun(opts: FinishRunOptions): Promise<AfterGatesReport> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const store = new FactoryStore(opts.gh);
  const found = await store.get<WorkItemDoc>(workItemPath(opts.workItem), "work-item");
  if (found === null) throw new Error(`${opts.workItem} is not on the data ref`);
  let item: WorkItemDoc = found;
  const pr = opts.pr !== null && opts.pr > 0 ? opts.pr : null;

  const live = await store.data.readJson<{ started_at?: string }>(livePath(opts.runId)).catch(() => null);
  // A run that handed off to the gates' workflow comes back here once they
  // finish. Its item waits in review, not running.
  const handed = await store.data.readJson<Handoff>(handoffPath(opts.runId)).catch(() => null);
  // The data ref is the one place a step's cost is recorded: `bsf budget
  // settle` writes steps/<run>/<role>-<attempt>.json in the same command that
  // charges the budget. The artifacts are evidence, and fill in only a role
  // the ref has no record of, so the two can no longer disagree.
  const recorded = await stepsFromRef(store, opts.runId);
  const carried = opts.steps ?? handed?.steps ?? [];
  const steps = [...recorded, ...carried.filter((c) => !recorded.some((r) => r.role === c.role))];
  const record = (report: AfterGatesReport, checks: readonly GateCheck[], commit: string | null, status: string) => ({
    path: runPath(opts.runId),
    content: json(
      runRecord({
        runId: opts.runId, workItem: item.id, pipeline: item.pipeline,
        startedAt: live?.started_at ?? opts.now(), endedAt: opts.now(), attempt: opts.attempt,
        report, itemStatus: status, steps, checks, commit,
      }),
    ),
  });

  // Triage (or a person) already decided what became of the item: needs
  // info, out of scope, a duplicate. There is nothing to gate and nothing to
  // retry; the run only ends its live record.
  if (item.status !== "running" && !(handed !== null && item.status === "in_review")) {
    const stood: AfterGatesReport = { next: "stood_down", reason: `${item.id} is ${item.status}`, pr, attempt: opts.attempt };
    await store.put(
      [{ path: livePath(opts.runId), content: null }, record(stood, [], null, item.status)],
      `run ${opts.runId}: ${item.id} stood down (${item.status})`,
    );
    return stood;
  }

  let report: AfterGatesReport;
  let failures: unknown = null;
  let finalChecks: readonly GateCheck[] = [];
  let finalHead: string | null = null;
  if (pr === null) {
    // No PR: the builder failed, or produced nothing. Another attempt is the
    // same as after a failed gate, and at the cap it is a human's.
    // A run whose build never ran (triage or an earlier step failed) did not
    // fail the item: put it back in the queue, say so on the issue, and stop
    // asking after two tries (fix 3). A build that ran and made nothing keeps
    // the attempt cap below.
    const buildRan = opts.buildResult !== "" && opts.buildResult !== "not run" && opts.buildResult !== "skipped";
    const requeues = item.requeues ?? 0;
    report = !buildRan
      ? requeues < 2
        ? { next: "requeued", reason: `the run ended before the build (${opts.buildResult || "not run"})`, pr, attempt: opts.attempt }
        : { next: "escalate", reason: `the run ended before the build twice (${opts.buildResult || "not run"})`, pr, attempt: opts.attempt }
      : opts.attempt >= opts.maxAttempts
        ? { next: "escalate", reason: `the build made no PR (${opts.buildResult}) on attempt ${opts.attempt} of ${opts.maxAttempts}`, pr, attempt: opts.attempt }
        : { next: "retry", reason: `the build made no PR (${opts.buildResult})`, pr, attempt: opts.attempt + 1 };
  } else {
    // Link the PR to the item first: the gates' plan reads this link to
    // find the spec the verifier checks the change against.
    if (item.pr !== pr) {
      const at = opts.now();
      const ledger = await store.ledger(at);
      // A rebuild (the old PR conflicted with main) opened a new PR for the
      // same item: the old one is kept on the item, so an approval given there
      // can carry over, and closed with a pointer to the new one.
      const replaced = typeof item.pr === "number" ? item.pr : null;
      const previous = replaced === null ? item.previous_prs ?? [] : [...(item.previous_prs ?? []), replaced];
      const linked: WorkItemDoc = { ...item, pr, ...(previous.length === 0 ? {} : { previous_prs: previous }) };
      await store.put(
        [
          { path: workItemPath(item.id), content: json(linked) },
          {
            path: LEDGER,
            content: json({
              ...withStatus(ledger, item, "running", pr, at),
              merge_queue: ledger.merge_queue.filter((q) => replaced === null || q.pr !== replaced),
            }),
          },
        ],
        `run ${opts.runId}: ${item.id} is PR #${pr}${replaced === null ? "" : ` (replaces #${replaced})`}`,
      );
      item = linked;
      if (replaced !== null) {
        await opts.gh
          .send("POST", `repos/${opts.gh.repo}/issues/${replaced}/comments`, {
            body: `Rebuilt on the current main as #${pr}, because this branch conflicted with it. An approval given here carries to #${pr} when the rebuilt change adds the same lines and removes nothing new.`,
          })
          .catch(() => undefined);
        // The comment above says why; closing goes through the one helper.
        await closePullWithReason(opts.gh, replaced, `Replaced by #${pr} because this branch conflicted with main.`);
      }
    }
    // A hardening PR changes the files its correction named, and tests for
    // them. Anything else (rules, dependencies, config nobody asked for) is
    // a person's to decide, so the run stops here.
    const stray = item.pipeline === "hardening" ? await strayHardeningFiles(opts.gh, pr, item) : [];
    const strayReport: typeof report = {
      next: "escalate",
      reason: `this hardening PR changes files its correction did not name: ${stray.slice(0, 5).join(", ")}${stray.length > 5 ? ` and ${stray.length - 5} more` : ""}`,
      pr,
      attempt: opts.attempt,
    };
    const deadline = Date.parse(opts.now()) + opts.waitMs;
    let head = (await opts.gh.pull(pr)).head.sha;
    let checks = stray.length > 0 ? [] : await gateChecks(opts.gh, head);
    for (; stray.length === 0; ) {
      const agg = checks.find((c) => c.name === GATES_CHECK);
      if (agg !== undefined && agg.status === "completed") break;
      if (Date.parse(opts.now()) >= deadline) break;
      await sleep(opts.pollMs);
      head = (await opts.gh.pull(pr)).head.sha;
      checks = await gateChecks(opts.gh, head);
    }
    finalChecks = checks;
    finalHead = head;
    const agg = checks.find((c) => c.name === GATES_CHECK);
    if (stray.length > 0) {
      report = strayReport;
    } else if ((agg === undefined || agg.status !== "completed") && opts.waitMs <= 0) {
      // Hand off: the gates' own workflow finishes this run when they report,
      // so no job here sits billing minutes while it waits (fix 6).
      report = { next: "awaiting_gates", reason: `${GATES_CHECK} has not reported on ${head.slice(0, 7)} yet`, pr, attempt: opts.attempt };
    } else if (agg === undefined || agg.status !== "completed") {
      report = { next: "timed_out", reason: `${GATES_CHECK} did not report on ${head.slice(0, 7)} in ${Math.round(opts.waitMs / 60000)} min`, pr, attempt: opts.attempt };
    } else {
      const d = afterGates({ ...gateVerdicts(checks), attempt: opts.attempt, maxAttempts: opts.maxAttempts });
      report = { next: d.next, reason: d.reason, pr, attempt: "attempt" in d ? d.attempt : opts.attempt };
      if (d.next === "retry" || d.next === "escalate") {
        // A verification the sandbox could not give is not the change's
        // failure. Rebuilding would spend the budget on the same verdict, so
        // the change waits for the repair and is verified again when it lands.
        const stuck =
          gateVerdicts(checks).staticGate !== "failed"
            ? await reportsHolding(store, item.id, live?.started_at ?? opts.now()).catch(() => [])
            : [];
        if (stuck.length > 0) {
          report = {
            next: "wait_sandbox",
            reason: `the sandbox could not judge this change (${stuck.length} report${stuck.length === 1 ? "" : "s"} filed); it is verified again once the repair lands`,
            pr,
            attempt: opts.attempt,
          };
        } else {
          failures = gateFailures(checks, head, opts.attempt, opts.now());
        }
      }
    }
  }

  if (report.next === "awaiting_gates" && pr !== null) {
    const doc: Handoff = { run: opts.runId, work_item: item.id, pr, attempt: opts.attempt, build_result: opts.buildResult, steps };
    const now = opts.now();
    const ledger = await store.ledger(now);
    await store.put(
      [
        { path: workItemPath(item.id), content: json({ ...item, status: "in_review", pr }) },
        { path: LEDGER, content: json(withStatus(ledger, item, "in_review", pr, now)) },
        { path: handoffPath(opts.runId), content: json(doc) },
      ],
      `run ${opts.runId}: ${item.id} waits for the gates on PR #${pr}`,
    );
    return report;
  }

  // Where the item goes. A run that timed out waiting is left in review with
  // its PR: the gates may still report, and merge reads them directly.
  const status: Status =
    report.next === "clear" || report.next === "verify" || report.next === "timed_out" || report.next === "wait_sandbox"
      ? "in_review"
      : report.next === "retry"
        ? "running"
        : report.next === "requeued"
          ? "queued"
          : "escalated";
  const now = opts.now();
  const ledger = await store.ledger(now);
  const next = {
    ...item,
    status,
    ...(pr === null ? {} : { pr }),
    ...(report.next === "requeued" ? { requeues: (item.requeues ?? 0) + 1 } : {}),
  };
  await store.put(
    [
      { path: workItemPath(item.id), content: json(next) },
      { path: LEDGER, content: json(withStatus(ledger, item, status, pr, now)) },
      { path: livePath(opts.runId), content: null },
      ...(handed === null ? [] : [{ path: handoffPath(opts.runId), content: null }]),
      record(report, finalChecks, finalHead, status),
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
  if (report.next === "requeued") {
    const issue = issueNumber(item.source?.ref);
    if (issue !== null) {
      const at = new Date(now);
      const hhmm = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
      await opts.gh
        .send("POST", `repos/${opts.gh.repo}/issues/${issue}/comments`, {
          body: `I picked this up at ${hhmm} but could not finish the step (${report.reason}). Trying again in 5 minutes.`,
        })
        .catch(() => undefined);
      await opts.gh.send("POST", `repos/${opts.gh.repo}/issues/${issue}/labels`, { labels: ["factory:queued"] }).catch(() => undefined);
    }
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
      const body = await escalationBody(opts.gh, item.id, report.reason, failures).catch(
        () =>
          `The factory stopped on this and needs a person: ${report.reason}.\n\n` +
          `Fix what it needs (or push to the PR yourself), then comment \`/retry\` here to hand it back.`,
      );
      await opts.gh.send("POST", `repos/${opts.gh.repo}/issues/${target}/comments`, { body }).catch(() => undefined);
    }
  }
  return report;
}

/**
 * A factory change that was held or escalated and then passed its gates on its
 * own: after a sandbox repair the stuck branch is brought up to date and
 * verified again, which no factory run is waiting to see. Nothing else would
 * hand it to merge, so it stayed a draft with its stopped labels. When the
 * gates are green on its head, it is cleared as a run would have cleared it.
 */
export async function clearHeldChange(opts: {
  readonly gh: GitHub;
  readonly pr: number;
  readonly now: () => string;
}): Promise<string> {
  const store = new FactoryStore(opts.gh);
  const now = opts.now();
  const ledger = await store.ledger(now);
  const open = ledger.open.find((o) => o.pr === opts.pr);
  if (open === undefined) return `#${opts.pr} is not a factory change in the ledger`;
  if (open.status !== "in_review" && open.status !== "escalated") return `${open.work_item} is ${open.status}, not held`;
  const pull = await opts.gh.pull(opts.pr);
  const checks = await gateChecks(opts.gh, pull.head.sha);
  const agg = checks.find((c) => c.name === GATES_CHECK);
  if (agg === undefined || agg.status !== "completed" || agg.conclusion !== "success") {
    return `${GATES_CHECK} has not passed on ${pull.head.sha.slice(0, 7)}`;
  }
  const names = new Set((pull.labels ?? []).map((l) => l.name));
  const stale = ["factory:escalated", "factory:in-progress"].filter((n) => names.has(n));
  if (!pull.draft && stale.length === 0 && names.has("factory:cleared")) return `#${opts.pr} is already cleared`;

  await opts.gh.markReady(opts.pr);
  for (const n of stale) {
    await opts.gh.send("DELETE", `repos/${opts.gh.repo}/issues/${opts.pr}/labels/${encodeURIComponent(n)}`).catch(() => undefined);
  }
  if (!names.has("factory:cleared")) {
    await opts.gh.send("POST", `repos/${opts.gh.repo}/issues/${opts.pr}/labels`, { labels: ["factory:cleared"] }).catch(() => undefined);
  }
  const doc = await store.get<WorkItemDoc>(workItemPath(open.work_item), "work-item");
  if (doc !== null && open.status === "escalated") {
    await store.put(
      [
        { path: workItemPath(open.work_item), content: json({ ...doc, status: "in_review" }) },
        { path: LEDGER, content: json(withStatus(ledger, doc, "in_review", opts.pr, now)) },
      ],
      `${open.work_item} cleared: its gates passed after a sandbox repair`,
    );
  }
  return `cleared ${open.work_item} (#${opts.pr}): the gates passed on ${pull.head.sha.slice(0, 7)}`;
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
  /** For `needs_info`: the one question to put to the author. */
  readonly question?: string;
  /**
   * What the factory now believes is being asked, in its own words.
   *
   * The playback. Written whenever triage can say it, and read at the top of
   * the next run so a conversation builds rather than restarting. When this
   * can be written with nothing filled in, the conversation is over — that is
   * the end condition, and there is no turn limit.
   */
  readonly understood?: string;
}

/** Problems with a triage result, or none. */
export function triageProblems(r: unknown): readonly string[] {
  if (typeof r !== "object" || r === null) return ["the triage result is not an object"];
  const o = r as Record<string, unknown>;
  const out: string[] = [];
  if (!TRIAGE_OUTCOMES.includes(o["outcome"] as TriageOutcome)) out.push(`outcome must be one of ${TRIAGE_OUTCOMES.join(", ")}`);
  if (typeof o["reason"] !== "string" || o["reason"].trim() === "") out.push("reason is required");
  if (o["outcome"] === "needs_info" && (typeof o["question"] !== "string" || o["question"].trim() === "")) {
    // The factory posts this question itself, so there has to be one. When the
    // agent was asked to both record the outcome and remember to comment, the
    // comment was the half that went missing — and the author of the request
    // was left with an acknowledgement and then permanent silence.
    out.push("needs_info names the one question to ask the author, in question");
  }
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

/**
 * What the factory says to the author when triage ends the pipeline.
 *
 * Rendered here, from the recorded outcome, rather than left to the agent to
 * remember: `needs_info`, `out_of_scope` and `duplicate` all stop the run, and
 * all three were silent whenever the agent's own job did not finish cleanly.
 * The live install's very first feature request died exactly this way — the
 * outcome reached the work item, the question never reached the issue.
 */
export function triageMessage(result: TriageResult): string {
  switch (result.outcome) {
    case "needs_info":
      return (
        `**One question before I start.**\n\n${(result.question ?? result.reason).trim()}\n\n` +
        `Answer in a comment here and I will pick this up again — nothing else is needed from you.`
      );
    case "out_of_scope":
      return (
        `**I am not going to take this on.** ${result.reason.trim()}\n\n` +
        `If that is wrong, say so in a comment and it will be looked at again.`
      );
    case "duplicate":
      return (
        `**This looks like a duplicate.** ${result.reason.trim()}\n\n` +
        `If it is actually a different problem, say so in a comment and it will be reopened as its own item.`
      );
    case "proceed":
      return "";
  }
}

const TRIAGE_LABEL: Partial<Record<TriageOutcome, string>> = {
  needs_info: "factory:needs-info",
  out_of_scope: "factory:out-of-scope",
  duplicate: "factory:duplicate",
};

/** Marks the factory's own outcome comment, so saying it twice is impossible. */
const triageMarker = (workItem: string): string => `<!-- bsf:triage:${workItem} -->`;

/**
 * Tell the author what triage decided, on the thread they opened.
 *
 * Idempotent: the marker means this can be called from the role's own run and
 * again from the safety net that runs whatever happened, without the author
 * hearing it twice. Returns whether anything was posted.
 */
export async function announceTriage(
  gh: GitHub,
  workItem: string,
  source: string | null | undefined,
  result: TriageResult,
): Promise<boolean> {
  const target = issueNumber(source);
  if (target === null || result.outcome === "proceed") return false;
  const marker = triageMarker(workItem);
  const existing = await gh
    .get<readonly { readonly body?: string }[]>(`repos/${gh.repo}/issues/${target}/comments?per_page=100`)
    .catch(() => []);
  if (existing.some((c) => (c.body ?? "").includes(marker))) return false;
  await gh.send("POST", `repos/${gh.repo}/issues/${target}/comments`, {
    body: `${triageMessage(result)}\n\n${marker}`,
  });
  const label = TRIAGE_LABEL[result.outcome];
  if (label !== undefined) {
    await gh.send("POST", `repos/${gh.repo}/issues/${target}/labels`, { labels: [label] }).catch(() => undefined);
  }
  return true;
}

/** Apply triage's outcome to the item, which is what tells the rest of the run whether to go on. */
export async function writeTriage(gh: GitHub, workItem: string, result: TriageResult, now: string): Promise<Status> {
  const store = new FactoryStore(gh);
  const item = await store.get<WorkItemDoc & { related?: readonly string[] }>(workItemPath(workItem), "work-item");
  if (item === null) throw new Error(`${workItem} is not on the data ref`);
  const status = TRIAGE_STATUS[result.outcome];
  if (status === item.status) {
    // Already recorded — but the author may still not have been told, which is
    // the whole failure this guards against. Announcing is idempotent.
    await announceTriage(gh, item.id, item.source?.ref, result).catch(() => undefined);
    return status;
  }
  const related =
    result.duplicate_of === undefined ? item.related ?? [] : [...new Set([...(item.related ?? []), result.duplicate_of])];
  const ledger = await store.ledger(now);
  await store.put(
    [
      { path: workItemPath(item.id), content: json({ ...item, status, related, triage_reason: result.question ?? result.reason }) },
      { path: LEDGER, content: json(withStatus(ledger, item, status, null, now)) },
    ],
    `triage: ${item.id} ${result.outcome}`,
  );
  // The factory speaks for itself. This used to be a line in the role's prompt
  // asking the agent to "also comment", which meant the author heard nothing
  // whenever the agent wrote its outcome and stopped.
  await announceTriage(gh, item.id, item.source?.ref, result).catch(() => undefined);

  // Keep the conversation. A question asked and forgotten is how the second
  // turn ends up repeating the first.
  if (result.outcome === "needs_info" && result.question !== undefined) {
    await appendTurn(gh, item.id, { at: now, who: "factory", text: result.question }, result.understood ?? null, [
      result.question,
    ]).catch(() => undefined);
  } else if (result.outcome === "proceed" && result.understood !== undefined) {
    await closeBrainstorm(gh, item.id, result.understood, now).catch(() => undefined);
  }
  return status;
}

/**
 * The safety net: say something about an item whose run ended without a PR.
 *
 * Runs whatever happened to the roles, because the case that matters is the
 * one where a role's own job failed. Reads the recorded outcome rather than any
 * job's result, and is idempotent, so it is harmless when the run went fine.
 */
export async function announceTerminalState(gh: GitHub, workItem: string): Promise<string> {
  const store = new FactoryStore(gh);
  const item = await store.get<WorkItemDoc & { triage_reason?: string }>(workItemPath(workItem), "work-item");
  if (item === null) return `${workItem} is not on the data ref`;
  if (typeof item.pr === "number") return `${workItem} is PR #${item.pr}; nothing to say here`;
  const outcome = ({ needs_info: "needs_info", rejected: "out_of_scope", duplicate: "duplicate" } as const)[
    item.status as "needs_info" | "rejected" | "duplicate"
  ];
  if (outcome === undefined) return `${workItem} is ${item.status}; nothing to say here`;
  const reason = item.triage_reason ?? "Triage stopped here and did not record why.";
  const said = await announceTriage(gh, item.id, item.source?.ref, {
    outcome,
    reason,
    ...(outcome === "needs_info" ? { question: reason } : {}),
  });
  return said ? `told ${item.source?.ref ?? "the dashboard"} that ${workItem} is ${item.status}` : `${workItem}: already said`;
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

/* -------------------------------------------------------------- run record */

export interface StepReportDoc {
  readonly role: string;
  readonly model: string;
  readonly exit: "ok" | "error" | "timeout" | "refused";
  readonly duration_sec: number;
  readonly tokens: { readonly in: number; readonly out: number; readonly cached?: number };
  readonly cost_usd: number;
  readonly transcript: string | null;
}

const OUTCOME: Record<string, string> = {
  clear: "draft_pr",
  verify: "draft_pr",
  timed_out: "draft_pr",
  wait_sandbox: "draft_pr",
  retry: "failed",
  escalate: "escalated",
  no_pr: "failed",
};
const STATUS_OUTCOME: Record<string, string> = {
  duplicate: "duplicate",
  rejected: "rejected",
  needs_info: "no_action",
  escalated: "escalated",
};

/**
 * The record of one factory-run: what each role cost and did, how the gates
 * judged it, and how it ended. Everything that measures the factory — the
 * review, the dashboard's cost and quality — reads these, and
 * before this nothing wrote them, so all of it measured an empty set.
 */
export function runRecord(input: {
  readonly runId: string;
  readonly workItem: string;
  readonly pipeline: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly attempt: number;
  readonly report: AfterGatesReport;
  readonly itemStatus: string;
  readonly steps: readonly StepReportDoc[];
  readonly checks: readonly GateCheck[];
  readonly commit: string | null;
}): Record<string, unknown> {
  const outcome =
    input.report.next === "stood_down"
      ? (STATUS_OUTCOME[input.itemStatus] ?? "no_action")
      : (OUTCOME[input.report.next] ?? "failed");
  const gate = (names: readonly string[]): "pass" | "fail" | "skipped" => {
    const cs = input.checks.filter((c) => names.includes(c.name));
    if (cs.length === 0) return "skipped";
    return cs.some((c) => c.conclusion === "failure" || c.conclusion === "timed_out") ? "fail" : "pass";
  };
  const steps = input.steps.map((s) => ({
    role: s.role,
    model: s.model,
    attempt: input.attempt,
    duration_sec: s.duration_sec,
    tokens: s.tokens,
    cost_usd: s.cost_usd,
    transcript: s.transcript,
    exit: s.exit,
  }));
  const gates =
    input.checks.length === 0
      ? []
      : [
          { gate: "static", attempt: input.attempt, result: gate(GATE_CHECKS.static), ...(input.commit === null ? {} : { commit: input.commit }) },
          {
            gate: "verification",
            attempt: input.attempt,
            result: gate(input.checks.map((c) => c.name).filter((n) => n.startsWith("factory/gate-") && !GATE_CHECKS.static.includes(n as never))),
            ...(input.commit === null ? {} : { commit: input.commit }),
          },
        ];
  const cost = Math.round(steps.reduce((a, s) => a + s.cost_usd, 0) * 10000) / 10000;
  return {
    schema: "run/1",
    id: input.runId,
    work_item: input.workItem,
    pipeline: input.pipeline,
    actor: { kind: "agent", harness: "claude-code" },
    started_at: input.startedAt,
    ended_at: input.endedAt,
    duration_sec: Math.max(0, Math.round((Date.parse(input.endedAt) - Date.parse(input.startedAt)) / 1000)),
    outcome,
    pr: input.report.pr,
    steps,
    gates,
    cost_usd: cost,
    escalated: outcome === "escalated",
  };
}

/* -------------------------------------------------------------- PR closed */

export interface PrClosedReport {
  readonly workItem: string | null;
  readonly status: "merged" | "rejected" | "no_item";
  readonly runsUpdated: readonly string[];
}

/**
 * A factory PR closed: its work item is done. Merged makes it `merged`, with
 * the time, which is what the metrics count and what lets anything waiting on
 * the change (a sandbox report, a gardening item on the same files) go ahead.
 * Closed without merging makes it `rejected`. The item's runs that ended at
 * the PR take the same outcome. Nothing else marks an item finished, so an
 * item left `in_review` after its PR closed would block those forever.
 */
export async function prClosed(opts: {
  readonly gh: GitHub;
  readonly pr: number;
  readonly merged: boolean;
  readonly now: string;
}): Promise<PrClosedReport> {
  const store = new FactoryStore(opts.gh);
  const ledger = await store.ledger(opts.now);
  const id =
    ledger.open.find((o) => o.pr === opts.pr)?.work_item ??
    ledger.merge_queue.find((q) => q.pr === opts.pr)?.work_item ??
    null;
  if (id === null) return { workItem: null, status: "no_item", runsUpdated: [] };
  const item = await store.get<WorkItemDoc & { merged_at?: string; closed_at?: string }>(workItemPath(id), "work-item");
  if (item === null) return { workItem: id, status: "no_item", runsUpdated: [] };
  // A PR the item has moved on from (rebuilt as a new PR after a conflict)
  // closing says nothing about the item.
  if (typeof item.pr === "number" && item.pr !== opts.pr) return { workItem: id, status: "no_item", runsUpdated: [] };

  const status = opts.merged ? "merged" : "rejected";
  const nextItem = {
    ...item,
    status,
    pr: opts.pr,
    ...(opts.merged ? { merged_at: opts.now } : { closed_at: opts.now }),
  };
  const changes: { path: string; content: string }[] = [{ path: workItemPath(id), content: json(nextItem) }];

  const runsUpdated: string[] = [];
  for (const runId of item.runs ?? []) {
    const run = await store.get<{ outcome?: string; pr?: number | null }>(runPath(runId), "run");
    if (run === null || run.outcome !== "draft_pr") continue;
    changes.push({ path: runPath(runId), content: json({ ...run, outcome: opts.merged ? "merged" : "rejected" }) });
    runsUpdated.push(runId);
  }

  const entry = ledger.open.find((o) => o.work_item === id);
  const nextLedger: Ledger = {
    ...ledger,
    updated_at: opts.now,
    open: ledger.open.filter((o) => o.work_item !== id),
    recent: [
      ...ledger.recent.filter((r) => r.work_item !== id),
      {
        work_item: id,
        status,
        ...(opts.merged ? { merged_at: opts.now } : {}),
        ...(entry?.fingerprint === undefined ? {} : { fingerprint: entry.fingerprint }),
        pr: opts.pr,
      },
    ],
    merge_queue: ledger.merge_queue.filter((q) => q.pr !== opts.pr),
  };
  changes.push({ path: LEDGER, content: json(nextLedger) });
  await store.put(changes, `PR #${opts.pr} ${opts.merged ? "merged" : "closed"}: ${id} ${status}`);
  return { workItem: id, status, runsUpdated };
}

/* ------------------------------------------------------------------- drop */

export interface DropReport {
  readonly dropped: readonly string[];
  readonly skipped: readonly { readonly work_item: string; readonly why: string }[];
  readonly cancelledRuns: readonly number[];
  readonly closedPrs: readonly number[];
}

const DROPPABLE = new Set(["queued", "running", "in_review", "escalated", "needs_info", "waiting_trust"]);

/**
 * An owner drops work items: each becomes `rejected`, its live Actions run is
 * cancelled and its PR closed with the reason. This is how a person takes
 * back work the factory should not do, whether or not it has a PR yet.
 */
export async function dropItems(opts: {
  readonly gh: GitHub;
  readonly ids: readonly string[];
  readonly why: string;
  readonly now: string;
}): Promise<DropReport> {
  const store = new FactoryStore(opts.gh);
  const ledger = await store.ledger(opts.now);
  const changes: { path: string; content: string | null }[] = [];
  const dropped: string[] = [];
  const skipped: { work_item: string; why: string }[] = [];
  const cancelledRuns: number[] = [];
  const closedPrs: number[] = [];

  for (const id of opts.ids) {
    const item = await store.get<WorkItemDoc>(workItemPath(id), "work-item");
    if (item === null) {
      skipped.push({ work_item: id, why: "not on the data ref" });
      continue;
    }
    if (!DROPPABLE.has(item.status)) {
      skipped.push({ work_item: id, why: `already ${item.status}` });
      continue;
    }
    changes.push({ path: workItemPath(id), content: json({ ...item, status: "rejected", closed_at: opts.now }) });
    const runId = (item.runs ?? []).at(-1);
    if (runId !== undefined) {
      const live = await store.get<{ actions_run?: number }>(livePath(runId), "live");
      if (live !== null) {
        if (live.actions_run !== undefined) {
          await opts.gh.send("POST", `repos/${opts.gh.repo}/actions/runs/${live.actions_run}/cancel`, {}).then(
            () => cancelledRuns.push(live.actions_run as number),
            () => undefined,
          );
        }
        changes.push({ path: livePath(runId), content: null });
      }
    }
    if (typeof item.pr === "number") {
      if (await closePullWithReason(opts.gh, item.pr, `Closed because an owner dropped it: ${opts.why}`)) closedPrs.push(item.pr);
    }
    dropped.push(id);
  }

  if (dropped.length > 0) {
    const gone = new Set(dropped);
    const nextLedger: Ledger = {
      ...ledger,
      updated_at: opts.now,
      open: ledger.open.filter((o) => !gone.has(o.work_item)),
      recent: [
        ...ledger.recent.filter((r) => !gone.has(r.work_item)),
        ...ledger.open
          .filter((o) => gone.has(o.work_item))
          .map((o) => ({ work_item: o.work_item, status: "rejected", ...(o.pr == null ? {} : { pr: o.pr }) })),
      ],
      merge_queue: ledger.merge_queue.filter((q) => q.work_item === undefined || !gone.has(q.work_item)),
    };
    changes.push({ path: LEDGER, content: json(nextLedger) });
    await store.put(changes, `drop ${dropped.length} item(s): ${opts.why.slice(0, 60)}`);
  }
  return { dropped, skipped, cancelledRuns, closedPrs };
}

/**
 * An escalation, in the same layout as a PR: why it stopped first, then the
 * proof the roles captured, the failing checks as the things to focus on, and
 * what to do next.
 */
async function escalationBody(gh: GitHub, workItem: string, reason: string, failures: unknown): Promise<string> {
  const { renderReport, reportPath } = await import("./pr-report.js");
  type Stored = import("./pr-report.js").StoredReport;
  const store = new FactoryStore(gh);
  const reports: Stored[] = [];
  for (const role of ["builder", "verifier"]) {
    const r = await store.data.readJson<Stored>(reportPath(workItem, role));
    if (r !== null) reports.push(r);
  }
  const items = ((failures as { items?: { check: string; title: string | null; summary: string | null }[] } | null)?.items ?? []);
  const failing: Stored = {
    role: "gates", attempt: 0, media_commit: null, media_prefix: "", inline: {}, problems: [], stored_at: "",
    report: {
      schema: "pr-report/1",
      summary: ["Failing checks"],
      blocks: [],
      focus: items.slice(0, 6).map((i) => ({ title: `${i.check}: ${i.title ?? "failed"}`, detail: (i.summary ?? "").split("\n").find((l) => l.trim() !== "")?.slice(0, 900) ?? "See the check." })),
    },
  };
  const rendered = renderReport({
    repo: gh.repo,
    kind: "escalation",
    reports: [...reports, failing],
    lead: [`The factory stopped on this and needs a person: ${reason}.`, "Fix what it needs, or push to the PR yourself, then comment `/retry` here to hand it back."],
    footer: `Work item ${workItem}`,
  });
  return rendered.body;
}


/**
 * The files a hardening PR changed that its correction did not name. Empty
 * when the correction names no files (nothing to hold it to) or every changed
 * file is named or is a test.
 */
export async function strayHardeningFiles(gh: GitHub, pr: number, item: { readonly body?: string } | object): Promise<string[]> {
  const allowed = scopeOf(filesNamedIn((item as { body?: string }).body ?? ""));
  if (allowed === null) return [];
  const changed = (await gh.pullFiles(pr).catch(() => [])).map((f) => f.filename);
  const isTest = (f: string) => /(^|\/)(tests?|__tests__|spec)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f);
  return changed.filter((f) => !isTest(f) && !scopesOverlap(scopeOf([f]), allowed));
}

/* ------------------------------------------------------ a step that failed */

export interface JobSummary {
  readonly name: string;
  readonly conclusion: string | null;
}

/**
 * Did the role's agent actually finish? gh-aw wraps every role in jobs named
 * `<caller> / <job>`. When triage decides to proceed it has nothing to emit,
 * gh-aw's `conclusion` job reports it "could not complete", and the whole
 * called workflow fails although the agent, its detection and its safe
 * outputs all succeeded. That is a recovery, not a failure; any other failed
 * job is a real one.
 */
export function agentFinishedCleanly(jobs: readonly JobSummary[], step: string): boolean {
  const mine = jobs.filter((j) => j.name.toLowerCase().startsWith(`${step} / `) || j.name.toLowerCase().startsWith(`${step}/`));
  const part = (j: JobSummary) => j.name.split("/").pop()!.trim().toLowerCase();
  const agent = mine.find((j) => part(j) === "agent");
  if (agent?.conclusion !== "success") return false;
  return mine.every((j) => part(j) === "conclusion" || j.conclusion === "success" || j.conclusion === "skipped");
}

export interface FailStepReport {
  readonly recovered: boolean;
  readonly action: "recovered" | "requeued" | "escalated";
  readonly reason: string;
}

/**
 * `bsf run fail-step ITEM --step triage`: a step ended in failure.
 *
 * If its agent in fact finished, the run carries on. Otherwise the item goes
 * back in the queue through the same counter as a run that ended before the
 * build (fix 3), and the person is told once, on their issue.
 */
export async function failStep(opts: {
  readonly gh: GitHub;
  readonly workItem: string;
  readonly step: string;
  readonly runId: string;
  readonly now: string;
  readonly jobs?: readonly JobSummary[];
}): Promise<FailStepReport> {
  const jobs =
    opts.jobs ??
    (
      await opts.gh
        .get<{ jobs: { name: string; conclusion: string | null }[] }>(`repos/${opts.gh.repo}/actions/runs/${opts.runId}/jobs?per_page=100`)
        .catch(() => ({ jobs: [] }))
    ).jobs;
  if (agentFinishedCleanly(jobs, opts.step)) {
    return { recovered: true, action: "recovered", reason: `the ${opts.step} agent finished; only gh-aw's closing report failed` };
  }
  const store = new FactoryStore(opts.gh);
  const item = await store.get<WorkItemDoc>(workItemPath(opts.workItem), "work-item");
  if (item === null) throw new Error(`${opts.workItem} is not on the data ref`);
  const requeues = item.requeues ?? 0;
  const escalate = requeues >= 2;
  const status: Status = escalate ? "escalated" : "queued";
  const ledger = await store.ledger(opts.now);
  await store.put(
    [
      { path: workItemPath(item.id), content: json({ ...item, status, requeues: escalate ? requeues : requeues + 1 }) },
      { path: LEDGER, content: json(withStatus(ledger, item, status, item.pr ?? null, opts.now)) },
    ],
    `${item.id}: ${opts.step} failed, ${escalate ? "escalated" : "queued again"}`,
  );
  const issue = issueNumber(item.source?.ref);
  if (issue !== null) {
    await opts.gh
      .send("POST", `repos/${opts.gh.repo}/issues/${issue}/comments`, {
        body: escalate
          ? `The factory could not read this request (${opts.step} failed twice), so it has stopped and needs a person. Comment /retry once that is sorted.`
          : `The factory could not read this request (${opts.step} failed). Trying again in 5 minutes.`,
      })
      .catch(() => undefined);
    if (!escalate) await opts.gh.send("POST", `repos/${opts.gh.repo}/issues/${issue}/labels`, { labels: ["factory:queued"] }).catch(() => undefined);
  }
  return {
    recovered: false,
    action: escalate ? "escalated" : "requeued",
    reason: `${opts.step} failed before its agent finished`,
  };
}


/** The steps `bsf budget settle` recorded for a run, from `steps/<run>/`. */
export async function stepsFromRef(store: FactoryStore, runId: string): Promise<StepReportDoc[]> {
  const names = await store.data.list(`steps/${runId}/`).catch(() => [] as readonly string[]);
  const out: StepReportDoc[] = [];
  for (const n of names.filter((x) => x.endsWith(".json"))) {
    const d = await store.data.readJson<StepRecord>(n).catch(() => null);
    if (d === null) continue;
    out.push({
      role: d.role,
      model: d.model ?? "unknown",
      exit: "ok",
      duration_sec: d.duration_sec,
      tokens: d.tokens ?? { in: 0, out: 0 },
      cost_usd: d.cost_usd,
      transcript: null,
    });
  }
  return out;
}

/** What `bsf budget settle` writes for each step it charges. */
export interface StepRecord {
  readonly role: string;
  readonly run_id: string;
  readonly attempt: number;
  readonly at: string;
  readonly model?: string;
  readonly cost_usd: number;
  readonly duration_sec: number;
  readonly tokens?: { readonly in: number; readonly out: number };
  /** Minutes GitHub billed for the job, when it could be read (fix 6). */
  readonly billed_minutes?: number;
}

/** Split a budget key `<run>-<attempt>-<role>`. */
export function parseBudgetKey(key: string): { run: string; attempt: number; role: string } | null {
  const m = /^(\d+)-(\d+)-(.+)$/.exec(key);
  return m === null ? null : { run: m[1]!, attempt: Number(m[2]), role: m[3]! };
}

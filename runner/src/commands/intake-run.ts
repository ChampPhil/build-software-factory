import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { GitHub } from "../lib/github.js";
import { FactoryStore, CURSOR, INCOMING, LEDGER, json, workItemPath } from "../lib/store.js";
import type { Change } from "../lib/dataref.js";
import { runIntake, chooseDispatches, type IncomingEvent, type EventKind, type IntakeResult, type LedgerOpenItem, type DispatchDecision } from "./intake.js";
import type { Policy, Association, Pipeline as QueuedPipeline } from "../lib/types.js";
import { workItemId } from "../lib/ids.js";

/**
 * `bsf intake` — the deterministic side of intake.
 *
 * Two things make this safe to run repeatedly and safe to lose a run of:
 * the incoming event is appended to the data ref before anything is decided,
 * and every run drains every event above the cursor rather than only the one
 * that started it (doc 07). So a dropped run costs a delay, never a request.
 */

export interface IntakeRunOptions {
  readonly gh: GitHub;
  readonly eventName: string;
  readonly eventPath: string;
  readonly now: string;
  readonly policy: Policy;
  readonly triggers: {
    readonly issues: boolean;
    readonly comments: boolean;
    readonly ci_failure_on_main: boolean;
    readonly dashboard_dispatch: boolean;
  };
  readonly maxRuns: number;
  readonly runningRuns: number;
  /** Pipelines over their budget share; they stay queued (doc 06). */
  readonly pausedPipelines?: readonly QueuedPipeline[];
  readonly runWorkflow?: string;
  readonly ref?: string;
  /** Set to skip dispatching, for a dry run. */
  readonly plan?: boolean;
}

export interface IntakeRunReport {
  readonly result: IntakeResult;
  readonly dispatched: readonly string[];
  readonly commit: string | null;
  readonly decision: DispatchDecision;
}

/**
 * The GitHub event payload, narrowed to the fields intake reads. Everything
 * here is attacker-controlled text on a public repo, so nothing from it is
 * interpolated into a prompt without passing through stripUntrustedText.
 */
interface Payload {
  action?: string;
  issue?: { number?: number; title?: string; body?: string | null; labels?: { name?: string }[]; user?: { login?: string; type?: string }; author_association?: string };
  comment?: { id?: number; body?: string | null; user?: { login?: string; type?: string }; author_association?: string; created_at?: string };
  pull_request?: { number?: number; head?: { repo?: { full_name?: string } | null }; base?: { repo?: { full_name?: string } } };
  label?: { name?: string };
  sender?: { login?: string; type?: string };
  workflow_run?: { conclusion?: string; head_branch?: string; name?: string; id?: number };
  inputs?: Record<string, string>;
}

/**
 * The event id must rise monotonically, because the cursor is "everything at
 * or below this id is done". Wall-clock milliseconds do that without any
 * shared counter, and a hash of the payload breaks a tie if two events land in
 * the same millisecond.
 */
export function eventId(payload: unknown, now: string): number {
  const ms = Date.parse(now);
  const base = Number.isNaN(ms) ? Date.now() : ms;
  const h = createHash("sha256").update(JSON.stringify(payload)).digest();
  return base * 1000 + ((h[0]! << 2) % 1000);
}

/** Translate a GitHub webhook payload into the one event shape intake reads. */
export function normalizeEvent(
  eventName: string,
  payload: Payload,
  now: string,
): IncomingEvent | null {
  const assoc = (s: string | undefined): Association =>
    (s ?? "NONE").toUpperCase() as Association;

  const id = eventId(payload, now);

  if (eventName === "issues" && payload.issue !== undefined) {
    const kind: EventKind = payload.action === "labeled" ? "issue_labeled" : "issue_opened";
    if (payload.action !== "opened" && payload.action !== "labeled") return null;
    return {
      id, kind, at: now,
      actor: payload.issue.user?.login ?? payload.sender?.login ?? "unknown",
      actor_association: assoc(payload.issue.author_association),
      actor_is_bot: (payload.issue.user?.type ?? payload.sender?.type) === "Bot",
      ...(payload.issue.title === undefined ? {} : { title: payload.issue.title }),
      ...(payload.issue.body == null ? {} : { body: payload.issue.body }),
      ...(payload.issue.number === undefined ? {} : { ref: `#${payload.issue.number}` }),
      labels: (payload.issue.labels ?? []).map((l) => l.name ?? "").filter((n) => n !== ""),
    };
  }

  if ((eventName === "issue_comment" || eventName === "pull_request_review_comment") && payload.comment !== undefined) {
    if (payload.action !== "created") return null;
    const onPr = payload.pull_request !== undefined || eventName === "pull_request_review_comment";
    return {
      id,
      kind: onPr ? "review_comment" : "issue_comment",
      at: payload.comment.created_at ?? now,
      actor: payload.comment.user?.login ?? "unknown",
      actor_association: assoc(payload.comment.author_association),
      actor_is_bot: payload.comment.user?.type === "Bot",
      ...(payload.comment.body == null ? {} : { body: payload.comment.body }),
      ...(onPr
        ? { ref: `#${payload.pull_request?.number ?? payload.issue?.number ?? 0}`, pr: payload.pull_request?.number ?? payload.issue?.number ?? 0 }
        : { ref: `#${payload.issue?.number ?? 0}` }),
      // A comment on a PR from a fork is still a fork event: the PR's head
      // repository, not the commenter, decides that.
      ...(payload.pull_request === undefined
        ? {}
        : { from_fork: isFork(payload.pull_request) }),
    };
  }

  if (eventName === "workflow_run" && payload.workflow_run !== undefined) {
    const wr = payload.workflow_run;
    if (wr.conclusion !== "failure") return null;
    return {
      id, kind: "ci_failure_on_main", at: now,
      actor: "github-actions",
      actor_association: "NONE",
      actor_is_bot: true,
      title: `CI failed on ${wr.head_branch ?? "main"}: ${wr.name ?? "workflow"}`,
      ...(wr.id === undefined ? {} : { body: `Failing run: ${wr.id}` }),
    };
  }

  if (eventName === "workflow_dispatch") {
    const inputs = payload.inputs ?? {};
    const kindInput = inputs["kind"] as EventKind | undefined;
    return {
      id,
      kind: kindInput ?? "dashboard_dispatch",
      at: now,
      actor: payload.sender?.login ?? "unknown",
      // A dispatch is only possible for someone with write access, so the
      // association GitHub would report is at least a collaborator's.
      actor_association: "COLLABORATOR",
      ...(inputs["title"] === undefined ? {} : { title: inputs["title"] }),
      ...(inputs["body"] === undefined ? {} : { body: inputs["body"] }),
      ...(inputs["ref"] === undefined ? {} : { ref: inputs["ref"] }),
    };
  }

  return null;
}

function isFork(pr: NonNullable<Payload["pull_request"]>): boolean {
  const head = pr.head?.repo?.full_name;
  const base = pr.base?.repo?.full_name;
  // A deleted head repository reads as null, and only a fork's head repo can
  // be deleted while its PR lives — so null is a fork (see policy-run).
  if (head === undefined || head === null) return true;
  return base !== undefined && head !== base;
}

export async function runIntakeCommand(opts: IntakeRunOptions): Promise<IntakeRunReport> {
  const store = new FactoryStore(opts.gh);
  const payload = JSON.parse(readFileSync(opts.eventPath, "utf8")) as Payload;
  const incoming = normalizeEvent(opts.eventName, payload, opts.now);

  // Persist first. Everything after this point can be redone by a later run.
  const existing = (await store.data.read(INCOMING)) ?? "";
  const queued: IncomingEvent[] = existing
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as IncomingEvent);

  if (incoming !== null && !queued.some((e) => e.id === incoming.id)) {
    queued.push(incoming);
    await store.data.commitWithRetry(
      async () => {
        const text = (await store.data.read(INCOMING)) ?? "";
        return [{ path: INCOMING, content: `${text}${JSON.stringify(incoming)}\n` }];
      },
      `intake: record ${incoming.kind}`,
    );
  }

  const cursorDoc = await store.data.readJson<{ cursor?: number }>(CURSOR);
  const cursor = cursorDoc?.cursor ?? 0;
  const ledger = await store.ledger(opts.now);

  const openItems: LedgerOpenItem[] = ledger.open.map((o) => ({
    work_item: o.work_item,
    status: o.status,
    pipeline: o.pipeline as LedgerOpenItem["pipeline"],
    ...(o.fingerprint === undefined ? {} : { fingerprint: o.fingerprint }),
  }));

  const result = runIntake(queued, {
    policy: opts.policy,
    triggers: opts.triggers,
    cursor,
    openItems,
    recentlyMerged: ledger.recent
      .filter((r) => r.merged_at !== undefined)
      .map((r) => ({
        work_item: r.work_item,
        ...(r.fingerprint === undefined ? {} : { fingerprint: r.fingerprint }),
        ...(r.pr == null ? {} : { pr: r.pr }),
      })),
    // A ULID, so the id sorts chronologically and matches the schema's
    // pattern. The event's own timestamp seeds it, so re-running intake over
    // the same event queue produces ids in the same order.
    newId: (e) => workItemId(Date.parse(e.at) || Date.now()),
  });

  const changes: Change[] = [];
  const newItems: { id: string; priority: "high" | "normal"; pipeline: string; created_at: string; fingerprint: string; status: string }[] = [];

  for (const d of result.decisions) {
    if (d.workItem === null) continue;
    changes.push({ path: workItemPath(d.workItem.id), content: json(d.workItem) });
    newItems.push({
      id: d.workItem.id,
      priority: d.workItem.priority,
      pipeline: d.workItem.pipeline,
      created_at: d.workItem.created_at,
      fingerprint: d.workItem.fingerprint,
      status: d.workItem.status,
    });
  }

  if (newItems.length > 0 || result.cursor !== cursor) {
    const nextLedger = {
      ...ledger,
      updated_at: opts.now,
      open: [
        ...ledger.open,
        ...newItems
          .filter((i) => !ledger.open.some((o) => o.work_item === i.id))
          .map((i) => ({
            work_item: i.id,
            pipeline: i.pipeline,
            status: i.status,
            fingerprint: i.fingerprint,
            priority: i.priority,
            created_at: i.created_at,
          })),
      ],
    };
    changes.push({ path: LEDGER, content: json(nextLedger) });
    changes.push({ path: CURSOR, content: json({ cursor: result.cursor, updated_at: opts.now }) });
    // Processed events are dropped from the queue, so it stays short. The
    // decisions live on in the work items and the run files.
    const remaining = queued.filter((e) => e.id > result.cursor);
    changes.push({
      path: INCOMING,
      content: remaining.map((e) => JSON.stringify(e)).join("\n") + (remaining.length > 0 ? "\n" : ""),
    });
  }

  let commit: string | null = null;
  if (changes.length > 0) {
    commit = await store.put(changes, `intake: ${newItems.length} work item(s), cursor ${result.cursor}`);
  }

  // Queued items from earlier runs are dispatched here too, not only the ones
  // this run created: a slot that frees up should not wait for the next event.
  const queuedItems = [
    ...newItems.filter((i) => i.status === "queued"),
    ...ledger.open
      .filter((o) => o.status === "queued" && !newItems.some((i) => i.id === o.work_item))
      .map((o) => ({
        id: o.work_item,
        pipeline: o.pipeline,
        priority: o.priority ?? ("normal" as const),
        created_at: o.created_at ?? opts.now,
        fingerprint: o.fingerprint ?? "",
        status: o.status,
      })),
  ];

  const decision = chooseDispatches(
    queuedItems.map((i) => ({
      work_item: i.id,
      priority: i.priority,
      pipeline: i.pipeline as QueuedPipeline,
      created_at: i.created_at,
    })),
    { running: opts.runningRuns, maxRuns: opts.maxRuns, pausedPipelines: opts.pausedPipelines ?? [] },
  );

  const dispatched: string[] = [];
  if (opts.plan !== true) {
    for (const id of decision.dispatch) {
      await opts.gh.dispatchWorkflow(opts.runWorkflow ?? "factory-run.yml", opts.ref, {
        work_item: id,
      });
      dispatched.push(id);
    }
  }

  return { result, dispatched, commit, decision };
}

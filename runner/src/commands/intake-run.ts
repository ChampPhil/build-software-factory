import { acknowledgement } from "./acknowledge.js";
import { applyControl, controlDispatch, focusComment, routeRequest, type Router, type RoutableDoc } from "./routing-run.js";
import { isTrustedActor } from "./policy.js";
import type { WorkItemDraft } from "./intake.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { effectiveAssociation, type GitHub } from "../lib/github.js";
import { FactoryStore, CURSOR, INCOMING, LEDGER, json, workItemPath, runPath } from "../lib/store.js";
import { appendTurn, readBrainstorm, heldLive } from "./brainstorm.js";
import type { CorrectionRecord } from "./corrections.js";
import { decideCandidate, candidateRequest } from "./candidate-decisions.js";
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
  /** False until setup's PR has merged; see chooseDispatches. */
  readonly setupFinished?: boolean;
  readonly runWorkflow?: string;
  readonly ref?: string;
  /** Set to skip dispatching, for a dry run. */
  readonly plan?: boolean;
  /**
   * Only write the event down (and mark the issue queued), then stop. The
   * intake workflow's first job does this in a group of its own, so no event
   * is lost to GitHub keeping one pending run per group (fix 4).
   */
  readonly recordOnly?: boolean;
  /** The chief of staff. Without one, the fixed table's route stands. */
  readonly router?: Router;
}

/** What a record-only run returns: the event is on the data ref, nothing was decided. */
export interface IntakeRecordedReport {
  readonly recorded: true;
  readonly event: number | null;
}

export interface IntakeRunReport {
  readonly result: IntakeResult;
  readonly dispatched: readonly string[];
  readonly commit: string | null;
  readonly decision: DispatchDecision;
  /** The issues the factory commented on to say it had read them. */
  readonly acknowledged: readonly number[];
  /** The work items the chief of staff routed. */
  readonly routed: readonly string[];
}

/**
 * The GitHub event payload, narrowed to the fields intake reads. Everything
 * here is attacker-controlled text on a public repo, so nothing from it is
 * interpolated into a prompt without passing through stripUntrustedText.
 */
interface Payload {
  action?: string;
  issue?: { number?: number; title?: string; body?: string | null; labels?: { name?: string }[]; user?: { login?: string; type?: string }; author_association?: string; state?: string; pull_request?: unknown };
  comment?: { id?: number; body?: string | null; user?: { login?: string; type?: string }; author_association?: string; created_at?: string; html_url?: string };
  review?: { body?: string | null; state?: string; user?: { login?: string; type?: string }; author_association?: string; submitted_at?: string; html_url?: string };
  pull_request?: { number?: number; head?: { repo?: { full_name?: string } | null }; base?: { repo?: { full_name?: string } } };
  /** For a `pull_request` `synchronize`: the branch head before and after the push. */
  before?: string;
  after?: string;
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
    // The report issues gh-aw files about its own runs ("[aw] Triage: finished
    // without a terminal safe output") are the factory's noise, not a request.
    if (isGhAwReport(payload.issue)) return null;
    return {
      id, kind, at: now,
      actor: payload.issue.user?.login ?? payload.sender?.login ?? "unknown",
      actor_association: assoc(payload.issue.author_association),
      actor_is_bot: (payload.issue.user?.type ?? payload.sender?.type) === "Bot",
      ...(payload.issue.title === undefined ? {} : { title: payload.issue.title }),
      ...(payload.issue.body == null ? {} : { body: payload.issue.body }),
      ...(payload.issue.number === undefined ? {} : { ref: `#${payload.issue.number}` }),
      labels: (payload.issue.labels ?? []).map((l) => l.name ?? "").filter((n) => n !== ""),
      ...(payload.action === "labeled" && payload.label?.name !== undefined
        ? { label_added: payload.label.name, ...(payload.sender?.login === undefined ? {} : { labeled_by: payload.sender.login }) }
        : {}),
    };
  }

  if ((eventName === "issue_comment" || eventName === "pull_request_review_comment") && payload.comment !== undefined) {
    if (payload.action !== "created") return null;
    // GitHub sends a comment on a PR's conversation as an issue_comment whose
    // issue carries a pull_request key. Read without it, every PR comment
    // looked like a new request (trinsports filed work from a status comment
    // on its closed setup PR).
    const onPr = payload.pull_request !== undefined || payload.issue?.pull_request != null || eventName === "pull_request_review_comment";
    // Nothing on a closed issue or PR starts work, apart from an explicit
    // /retry, which names what it hands back.
    const closed = payload.issue?.state === "closed";
    if (retryRequested(payload.comment.body)) {
      return {
        id,
        kind: "retry_requested",
        at: payload.comment.created_at ?? now,
        actor: payload.comment.user?.login ?? "unknown",
        actor_association: assoc(payload.comment.author_association),
        actor_is_bot: payload.comment.user?.type === "Bot",
        ref: `#${payload.pull_request?.number ?? payload.issue?.number ?? 0}`,
        ...(payload.pull_request === undefined ? {} : { from_fork: isFork(payload.pull_request) }),
      };
    }
    if (closed) return null;
    const practice = practiceText(payload.comment.body);
    if (practice !== null) {
      // Wherever someone already is — an issue, a PR, a review thread — a
      // `/practice` line declares a standing instruction. It is not a
      // revision of that PR's run or a new product request.
      return {
        id,
        kind: "practice_declared",
        at: payload.comment.created_at ?? now,
        actor: payload.comment.user?.login ?? "unknown",
        actor_association: assoc(payload.comment.author_association),
        actor_is_bot: payload.comment.user?.type === "Bot",
        title: `Practice: ${practice}`,
        body: practice,
        ref: `#${payload.pull_request?.number ?? payload.issue?.number ?? 0}`,
        ...(payload.pull_request === undefined ? {} : { from_fork: isFork(payload.pull_request) }),
      };
    }
    return {
      id,
      kind: onPr ? "review_comment" : "issue_comment",
      at: payload.comment.created_at ?? now,
      actor: payload.comment.user?.login ?? "unknown",
      actor_association: assoc(payload.comment.author_association),
      actor_is_bot: payload.comment.user?.type === "Bot",
      ...(payload.comment.body == null ? {} : { body: payload.comment.body }),
      ...(payload.comment.html_url === undefined ? {} : { url: payload.comment.html_url }),
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

  // A review someone submitted. An approval is the gate working, and a comment
  // review with no body is only the envelope for its inline comments, which
  // arrive as their own events.
  if (eventName === "pull_request_review" && payload.review !== undefined && payload.pull_request !== undefined) {
    if (payload.action !== "submitted") return null;
    const state = (payload.review.state ?? "").toUpperCase();
    if (state !== "CHANGES_REQUESTED" && state !== "COMMENTED") return null;
    if (state === "COMMENTED" && (payload.review.body ?? "").trim() === "") return null;
    return {
      id,
      kind: "pr_review",
      at: payload.review.submitted_at ?? now,
      actor: payload.review.user?.login ?? "unknown",
      actor_association: assoc(payload.review.author_association),
      actor_is_bot: payload.review.user?.type === "Bot",
      review_state: state,
      ...(payload.review.body == null ? {} : { body: payload.review.body }),
      ...(payload.review.html_url === undefined ? {} : { url: payload.review.html_url }),
      ref: `#${payload.pull_request.number ?? 0}`,
      pr: payload.pull_request.number ?? 0,
      from_fork: isFork(payload.pull_request),
    };
  }

  // A push to a PR's branch by someone other than the factory. What they
  // changed is filled in by the caller, which can ask GitHub; this stays pure.
  if (eventName === "pull_request_target" || eventName === "pull_request") {
    if (payload.action !== "synchronize" || payload.pull_request?.number === undefined) return null;
    return {
      id,
      kind: "human_push",
      at: now,
      actor: payload.sender?.login ?? "unknown",
      actor_association: "NONE",
      actor_is_bot: payload.sender?.type === "Bot",
      ref: `#${payload.pull_request.number}`,
      pr: payload.pull_request.number,
      from_fork: isFork(payload.pull_request),
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
    const title = typeof inputs["title"] === "string" ? inputs["title"] : undefined;
    const retryOf = /^\s*\/retry\s+(wi_[0-9A-HJKMNP-TV-Z]{26})\s*$/.exec(title ?? "")?.[1];
    if (retryOf !== undefined) {
      return {
        id, kind: "retry_requested", at: now,
        actor: payload.sender?.login ?? "unknown",
        actor_association: "COLLABORATOR",
        target_item: retryOf,
      };
    }
    const practice = practiceText(title);
    if (practice !== null) {
      return {
        id, kind: "practice_declared", at: now,
        actor: payload.sender?.login ?? "unknown",
        actor_association: "COLLABORATOR",
        title: `Practice: ${practice}`,
        body: practice,
      };
    }
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

/** `kind=candidate_accept|candidate_reject` on a dispatch, with the candidate's id as the title. */
export function candidateDecision(
  eventName: string,
  payload: Payload,
): { readonly id: string; readonly status: "accepted" | "rejected"; readonly by: string } | null {
  if (eventName !== "workflow_dispatch") return null;
  const kind = payload.inputs?.["kind"];
  const id = (payload.inputs?.["title"] ?? "").trim();
  if ((kind !== "candidate_accept" && kind !== "candidate_reject") || id === "") return null;
  return { id, status: kind === "candidate_accept" ? "accepted" : "rejected", by: payload.sender?.login ?? "unknown" };
}

/** Whether a comment is `/retry` (optionally followed by a reason). */
export function retryRequested(body: string | null | undefined): boolean {
  return body != null && /^\s*\/retry(\s|$)/.test(body);
}

/**
 * The practice a comment declares, or null. A line `/practice <text>` at the
 * start of the comment; anything after it on later lines is kept as context.
 */
export function practiceText(body: string | null | undefined): string | null {
  if (body == null) return null;
  const m = /^\s*\/practice\s+([\s\S]+)$/.exec(body);
  if (m?.[1] === undefined) return null;
  const text = m[1].trim();
  return text === "" ? null : text;
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
  const r = await intakeImpl({ ...opts, recordOnly: false });
  if ("recorded" in r) throw new Error("unreachable: record-only was off");
  return r;
}

/** Put on an issue from someone the factory does not trust, in place of factory:queued. */
export const AWAITING_LABEL = "factory:awaiting-maintainer";

/** The first intake job: write the event down and mark the issue queued (fix 4). */
export async function recordIntakeCommand(opts: IntakeRunOptions): Promise<IntakeRecordedReport> {
  const r = await intakeImpl({ ...opts, recordOnly: true });
  if (!("recorded" in r)) throw new Error("unreachable: record-only was on");
  return r;
}

async function intakeImpl(opts: IntakeRunOptions): Promise<IntakeRunReport | IntakeRecordedReport> {
  const store = new FactoryStore(opts.gh);
  await store.data.pin();
  const payload = JSON.parse(readFileSync(opts.eventPath, "utf8")) as Payload;
  // A person accepting or rejecting a candidate on the dashboard. Rejecting is
  // only a record; accepting is also a request to harden against it now, which
  // goes in as a correction like any other.
  const picked = candidateDecision(opts.eventName, payload);
  let fromCandidate: IncomingEvent | null = null;
  if (picked !== null) {
    const done = await decideCandidate({ gh: opts.gh, id: picked.id, status: picked.status, by: picked.by, now: opts.now });
    if (done.candidate !== null && picked.status === "accepted") {
      const ask = candidateRequest(done.candidate);
      fromCandidate = {
        id: eventId(payload, opts.now), kind: "correction", at: opts.now, actor: picked.by, actor_association: "COLLABORATOR",
        title: ask.title, body: ask.body, ref: `candidate:${picked.id}`,
      };
    }
  }
  // The dashboard's direct controls: a standing goal added or removed, a route changed.
  const control = controlDispatch(opts.eventName, payload);
  if (control !== null) await applyControl(store, control, opts.now);

  // `/focus` in a comment, from someone the factory trusts, is a standing goal.
  let focused = false;
  const focus = focusComment(opts.eventName, payload);
  if (focus !== null) {
    const association = await effectiveAssociation(opts.gh, focus.actor, focus.association, opts.policy.trust.associations);
    if (isTrustedActor(opts.policy, focus.actor, association as Association, { isBot: focus.isBot })) {
      await applyControl(store, { kind: "goal_add", text: focus.text, lane: focus.lane, by: focus.actor }, opts.now);
      focused = true;
      if (focus.number !== null && opts.plan !== true) {
        await opts.gh
          .send("POST", `repos/${opts.gh.repo}/issues/${focus.number}/comments`, {
            body: `Recorded as a standing goal${focus.lane === null ? "" : ` for ${focus.lane.replace("_", " ")}`}: ${focus.text}\n\nThe factory weighs it when it routes new requests. Remove it from the dashboard's Factory page.`,
          })
          .catch(() => undefined);
      }
    }
  }
  const normalized = picked !== null ? fromCandidate : control !== null || focused ? null : normalizeEvent(opts.eventName, payload, opts.now);
  const raw = normalized?.kind === "human_push" ? await enrichPush(opts.gh, normalized, payload) : normalized;
  const incoming =
    raw === null
      ? null
      : {
          ...raw,
          actor_association: (await effectiveAssociation(
            opts.gh,
            raw.actor,
            raw.actor_association ?? "NONE",
            opts.policy.trust.associations,
          )) as typeof raw.actor_association,
        };

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

  if (opts.recordOnly === true) {
    // The issue says "queued" from here until a run starts (fix 3).
    const num = incoming?.kind === "issue_opened" ? /^#(\d+)$/.exec(incoming.ref ?? "")?.[1] : undefined;
    if (num !== undefined) {
      // Someone the factory does not trust gets a different label: nothing is
      // queued for them until a maintainer accepts it (D53).
      const trusted = incoming !== null && isTrustedActor(opts.policy, incoming.actor, incoming.actor_association, { isBot: incoming.actor_is_bot === true });
      await opts.gh.send("POST", `repos/${opts.gh.repo}/issues/${num}/labels`, { labels: [trusted ? "factory:queued" : AWAITING_LABEL] }).catch(() => undefined);
    }
    return { recorded: true, event: incoming?.id ?? null };
  }

  const cursorDoc = await store.data.readJson<{ cursor?: number }>(CURSOR);
  const cursor = cursorDoc?.cursor ?? 0;
  const ledger = await store.ledger(opts.now);

  // The sweep that used to re-list every issue here is gone (fix 2): the
  // record job gives every event its own run, so none is dropped, and the
  // sweep cost one API call per open issue on every run.

  const openItems: LedgerOpenItem[] = ledger.open.map((o) => ({
    work_item: o.work_item,
    status: o.status,
    pipeline: o.pipeline as LedgerOpenItem["pipeline"],
    ...(o.fingerprint === undefined ? {} : { fingerprint: o.fingerprint }),
    ...(o.source_ref === undefined ? {} : { source_ref: o.source_ref }),
    ...(o.pr === undefined ? {} : { pr: o.pr }),
  }));

  const prItems = await prItemsFor(store, ledger, queued.filter((e) => e.id > cursor));

  // Which conversations have a job holding them open. Only the items that
  // could be answered are read, which is almost always none or one: a held
  // job answers its own comments within seconds, and requeuing the item as
  // well would start a second conversation asking the same question again.
  const liveConversations: string[] = [];
  for (const o of openItems) {
    if (o.status !== "needs_info") continue;
    const convo = await readBrainstorm(opts.gh, o.work_item).catch(() => null);
    if (heldLive(convo, new Date(opts.now))) liveConversations.push(o.work_item);
  }

  // What each open item is already doing, so a correction that repeats it or
  // edits the same files folds into it rather than opening a second PR.
  const openItemBodies: Record<string, string> = {};
  if (queued.some((e) => e.pr !== undefined && e.id > cursor)) {
    for (const o of openItems) {
      const doc = await store.get<{ body?: string }>(workItemPath(o.work_item), "work-item").catch(() => null);
      if (doc?.body !== undefined) openItemBodies[o.work_item] = doc.body;
    }
  }

  const result = runIntake(queued, {
    prItems,
    openItemBodies,
    policy: opts.policy,
    triggers: opts.triggers,
    cursor,
    openItems,
    liveConversations,
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
  const newItems: { id: string; priority: "high" | "normal"; pipeline: string; created_at: string; fingerprint: string; status: string; source_ref: string | null }[] = [];

  // The chief of staff decides what each new request is, before anything is
  // written or dispatched, so the pipeline on the work item is the one that runs.
  const routed: string[] = [];
  const questions: { issue: string | null; text: string }[] = [];
  const decisions = [];
  for (const d of result.decisions) {
    if (opts.router !== undefined && d.workItem !== null && d.outcome === "queued") {
      const r = await routeRequest(store, opts.router, d.workItem as unknown as RoutableDoc & WorkItemDraft, opts.now);
      if (r !== null) {
        routed.push(d.workItem.id);
        if (r.question !== null) questions.push({ issue: d.workItem.source.ref, text: r.question });
        decisions.push({ ...d, workItem: r.item });
        continue;
      }
    }
    decisions.push(d);
  }

  // Answers and admissions put an existing item back in the queue.
  const requeued = new Map<string, { status: string; pipeline: string; priority?: string }>();
  for (const d of decisions) {
    if ((d.outcome !== "answers_open_item" && d.outcome !== "admits_open_item" && d.outcome !== "retries_open_item") || d.openItem === undefined) continue;
    const doc = await store.get<{ status: string; body: string } & Record<string, unknown>>(workItemPath(d.openItem), "work-item");
    if (doc === null) continue;
    const body =
      d.outcome === "answers_open_item" && (d.event.body ?? "").trim() !== ""
        ? `${doc.body}\n\nAnswer from @${d.event.actor}:\n${d.event.body ?? ""}`
        : doc.body;
    // Their answer joins the conversation, so the next run of triage builds on
    // it instead of starting again from the issue text. Without this the item
    // comes back with no memory of what was already settled, and the second
    // question reads as though nobody was listening to the first answer.
    if (d.outcome === "answers_open_item" && (d.event.body ?? "").trim() !== "") {
      await appendTurn(opts.gh, d.openItem, {
        at: opts.now,
        who: "person",
        text: (d.event.body ?? "").trim(),
        ...(commentIdOf(d.event.url) === null ? {} : { comment: commentIdOf(d.event.url) as number }),
      }).catch(() => undefined);
    }
    let next: Record<string, unknown> = { ...doc, status: "queued", body };
    // A request admitted late, or one that was waiting on the chief of staff's
    // question, is routed now, with the answer in front of it.
    if (opts.router !== undefined) {
      const r = await routeRequest(store, opts.router, { id: d.openItem, ...next } as unknown as RoutableDoc, opts.now);
      if (r !== null) {
        routed.push(d.openItem);
        next = { ...r.item };
        if (r.question !== null) {
          const ref = (doc["source"] as { ref?: string | null } | undefined)?.ref ?? null;
          questions.push({ issue: ref, text: r.question });
        }
      }
    }
    changes.push({ path: workItemPath(d.openItem), content: json(next) });
    if (d.outcome === "admits_open_item" && opts.plan !== true) {
      const n = /^#(\d+)$/.exec(String((doc["source"] as { ref?: string | null } | undefined)?.ref ?? ""))?.[1];
      if (n !== undefined) {
        await opts.gh.send("DELETE", `repos/${opts.gh.repo}/issues/${n}/labels/${encodeURIComponent(AWAITING_LABEL)}`).catch(() => undefined);
        await opts.gh.send("POST", `repos/${opts.gh.repo}/issues/${n}/labels`, { labels: ["factory:queued"] }).catch(() => undefined);
      }
    }
    requeued.set(d.openItem, { status: String(next["status"]), pipeline: String(next["pipeline"] ?? doc["pipeline"]) });
  }

  for (const d of decisions) {
    if (d.workItem === null) continue;
    changes.push({ path: workItemPath(d.workItem.id), content: json(d.workItem) });
    newItems.push({
      id: d.workItem.id,
      priority: d.workItem.priority,
      pipeline: d.workItem.pipeline,
      created_at: d.workItem.created_at,
      fingerprint: d.workItem.fingerprint,
      status: d.workItem.status,
      source_ref: d.workItem.source.ref,
    });
  }

  // What a person corrected is kept on the run it corrected, which is where
  // scoring and the review read `human_corrections` from.
  changes.push(...(await correctionChanges(store, result.decisions)));
  // Say on the existing PR that the same thing was asked again, and on the
  // source PR that it is already covered.
  for (const d of result.decisions) {
    const a = d.alsoRequested;
    if (a === undefined || opts.plan === true) continue;
    if (a.pr !== null) {
      await opts.gh.send("POST", `repos/${opts.gh.repo}/issues/${a.pr}/comments`, { body: `Also requested: ${a.text}` }).catch(() => undefined);
    }
    await opts.gh
      .send("POST", `repos/${opts.gh.repo}/issues/${a.sourcePr}/comments`, {
        body: a.pr !== null ? `Already covered by #${a.pr}.` : "Already covered by work the factory has open.",
      })
      .catch(() => undefined);
  }

  if (newItems.length > 0 || requeued.size > 0 || result.cursor !== cursor) {
    const nextLedger = {
      ...ledger,
      updated_at: opts.now,
      open: [
        ...ledger.open.map((o) => {
          const p = requeued.get(o.work_item);
          return p === undefined ? o : { ...o, status: p.status, pipeline: p.pipeline };
        }),
        ...newItems
          .filter((i) => !ledger.open.some((o) => o.work_item === i.id))
          .map((i) => ({
            work_item: i.id,
            pipeline: i.pipeline,
            status: i.status,
            fingerprint: i.fingerprint,
            priority: i.priority,
            created_at: i.created_at,
            source_ref: i.source_ref,
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
      .filter((o) => (o.status === "queued" || requeued.get(o.work_item)?.status === "queued") && !newItems.some((i) => i.id === o.work_item))
      .map((o) => ({
        id: o.work_item,
        pipeline: requeued.get(o.work_item)?.pipeline ?? o.pipeline,
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
    { running: opts.runningRuns, maxRuns: opts.maxRuns, pausedPipelines: opts.pausedPipelines ?? [],
      ...(opts.setupFinished === undefined ? {} : { setupFinished: opts.setupFinished }) },
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

  // Say so on the issue, last: the request is already safe in the data ref,
  // so a comment that fails to post loses nothing.
  const acknowledged: number[] = [];
  if (opts.plan !== true) {
    for (const q of questions) {
      const n = /^#(\d+)$/.exec(q.issue ?? "")?.[1];
      if (n === undefined) continue;
      try {
        await opts.gh.send("POST", `repos/${opts.gh.repo}/issues/${n}/comments`, {
          body: `One question before I start: ${q.text}\n\nReply here and the factory picks the request up again. Nothing times out, so take as long as you need.`,
        });
      } catch {
        // The item is already waiting; a comment that fails to post loses nothing.
      }
    }
    for (const d of decisions) {
      const ack = acknowledgement(d, opts.policy.trust.accept_label);
      if (ack === null) continue;
      try {
        await opts.gh.send("POST", `repos/${opts.gh.repo}/issues/${ack.issue}/comments`, { body: ack.body });
        acknowledged.push(ack.issue);
      } catch {
        // A missing permission or a deleted issue must not fail intake.
      }
    }
  }

  return { result, dispatched, commit, decision, acknowledged, routed };
}

/* ------------------------------------------------------------- corrections */

/**
 * What a person pushed onto a factory branch, for the correction it becomes:
 * the commit messages and the files they touched.
 */
async function enrichPush(gh: GitHub, ev: IncomingEvent, payload: Payload): Promise<IncomingEvent> {
  const { before, after } = payload;
  if (before === undefined || after === undefined || /^0+$/.test(before)) return ev;
  try {
    const cmp = await gh.get<{ html_url?: string; commits?: { commit?: { message?: string } }[]; files?: { filename?: string }[] }>(
      `repos/${gh.repo}/compare/${before}...${after}`,
    );
    const messages = (cmp.commits ?? []).map((c) => (c.commit?.message ?? "").split("\n")[0]!.trim()).filter((m) => m !== "");
    const files = (cmp.files ?? []).map((f) => f.filename ?? "").filter((f) => f !== "");
    return {
      ...ev,
      ...(messages.length === 0 ? {} : { body: messages.join("; ") }),
      ...(files.length === 0 ? {} : { files }),
      ...(cmp.html_url === undefined ? {} : { url: cmp.html_url }),
    };
  } catch {
    // The push is still a correction; it just carries less to read.
    return ev;
  }
}

/** For each PR a pending event is about: the work item behind it, if the factory opened it. */
export async function prItemsFor(
  store: FactoryStore,
  ledger: { readonly open: readonly { work_item: string; pipeline: string; pr?: number | null }[]; readonly recent: readonly { work_item: string; pr?: number | null }[] },
  pending: readonly IncomingEvent[],
): Promise<Record<string, { work_item: string; pipeline: QueuedPipeline }>> {
  const out: Record<string, { work_item: string; pipeline: QueuedPipeline }> = {};
  for (const e of pending) {
    if (e.pr === undefined || out[String(e.pr)] !== undefined) continue;
    const open = ledger.open.find((o) => o.pr === e.pr);
    if (open !== undefined) {
      out[String(e.pr)] = { work_item: open.work_item, pipeline: open.pipeline as QueuedPipeline };
      continue;
    }
    const recent = ledger.recent.find((r) => r.pr === e.pr);
    if (recent === undefined) continue;
    const doc = await store.get<{ pipeline?: string }>(workItemPath(recent.work_item), "work-item").catch(() => null);
    if (doc?.pipeline !== undefined) out[String(e.pr)] = { work_item: recent.work_item, pipeline: doc.pipeline as QueuedPipeline };
  }
  return out;
}

/** Append each captured correction to the run whose PR it was said on. */
export async function correctionChanges(
  store: FactoryStore,
  decisions: readonly { readonly correction?: CorrectionRecord | undefined; readonly correctedItem?: string | undefined; readonly outcome: string }[],
): Promise<Change[]> {
  const byRun = new Map<string, { doc: Record<string, unknown>; added: CorrectionRecord[] }>();
  for (const d of decisions) {
    if (d.correction === undefined || d.correctedItem === undefined) continue;
    if (d.outcome !== "correction_captured" && d.outcome !== "context_for_open_item") continue;
    const item = await store.get<{ runs?: readonly string[] }>(workItemPath(d.correctedItem), "work-item").catch(() => null);
    const runId = item?.runs?.[item.runs.length - 1];
    if (runId === undefined) continue;
    let entry = byRun.get(runId);
    if (entry === undefined) {
      const doc = await store.get<Record<string, unknown>>(runPath(runId), "run").catch(() => null);
      if (doc === null) continue;
      entry = { doc, added: [] };
      byRun.set(runId, entry);
    }
    const c = d.correction;
    if (!entry.added.some((a) => a.at === c.at && a.by === c.by && a.text === c.text)) entry.added.push(c);
  }
  const changes: Change[] = [];
  for (const [runId, { doc, added }] of byRun) {
    const have = (doc["human_corrections"] as CorrectionRecord[] | undefined) ?? [];
    const fresh = added.filter((a) => !have.some((h) => h.at === a.at && h.by === a.by && h.text === a.text));
    if (fresh.length === 0) continue;
    changes.push({ path: runPath(runId), content: json({ ...doc, human_corrections: [...have, ...fresh] }) });
  }
  return changes;
}

/* ----------------------------------------------------------- missed issues */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The time a ULID-based id (wi_…) was made, in ms; null when it is not one. */
export function ulidTime(id: string): number | null {
  const u = id.replace(/^[a-z]+_/, "").slice(0, 10).toUpperCase();
  if (u.length !== 10) return null;
  let t = 0;
  for (const ch of u) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    t = t * 32 + v;
  }
  return t;
}

const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Open issues from the last day that no event, open item or recent work item
 * knows about: requests whose own intake run was dropped before it recorded
 * them.
 */
export async function missedIssues(
  gh: GitHub,
  store: FactoryStore,
  queued: readonly IncomingEvent[],
  ledger: { readonly open: readonly { readonly source_ref?: string | null }[] },
  now: string,
  trusted: readonly string[],
): Promise<IncomingEvent[]> {
  const since = Date.parse(now) - RECOVERY_WINDOW_MS;
  const issues = await gh.get<
    { number: number; title: string; body?: string | null; created_at: string; pull_request?: unknown; author_association?: string; user?: { login?: string; type?: string }; labels?: { name?: string }[] }[]
  >(`repos/${gh.repo}/issues?state=open&sort=created&direction=desc&per_page=50`);
  const recent = issues.filter((i) => i.pull_request === undefined && Date.parse(i.created_at) >= since);
  if (recent.length === 0) return [];

  const known = new Set<string>();
  for (const e of queued) if (e.ref !== undefined && e.ref !== null) known.add(e.ref);
  for (const o of ledger.open) if (o.source_ref != null) known.add(o.source_ref);
  for (const path of await store.data.list("work-items/")) {
    const t = ulidTime(path.slice("work-items/".length));
    if (t === null || t < since - 60_000) continue;
    const doc = await store.data.readJson<{ source?: { ref?: string | null } }>(path);
    const ref = doc?.source?.ref;
    if (typeof ref === "string") known.add(ref);
  }

  const out: IncomingEvent[] = [];
  for (const i of recent) {
    if (known.has(`#${i.number}`)) continue;
    // A bot's issue is never a request (intake ignores it), so it would come
    // back as "missed" on every run.
    if (i.user?.type === "Bot" || /\[bot\]$/.test(i.user?.login ?? "")) continue;
    const ev = normalizeEvent("issues", { action: "opened", issue: i, sender: i.user } as Payload, now);
    if (ev === null) continue;
    out.push({
      ...ev,
      id: ev.id + out.length,
      // The issue's own time, so its work item sorts where it was asked.
      at: i.created_at,
      actor_association: (await effectiveAssociation(gh, ev.actor, ev.actor_association ?? "NONE", trusted)) as typeof ev.actor_association,
    });
  }
  return out;
}


/** The comment id in a GitHub comment URL (`...#issuecomment-123`), or null. */
export function commentIdOf(url: string | undefined): number | null {
  const m = /(?:issuecomment-|#c|discussion_r)(\d+)/.exec(url ?? "");
  return m === null ? null : Number(m[1]);
}


/** An issue gh-aw filed about one of its own runs: labelled, titled or marked as one. */
export function isGhAwReport(issue: { title?: string | undefined; body?: string | null | undefined; labels?: readonly { name?: string | undefined }[] | undefined }): boolean {
  return (
    (issue.labels ?? []).some((l) => l.name === "agentic-workflows") ||
    (issue.title ?? "").startsWith("[aw] ") ||
    (issue.body ?? "").includes("gh-aw-agentic-workflow")
  );
}

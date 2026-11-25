import { createHash } from "node:crypto";
import type { Association, Pipeline, Policy, TriggerClass } from "../lib/types.js";
import { isTrustedActor } from "./policy.js";
import type { Routing } from "./chief-of-staff.js";
import { ASK_LABEL, extractGoal, TIDY_LABEL } from "./request-text.js";
import { classifyCorrection, recordOf, workItemBody, workItemTitle, type CorrectionKind, type CorrectionRecord } from "./corrections.js";

/**
 * `bsf intake` — turns every trigger into one standard work item.
 *
 * Routing only sees what the work is, not where it came from (doc 01). Intake
 * runs in a single concurrency group with `queue: max`, and each run processes
 * every event not yet processed, by cursor, so no request is lost even if a
 * pending run is dropped (doc 06).
 */

export type EventKind =
  | "issue_opened" | "issue_labeled" | "issue_comment" | "review_comment"
  | "ci_failure_on_main" | "dashboard_dispatch" | "schedule_gardening"
  | "review_routed" | "conflict_detected" | "correction"
  /** A review a person submitted on a PR: a change request, or a comment with a body. */
  | "pr_review"
  /** A person pushed a commit onto a factory branch. */
  | "human_push"
  /** `/practice …` from a trusted person: a standing instruction for every agent. */
  | "practice_declared"
  /** `/retry` from a trusted person: an escalated item goes back in the queue. */
  | "retry_requested";

export interface IncomingEvent {
  /** Monotonic per-repo event id. The cursor is the highest id processed. */
  readonly id: number;
  readonly kind: EventKind;
  readonly at: string;
  readonly actor: string;
  readonly actor_association: Association;
  readonly actor_is_bot?: boolean;
  readonly title?: string;
  readonly body?: string;
  /** `#142`, or a PR number for review comments. */
  readonly ref?: string;
  readonly labels?: readonly string[];
  readonly via?: "slack" | "linear" | "sentry";
  readonly from_fork?: boolean;
  /** Set for events that belong to an existing run, such as a review comment. */
  readonly pr?: number;
  readonly touched_area?: string;
  /** The work item a `/retry` names, when it names one (a dispatch has no issue to find it by). */
  readonly target_item?: string;
  /** For a label event: the label just added, and who added it. */
  readonly label_added?: string;
  readonly labeled_by?: string;
  /** For a `pr_review`: GitHub's state for it, `CHANGES_REQUESTED` or `COMMENTED`. */
  readonly review_state?: string;
  /** The comment, review or commit this event came from, so a hardening PR can link back to it. */
  readonly url?: string;
  /** For a `human_push`: the files the person changed. */
  readonly files?: readonly string[];
}

export interface WorkItemDraft {
  readonly schema: "work-item/1";
  readonly id: string;
  readonly created_at: string;
  readonly source: {
    readonly kind: string;
    readonly ref: string | null;
    readonly actor: string;
    readonly via: "slack" | "linear" | "sentry" | null;
  };
  readonly trigger_class: TriggerClass;
  readonly pipeline: Pipeline;
  readonly title: string;
  readonly body: string | null;
  readonly priority: "high" | "normal";
  readonly fingerprint: string;
  readonly status: "queued" | "waiting_trust" | "needs_info";
  readonly runs: readonly string[];
  readonly pr: number | null;
  readonly parent: string | null;
  readonly related: readonly string[];
  readonly spec: null;
  /** What should be true when this is done, as the person wrote it. Absent when they gave none. */
  readonly goal?: string;
  /** One concrete check that proves the goal, written by the chief of staff. */
  readonly success_check?: string;
  /** Who chose the pipeline, and why. */
  readonly routing?: Routing;
}

export interface IntakeDecision {
  readonly event: IncomingEvent;
  /** A new work item, or null when the event is a revision of an existing run. */
  readonly workItem: WorkItemDraft | null;
  readonly outcome:
    | "queued"
    | "waiting_trust"
    | "revision_of_existing_run"
    | "ignored_fork"
    | "ignored_trigger_disabled"
    | "ignored_untrusted_practice"
    /** A trusted person asked, in words, for a change to the factory's setup. Kept on the issue; no work item, no run. */
    | "settings_request"
    | "ignored_untrusted_ask"
    | "ignored_bot"
    | "context_for_open_item"
    | "answers_open_item"
    // A comment on an item whose conversation is being held open. Recorded,
    // and deliberately not dispatched: the held job answers it.
    | "conversation_in_progress"
    | "admits_open_item"
    | "retries_open_item"
    | "ignored_untrusted_retry"
    /** A person's correction on a factory PR became a hardening work item. */
    | "correction_captured"
    | "not_a_correction"
    | "ignored_untrusted_correction"
    | "ignored_not_factory_pr";
  readonly reason: string;
  /** For `correction_captured`: what to write on the run it corrects. */
  readonly correction?: CorrectionRecord;
  /** For `correction_captured` and a revision: the work item whose PR it was said on. */
  readonly correctedItem?: string;
  /** The open item an answer or an admission applies to. */
  readonly openItem?: string;
  /** Open items whose fingerprint is close enough to be worth triage's attention. */
  readonly duplicateShortlist: readonly string[];
}

export interface IntakeResult {
  readonly decisions: readonly IntakeDecision[];
  /** The highest event id processed. Persisted so the next run starts after it. */
  readonly cursor: number;
  readonly processed: number;
}

export interface LedgerOpenItem {
  readonly work_item: string;
  readonly fingerprint?: string;
  /** The issue or PR the item came from (`#N`), so a later comment there finds it. */
  readonly source_ref?: string | null;
  /** The item's PR, so a comment on the PR finds it too. */
  readonly pr?: number | null;
  readonly status: string;
  readonly pipeline: Pipeline;
}

export interface IntakeContext {
  readonly policy: Policy;
  readonly triggers: {
    readonly issues: boolean;
    readonly comments: boolean;
    readonly ci_failure_on_main: boolean;
    readonly dashboard_dispatch: boolean;
  };
  /** Highest event id already processed. Events at or below it are skipped. */
  readonly cursor: number;
  readonly openItems: readonly LedgerOpenItem[];
  /**
   * Work items with a conversation already being held open.
   *
   * A held job is blocked on `bsf brainstorm wait` and will pick the next
   * comment up itself, within seconds. Requeuing the item as well would start
   * a second conversation that asks the person the same question again — the
   * one way this can go visibly wrong for them. Absent, nothing is held and
   * intake behaves as it always did.
   */
  readonly liveConversations?: readonly string[];
  /** Items merged recently, for the follow-up rule. */
  readonly recentlyMerged?: readonly { readonly work_item: string; readonly fingerprint?: string; readonly pr?: number }[];
  /**
   * The factory PRs people are speaking on, by PR number: whose work item
   * made each, and in which pipeline. Present when intake could look, and then
   * it decides what a comment on a PR is; absent, a comment on a PR is only a
   * revision of that PR, as before.
   */
  readonly prItems?: Readonly<Record<string, { readonly work_item: string; readonly pipeline: Pipeline }>>;
  /** Injected so ids are deterministic in tests. */
  readonly newId: (event: IncomingEvent) => string;
}

/** Trigger -> pipeline (doc 06). Routing never looks at where the work came from. */
const ROUTE: Readonly<Record<EventKind, { pipeline: Pipeline; cls: TriggerClass; priority?: "high" }>> = {
  issue_opened: { pipeline: "product_work", cls: "request" },
  issue_labeled: { pipeline: "product_work", cls: "request" },
  issue_comment: { pipeline: "product_work", cls: "request" },
  dashboard_dispatch: { pipeline: "product_work", cls: "request" },
  ci_failure_on_main: { pipeline: "product_work", cls: "dev_event", priority: "high" },
  review_comment: { pipeline: "product_work", cls: "dev_event" },
  pr_review: { pipeline: "hardening", cls: "self" },
  human_push: { pipeline: "hardening", cls: "self" },
  correction: { pipeline: "hardening", cls: "self" },
  // A practice changes what every agent reads, which is the definition.
  practice_declared: { pipeline: "definition", cls: "request" },
  retry_requested: { pipeline: "product_work", cls: "request" },
  schedule_gardening: { pipeline: "gardening", cls: "scheduled" },
  review_routed: { pipeline: "hardening", cls: "self" },
  conflict_detected: { pipeline: "conflict", cls: "dev_event" },
};

/**
 * The fingerprint shortlists possible duplicates; triage decides (doc 02).
 * Normalizing hard is deliberate: a reworded duplicate should still collide,
 * because the cost of a wrong shortlist is one triage comparison.
 */
export function fingerprint(input: {
  title?: string | undefined;
  body?: string | undefined;
  area?: string | undefined;
}): string {
  const text = `${input.title ?? ""} ${input.body ?? ""}`;
  const normalized = text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .sort()
    .join(" ");
  const h = createHash("sha256");
  h.update(normalized);
  h.update("\u0000");
  h.update(input.area ?? "");
  return `sha256:${h.digest("hex")}`;
}

const STOP = new Set([
  "the", "and", "for", "that", "this", "with", "from", "when", "then", "than",
  "but", "not", "are", "was", "were", "has", "have", "had", "its", "it's",
  "you", "your", "our", "can", "cant", "wont", "does", "doesnt", "did",
  "should", "would", "could", "there", "their", "they", "what", "which",
]);

/** Untrusted text never reaches a prompt (doc 06). */
export function stripUntrustedText(
  body: string | undefined,
  trusted: boolean,
): { readonly body: string | null; readonly stripped: boolean } {
  if (body === undefined || body === "") return { body: null, stripped: false };
  if (trusted) return { body, stripped: false };
  return { body: null, stripped: true };
}

export function runIntake(events: readonly IncomingEvent[], ctx: IntakeContext): IntakeResult {
  const decisions: IntakeDecision[] = [];
  // Every intake run processes every event not yet processed, not only the one
  // that started it, so a dropped pending run loses nothing.
  const pending = events.filter((e) => e.id > ctx.cursor).slice().sort((a, b) => a.id - b.id);

  let cursor = ctx.cursor;
  for (const event of pending) {
    decisions.push(decide(event, ctx));
    cursor = Math.max(cursor, event.id);
  }

  return { decisions, cursor, processed: pending.length };
}

function triggerEnabled(ctx: IntakeContext, kind: EventKind): boolean {
  switch (kind) {
    case "issue_opened":
    case "issue_labeled":
      return ctx.triggers.issues;
    case "issue_comment":
    case "review_comment":
    case "pr_review":
      return ctx.triggers.comments;
    case "ci_failure_on_main":
      return ctx.triggers.ci_failure_on_main;
    case "dashboard_dispatch":
      return ctx.triggers.dashboard_dispatch;
    default:
      return true;
  }
}

/**
 * How much to trust whoever added a label. Only people with triage access can
 * label someone else's issue, so a different labeler counts as a maintainer.
 * But an issue form applies its own labels (the "Harden this" form adds
 * factory:harden) and GitHub reports the issue's author as the one who added
 * them, so an outsider using the form would look like a maintainer. When the
 * labeler is the author, the author's own association decides.
 */
function labelerAssociation(e: IncomingEvent): IncomingEvent["actor_association"] {
  return e.labeled_by !== undefined && e.labeled_by === e.actor ? e.actor_association : "MEMBER";
}

function decide(incoming: IncomingEvent, ctx: IntakeContext): IntakeDecision {
  // The harden label asks for hardening at once (doc 06): the issue it is put
  // on describes a mistake to turn into a rule. Only people with triage access
  // or more can label, so whoever added it is the trusted actor.
  const hardenLabel = ctx.policy.trust.harden_label ?? "factory:harden";
  const event: IncomingEvent =
    incoming.kind === "issue_labeled" && incoming.label_added === hardenLabel
      ? { ...incoming, kind: "correction", actor: incoming.labeled_by ?? incoming.actor, actor_association: labelerAssociation(incoming), actor_is_bot: false }
      : // Opened with the label already on it: hardening only, not product
        // work as well. The author could label it, so they have triage access.
        incoming.kind === "issue_opened" && (incoming.labels ?? []).includes(hardenLabel)
        ? { ...incoming, kind: "correction" }
        : incoming;
  // A request made with the tidy form arrives already labelled: it is
  // gardening work a person asked for, not a bug or a feature.
  const tidy = event.kind === "issue_opened" && (event.labels ?? []).includes(TIDY_LABEL);
  const route: { pipeline: Pipeline; cls: TriggerClass; priority?: "high" } = tidy
    ? { pipeline: "gardening", cls: "request" }
    : ROUTE[event.kind];

  if (event.from_fork === true) {
    return { event, workItem: null, outcome: "ignored_fork", reason: "fork events never start agent work", duplicateShortlist: [] };
  }

  if (!triggerEnabled(ctx, event.kind)) {
    return { event, workItem: null, outcome: "ignored_trigger_disabled", reason: `the ${event.kind} trigger is off`, duplicateShortlist: [] };
  }

  // A review comment on a factory PR is a revision of that PR's run, not a new item.
  if (event.kind === "review_comment" && event.pr !== undefined && ctx.prItems === undefined) {
    return {
      event, workItem: null, outcome: "revision_of_existing_run",
      reason: `review comment on PR #${event.pr} goes back to that PR's run as a revision`,
      duplicateShortlist: [],
    };
  }

  const machineOrigin = event.kind === "schedule_gardening" || event.kind === "review_routed" || event.kind === "conflict_detected";

  // A bot's event is never a request, unless the bot is an integration the
  // policy names as relaying people's requests (Linear, Sentry). Without this
  // every comment the factory itself posts — a triage question, an
  // escalation — came back in as a work item waiting for trust.
  const relay = (ctx.policy.trust.integration_bots ?? []).includes(event.actor);
  if (!machineOrigin && !relay && event.kind !== "dashboard_dispatch" && (event.actor_is_bot === true || /\[bot\]$/.test(event.actor))) {
    return { event, workItem: null, outcome: "ignored_bot", reason: `${event.actor} is a bot`, duplicateShortlist: [] };
  }

  const trusted =
    machineOrigin ||
    isTrustedActor(ctx.policy, event.actor, event.actor_association, { isBot: event.actor_is_bot === true });

  // A practice is an instruction every agent will follow from then on, so it
  // is never queued for a maintainer to wave through: from anyone else it is
  // ignored outright. Waiting on trust would leave an outsider's instruction
  // one label away from every prompt.
  if (event.kind === "practice_declared" && !trusted) {
    return {
      event, workItem: null, outcome: "ignored_untrusted_practice",
      reason: `${event.actor} is not trusted to set practices; only maintainers can`,
      duplicateShortlist: [],
    };
  }

  // A request to change how the factory is set up is not product work, and an
  // agent must not try it: it stays on its issue until the setup skill makes
  // the change as a pull request. Only a trusted person's counts.
  const asks =
    (incoming.kind === "issue_opened" && (incoming.labels ?? []).includes(ASK_LABEL)) ||
    (incoming.kind === "issue_labeled" && incoming.label_added === ASK_LABEL);
  if (asks) {
    const by = incoming.kind === "issue_labeled" ? (incoming.labeled_by ?? incoming.actor) : incoming.actor;
    const asker = incoming.kind === "issue_labeled" ? labelerAssociation(incoming) : incoming.actor_association;
    return isTrustedActor(ctx.policy, by, asker, { isBot: incoming.actor_is_bot === true })
      ? { event, workItem: null, outcome: "settings_request", reason: `${by} asked for a change to the factory's setup`, duplicateShortlist: [] }
      : { event, workItem: null, outcome: "ignored_untrusted_ask", reason: `${by} is not trusted to change the factory's setup`, duplicateShortlist: [] };
  }

  if (event.pr !== undefined && ctx.prItems !== undefined && (event.kind === "review_comment" || event.kind === "pr_review" || event.kind === "human_push")) {
    return decidePrCorrection(event, ctx, trusted);
  }

  const accepted = (event.labels ?? []).includes(ctx.policy.trust.accept_label);

  // `/retry` hands an item that stopped back to the factory. Only a trusted
  // person can, and only an item that stopped: escalated, or waiting on a
  // question. It never creates an item.
  if (event.kind === "retry_requested") {
    if (!trusted) {
      return { event, workItem: null, outcome: "ignored_untrusted_retry", reason: `${event.actor} is not trusted to retry work`, duplicateShortlist: [] };
    }
    const prNum = /^#(\d+)$/.exec(event.ref ?? "")?.[1];
    const open = ctx.openItems.find(
      (o) =>
        (event.target_item !== undefined && o.work_item === event.target_item) ||
        (event.ref != null && o.source_ref === event.ref) ||
        (prNum !== undefined && o.pr === Number(prNum)),
    );
    if (open === undefined) {
      return { event, workItem: null, outcome: "context_for_open_item", reason: "/retry names no open work item", duplicateShortlist: [] };
    }
    if (open.status !== "escalated" && open.status !== "needs_info") {
      return {
        event, workItem: null, outcome: "context_for_open_item", openItem: open.work_item,
        reason: `${open.work_item} is ${open.status}, not stopped, so there is nothing to retry`,
        duplicateShortlist: [],
      };
    }
    return {
      event, workItem: null, outcome: "retries_open_item", openItem: open.work_item,
      reason: `${event.actor} asked to retry ${open.work_item}`,
      duplicateShortlist: [],
    };
  }

  // A comment or label on an issue that already has an open item belongs to
  // that item. It answers a question triage asked, admits an item that was
  // waiting for trust, or is conversation — never a second item for the
  // same request.
  if ((event.kind === "issue_comment" || event.kind === "issue_labeled" || event.kind === "issue_opened") && event.ref != null) {
    const open = ctx.openItems.find((o) => o.source_ref === event.ref);
    if (open !== undefined) {
      if (event.kind === "issue_comment" && open.status === "needs_info" && trusted) {
        // Somebody is already listening. The held job sees this comment on its
        // next poll, a second or two from now, and answers it in the session
        // that asked the question — so it knows what the first three answers
        // settled. Starting a run here would ask them the same thing twice.
        if ((ctx.liveConversations ?? []).includes(open.work_item)) {
          return {
            event, workItem: null, outcome: "conversation_in_progress", openItem: open.work_item,
            reason: `a conversation is open on ${open.work_item} and will pick this up itself`,
            duplicateShortlist: [],
          };
        }
        return {
          event, workItem: null, outcome: "answers_open_item", openItem: open.work_item,
          reason: `${event.actor} answered the question on ${open.work_item}, so it goes back in the queue`,
          duplicateShortlist: [],
        };
      }
      if (event.kind === "issue_labeled" && open.status === "waiting_trust" && accepted) {
        return {
          event, workItem: null, outcome: "admits_open_item", openItem: open.work_item,
          reason: `${ctx.policy.trust.accept_label} admits ${open.work_item}`,
          duplicateShortlist: [],
        };
      }
      return {
        event, workItem: null, outcome: "context_for_open_item", openItem: open.work_item,
        reason: `${event.ref} already has ${open.work_item} (${open.status})`,
        duplicateShortlist: [],
      };
    }
  }

  const fp = fingerprint({ title: event.title, body: event.body, area: event.touched_area });
  const shortlist = shortlistDuplicates(fp, ctx);

  const { body } = stripUntrustedText(event.body, trusted || accepted);

  const priority: "high" | "normal" =
    route.priority === "high" ? "high" : isFollowUpToMerged(fp, ctx) ? "high" : "normal";

  const related = relatedMerged(fp, ctx);

  // The goal is read from the author's own words, so it is kept only from
  // someone whose text the factory reads at all.
  const goal = trusted || accepted ? extractGoal(event.body) : null;

  const item: WorkItemDraft = {
    schema: "work-item/1",
    id: ctx.newId(event),
    created_at: event.at,
    source: {
      kind: sourceKind(event.kind),
      ref: event.ref ?? null,
      actor: event.actor,
      via: event.via ?? null,
    },
    trigger_class: route.cls,
    pipeline: route.pipeline,
    title: event.title ?? defaultTitle(event.kind),
    body,
    priority,
    fingerprint: fp,
    status: trusted || accepted ? "queued" : "waiting_trust",
    runs: [],
    pr: event.pr ?? null,
    parent: null,
    related,
    spec: null,
    ...(goal === null ? {} : { goal }),
  };

  if (!trusted && !accepted) {
    return {
      event, workItem: item, outcome: "waiting_trust",
      reason:
        `${event.actor} is not a trusted person, so nothing starts until a trusted person adds ` +
        `${ctx.policy.trust.accept_label}. Its text is stripped from prompts until then.`,
      duplicateShortlist: shortlist,
    };
  }

  return {
    event, workItem: item, outcome: "queued",
    reason: accepted && !trusted ? `admitted by ${ctx.policy.trust.accept_label}` : "trusted person",
    duplicateShortlist: shortlist,
  };
}

/**
 * What a person's words or push on a factory PR are.
 *
 * Every correction becomes a hardening work item, without a label and without
 * waiting for a repeat. Three things keep that from running away. A comment on
 * a hardening or definition PR is a review of that change, so it never raises
 * another correction (a comment on a rule would otherwise start another rule,
 * without end). Only trusted people's words count, because a correction goes
 * to an agent. And a correction that matches one already open folds into it.
 */
function decidePrCorrection(event: IncomingEvent, ctx: IntakeContext, trusted: boolean): IntakeDecision {
  const pr = event.pr!;
  const target = ctx.prItems?.[String(pr)];
  if (target === undefined) {
    return {
      event, workItem: null, outcome: event.kind === "review_comment" ? "revision_of_existing_run" : "ignored_not_factory_pr",
      reason: `PR #${pr} is not one the factory opened, so nothing there is a correction of it`,
      duplicateShortlist: [],
    };
  }
  if (target.pipeline === "hardening" || target.pipeline === "definition") {
    return {
      event, workItem: null, outcome: "revision_of_existing_run", correctedItem: target.work_item,
      reason: `PR #${pr} is a ${target.pipeline} change, so what a person says there reviews it and does not raise a new correction`,
      duplicateShortlist: [],
    };
  }
  if (!trusted) {
    return {
      event, workItem: null, outcome: "ignored_untrusted_correction", correctedItem: target.work_item,
      reason: `${event.actor} is not trusted, and a correction goes to an agent`,
      duplicateShortlist: [],
    };
  }

  const kind: CorrectionKind =
    event.kind === "human_push" ? "human_push" : event.kind === "pr_review" && event.review_state === "CHANGES_REQUESTED" ? "change_request" : "review_comment";
  const text = event.kind === "human_push" ? pushText(event) : (event.body ?? "");
  const verdict = classifyCorrection(text, kind);
  if (!verdict.correction) {
    return {
      event, workItem: null, outcome: event.kind === "review_comment" ? "revision_of_existing_run" : "not_a_correction",
      correctedItem: target.work_item,
      reason: `not a correction: ${verdict.why}`,
      duplicateShortlist: [],
    };
  }

  const record = recordOf({ at: event.at, by: event.actor, kind, text, ...(event.url === undefined ? {} : { url: event.url }) });
  const title = workItemTitle(record, pr);
  const body = workItemBody(record, { pr, parent: target.work_item });
  const fp = fingerprint({ title: record.text, body: "", area: event.touched_area });
  const folded = ctx.openItems.find((o) => o.pipeline === "hardening" && o.fingerprint === fp);
  if (folded !== undefined) {
    return {
      event, workItem: null, outcome: "context_for_open_item", openItem: folded.work_item, correction: record, correctedItem: target.work_item,
      reason: `${folded.work_item} is already hardening against this same correction`,
      duplicateShortlist: [],
    };
  }

  const item: WorkItemDraft = {
    schema: "work-item/1",
    id: ctx.newId(event),
    created_at: event.at,
    source: { kind: "correction", ref: `#${pr}`, actor: event.actor, via: null },
    trigger_class: "self",
    pipeline: "hardening",
    title,
    body,
    priority: "normal",
    fingerprint: fp,
    status: "queued",
    runs: [],
    // Not the corrected PR: this item's own PR, once it opens one, is what
    // a later comment is judged against. The PR it answers is in `source.ref`.
    pr: null,
    parent: target.work_item,
    related: [target.work_item],
    spec: null,
  };
  return {
    event, workItem: item, outcome: "correction_captured", correction: record, correctedItem: target.work_item,
    reason: `${event.actor}'s ${kind.replace(/_/g, " ")} on #${pr} corrects ${target.work_item}, so it goes to hardening`,
    duplicateShortlist: shortlistDuplicates(fp, ctx),
  };
}

function pushText(event: IncomingEvent): string {
  const files = event.files ?? [];
  const head = (event.body ?? "").trim();
  const shown = files.slice(0, 12).join(", ");
  const more = files.length > 12 ? ` and ${files.length - 12} more` : "";
  return `${head === "" ? "A person pushed a commit to the branch." : head}${files.length === 0 ? "" : `\nFiles changed: ${shown}${more}`}`;
}

/**
 * The `source.kind` the work-item schema allows, for each event kind the
 * factory routes on. Two vocabularies exist because one names the trigger and
 * the other names the origin; exported so every writer uses this mapping
 * rather than inventing a third.
 */
export function sourceKind(kind: EventKind): string {
  switch (kind) {
    case "issue_opened":
    case "issue_labeled": return "issue";
    case "issue_comment": return "issue_comment";
    case "review_comment": return "review_comment";
    case "ci_failure_on_main": return "ci_failure";
    case "dashboard_dispatch": return "dashboard";
    case "schedule_gardening": return "schedule";
    case "review_routed": return "review";
    case "conflict_detected": return "conflict";
    case "correction": return "correction";
    case "pr_review":
    case "human_push": return "correction";
    case "practice_declared": return "practice";
    case "retry_requested": return "dashboard";
  }
}

function defaultTitle(kind: EventKind): string {
  switch (kind) {
    case "schedule_gardening": return "Nightly gardening";
    case "ci_failure_on_main": return "CI is failing on main";
    case "conflict_detected": return "Resolve conflict on a factory PR";
    default: return "Untitled work item";
  }
}

function shortlistDuplicates(fp: string, ctx: IntakeContext): string[] {
  return ctx.openItems.filter((i) => i.fingerprint === fp).map((i) => i.work_item);
}

/**
 * A match with recently merged work is never a duplicate: a "still broken"
 * report becomes a high-priority follow-up linked to the earlier PR (doc 02).
 */
function isFollowUpToMerged(fp: string, ctx: IntakeContext): boolean {
  return (ctx.recentlyMerged ?? []).some((m) => m.fingerprint === fp);
}

function relatedMerged(fp: string, ctx: IntakeContext): string[] {
  return (ctx.recentlyMerged ?? []).filter((m) => m.fingerprint === fp).map((m) => m.work_item);
}

/* ----------------------------------------------------------------- dispatch */

export interface DispatchDecision {
  readonly dispatch: readonly string[];
  readonly stayQueued: readonly string[];
  readonly reason: string;
}

export interface QueuedItem {
  readonly work_item: string;
  readonly pipeline: Pipeline;
  readonly priority: "high" | "normal";
  readonly created_at: string;
}

/**
 * Dispatch while a concurrency slot is free: high priority first, then oldest
 * first. A pipeline whose budget share is used stays queued (doc 06).
 */
export function chooseDispatches(
  queued: readonly QueuedItem[],
  opts: {
    readonly maxRuns: number;
    readonly running: number;
    readonly pausedPipelines: readonly Pipeline[];
    /**
     * False until setup's PR has merged. Nothing can be built before then
     * (there is no sandbox), so every item waits rather than starting a run
     * that dies at the sandbox step and is dispatched again.
     */
    readonly setupFinished?: boolean;
  },
): DispatchDecision {
  if (opts.setupFinished === false) {
    return {
      dispatch: [],
      stayQueued: queued.map((q) => q.work_item),
      reason: "setup has not finished: work waits until the setup PR merges",
    };
  }
  const slots = Math.max(0, opts.maxRuns - opts.running);
  const paused = new Set(opts.pausedPipelines);

  const eligible = queued
    .filter((q) => !paused.has(q.pipeline))
    .slice()
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
      return a.created_at.localeCompare(b.created_at);
    });

  const dispatch = eligible.slice(0, slots).map((q) => q.work_item);
  const dispatched = new Set(dispatch);
  const stayQueued = queued.map((q) => q.work_item).filter((id) => !dispatched.has(id));

  return {
    dispatch,
    stayQueued,
    reason:
      slots === 0
        ? `no slots free (${opts.running}/${opts.maxRuns} running)`
        : `${slots} slot(s) free; dispatched ${dispatch.length}`,
  };
}

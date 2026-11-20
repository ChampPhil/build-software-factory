import { createHash } from "node:crypto";
import type { Association, Pipeline, Policy, TriggerClass } from "../lib/types.js";
import { isTrustedActor } from "./policy.js";

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
  /** `/practice …` from a trusted person: a standing instruction for every agent. */
  | "practice_declared";

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
  readonly status: "queued" | "waiting_trust";
  readonly runs: readonly string[];
  readonly pr: number | null;
  readonly parent: string | null;
  readonly related: readonly string[];
  readonly spec: null;
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
    | "ignored_bot"
    | "context_for_open_item"
    | "answers_open_item"
    | "admits_open_item";
  readonly reason: string;
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
  /** Items merged recently, for the follow-up rule. */
  readonly recentlyMerged?: readonly { readonly work_item: string; readonly fingerprint?: string; readonly pr?: number }[];
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
  correction: { pipeline: "hardening", cls: "self" },
  // A practice changes what every agent reads, which is the definition.
  practice_declared: { pipeline: "definition", cls: "request" },
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
      return ctx.triggers.comments;
    case "ci_failure_on_main":
      return ctx.triggers.ci_failure_on_main;
    case "dashboard_dispatch":
      return ctx.triggers.dashboard_dispatch;
    default:
      return true;
  }
}

function decide(event: IncomingEvent, ctx: IntakeContext): IntakeDecision {
  const route = ROUTE[event.kind];

  if (event.from_fork === true) {
    return { event, workItem: null, outcome: "ignored_fork", reason: "fork events never start agent work", duplicateShortlist: [] };
  }

  if (!triggerEnabled(ctx, event.kind)) {
    return { event, workItem: null, outcome: "ignored_trigger_disabled", reason: `the ${event.kind} trigger is off`, duplicateShortlist: [] };
  }

  // A review comment on a factory PR is a revision of that PR's run, not a new item.
  if (event.kind === "review_comment" && event.pr !== undefined) {
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

  const accepted = (event.labels ?? []).includes(ctx.policy.trust.accept_label);

  // A comment or label on an issue that already has an open item belongs to
  // that item. It answers a question triage asked, admits an item that was
  // waiting for trust, or is conversation — never a second item for the
  // same request.
  if ((event.kind === "issue_comment" || event.kind === "issue_labeled" || event.kind === "issue_opened") && event.ref != null) {
    const open = ctx.openItems.find((o) => o.source_ref === event.ref);
    if (open !== undefined) {
      if (event.kind === "issue_comment" && open.status === "needs_info" && trusted) {
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
    case "practice_declared": return "practice";
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
  },
): DispatchDecision {
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

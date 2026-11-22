import { createHash } from "node:crypto";
import { FactoryStore, LEDGER, json, workItemPath } from "../lib/store.js";
import { activeGoals, addGoal, parseFocus, parseGoalText, readGoals, removeGoal, writeGoals, LANES, type Lane } from "./standing-goals.js";
import { patchFor, route, routable, tableRouting, ROUTABLE, type Complete, type Routing } from "./chief-of-staff.js";

/**
 * What people ask of the router and the standing goals, and the router's own
 * run over new requests. Everything here is a decision on the data ref; none of
 * it touches the repo, so none of it needs a pull request.
 */

interface DispatchPayload {
  readonly inputs?: Record<string, string>;
  readonly sender?: { login?: string };
}

export type Control =
  | { readonly kind: "goal_add"; readonly text: string; readonly lane: Lane | null; readonly by: string }
  | { readonly kind: "goal_remove"; readonly id: string; readonly by: string }
  | { readonly kind: "route_override"; readonly item: string; readonly to: string; readonly by: string };

/** The dashboard's three direct controls, sent as `kind=` on a dispatch. Only someone with write access can dispatch. */
export function controlDispatch(eventName: string, payload: DispatchPayload): Control | null {
  if (eventName !== "workflow_dispatch") return null;
  const kind = payload.inputs?.["kind"];
  const title = (payload.inputs?.["title"] ?? "").trim();
  const body = (payload.inputs?.["body"] ?? "").trim();
  const by = payload.sender?.login ?? "unknown";
  if (title === "") return null;
  if (kind === "standing_goal_add") {
    const g = parseGoalText(title, body === "" ? null : body);
    return g === null ? null : { kind: "goal_add", text: g.text, lane: g.lane, by };
  }
  if (kind === "standing_goal_remove") return { kind: "goal_remove", id: title, by };
  if (kind === "route_override") return { kind: "route_override", item: title, to: body, by };
  return null;
}

/** A `/focus` comment, with who said it and where. */
export function focusComment(
  eventName: string,
  payload: {
    action?: string;
    issue?: { number?: number; pull_request?: unknown };
    comment?: { body?: string | null; user?: { login?: string; type?: string }; author_association?: string };
  },
): { text: string; lane: Lane | null; actor: string; association: string; isBot: boolean; number: number | null } | null {
  if ((eventName !== "issue_comment" && eventName !== "pull_request_review_comment") || payload.action !== "created") return null;
  const f = parseFocus(payload.comment?.body);
  if (f === null) return null;
  return {
    ...f,
    actor: payload.comment?.user?.login ?? "unknown",
    association: payload.comment?.author_association ?? "NONE",
    isBot: payload.comment?.user?.type === "Bot",
    number: payload.issue?.number ?? null,
  };
}

const CHANGEABLE = new Set(["queued", "needs_info", "waiting_trust", "escalated"]);

export interface ControlResult {
  readonly done: boolean;
  readonly note: string;
}

export async function applyControl(store: FactoryStore, c: Control, now: string): Promise<ControlResult> {
  if (c.kind === "goal_add") {
    const id = `goal_${createHash("sha256").update(`${c.text}${now}`).digest("hex").slice(0, 10)}`;
    await writeGoals(store, (cur) => addGoal(cur, { text: c.text, lane: c.lane, by: c.by, at: now, until: null }, id), `goals: add ${id}`);
    return { done: true, note: `standing goal ${id} recorded` };
  }
  if (c.kind === "goal_remove") {
    await writeGoals(store, (cur) => removeGoal(cur, c.id), `goals: remove ${c.id}`);
    return { done: true, note: `standing goal ${c.id} removed` };
  }

  if (!(ROUTABLE as readonly string[]).includes(c.to)) return { done: false, note: `${c.to} is not a pipeline a request can be moved to` };
  const doc = await store.get<Record<string, unknown> & { pipeline: string; status: string; routing?: Routing }>(workItemPath(c.item), "work-item");
  if (doc === null) return { done: false, note: `${c.item} is not on the data ref` };
  if (!CHANGEABLE.has(doc.status)) return { done: false, note: `${c.item} is ${doc.status}; a route can only change before work starts or after it stops` };
  if (doc.pipeline === c.to) return { done: false, note: `${c.item} is already ${c.to}` };

  const overrides = [...(doc.routing?.overrides ?? []), { at: now, by: c.by, from: doc.pipeline, to: c.to }];
  const routing: Routing = { by: "person", reason: `${c.by} moved it from ${doc.pipeline} to ${c.to}`, at: now, from: doc.pipeline, overrides };
  const ledger = await store.ledger(now);
  await store.put(
    [
      { path: workItemPath(c.item), content: json({ ...doc, pipeline: c.to, routing }) },
      { path: LEDGER, content: json({ ...ledger, updated_at: now, open: ledger.open.map((o) => (o.work_item === c.item ? { ...o, pipeline: c.to } : o)) }) },
    ],
    `route: ${c.by} moved ${c.item} to ${c.to}`,
  );
  return { done: true, note: `${c.item} moved to ${c.to}` };
}

/** What the router needs from outside: a model, a place to read context, and a way to pay. */
export interface Router {
  readonly complete: Complete;
  readonly model: string;
  readonly context: () => Promise<{ readonly featureMap: string; readonly history: string }>;
  readonly charge?: (usd: number, key: string) => Promise<void>;
}

export interface RoutableDoc {
  readonly title: string;
  readonly body: string | null;
  readonly pipeline: string;
  readonly priority: "high" | "normal";
  readonly trigger_class: string;
  readonly status: string;
  readonly goal?: string;
  readonly routing?: Routing;
  readonly id: string;
}

export interface Routed<T> {
  readonly item: T & { success_check?: string; routing?: Routing };
  /** Set when the request was too vague: the factory asks this before anything runs. */
  readonly question: string | null;
}

/** Route one request, or leave it where the table put it. Never throws and never blocks the work. */
export async function routeRequest<T extends RoutableDoc>(store: FactoryStore, router: Router, item: T, now: string): Promise<Routed<T> | null> {
  if (!routable(item)) return null;
  // One question is all it gets: a request already waiting on an answer is decided, not asked about again.
  const mayAsk = item.routing?.pending !== true;
  const goals = activeGoals(await readGoals(store).catch(() => null), now, undefined);
  const ctx = await router.context().catch(() => ({ featureMap: "", history: "" }));
  const out = await route(
    {
      title: item.title,
      body: item.body,
      tablePipeline: item.pipeline as "product_work",
      featureMap: ctx.featureMap,
      history: ctx.history,
      goals,
      mayAsk,
    },
    router.complete,
    router.model,
  );
  if (out.costUsd !== null && router.charge !== undefined) await router.charge(out.costUsd, `route-${item.id}-${mayAsk ? 1 : 2}`).catch(() => undefined);
  if (out.decision === null) {
    // The table's route stands, and the item is not left half-decided.
    return { item: { ...item, routing: tableRouting(out.skipped ?? "the chief of staff did not answer", now) }, question: null };
  }
  const patch = patchFor(item, out.decision, now);
  const question = out.decision.question;
  return {
    item: { ...item, ...patch, ...(question === null ? {} : { status: "needs_info" }) },
    question,
  };
}

export { LANES };

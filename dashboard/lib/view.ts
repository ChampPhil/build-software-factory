import type { LedgerFile, LedgerOpenItem, Pipeline, WorkItemDoc, CandidatesFile, RunFile } from "./types";
import type { IssueSummary, PullSummary } from "./github";

/**
 * The words the dashboard uses for the factory's states, and the few
 * derivations every page needs: which things are waiting on a person, and
 * what a "request" is when its parts live in four different places (the
 * ledger, the work item file, the issue and the pull request).
 *
 * All of it is plain data in, plain data out, so it is tested without a
 * browser and every page says the same thing about the same state.
 */

export const PIPE: Readonly<Record<string, string>> = {
  product_work: "Product work",
  gardening: "Gardening",
  hardening: "Hardening",
  definition: "Practices",
  conflict: "Conflict fix",
};
export const pipeName = (p: string | null | undefined): string => (p == null ? "Unknown" : (PIPE[p] ?? p.replace(/_/g, " ")));

export const STATUS: Readonly<Record<string, string>> = {
  queued: "Queued",
  running: "Running",
  in_review: "In review",
  in_review_ready: "Ready to merge",
  in_review_blocked: "In review",
  queued_to_merge: "Merging itself",
  merged: "Merged",
  escalated: "Stuck, needs you",
  duplicate: "Duplicate",
  rejected: "Turned down",
  waiting_trust: "Waiting for your OK",
  needs_info: "Question for you",
  closed: "Closed",
};
export const statusName = (s: string): string => STATUS[s] ?? s.replace(/_/g, " ");

/** The checks a pull request needs before it is ready to merge. */
export const REQUIRED_CHECKS: readonly string[] = ["factory/gates", "factory/verification"];

export interface CheckLike {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/**
 * The one place that decides what an in-review pull request is called.
 * "Ready to merge" only when it is not a draft and both required checks
 * succeeded; otherwise it names the check it is waiting on.
 */
export function statusLabel(
  item: { readonly status: string },
  pull: { readonly draft: boolean } | null | undefined,
  checks: readonly CheckLike[] | null | undefined,
): string {
  if (item.status !== "in_review") return statusName(item.status);
  if (pull == null || checks == null) return "In review";
  if (pull.draft) return "In review: still a draft";
  for (const name of REQUIRED_CHECKS) {
    const c = checks.find((x) => x.name === name);
    if (c === undefined) return `In review: waiting on ${name}`;
    if (c.status !== "completed") return `In review: waiting on ${name}`;
    if (c.conclusion !== "success") return `In review: waiting on ${name} (${(c.conclusion ?? "no result").replace(/_/g, " ")})`;
  }
  return "Ready to merge";
}

/**
 * An issue the workflow tooling (gh-aw) files about its own failures. It is
 * the factory's health, not a request: it must not appear among requests or
 * questions, and a person must never be offered "Let the factory start it".
 */
export function isGhAwIssue(i: { readonly title: string; readonly labels: readonly { readonly name: string }[] }): boolean {
  return i.labels.some((l) => l.name === "agentic-workflows") || i.title.startsWith("[aw] ");
}

/** Issues the factory itself raised about its own health: gh-aw failures and factory_health items. */
export function isFactoryHealthIssue(i: { readonly title: string; readonly labels: readonly { readonly name: string }[] }): boolean {
  return isGhAwIssue(i) || i.labels.some((l) => l.name === "factory:health");
}

export type Tone = "you" | "stop" | "busy" | "done" | "";
export function toneOf(status: string): Tone {
  switch (status) {
    case "needs_info":
    case "in_review":
    case "waiting_trust":
      return "you";
    case "escalated":
      return "stop";
    case "running":
    case "queued_to_merge":
      return "busy";
    case "merged":
      return "done";
    default:
      return "";
  }
}

export const OPEN_STATUSES: readonly string[] = ["queued", "running", "in_review", "queued_to_merge", "escalated", "waiting_trust", "needs_info"];
export const NEEDS_STATUSES: readonly string[] = ["needs_info", "in_review", "escalated", "waiting_trust"];
export const CLOSED_STATUSES: readonly string[] = ["duplicate", "rejected", "closed"];

export const OUTCOME: Readonly<Record<string, string>> = {
  running: "Running",
  draft_pr: "Opened a PR",
  merged: "Merged",
  escalated: "Handed to you",
  duplicate: "Duplicate",
  failed: "Failed",
  cancelled: "Cancelled",
  rejected: "Turned down",
  no_action: "Nothing to do",
};
export const outcomeName = (o: string): string => OUTCOME[o] ?? o.replace(/_/g, " ");
export function outcomeTone(o: string): Tone {
  if (o === "merged") return "done";
  if (o === "failed" || o === "escalated") return "stop";
  if (o === "running") return "busy";
  return "";
}

export const STEP: Readonly<Record<string, string>> = {
  triage: "Reading the request",
  brainstorm: "Talking it through",
  spec: "Writing the spec",
  builder: "Building",
  verifier: "Checking it in the sandbox",
  gardener: "Tidying",
  hardener: "Hardening",
  scorer: "Scoring",
  gate: "At the gates",
  merge: "Merging",
};
export const stepName = (s: string): string => STEP[s] ?? s;
export const STEP_SHORT: Readonly<Record<string, string>> = {
  triage: "Read", brainstorm: "Talk", spec: "Spec", builder: "Build", verifier: "Verify", gate: "Gate",
  gardener: "Tidy", hardener: "Harden", scorer: "Score", merge: "Merge",
};
/** The stations a run passes, in order, for drawing where it is. */
export function pathFor(pipeline: string): readonly string[] {
  if (pipeline === "gardening") return ["gardener", "verifier", "gate"];
  if (pipeline === "hardening") return ["triage", "hardener", "verifier", "gate"];
  return ["triage", "spec", "builder", "verifier", "gate"];
}

export const SOURCE: Readonly<Record<string, string>> = {
  issue: "an issue",
  issue_comment: "an issue comment",
  review_comment: "a review comment",
  pr: "a pull request",
  schedule: "the nightly schedule",
  ci_failure: "a CI failure on main",
  dashboard: "the dashboard",
  review: "the factory's self-review",
  gardener: "gardening",
  conflict: "a merge conflict",
  correction: "a correction someone made",
  practice: "a practice",
};

/** "#42" → 42. Anything else, including a URL or a Slack thread, is not an issue on this repository. */
export function issueOf(ref: string | null | undefined): number | null {
  const m = /^#(\d+)$/.exec((ref ?? "").trim());
  return m === null ? null : Number(m[1]);
}

const LABEL_PIPE: Readonly<Record<string, Pipeline>> = {
  "factory:product-work": "product_work",
  "factory:gardening": "gardening",
  "factory:hardening": "hardening",
  "factory:definition": "definition",
  "factory:conflict": "conflict",
};
export function pipelineOfLabels(labels: readonly { readonly name: string }[]): Pipeline | null {
  for (const l of labels) {
    const p = LABEL_PIPE[l.name];
    if (p !== undefined) return p;
  }
  return null;
}
const has = (labels: readonly { readonly name: string }[], name: string): boolean => labels.some((l) => l.name === name);
export const isFactoryPull = (p: PullSummary): boolean => p.labels.some((l) => l.name.startsWith("factory:"));

/** People whose issues start work by themselves. Everyone else waits for factory:accept. */
export const TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"] as const;
export const isTrusted = (association: string): boolean => (TRUSTED as readonly string[]).includes(association);

/* ------------------------------------------------------------------ requests */

/** A request as a person thinks of it: one thing they asked for, whatever pieces it is made of. */
export interface Request {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly pipeline: Pipeline;
  readonly pr: number | null;
  readonly issue: number | null;
  readonly priority: "high" | "normal";
  readonly created_at: string | null;
  readonly merged_at: string | null;
  readonly open: boolean;
  readonly doc: WorkItemDoc | null;
}

/** The title a person would recognise: the work item's own, else the issue's, else the id. */
export function titleOf(doc: WorkItemDoc | null | undefined, issue: IssueSummary | undefined, id: string): string {
  const raw = doc?.title ?? issue?.title ?? null;
  if (raw === null || raw.trim() === "") return `Request ${id}`;
  // Issue forms prefix the kind, which the page already says another way.
  return raw.replace(/^\[(Feature|Bug|Harden|Tidy|Hardening|Gardening|Settings)\]\s*/i, "");
}

/**
 * Every request the factory knows about, newest first: the open ones from the
 * ledger, and the recently finished ones. The ledger's own fields win over the
 * work item file, because the ledger is rewritten on every change and the file
 * is not.
 */
export function requestsFrom(
  ledger: LedgerFile | null,
  docs: Readonly<Record<string, WorkItemDoc>>,
  issues: readonly IssueSummary[] = [],
): readonly Request[] {
  if (ledger === null) return [];
  const byIssue = new Map(issues.map((i) => [i.number, i]));
  const seen = new Set<string>();
  const out: Request[] = [];
  for (const o of ledger.open) {
    seen.add(o.work_item);
    const doc = docs[o.work_item] ?? null;
    const issue = issueOf(o.source_ref ?? doc?.source.ref);
    out.push({
      id: o.work_item,
      title: titleOf(doc, issue === null ? undefined : byIssue.get(issue), o.work_item),
      status: o.status,
      pipeline: o.pipeline,
      pr: o.pr ?? doc?.pr ?? null,
      issue,
      priority: o.priority ?? "normal",
      created_at: o.created_at ?? doc?.created_at ?? null,
      merged_at: null,
      open: true,
      doc,
    });
  }
  for (const r of ledger.recent) {
    if (seen.has(r.work_item)) continue;
    seen.add(r.work_item);
    const doc = docs[r.work_item] ?? null;
    const issue = issueOf(doc?.source.ref);
    out.push({
      id: r.work_item,
      title: titleOf(doc, issue === null ? undefined : byIssue.get(issue), r.work_item),
      status: r.status,
      pipeline: doc?.pipeline ?? "product_work",
      pr: r.pr ?? doc?.pr ?? null,
      issue,
      priority: "normal",
      created_at: doc?.created_at ?? null,
      merged_at: r.merged_at ?? null,
      open: false,
      doc,
    });
  }
  return out;
}

/** Ids worth opening the work item file for, capped so a long history costs a fixed number of reads. */
export function requestIds(ledger: LedgerFile | null, cap = 40): readonly string[] {
  if (ledger === null) return [];
  const ids = [...ledger.open.map((o) => o.work_item), ...ledger.recent.map((r) => r.work_item)];
  return [...new Set(ids)].slice(0, cap);
}

const ORDER = ["needs_info", "escalated", "in_review", "waiting_trust", "running", "queued_to_merge", "queued", "merged", "duplicate", "rejected", "closed"];
export function sortRequests(list: readonly Request[]): readonly Request[] {
  const rank = (s: string): number => {
    const i = ORDER.indexOf(s);
    return i === -1 ? ORDER.length : i;
  };
  const time = (r: Request): number => Date.parse(r.merged_at ?? r.created_at ?? "") || 0;
  return [...list].sort((a, b) => rank(a.status) - rank(b.status) || time(b) - time(a));
}

export type RequestFilter = "open" | "needs" | "running" | "merged" | "closed" | "all";
export const REQUEST_FILTERS: readonly { readonly id: RequestFilter; readonly label: string; readonly fits: (r: Request) => boolean }[] = [
  { id: "open", label: "Open", fits: (r) => r.open },
  { id: "needs", label: "Needs you", fits: (r) => NEEDS_STATUSES.includes(r.status) },
  { id: "running", label: "In progress", fits: (r) => ["running", "queued", "queued_to_merge"].includes(r.status) },
  { id: "merged", label: "Merged", fits: (r) => r.status === "merged" },
  { id: "closed", label: "Closed", fits: (r) => !r.open && r.status !== "merged" },
  { id: "all", label: "All", fits: () => true },
];

/* ------------------------------------------------------------------ waiting on you */

export type Need =
  | { readonly kind: "question"; readonly item: LedgerOpenItem; readonly issue: number | null }
  | { readonly kind: "review"; readonly pull: PullSummary; readonly item: LedgerOpenItem | null }
  | { readonly kind: "practice"; readonly pull: PullSummary }
  | { readonly kind: "escalated"; readonly item: LedgerOpenItem; readonly pull: PullSummary | null }
  | { readonly kind: "trust"; readonly item: LedgerOpenItem; readonly issue: number | null }
  | { readonly kind: "outside"; readonly issue: IssueSummary }
  | { readonly kind: "ask"; readonly issue: IssueSummary }
  | { readonly kind: "candidate"; readonly candidate: CandidatesFile["candidates"][number] };

/**
 * Everything that is waiting on a person, in the order it is worth their time:
 * a question first, because a person answering is the only thing holding that
 * request; then finished work to merge; then work that stopped; then strangers
 * asking; then rules the factory could add.
 */
export function needsFrom(input: {
  readonly ledger: LedgerFile | null;
  readonly pulls: readonly PullSummary[];
  readonly issues: readonly IssueSummary[];
  readonly candidates: readonly CandidatesFile["candidates"][number][];
}): readonly Need[] {
  const open = input.ledger?.open ?? [];
  const byPr = new Map(open.flatMap((o) => (o.pr == null ? [] : [[o.pr, o] as const])));
  const out: Need[] = [];
  for (const item of open.filter((o) => o.status === "needs_info")) {
    out.push({ kind: "question", item, issue: issueOf(item.source_ref) });
  }
  const factory = input.pulls.filter(isFactoryPull);
  const queued = new Set((input.ledger?.merge_queue ?? []).map((m) => m.pr));
  for (const pull of factory) {
    if (has(pull.labels, "factory:definition")) continue;
    // Out of draft and cleared is the runner's hand-off: the gates passed and
    // the pipeline wants a person. One in the merge queue merges itself.
    if (!pull.draft && has(pull.labels, "factory:cleared") && !queued.has(pull.number)) {
      out.push({ kind: "review", pull, item: byPr.get(pull.number) ?? null });
    }
  }
  for (const pull of factory.filter((p) => has(p.labels, "factory:definition"))) out.push({ kind: "practice", pull });
  for (const item of open.filter((o) => o.status === "escalated")) {
    out.push({ kind: "escalated", item, pull: item.pr == null ? null : (factory.find((p) => p.number === item.pr) ?? null) });
  }
  const trustIssues = new Set<number>();
  for (const item of open.filter((o) => o.status === "waiting_trust")) {
    const issue = issueOf(item.source_ref);
    if (issue !== null) trustIssues.add(issue);
    out.push({ kind: "trust", item, issue });
  }
  const known = new Set(open.flatMap((o) => (issueOf(o.source_ref) === null ? [] : [issueOf(o.source_ref)!])));
  for (const issue of input.issues) {
    if (issue.pull_request !== undefined) continue;
    if (isTrusted(issue.author_association) || has(issue.labels, "factory:accept")) continue;
    if (trustIssues.has(issue.number) || known.has(issue.number)) continue;
    out.push({ kind: "outside", issue });
  }
  // A question to the factory (factory:ask) that nobody has answered yet is waiting on the factory, but the person
  // who asked it should see it is still open rather than assume it was handled.
  for (const issue of input.issues) {
    if (issue.pull_request !== undefined || !has(issue.labels, "factory:ask")) continue;
    if ((issue.comments ?? 0) > 0) continue;
    out.push({ kind: "ask", issue });
  }
  for (const candidate of input.candidates.filter((c) => c.status === "pending")) out.push({ kind: "candidate", candidate });
  return out;
}

/* ------------------------------------------------------------------ words */

export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  if (iso == null) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((now.getTime() - t) / 1000);
  if (s < -60) return `in ${span(-s)}`;
  if (s < 45) return "just now";
  return `${span(s)} ago`;
}
function span(s: number): string {
  const m = Math.round(s / 60);
  if (m < 60) return m <= 1 ? "a minute" : `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "an hour" : `${h} hours`;
  const d = Math.round(h / 24);
  if (d < 14) return d === 1 ? "a day" : `${d} days`;
  const w = Math.round(d / 7);
  if (d < 60) return `${w} weeks`;
  return `${Math.round(d / 30)} months`;
}

/** "3 min", "1 h 20 min": for how long something took. */
export function dur(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "";
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

export function since(iso: string | null | undefined, now: Date = new Date()): string {
  if (iso == null) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : dur(Math.max(0, (now.getTime() - t) / 1000));
}

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "$0.00";
  return n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "";
  return `${(n * 100).toFixed(digits)}%`;
}

export function clock(iso: string | null | undefined): string {
  if (iso == null) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" ", " ").toLowerCase();
  if (d.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

export function day(iso: string | null | undefined): string {
  if (iso == null) return "";
  // A bare date is a calendar day, not midnight UTC, so it must not shift a day west of Greenwich.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A local clock time for a cron hour stored in UTC. */
export function hourLocal(utcHour: number, ref: Date = new Date()): string {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), utcHour));
  return d.toLocaleTimeString("en-US", { hour: "numeric" }).replace(" ", " ").toLowerCase();
}

/** "1:00 am (06:00 UTC)": the local time first, the UTC hour in the style the workflow file uses. */
export function hourLabel(utcHour: number, ref: Date = new Date()): string {
  const local = hourLocal(utcHour, ref).replace(/^(\d+)/, "$1:00");
  return `${local} (${String(utcHour).padStart(2, "0")}:00 UTC)`;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
/** Small counts as words at the start of a sentence, the way a person writes them. */
export const countWord = (n: number): string => WORDS[n] ?? n.toLocaleString("en-US");

/** A greeting line that says when it is, for the top of the briefing. */
export function whenLine(now: Date = new Date()): string {
  const dayName = now.toLocaleDateString("en-US", { weekday: "long" });
  const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" ", " ").toLowerCase();
  return `${dayName}, ${time}.`;
}

/** The runs that belong to one request, newest first. */
export function runsFor(runs: readonly RunFile[], workItem: string): readonly RunFile[] {
  return runs.filter((r) => r.work_item === workItem).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

/** A run's id, short enough to say: "run-0031" stays, a ULID loses its prefix. */
export const shortRun = (id: string): string => id.replace(/^run_/, "").toLowerCase();

/** The summary lines at the top of a factory pull request body, before the first heading. */
export function summaryOf(body: string | null | undefined, max = 5): readonly string[] {
  if (body == null) return [];
  const lines: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") && lines.length > 0) break;
    if (line === "" || line.startsWith("#") || line.startsWith("<!--") || line.startsWith("|") || line.startsWith("```")) continue;
    const clean = line.replace(/^[-*]\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    if (clean !== "") lines.push(clean);
    if (lines.length >= max) break;
  }
  return lines;
}

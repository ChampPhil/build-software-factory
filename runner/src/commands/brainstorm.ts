/**
 * The conversation that happens before any code is written.
 *
 * A request arrives as a sentence or two, and the gap between what someone
 * wrote and what they meant is where most wasted work comes from. Triage used
 * to close that gap with a single question, asked once: better than silence,
 * and nowhere near enough to pin down what somebody actually wants.
 *
 * So it becomes a conversation. The person answers; intake already puts the
 * item back in the queue when they do; the role runs again. The only thing
 * missing was memory — each run started from nothing and would ask the same
 * question again, or a different one with no sense of what had been settled.
 * This is that memory.
 *
 * What it is not: a spec the person has to approve. Nobody filing a request
 * wants to review a document about it. The log is an input to the spec stage,
 * which still does its own research; the person's part ends when the
 * conversation does.
 *
 * It is also held open rather than resumed. A turn used to be a whole workflow
 * run: a comment woke intake, intake requeued the item, the role started from
 * scratch and built a sandbox it never used to ask one question. Three to five
 * minutes a turn, which is not a conversation — it is correspondence. Now one
 * job stays alive and the agent blocks on `wait` between questions, so the
 * conversation is the agent's own context and a turn costs only the model
 * call. It is cheaper too: a held job is billed as one job, where a run per
 * turn is billed per job and each one rounds up to a whole minute.
 */

import type { GitHub } from "../lib/github.js";
import { FactoryStore } from "../lib/store.js";
import { redact } from "./mine.js";

export const brainstormPath = (workItem: string): string => `brainstorms/${workItem}.json`;

export interface BrainstormTurn {
  readonly at: string;
  readonly who: "factory" | "person";
  readonly text: string;
}

export interface Brainstorm {
  readonly schema: "brainstorm/1";
  readonly work_item: string;
  readonly turns: readonly BrainstormTurn[];
  /**
   * What the factory believes is being asked, in its own words.
   *
   * Played back to the person every few turns and corrected by them. When
   * this can be written without filling anything in, the conversation is
   * over — that is the end condition, rather than a number of turns.
   */
  readonly understood: string | null;
  /** Questions the factory still has. Empty is what "enough" looks like. */
  readonly open: readonly string[];
  readonly closed_at?: string;
  /**
   * The run holding this conversation open, and when it last said so.
   *
   * Together they answer one question intake has to get right: is somebody
   * already listening? A fresh heartbeat means a job is blocked on `wait` and
   * will pick the next comment up itself, so intake must not start a second
   * conversation and ask the person the same thing twice. A stale one means
   * that job is gone and intake takes over.
   */
  readonly holder?: string;
  readonly heartbeat_at?: string;
  /** The last comment this conversation has accounted for, so `wait` knows what is new. */
  readonly last_comment_id?: number;
}

/**
 * How long a heartbeat is worth trusting.
 *
 * The holder refreshes it on every poll, so a gap this long means the job is
 * actually gone rather than busy: a wedged holder must not be able to block a
 * conversation for the six hours a job may live.
 */
export const HEARTBEAT_STALE_MS = 90_000;

/** Is a job listening to this conversation right now? */
export function heldLive(b: Brainstorm | null, now: Date): boolean {
  if (b === null || b.closed_at !== undefined) return false;
  if (b.holder === undefined || b.heartbeat_at === undefined) return false;
  const beat = Date.parse(b.heartbeat_at);
  if (Number.isNaN(beat)) return false;
  // A heartbeat from the future is a clock disagreement, not liveness.
  return beat <= now.getTime() + 5_000 && now.getTime() - beat < HEARTBEAT_STALE_MS;
}

export const empty = (workItem: string): Brainstorm => ({
  schema: "brainstorm/1",
  work_item: workItem,
  turns: [],
  understood: null,
  open: [],
});

export async function readBrainstorm(gh: GitHub, workItem: string): Promise<Brainstorm | null> {
  return new FactoryStore(gh).get<Brainstorm>(brainstormPath(workItem), "brainstorm");
}

/** Append a turn, and update what the factory thinks it has understood. */
export async function appendTurn(
  gh: GitHub,
  workItem: string,
  turn: BrainstormTurn,
  understood?: string | null,
  open?: readonly string[],
): Promise<Brainstorm> {
  const store = new FactoryStore(gh);
  const current = (await store.get<Brainstorm>(brainstormPath(workItem), "brainstorm")) ?? empty(workItem);
  const next: Brainstorm = {
    ...current,
    turns: [...current.turns, turn],
    understood: understood === undefined ? current.understood : understood,
    open: open === undefined ? current.open : [...open],
  };
  await store.put(
    [{ path: brainstormPath(workItem), content: `${JSON.stringify(next, null, 2)}\n` }],
    `brainstorm: ${workItem} ${turn.who}`,
  );
  return next;
}

/** Close the conversation. The log stays; it is what spec reads. */
export async function closeBrainstorm(gh: GitHub, workItem: string, understood: string, now: string): Promise<void> {
  const store = new FactoryStore(gh);
  const current = (await store.get<Brainstorm>(brainstormPath(workItem), "brainstorm")) ?? empty(workItem);
  const next: Brainstorm = { ...current, understood, open: [], closed_at: now };
  await store.put(
    [{ path: brainstormPath(workItem), content: `${JSON.stringify(next, null, 2)}\n` }],
    `brainstorm: ${workItem} settled`,
  );
}

/**
 * The conversation so far, as the role reads it at the top of its next run.
 *
 * Plain text rather than JSON, because the thing being handed over is a
 * conversation and an agent reads one better than it reads a record of one.
 */
export function render(b: Brainstorm | null): string {
  if (b === null || b.turns.length === 0) {
    return "No conversation yet. This is the first thing you will say about this request.";
  }
  const lines: string[] = [`The conversation so far (${b.turns.length} turn${b.turns.length === 1 ? "" : "s"}):`, ""];
  for (const t of b.turns) {
    lines.push(`${t.who === "factory" ? "You asked" : "They answered"}: ${t.text}`);
  }
  lines.push("");
  if (b.understood !== null) {
    lines.push("What you last played back to them, which they did not correct:");
    lines.push(b.understood);
    lines.push("");
  }
  if (b.open.length > 0) {
    lines.push("Still open, by your own last reckoning:");
    for (const q of b.open) lines.push(`  - ${q}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Whether the conversation has gone on long enough to be worth saying so.
 *
 * Not a cap — nothing stops a conversation that is still getting somewhere,
 * and a person who wants to keep talking should be able to. But a run of
 * questions that is not converging is a sign the request needs a person
 * rather than more questions, and the role is told to notice that itself.
 */
export function drifting(b: Brainstorm | null): boolean {
  if (b === null) return false;
  const asked = b.turns.filter((t) => t.who === "factory").length;
  return asked >= 6 && b.understood === null;
}

/* ----------------------------------------------------------- holding it open */

/**
 * An issue comment as the REST API returns it.
 *
 * Everything but the id is optional and may be explicitly absent: a comment
 * can come back with no body, and a deleted user leaves no login. The types
 * say so rather than pretending otherwise, so a caller has to handle it.
 */
export interface IssueComment {
  readonly id: number;
  readonly body?: string | undefined;
  readonly user?: { readonly login?: string | undefined } | undefined;
  readonly author_association?: string | undefined;
  readonly created_at?: string | undefined;
}

/**
 * Which of an issue's comments is the person's next answer.
 *
 * Three things are not an answer, and all three would otherwise be read as
 * one. The factory's own questions, which would have it talking to itself. A
 * comment from anyone the repo does not trust, because a conversation that
 * decides what gets built is not open to passers-by. And anything already
 * accounted for, which is what `after` is: without it a restarted holder
 * re-answers the last thing it already answered.
 */
export function nextAnswer(
  comments: readonly IssueComment[],
  opts: {
    readonly after: number;
    readonly trusted: (c: IssueComment) => boolean;
  },
): IssueComment | null {
  const fresh = comments
    .filter((c) => c.id > opts.after)
    .filter((c) => (c.body ?? "").trim() !== "")
    .filter((c) => opts.trusted(c))
    .sort((a, b) => a.id - b.id);
  return fresh[0] ?? null;
}

/** Marks a comment the factory wrote, so the loop never reads its own question as an answer. */
export const FACTORY_MARKER = "<!-- bsf:brainstorm -->";

/** Takes only what it reads, so a caller can pass a comment from any source. */
export const wroteByFactory = (c: {
  readonly body?: string | undefined;
  readonly user?: { readonly login?: string | undefined } | undefined;
}): boolean => (c.body ?? "").includes(FACTORY_MARKER) || /\[bot\]$/.test(c.user?.login ?? "");

/** A question should be a question, not an essay. */
export const QUESTION_LIMIT = 1200;

/**
 * What the factory is willing to post in its own voice.
 *
 * Every other role proposes its writes as safe outputs, and a trusted job
 * performs them once the agent has exited — which a conversation cannot do,
 * because a question posted after the run has ended is not a question. So this
 * is the same bargain made synchronously: the agent proposes words, trusted
 * code from the default branch decides what actually goes out.
 *
 * Three things are taken out. Anything secret-shaped, because people paste
 * keys into agent chats and this text is about to be public. `@` mentions,
 * because a question to one person should not notify a team, and a model that
 * has read the repository knows plenty of logins. And the factory's own HTML
 * markers, because those are how its surfaces tell their own comments apart —
 * a question that could forge `bsf:triage` could forge a verdict.
 */
export function saneComment(text: string): string {
  return redact(text)
    .replace(/<!--\s*bsf:[\s\S]*?-->/gi, "")
    // Keeps the word, drops the notification: @philip reads as philip.
    .replace(/(^|[^\w`])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\b/g, "$1$2")
    .trim()
    .slice(0, QUESTION_LIMIT);
}

/**
 * Ask a question: one comment on the issue, one turn in the log.
 *
 * Both or neither. They were going to be two calls, and two calls drift — a
 * question the person can see with no turn recording it means the next holder
 * asks it again, and a turn with no comment means the person is waiting for
 * something that was never sent. The attribution bug on the footer came from
 * exactly this shape, two renderings of one fact kept in step by hand.
 */
export async function say(
  gh: GitHub,
  opts: {
    readonly workItem: string;
    readonly issue: number;
    readonly text: string;
    readonly now: string;
    readonly understood?: string | null;
    readonly open?: readonly string[];
  },
): Promise<{ readonly commentId: number }> {
  const text = saneComment(opts.text);
  if (text === "") throw new Error("nothing to ask: the question was empty once redacted");
  const posted = await gh.send<{ id: number }>(`POST`, `repos/${gh.repo}/issues/${opts.issue}/comments`, {
    body: `${text}\n\n${FACTORY_MARKER}`,
  });
  await appendTurn(
    gh,
    opts.workItem,
    { at: opts.now, who: "factory", text },
    opts.understood,
    opts.open,
  );
  // Recorded after the turn: if this write fails the question is still in the
  // log, and a holder that re-reads will not ask it twice.
  await mark(gh, opts.workItem, { lastCommentId: posted.id, now: opts.now });
  return { commentId: posted.id };
}

/** Update the liveness marker and the last comment accounted for. */
export async function mark(
  gh: GitHub,
  workItem: string,
  opts: { readonly holder?: string; readonly lastCommentId?: number; readonly now: string },
): Promise<Brainstorm> {
  const store = new FactoryStore(gh);
  const current = (await store.get<Brainstorm>(brainstormPath(workItem), "brainstorm")) ?? empty(workItem);
  const next: Brainstorm = {
    ...current,
    ...(opts.holder === undefined ? {} : { holder: opts.holder }),
    heartbeat_at: opts.now,
    ...(opts.lastCommentId === undefined ? {} : { last_comment_id: opts.lastCommentId }),
  };
  await store.put(
    [{ path: brainstormPath(workItem), content: `${JSON.stringify(next, null, 2)}\n` }],
    `brainstorm: ${workItem} holding`,
  );
  return next;
}

export type WaitOutcome =
  | { readonly kind: "answer"; readonly text: string; readonly commentId: number; readonly from: string }
  | { readonly kind: "quiet"; readonly waitedMs: number }
  | { readonly kind: "closed" };

export interface WaitOptions {
  readonly issue: number;
  /** Give up after this long with nothing said, and let the job end. */
  readonly idleMs: number;
  /** How often to look, when GitHub does not ask for longer. */
  readonly pollMs: number;
  readonly trusted: (c: IssueComment) => boolean;
  /** The last comment already accounted for. */
  readonly after: number;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * Record the answer and say the holder is still alive.
   *
   * The loop takes these rather than writing the log itself. Watching an issue
   * and keeping a conversation are two jobs, and the loop only has one of
   * them — which also means the polling can be tested without a data ref.
   */
  readonly onAnswer: (c: IssueComment) => Promise<void>;
  readonly onHeartbeat: () => Promise<void>;
}

/**
 * Block until the person answers, or until they have been quiet long enough
 * that holding a runner for them is waste.
 *
 * The poll is conditional. GitHub's guidance is explicit that a 304 does not
 * count against the primary rate limit, so looking every couple of seconds
 * costs nothing while nothing is happening: only a poll that finds a new
 * comment spends quota, and that is a turn. Without this the arithmetic fails
 * — 1,800 polls an hour against a 1,000-an-hour token budget.
 *
 * `x-poll-interval` is obeyed when GitHub sends it. It is how GitHub asks for
 * room before it starts refusing, and a loop that ignores it earns a secondary
 * rate limit for the whole repository, not just for itself.
 */
export async function waitForAnswer(gh: GitHub, opts: WaitOptions): Promise<WaitOutcome> {
  const started = opts.now().getTime();
  let etag: string | undefined;
  let after = opts.after;
  let lastBeat = 0;

  for (;;) {
    const res = await gh.getConditional<IssueComment[]>(
      `repos/${gh.repo}/issues/${opts.issue}/comments?per_page=100`,
      etag,
    );
    if (res.etag !== undefined) etag = res.etag;

    if (res.status === 200 && res.body !== undefined) {
      const answer = nextAnswer(res.body, { after, trusted: opts.trusted });
      if (answer !== null) {
        await opts.onAnswer(answer);
        return {
          kind: "answer",
          text: (answer.body ?? "").trim(),
          commentId: answer.id,
          from: answer.user?.login ?? "someone",
        };
      }
      // Nothing to answer, but the list moved: don't re-read these next time.
      after = Math.max(after, ...res.body.map((c) => c.id), 0);
    }

    const elapsed = opts.now().getTime() - started;
    if (elapsed >= opts.idleMs) return { kind: "quiet", waitedMs: elapsed };

    // The heartbeat is what stops intake starting a second conversation, so it
    // is refreshed while waiting rather than only between turns.
    if (opts.now().getTime() - lastBeat >= HEARTBEAT_STALE_MS / 3) {
      await opts.onHeartbeat();
      lastBeat = opts.now().getTime();
    }

    const asked = res.pollAfter === undefined ? 0 : res.pollAfter * 1000;
    await opts.sleep(Math.max(opts.pollMs, asked));
  }
}

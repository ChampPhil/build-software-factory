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

/**
 * A reading of an ambiguous request: the problem it might be, the word for
 * that problem, and the sign that separates it from the other readings.
 *
 * Recorded because "which of these is it?" is a better opening question than
 * any open one. It is the one question only the person can answer, the answer
 * redirects everything downstream, and it costs them a glance rather than an
 * essay.
 */
export interface Reading {
  readonly problem: string;
  readonly term: string;
  readonly tells_it_apart: string;
}

/** One expert word, and what having it lets somebody ask for. */
export interface FrameTerm {
  readonly term: string;
  readonly means: string;
  /** The part of what they actually said that this word names. */
  readonly names: string;
  /** A project, paper or system that uses it this way. Unverified. */
  readonly prior_art?: string;
  /** What this word lets someone ask for that they could not before. */
  readonly unlocks: string;
}

/** A field that solved this shape of problem under other names. */
export interface Neighbor {
  readonly field: string;
  readonly carries_over: string;
  /** Where the analogy fails. Required: one with no stated limit gets over-applied. */
  readonly breaks_down: string;
  readonly terms?: readonly string[];
}

/**
 * The expert words for what is being asked.
 *
 * A request filed in vague words gets built in vague words, and the one thing
 * that reliably changes that is naming it. So the conversation works out what
 * this *is* before it starts asking about details.
 *
 * This is taught to the person, not kept from them. The naming has to reach
 * whoever filed the request, or every later question lands on somebody with no
 * word for the thing being asked about, and their answers are guesses — which
 * is the failure the frame exists to prevent. It is posted as a turn and never
 * as a gate: they take the vocabulary or they just answer the question at the
 * end of it.
 *
 * The spec stage reads it too, and is the only stage that *can* confirm any of
 * it: the conversation has no research egress. Everything here is the
 * conversation's unverified claim until that stage checks it.
 */
export interface Frame {
  readonly readings?: readonly Reading[];
  readonly reading_taken?: string;
  readonly named?: string;
  readonly terms?: readonly FrameTerm[];
  readonly neighbors?: readonly Neighbor[];
  readonly unmentioned?: readonly string[];
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
  /** The expert words for what is being asked. See {@link Frame}. */
  readonly frame?: Frame;
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
  if (b.frame !== undefined) {
    const f = b.frame;
    lines.push("The words the conversation settled on, and taught them.");
    lines.push(
      "Unverified: the conversation has no web access, so none of this was checked against a",
    );
    lines.push(
      "source. Confirm each term and each attribution before you build on it, and cut what you",
    );
    lines.push("cannot confirm. Do not repeat an attribution you have not read.");
    lines.push("");
    if (f.named !== undefined) lines.push(`What this is: ${f.named}`);
    if (f.reading_taken !== undefined) lines.push(`Read as: ${f.reading_taken}`);
    if (f.readings !== undefined && f.readings.length > 0) {
      lines.push("It could have been read as:");
      for (const r of f.readings) lines.push(`  - ${r.term}: ${r.problem} (told apart by: ${r.tells_it_apart})`);
    }
    if (f.terms !== undefined && f.terms.length > 0) {
      lines.push("Terms, most load-bearing first:");
      for (const t of f.terms) {
        const art = t.prior_art === undefined ? "" : ` [claimed prior art: ${t.prior_art}]`;
        lines.push(`  - ${t.term}: ${t.means} Names: ${t.names} Unlocks: ${t.unlocks}${art}`);
      }
    }
    if (f.neighbors !== undefined && f.neighbors.length > 0) {
      lines.push("Neighbouring fields, as research anchors:");
      for (const n of f.neighbors) {
        const w = n.terms === undefined || n.terms.length === 0 ? "" : ` Terms: ${n.terms.join(", ")}.`;
        lines.push(`  - ${n.field}: carries over: ${n.carries_over} Breaks down: ${n.breaks_down}${w}`);
      }
    }
    if (f.unmentioned !== undefined && f.unmentioned.length > 0) {
      lines.push("Raised with them as things they had not mentioned:");
      for (const u of f.unmentioned) lines.push(`  - ${u}`);
    }
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
export function saneComment(text: string, limit: number = QUESTION_LIMIT): string {
  return redact(text)
    .replace(/<!--\s*bsf:[\s\S]*?-->/gi, "")
    // Keeps the word, drops the notification: @philip reads as philip.
    .replace(/(^|[^\w`])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\b/g, "$1$2")
    .trim()
    .slice(0, limit);
}

/**
 * What a frame turn may run to.
 *
 * Longer than a question, and deliberately: a question should be one sentence
 * on a phone, while teaching somebody the words for their own problem cannot
 * be. It earns the extra room because trusted code renders it from validated
 * fields — the agent supplies structure, not three thousand free characters.
 */
export const FRAME_LIMIT = 3000;

/** How much of the frame the person is shown. The rest is in the log for spec. */
export const FRAME_TERMS_SHOWN = 4;
export const FRAME_NEIGHBORS_SHOWN = 2;
export const FRAME_UNMENTIONED_SHOWN = 3;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Read a frame the agent wrote, and refuse one that teaches nothing.
 *
 * The required fields are the ones that make a term worth a person's
 * attention: what it means, which part of *their own words* it names, and what
 * having it lets them ask for. A term with no `names` is one the conversation
 * went looking for rather than found, and a term with no `unlocks` is
 * vocabulary for its own sake — both are how this turn would decay into a
 * glossary nobody reads.
 */
export function parseFrame(raw: unknown): Frame {
  if (raw === null || typeof raw !== "object") throw new Error("the frame must be a JSON object");
  const o = raw as Record<string, unknown>;
  const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

  const terms = list(o["terms"]).map((t, i) => {
    const e = (t ?? {}) as Record<string, unknown>;
    const term = str(e["term"]);
    if (term === "") throw new Error(`terms[${i}]: no term`);
    for (const k of ["means", "names", "unlocks"] as const) {
      if (str(e[k]) === "") {
        throw new Error(
          `terms[${i}] (${term}): no ${k}. Every term needs what it means, the part of ` +
            `what they said that it names, and what having it lets them ask for. A term ` +
            `missing any of those is a glossary entry, not a word they can use.`,
        );
      }
    }
    const art = str(e["prior_art"]);
    return {
      term,
      means: str(e["means"]),
      names: str(e["names"]),
      unlocks: str(e["unlocks"]),
      ...(art === "" ? {} : { prior_art: art }),
    };
  });

  const neighbors = list(o["neighbors"]).map((n, i) => {
    const e = (n ?? {}) as Record<string, unknown>;
    const field = str(e["field"]);
    if (field === "") throw new Error(`neighbors[${i}]: no field`);
    const breaks = str(e["breaks_down"]);
    if (breaks === "") {
      throw new Error(
        `neighbors[${i}] (${field}): no breaks_down. An analogy with no stated limit is ` +
          `the one that gets over-applied, so where it fails is required.`,
      );
    }
    const terms_ = list(e["terms"]).map(str).filter((x) => x !== "");
    return {
      field,
      carries_over: str(e["carries_over"]),
      breaks_down: breaks,
      ...(terms_.length === 0 ? {} : { terms: terms_ }),
    };
  });

  const readings = list(o["readings"]).map((r, i) => {
    const e = (r ?? {}) as Record<string, unknown>;
    for (const k of ["problem", "term", "tells_it_apart"] as const) {
      if (str(e[k]) === "") throw new Error(`readings[${i}]: no ${k}`);
    }
    return { problem: str(e["problem"]), term: str(e["term"]), tells_it_apart: str(e["tells_it_apart"]) };
  });

  const named = str(o["named"]);
  const taken = str(o["reading_taken"]);
  const unmentioned = list(o["unmentioned"]).map(str).filter((x) => x !== "");

  if (named === "" && terms.length === 0 && readings.length === 0) {
    throw new Error("an empty frame: give at least `named`, or some `terms`, or the `readings` to choose between");
  }

  return {
    ...(readings.length === 0 ? {} : { readings }),
    ...(taken === "" ? {} : { reading_taken: taken }),
    ...(named === "" ? {} : { named }),
    ...(terms.length === 0 ? {} : { terms }),
    ...(neighbors.length === 0 ? {} : { neighbors }),
    ...(unmentioned.length === 0 ? {} : { unmentioned }),
  };
}

/**
 * The frame as the person reads it.
 *
 * Shaped here rather than by the agent so that every factory words this the
 * same way and so that the length stays somebody's decision rather than a
 * model's. It shows the top few terms and neighbours — the ranking is the
 * agent's — and leaves the rest in the log, because the person needs the words
 * that change what gets built and the spec stage needs all of them.
 *
 * It ends on the question. That is what keeps this a turn in a conversation
 * rather than a document to approve: they can take the vocabulary or ignore it
 * and just answer.
 */
/** Small numbers read as words in prose; "The 3 words" looks machine-written. */
const count = (n: number): string =>
  ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"][n] ?? String(n);

/** Ends a fragment the agent wrote, so two of them do not run together. */
const sentence = (text: string): string => (/[.!?:)]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

export function renderFrameTurn(frame: Frame, question: string): string {
  const out: string[] = [];
  if (frame.named !== undefined) out.push(`Before I ask anything else — **${frame.named}**`);

  const terms = (frame.terms ?? []).slice(0, FRAME_TERMS_SHOWN);
  if (terms.length > 0) {
    out.push(
      terms.length === 1
        ? "The word that matters most here:"
        : `The ${count(terms.length)} words that change what gets built here:`,
    );
    // `names` and `unlocks` are the agent's own sentences, and it writes them
    // as a clause one time and a noun phrase the next. Anything that glues
    // them into scaffolding ("Names the part where X") reads broken for half
    // of them, so each gets a line behind a label that takes either shape.
    out.push(
      terms
        .map((t) => {
          const art = t.prior_art === undefined ? "" : ` Used this way in ${sentence(t.prior_art)}`;
          return [
            `- **${t.term}** — ${sentence(t.means)}`,
            `  From what you wrote: ${sentence(t.names)}`,
            `  Lets you ask for: ${sentence(t.unlocks)}${art}`,
          ].join("\n");
        })
        .join("\n"),
    );
  }

  const near = (frame.neighbors ?? []).slice(0, FRAME_NEIGHBORS_SHOWN);
  if (near.length > 0) {
    out.push(near.length === 1 ? "Where this has been solved before:" : "Where this has been solved before, under other names:");
    out.push(
      near
        .map((n) => {
          const lines = [`- **${n.field}**${n.carries_over === "" ? "" : ` — ${sentence(n.carries_over)}`}`];
          lines.push(`  Where it stops being the same problem: ${sentence(n.breaks_down)}`);
          if (n.terms !== undefined && n.terms.length > 0) lines.push(`  Worth borrowing: ${n.terms.join(", ")}.`);
          return lines.join("\n");
        })
        .join("\n"),
    );
  }

  const unsaid = (frame.unmentioned ?? []).slice(0, FRAME_UNMENTIONED_SHOWN);
  if (unsaid.length > 0) {
    out.push("Things you did not mention that will decide something:");
    out.push(unsaid.map((u) => `- ${sentence(u)}`).join("\n"));
  }

  out.push(question);
  return out.join("\n\n");
}

/**
 * Teach the frame and ask the next question, in one turn.
 *
 * One call rather than two because a frame with no question is a document, and
 * the person is owed a conversation. The structure goes in the log for the spec
 * stage; the prose goes on the issue for them.
 */
export async function sayFrame(
  gh: GitHub,
  opts: {
    readonly workItem: string;
    readonly issue: number;
    readonly frame: Frame;
    readonly question: string;
    readonly now: string;
    readonly open?: readonly string[];
  },
): Promise<{ readonly commentId: number }> {
  const question = saneComment(opts.question);
  if (question === "") throw new Error("a frame needs a question after it, or it is a document rather than a turn");
  const text = saneComment(renderFrameTurn(opts.frame, question), FRAME_LIMIT);
  const posted = await gh.send<{ id: number }>(`POST`, `repos/${gh.repo}/issues/${opts.issue}/comments`, {
    body: `${text}\n\n${FACTORY_MARKER}`,
  });
  const store = new FactoryStore(gh);
  const current = (await store.get<Brainstorm>(brainstormPath(opts.workItem), "brainstorm")) ?? empty(opts.workItem);
  const next: Brainstorm = {
    ...current,
    turns: [...current.turns, { at: opts.now, who: "factory", text }],
    frame: opts.frame,
    ...(opts.open === undefined ? {} : { open: opts.open }),
    heartbeat_at: opts.now,
    last_comment_id: posted.id,
  };
  await store.put(
    [{ path: brainstormPath(opts.workItem), content: `${JSON.stringify(next, null, 2)}\n` }],
    `brainstorm: ${opts.workItem} framed`,
  );
  return { commentId: posted.id };
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

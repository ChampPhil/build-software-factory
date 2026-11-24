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
 */

import type { GitHub } from "../lib/github.js";
import { FactoryStore } from "../lib/store.js";

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

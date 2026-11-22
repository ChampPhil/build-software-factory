/**
 * Standing goals: what the factory is asked to focus on for a while.
 *
 * "Focus hardening on auth this month" is said in the dashboard or in a
 * comment; the factory records it here. Nobody edits a file. Goals live on the
 * data ref, never in the repo, because they are direction for the factory's
 * attention and not rules about the code: they cannot loosen a guardrail or
 * widen what a pipeline may change.
 */

import type { FactoryStore } from "../lib/store.js";

export const GOALS_PATH = "standing-goals.json";

export const LANES = ["product_work", "gardening", "hardening"] as const;
export type Lane = (typeof LANES)[number];

export interface StandingGoal {
  readonly id: string;
  readonly text: string;
  /** The pipeline it applies to, or null for all of them. */
  readonly lane: Lane | null;
  readonly by: string;
  readonly at: string;
  /** After this the goal stops applying by itself. Null: until someone removes it. */
  readonly until: string | null;
}

export interface GoalsDoc {
  readonly schema: "standing-goals/1";
  readonly goals: readonly StandingGoal[];
}

export const MAX_GOALS = 20;
const MAX_TEXT = 300;

export const emptyGoals = (): GoalsDoc => ({ schema: "standing-goals/1", goals: [] });

/** `/focus hardening: auth this month`: the lane is optional. */
export function parseFocus(body: string | null | undefined): { lane: Lane | null; text: string } | null {
  if (body == null) return null;
  const m = /^\s*\/focus\s+([\s\S]+)$/.exec(body);
  if (m?.[1] === undefined) return null;
  return parseGoalText(m[1]);
}

const LANE_WORD: Record<string, Lane> = {
  product: "product_work",
  product_work: "product_work",
  features: "product_work",
  gardening: "gardening",
  tidying: "gardening",
  hardening: "hardening",
};

/** A goal as typed, with an optional leading `lane:`. Null when there is nothing to record. */
export function parseGoalText(raw: string, laneHint?: string | null): { lane: Lane | null; text: string } | null {
  let text = raw.trim();
  let lane: Lane | null = laneHint !== undefined && laneHint !== null && (LANES as readonly string[]).includes(laneHint) ? (laneHint as Lane) : null;
  const lead = /^([a-z_]+)\s*:\s*([\s\S]+)$/i.exec(text);
  if (lead?.[1] !== undefined && lead[2] !== undefined && LANE_WORD[lead[1].toLowerCase()] !== undefined) {
    lane = LANE_WORD[lead[1].toLowerCase()]!;
    text = lead[2].trim();
  }
  if (text === "") return null;
  return { lane, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text };
}

/** The goals that apply now, optionally for one lane (a goal with no lane applies to every lane). */
export function activeGoals(doc: GoalsDoc | null, now: string, lane?: Lane): readonly StandingGoal[] {
  const t = Date.parse(now);
  return (doc?.goals ?? []).filter(
    (g) => (g.until === null || Date.parse(g.until) > t) && (lane === undefined || g.lane === null || g.lane === lane),
  );
}

export function addGoal(doc: GoalsDoc | null, goal: Omit<StandingGoal, "id">, id: string): GoalsDoc {
  const base = doc ?? emptyGoals();
  const kept = base.goals.filter((g) => g.text !== goal.text || g.lane !== goal.lane);
  // The oldest go first, so the list stays short enough to put in a prompt.
  return { ...base, goals: [...kept, { ...goal, id }].slice(-MAX_GOALS) };
}

export function removeGoal(doc: GoalsDoc | null, id: string): GoalsDoc {
  const base = doc ?? emptyGoals();
  return { ...base, goals: base.goals.filter((g) => g.id !== id) };
}

export async function readGoals(store: FactoryStore): Promise<GoalsDoc | null> {
  const raw = await store.data.readJson<GoalsDoc>(GOALS_PATH);
  return raw !== null && raw.schema === "standing-goals/1" && Array.isArray(raw.goals) ? raw : null;
}

export async function writeGoals(store: FactoryStore, next: (cur: GoalsDoc | null) => GoalsDoc, message: string): Promise<GoalsDoc> {
  let out = emptyGoals();
  await store.data.commitWithRetry(async () => {
    out = next(await readGoals(store));
    return [{ path: GOALS_PATH, content: `${JSON.stringify(out, null, 2)}\n` }];
  }, message);
  return out;
}

/** "Standing goal 1: ..." lines for a prompt. */
export function goalLines(goals: readonly StandingGoal[]): string[] {
  return goals.map((g, i) => `${i + 1}. ${g.text}${g.lane === null ? "" : ` (for ${g.lane.replace("_", " ")})`}`);
}

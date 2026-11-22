import type { GitHub } from "../lib/github.js";
import { FactoryStore, json } from "../lib/store.js";

/**
 * What a person decided about a guardrail candidate, kept on the data ref.
 *
 * The candidates themselves live in the repo (`.factory/guardrails/candidates.json`,
 * changed only by reviewed PRs), so a click on the dashboard cannot edit them.
 * A decision is a separate small record laid over them: accepted starts
 * hardening on it now, rejected keeps hardening from proposing it again.
 */

export const DECISIONS_PATH = "guardrails/candidate-decisions.json";
export const CANDIDATES_REPO_PATH = ".factory/guardrails/candidates.json";

export interface Decision {
  readonly status: "accepted" | "rejected";
  readonly by: string;
  readonly at: string;
}

export interface DecisionsFile {
  readonly schema: "candidate-decisions/1";
  readonly decisions: Readonly<Record<string, Decision>>;
}

export interface CandidateLike {
  readonly id: string;
  readonly problem_class: string;
  readonly occurrences?: number;
  readonly sources?: readonly { readonly quote?: string }[];
  readonly proposed_fix?: string;
  readonly status?: string;
}

/** The candidates with people's decisions laid over their stored status. */
export function overlay<T extends CandidateLike>(candidates: readonly T[], file: DecisionsFile | null): T[] {
  return candidates.map((c) => {
    const d = file?.decisions[c.id];
    return d === undefined ? c : { ...c, status: d.status };
  });
}

export function emptyDecisions(): DecisionsFile {
  return { schema: "candidate-decisions/1", decisions: {} };
}

export async function readDecisions(store: FactoryStore): Promise<DecisionsFile> {
  return (await store.data.readJson<DecisionsFile>(DECISIONS_PATH)) ?? emptyDecisions();
}

/** The work item text an accepted candidate becomes: the problem class and the words it was mined from. */
export function candidateRequest(c: CandidateLike): { title: string; body: string } {
  const quotes = (c.sources ?? []).map((s) => s.quote).filter((q): q is string => q !== undefined && q !== "").slice(0, 5);
  return {
    title: `Candidate: ${c.problem_class}`.slice(0, 120),
    body: [
      `A person accepted this guardrail candidate on the dashboard: ${c.problem_class}.`,
      `It was seen ${c.occurrences ?? 1} time(s).`,
      ...(quotes.length === 0 ? [] : ["", "What people said:", ...quotes.map((q) => `> ${q}`)]),
      `Candidate: ${c.id}`,
    ].join("\n"),
  };
}

export interface DecideResult {
  readonly candidate: CandidateLike | null;
  readonly commit: string | null;
}

/** Record accept or reject for one candidate. A candidate that is not in the repo's file records nothing. */
export async function decideCandidate(opts: {
  readonly gh: GitHub;
  readonly id: string;
  readonly status: "accepted" | "rejected";
  readonly by: string;
  readonly now: string;
}): Promise<DecideResult> {
  const branch = await opts.gh.defaultBranch();
  const raw = await opts.gh.fileAtRef(CANDIDATES_REPO_PATH, branch);
  const list = raw === null ? [] : ((JSON.parse(raw) as { candidates?: CandidateLike[] }).candidates ?? []);
  const candidate = list.find((c) => c.id === opts.id) ?? null;
  if (candidate === null) return { candidate: null, commit: null };

  const store = new FactoryStore(opts.gh);
  const file = await readDecisions(store);
  const next: DecisionsFile = {
    ...file,
    decisions: { ...file.decisions, [opts.id]: { status: opts.status, by: opts.by, at: opts.now } },
  };
  const commit = await store.put([{ path: DECISIONS_PATH, content: json(next) }], `candidate ${opts.id} ${opts.status} by ${opts.by}`);
  return { candidate, commit };
}

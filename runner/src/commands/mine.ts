import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { candidateId } from "../lib/ids.js";
import type { Harness, Candidate, CandidateSource, CandidateSourceKind } from "../lib/types.js";

const exec = promisify(execFile);

/**
 * `bsf mine-corrections` — read the user's own past agent sessions and find
 * the moments where they corrected one.
 *
 * This is the one thing in the factory that cannot be derived from the
 * repository: a correction is a human saying "no, not like that", and it lives
 * in the session logs on their machine. Those corrections are the best source
 * of guardrails there is, because each one is a rule the user already wanted
 * and had to state by hand.
 *
 * Done with memex (MIT), which reads every harness the factory supports. The
 * queries find candidate turns; the scoring here decides which are really
 * corrections, because that judgement should be testable rather than a search
 * ranking nobody can inspect.
 */

export interface MemexHit {
  readonly source?: string;
  readonly session_id?: string;
  readonly turn_id?: number;
  readonly role?: string;
  readonly text?: string;
  readonly snippet?: string;
  readonly ts?: number;
  readonly project?: string;
  readonly cwd?: string;
  readonly score?: number;
}

export interface Correction {
  readonly text: string;
  readonly source: string;
  readonly session: string;
  readonly at: string | null;
  /** How correction-like this turn is, 0 to 1. */
  readonly confidence: number;
  readonly signals: readonly string[];
  /**
   * Set when a classifier already chose how to enforce this correction.
   * Absent means the ordered phrase check in `proposedFix` decides.
   */
  readonly enforcement?: "api_change" | "static_rule" | "verification" | "context";
}

/* ------------------------------------------------------------- the classifier */

/**
 * What a correction looks like in a user's own words.
 *
 * Weighted because the strong signals are rare and the weak ones are common:
 * "actually" alone is how people think aloud, but "no, don't do that" is
 * unambiguous. A turn needs to clear the threshold on the sum, so one strong
 * signal or several weak ones both count.
 */
const SIGNALS: readonly { readonly name: string; readonly re: RegExp; readonly weight: number }[] = [
  { name: "explicit_no", re: /\b(no|nope),?\s+(don'?t|do not|that'?s|stop|wrong)\b/i, weight: 0.5 },
  { name: "prohibition", re: /\b(never|don'?t ever|do not ever|stop)\s+\w+/i, weight: 0.4 },
  { name: "undo", re: /\b(revert|undo|roll ?back|put (it|that) back)\b/i, weight: 0.45 },
  { name: "broke", re: /\byou (broke|deleted|removed|changed|overwrote)\b/i, weight: 0.45 },
  { name: "wrong", re: /\b(that'?s|this is|it'?s) (wrong|not right|incorrect|not what)\b/i, weight: 0.4 },
  // Having to say it twice is the strongest signal of all — repetition is
  // exactly what makes a correction worth a rule — so it stands on its own.
  { name: "repeated", re: /\b(i (already )?(told|said|asked)|as i (said|mentioned)|like i said)\b/i, weight: 0.45 },
  // "again" alone is not: "can you run that again" is a request.
  { name: "again", re: /\bagain\b/i, weight: 0.15 },
  { name: "instead", re: /\b(instead of|rather than|should (have|be) \w+)\b/i, weight: 0.25 },
  { name: "always", re: /\balways\s+(use|write|put|keep|run|prefer)\b/i, weight: 0.3 },
  { name: "why", re: /\bwhy (did|are) you\b/i, weight: 0.3 },
  { name: "actually", re: /\bactually\b/i, weight: 0.1 },
  { name: "not_like_that", re: /\bnot like (that|this)\b/i, weight: 0.4 },
];

/** Below this, a turn is somebody thinking aloud rather than correcting. */
export const CORRECTION_THRESHOLD = 0.4;

export function scoreCorrection(text: string): { confidence: number; signals: readonly string[] } {
  const signals: string[] = [];
  let total = 0;
  for (const s of SIGNALS) {
    if (s.re.test(text)) {
      signals.push(s.name);
      total += s.weight;
    }
  }
  // A very long turn is usually a specification, not a correction, and a very
  // short one carries no rule worth keeping.
  const words = text.trim().split(/\s+/).length;
  if (words < 3) total *= 0.3;
  if (words > 200) total *= 0.5;
  return { confidence: Math.min(1, total), signals };
}


/* ------------------------------------------------------- what it is about */

/**
 * Whether a correction is about this repository or about the factory itself.
 *
 * These are two different things and the difference matters. "Use the api
 * client, not fetch" is this codebase's convention, and a guardrail here is
 * exactly right. "Stop attaching a screenshot of the title page and calling it
 * proof" is not about this codebase at all — it is a defect in how the factory
 * works, and a local guardrail for it is a private patch for a bug every other
 * factory also has. Hardened locally, it is fixed once for one person; sent
 * upstream, it is fixed once for everyone.
 *
 * Nothing routes on this yet: recording it now means the question can be asked
 * of history later instead of re-mining it, and it is already worth seeing on
 * the dashboard — a column of corrections marked `factory` is a list of bugs
 * somebody is working around.
 *
 * `repo` is the default and the safe one. A correction misread as a factory
 * defect would, once anything does route on this, leave a real convention
 * unenforced here.
 */
export type CorrectionTarget = "repo" | "factory";

/**
 * Words about the machinery rather than the code. Role names, the artefacts a
 * run produces, the things the factory does to a repository.
 */
const FACTORY_SIGNALS: readonly RegExp[] = [
  /\bfactory\b/i,
  /\b(the )?(builder|verifier|gardener|hardener|scorer|triage) (role|agent|keeps|should|is|did|never|always)\b/i,
  /\byou (keep|always|never) (open|opening|attach|attaching|file|filing) (a |the )?(pr|pull request|issue|screenshot|video|proof)\b/i,
  /\b(the )?(proof|screenshot|video|recording) (is|was|shows|never|just|only)\b/i,
  /\bstop (opening|filing|attaching|creating) (prs|pull requests|issues)\b/i,
  /\b(the )?(gate|gates|guardrail|baseline|ratchet|sandbox|work item|data ref)\b/i,
  /\bthe (bot|agent|app) (keeps|should|never|always|did)\b/i,
  /\b(spec|triage) (step|stage|role)\b/i,
  /\bauto[- ]?merge\b/i,
  /\brun (cost|budget|minutes)\b/i,
];

/** Where a correction is aimed, read from its own words. */
export function correctionTarget(text: string): { target: CorrectionTarget; signals: readonly string[] } {
  const signals = FACTORY_SIGNALS.filter((re) => re.test(text)).map((re) => re.source.slice(0, 28));
  return { target: signals.length > 0 ? "factory" : "repo", signals };
}

/* ------------------------------------------------------------ consent first */

export interface SessionSummary {
  readonly session: string;
  readonly source: string;
  readonly at: string | null;
  /** The session's opening message, so the user can recognise it. */
  readonly opening: string;
  readonly turns: number | null;
}

/**
 * List the sessions that *would* be read, without reading their contents.
 *
 * This exists because of the order phase 1 requires: list what was found,
 * let the user exclude any, and only then read one. These are their private
 * conversations on their own machine, some of which will have nothing to do
 * with this repository, so reading first and asking afterwards is not a thing
 * that can be undone by apologising.
 *
 * The opening message is the one piece of content shown, because a list of
 * session ids and dates is not something anyone can make a decision about.
 * It is redacted like everything else.
 */
export async function listSessions(opts: MineOptions): Promise<{
  available: boolean;
  sessions: readonly SessionSummary[];
  note: string;
}> {
  const run = opts.runMemex ?? defaultRunMemex;
  if (!(await memexAvailable(run))) {
    return { available: false, sessions: [], note: "memex is not installed, so there are no sessions to list." };
  }

  const args = [
    "sessions",
    "--cwd",
    opts.repoPath,
    "--format",
    "json",
    ...(opts.sources === undefined ? [] : opts.sources.flatMap((s) => ["--source", s])),
  ];

  let out: string;
  try {
    out = await run(args);
  } catch {
    return {
      available: true,
      sessions: [],
      note: "memex could not list sessions for this directory. Nothing was read.",
    };
  }

  const sessions = parseHits(out).map((h): SessionSummary => ({
    session: h.session_id ?? "unknown",
    source: h.source ?? "unknown",
    at: typeof h.ts === "number" ? new Date(h.ts).toISOString() : null,
    opening: redact((h.text ?? h.snippet ?? "").slice(0, 160)).trim(),
    turns: typeof h.turn_id === "number" ? h.turn_id : null,
  }));

  return {
    available: true,
    sessions,
    note:
      sessions.length === 0
        ? "memex found no sessions for this directory."
        : `${sessions.length} session(s) found. Nothing has been read yet: exclude any you would ` +
          "rather keep private, then mining reads only the rest.",
  };
}

/* ---------------------------------------------------------------- redaction */

/**
 * Strip anything secret-shaped before a mined turn goes anywhere.
 *
 * This is not optional and not delegated: mined text is written into the
 * repository's guardrail candidates, committed and pushed, and people paste
 * keys into agent chats. memex has redaction of its own, but it is applied on
 * some paths and not others, so the pass that matters is the one here —
 * immediately before the text leaves this process.
 */
type Replacement = string | ((match: string) => string);

const SECRETS: readonly { readonly re: RegExp; readonly as: Replacement }[] = [
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, as: "[github-token]" },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, as: "[api-key]" },
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, as: "[api-key]" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, as: "[aws-key-id]" },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, as: "[google-key]" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, as: "[slack-token]" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, as: "[private-key]" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, as: "[jwt]" },
  { re: /\b[a-z]+:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi, as: "[url-with-credentials]" },
  // Anything assigned to a secret-shaped name, whatever the value looks like:
  // the name is the evidence, so the value never needs inspecting.
  {
    re: /\b(password|passwd|secret|token|api[_-]?key)\b(\s*[:=]\s*)\S+/gi,
    as: (m: string) => `${m.split(/[:=]/)[0]!.trimEnd()}: [redacted]`,
  },
];

export function redact(text: string): string {
  let out = text;
  for (const s of SECRETS) {
    out = typeof s.as === "string" ? out.replace(s.re, s.as) : out.replace(s.re, s.as);
  }
  return out;
}

/* -------------------------------------------------------------------- memex */

export interface MineOptions {
  readonly repoPath: string;
  readonly sources?: readonly string[];
  readonly limitPerQuery?: number;
  readonly threshold?: number;
  /**
   * Sessions the user excluded. Mining drops their turns after the search,
   * because memex has no exclude filter — so the id is checked against this
   * list before a turn's text is kept, and an unidentifiable turn is dropped
   * rather than kept.
   */
  readonly excludeSessions?: readonly string[];
  /** Injected in tests. */
  readonly runMemex?: (args: readonly string[]) => Promise<string>;
}

export interface MineReport {
  readonly available: boolean;
  readonly corrections: readonly Correction[];
  readonly searched: number;
  readonly note: string;
}

/**
 * The queries. Several narrow ones rather than one broad one, because each
 * names a different way people correct an agent and memex ranks each
 * separately; fusing the results beats one query's idea of relevance.
 */
export const QUERIES: readonly string[] = [
  "no don't do that",
  "that's wrong",
  "revert that change",
  "you broke the build",
  "I already told you",
  "always use",
  "never do this",
  "not like that, instead",
];

async function defaultRunMemex(args: readonly string[]): Promise<string> {
  const { stdout } = await exec("memex", args, { maxBuffer: 64 * 1024 * 1024 });
  return String(stdout);
}

export async function memexAvailable(run = defaultRunMemex): Promise<boolean> {
  try {
    await run(["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function mineCorrections(opts: MineOptions): Promise<MineReport> {
  const run = opts.runMemex ?? defaultRunMemex;

  if (!(await memexAvailable(run))) {
    // Not an error: setup continues without mined guardrails, and says so.
    return {
      available: false,
      corrections: [],
      searched: 0,
      note:
        "memex is not installed, so past sessions were not read. Guardrails start from the " +
        "rule packs alone; install memex and re-run setup's guardrail phase to add the rest.",
    };
  }

  const threshold = opts.threshold ?? CORRECTION_THRESHOLD;
  const excluded = new Set(opts.excludeSessions ?? []);
  const seen = new Map<string, Correction>();
  let searched = 0;

  for (const query of QUERIES) {
    for (const source of opts.sources ?? [undefined]) {
      const args = [
        "search",
        query,
        "--cwd",
        opts.repoPath,
        // Only the user's own turns: an agent apologizing is not a correction.
        "--role",
        "user",
        "--format",
        "json",
        "--limit",
        String(opts.limitPerQuery ?? 25),
        ...(source === undefined ? [] : ["--source", source]),
      ];
      searched++;
      let out: string;
      try {
        out = await run(args);
      } catch {
        // One query failing (an unknown source, say) must not lose the rest.
        continue;
      }

      for (const hit of parseHits(out)) {
        const session = hit.session_id;
        if (excluded.size > 0) {
          // A turn whose session cannot be identified is dropped, not kept:
          // the user excluded something, and this might be it.
          if (session === undefined || excluded.has(session)) continue;
        }
        const text = hit.text ?? hit.snippet ?? "";
        if (text.trim() === "") continue;
        const { confidence, signals } = scoreCorrection(text);
        if (confidence < threshold) continue;

        // Redact before the text is kept anywhere, not on the way out.
        const clean = redact(text).trim();
        const key = `${hit.session_id ?? ""}:${hit.turn_id ?? clean.slice(0, 40)}`;
        const existing = seen.get(key);
        if (existing !== undefined && existing.confidence >= confidence) continue;

        seen.set(key, {
          text: clean,
          source: hit.source ?? "unknown",
          session: hit.session_id ?? "unknown",
          at: typeof hit.ts === "number" ? new Date(hit.ts).toISOString() : null,
          confidence: Math.round(confidence * 100) / 100,
          signals,
        });
      }
    }
  }

  const corrections = [...seen.values()].sort((a, b) => b.confidence - a.confidence);
  return {
    available: true,
    corrections,
    searched,
    note:
      corrections.length === 0
        ? "memex found no corrections in this repository's past sessions. Either the sessions are " +
          "elsewhere, or this repo has not been worked on with an agent that memex reads."
        : `${corrections.length} correction(s) found across ${searched} searches. Each is the user's ` +
          "own words, redacted of anything secret-shaped, and each is a rule they already wanted.",
  };
}

/** memex emits JSONL by default and a JSON array with --json-array. */
export function parseHits(out: string): readonly MemexHit[] {
  const trimmed = out.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as MemexHit[];
    } catch {
      return [];
    }
  }
  const hits: MemexHit[] = [];
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (t === "" || !t.startsWith("{")) continue;
    try {
      hits.push(JSON.parse(t) as MemexHit);
    } catch {
      // A progress line or a warning on stdout; the rest is still good.
    }
  }
  return hits;
}

/* --------------------------------------------------------------- clustering */

export interface CorrectionCluster {
  readonly theme: string;
  readonly corrections: readonly Correction[];
  readonly occurrences: number;
}

export const NOISE = new Set([
  "that", "this", "the", "and", "you", "your", "for", "with", "not", "dont", "don", "should",
  "would", "could", "have", "has", "was", "were", "are", "but", "its", "it", "all", "any",
  "use", "using", "used", "just", "like", "please", "can", "will", "did", "does", "about",
  "what", "when", "why", "how", "again", "actually", "instead", "always", "never", "stop",
]);

/**
 * Group corrections that are about the same thing.
 *
 * Shared significant words, because a correction repeated in different words
 * is still one rule — and the count is what decides whether it is worth a
 * guardrail. One correction is a preference; the same correction three times
 * is something the user should not have had to say three times.
 */
export function clusterCorrections(corrections: readonly Correction[]): readonly CorrectionCluster[] {
  const rawTerms = (c: Correction): string[] =>
    c.text
      .toLowerCase()
      // Issue and PR references are not content: they are unique per item, so
      // they cannot group anything, and they clutter a cluster's name.
      .replace(/\(#\d+\)|#\d+/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !NOISE.has(w));

  /**
   * A term common to most of the corpus distinguishes nothing.
   *
   * On a real repository this is what stops forty "fix: ..." commit subjects
   * collapsing into one cluster on the strength of the word "fix". Derived
   * from the corpus rather than kept as a hand-written list, because the
   * common words differ per repository — "fix" here, "migration" elsewhere —
   * and a list would always be the wrong one somewhere.
   */
  const frequency = new Map<string, number>();
  for (const c of corrections) {
    for (const w of new Set(rawTerms(c))) frequency.set(w, (frequency.get(w) ?? 0) + 1);
  }
  // Only where there is enough corpus for frequency to mean anything. Below
  // that, the commonest term in four corrections is often the very thing they
  // have in common — the signal, not the noise.
  const MIN_CORPUS = 15;
  const tooCommon = Math.ceil(corrections.length * 0.4);
  const distinguishing = (w: string): boolean =>
    corrections.length < MIN_CORPUS || (frequency.get(w) ?? 0) < tooCommon;

  const terms = (c: Correction): Set<string> => new Set(rawTerms(c).filter(distinguishing));

  /**
   * Matched against the cluster's *seed* terms, never against an accumulated
   * union.
   *
   * Growing the theme as items join is single-link clustering, and it drifts:
   * A shares two words with B, B shares two different words with C, and C
   * lands in A's cluster having nothing to do with it. On gh-aw's history that
   * pulled nine unrelated commits into one group. Holding the seed fixed keeps
   * a cluster about the thing it started as.
   */
  const clusters: { seed: Set<string>; items: Correction[] }[] = [];
  for (const c of corrections) {
    const t = terms(c);
    if (t.size === 0) continue;
    const match = clusters.find((cl) => {
      const shared = [...t].filter((w) => cl.seed.has(w)).length;
      // Two shared distinguishing terms, or one when there is only one to
      // share — "no any" and "stop using any" are the same rule.
      return shared >= 2 || (Math.min(t.size, cl.seed.size) <= 2 && shared >= 1);
    });
    if (match === undefined) clusters.push({ seed: t, items: [c] });
    else match.items.push(c);
  }

  return clusters
    .map((cl) => ({
      // The most confident correction's own words name the cluster: a theme
      // built from keywords reads like a tag cloud and tells nobody anything.
      theme: cl.items[0]!.text.slice(0, 120),
      corrections: cl.items,
      occurrences: cl.items.length,
    }))
    .sort((a, b) => b.occurrences - a.occurrences || b.corrections[0]!.confidence - a.corrections[0]!.confidence);
}

/* --------------------------------------------------------- guardrail candidates */

/**
 * What mining produces: a pending candidate whose source is whatever the
 * finder actually read (a chat, a revert, a review, a bug, a written rule).
 * The shared file's wider type is `Candidate` in lib/types.
 */
export interface MinedCandidate extends Candidate {
  readonly sources: readonly CandidateSource[];
  readonly status: "pending";
}

/**
 * memex's source names, as its own `SourceKind` spells them, mapped to the
 * harness ids the schemas use. A name memex reports that is not here is left
 * off the candidate rather than guessed at, because `harness` is a closed enum
 * and a wrong value would make the whole candidates file invalid.
 */
const HARNESS_BY_MEMEX_SOURCE: Readonly<Record<string, Harness>> = {
  claude: "claude-code",
  cursor: "cursor-cli",
  pi: "pi",
  kilocode: "kilo-code",
  hermes: "hermes-agent",
};

/**
 * What kind of fix a correction is asking for.
 *
 * The order matters: it mirrors hardening's own ordered check (doc 06), where
 * the strongest available fix wins. A correction about a shape the code could
 * forbid wants an API change; one about a pattern a linter could catch wants a
 * rule; one about behaviour wants a verification scenario; and only what none
 * of those can hold becomes a line of context.
 */
export function proposedFix(text: string): Candidate["proposed_fix"] {
  const t = text.toLowerCase();
  if (/\b(type|types|interface|signature|argument|parameter|return|enum|schema)\b/.test(t)) {
    return "api_change";
  }
  if (/\b(import|lint|format|naming|convention|unused|any|console\.log|style|pattern)\b/.test(t)) {
    return "static_rule";
  }
  if (/\b(test|tests|screenshot|click|render|flow|behaviou?r|broke|regression|works)\b/.test(t)) {
    return "verification";
  }
  // A standing prohibition or obligation is a rule, not a preference. Checked
  // last so a sentence that already names a type, a lint, or a behaviour
  // keeps that stronger fix.
  if (/\b(?:do not|don['’]t|dont|never|must|always|forbidden|prohibit|shall not)\b/.test(t)) {
    return "static_rule";
  }
  return "context";
}

/**
 * Which candidate source a mined record is.
 *
 * Chat turns stay agent chats. A revert, a written rule, a review, a bug,
 * or a fix that the classifier admitted keeps the source it actually came
 * from, so a reviewer can open that commit or comment.
 *
 * source: the correction's source name, such as "revert" or "cursor".
 */
export function sourceKind(source: string): CandidateSourceKind {
  if (source === "revert" || source === "fix_commit" || source === "prose_rule" || source === "bug") return source;
  if (source === "review") return "review_comment";
  return "agent_chat";
}

/** Turn clustered corrections into candidates the hardener can act on. */
export function candidatesFrom(
  clusters: readonly CorrectionCluster[],
  now: string,
): readonly MinedCandidate[] {
  return clusters.map((cl, i) => {
    const times = cl.corrections.map((c) => c.at).filter((a): a is string => a !== null).sort();
    const quotes = cl.corrections.slice(0, 5);
    const enforced = cl.corrections.map((c) => c.enforcement).filter((e) => e !== undefined);
    const sameEnforcement = enforced.length === cl.corrections.length && enforced.every((e) => e === enforced[0]);
    return {
      id: candidateId((Date.parse(now) || Date.now()) + i),
      problem_class: cl.theme,
      occurrences: cl.occurrences,
      ...(times[0] === undefined ? {} : { first_seen: times[0] }),
      ...(times[times.length - 1] === undefined ? {} : { last_seen: times[times.length - 1] }),
      sources: quotes.map((c) => {
        const harness = HARNESS_BY_MEMEX_SOURCE[c.source];
        return {
          kind: sourceKind(c.source),
          ...(harness === undefined ? {} : { harness }),
          session: c.session,
          // Already redacted when the correction was kept, not here.
          quote: c.text.slice(0, 500),
          ...(c.at === null ? {} : { at: c.at }),
        };
      }),
      proposed_fix: sameEnforcement ? enforced[0]! : proposedFix(cl.corrections.map((c) => c.text).join(" ")),
      // The cluster's own text decides, not one member's: a theme is what the
      // corrections have in common.
      target: correctionTarget(cl.corrections.map((c) => c.text).join(" ")).target,
      status: "pending" as const,
    };
  });
}

"use client";

import { routingCandidates } from "./routing";
import { FACTORY_YAML } from "./settings";

import { questionFrom, type Waiting } from "./questions";
import { readFirstRequest, type FirstRequest } from "./request";
import { useCallback, useEffect, useRef, useState } from "react";
import { GitHubClient, GitHubHttpError, type Auth } from "./github";
import { demoFetch, isDemo } from "./demo";
import { overlayDecisions, correctionCandidates, correctionsOf } from "./corrections";
import type {
  IndexFile, LedgerFile, LiveFile, RunFile, BaselinesFile, CoverageFile, CandidatesFile,
  ReviewFile, StoredRoleReport, DecisionsFile, WorkItemDoc, StandingGoalsFile, LedgerOpenItem,
} from "./types";

/**
 * Reading the factory's records, with the refresh rates the spec asks for:
 * the index every 60s, the ledger every 15s on the pages that show open work,
 * and the live status files every 5s.
 *
 * Polling stops when the tab is hidden. A dashboard left open on a second
 * monitor should not spend the user's rate limit all day.
 */

export type Loaded<T> =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly data: T; readonly at: Date }
  | { readonly state: "error"; readonly error: string; readonly retry: () => void };

export function useClient(auth: Auth | null): GitHubClient | null {
  const [client, setClient] = useState<GitHubClient | null>(null);
  // The two fields rather than the object: a caller that rebuilds an equal
  // `auth` on every render would otherwise make a new client each time, and
  // every poller downstream would restart.
  const token = auth?.token ?? null;
  const repo = auth?.repo ?? null;
  useEffect(() => {
    // Demo mode hands the same client a stand-in for GitHub, so every page runs its real code.
    setClient(
      token === null || repo === null
        ? null
        : new GitHubClient({ token, repo }, isDemo(token, repo) ? demoFetch() : undefined),
    );
  }, [token, repo]);
  return client;
}

function useVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const onChange = (): void => setVisible(!document.hidden);
    onChange();
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

export function usePolled<T>(
  load: (() => Promise<T>) | null,
  everyMs: number,
  deps: readonly unknown[] = [],
): Loaded<T> {
  const [result, setResult] = useState<Loaded<T>>({ state: "loading" });
  const visible = useVisible();
  const tick = useRef(0);
  // `load` is a new closure on every render. Keeping it in a ref, and keying
  // the effect on the caller's `deps` instead, stops each result from starting
  // the next request. Each call site lists what its `load` depends on.
  const loadRef = useRef(load);
  loadRef.current = load;
  const hasLoad = load !== null;

  const run = useCallback(async () => {
    const current = loadRef.current;
    if (current === null) return;
    const mine = ++tick.current;
    try {
      const data = await current();
      if (tick.current === mine) setResult({ state: "ready", data, at: new Date() });
    } catch (err) {
      if (tick.current !== mine) return;
      const message =
        err instanceof GitHubHttpError ? err.human : ((err as Error).message ?? "Something went wrong.");
      setResult({ state: "error", error: message, retry: () => void run() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps]);

  useEffect(() => {
    if (!hasLoad) return;
    void run();
    if (!visible) return;
    const id = setInterval(() => void run(), everyMs);
    return () => clearInterval(id);
  }, [run, everyMs, visible, hasLoad]);

  return result;
}

export function useIndex(client: GitHubClient | null): Loaded<IndexFile | null> {
  const load = client === null ? null : () => client.fileFromRef<IndexFile>("index.json");
  return usePolled(load, 60_000, [client?.repo]);
}

export function useLedger(client: GitHubClient | null, fast = false): Loaded<LedgerFile | null> {
  const load = client === null ? null : () => client.fileFromRef<LedgerFile>("ledger.json");
  return usePolled(load, fast ? 15_000 : 60_000, [client?.repo, fast]);
}

export function useLive(client: GitHubClient | null): Loaded<readonly LiveFile[]> {
  const load =
    client === null
      ? null
      : async (): Promise<readonly LiveFile[]> => {
          const refs = await client.liveRefs();
          const files = await Promise.all(
            refs.map((r) => client.fileFromRef<LiveFile>("status.json", r.ref)),
          );
          return files.filter((f): f is LiveFile => f !== null);
        };
  return usePolled(load, 5_000, [client?.repo]);
}

export function useGuardrails(client: GitHubClient | null): Loaded<{
  readonly baselines: BaselinesFile | null;
  readonly coverage: CoverageFile | null;
  readonly candidates: CandidatesFile | null;
}> {
  const load =
    client === null
      ? null
      : async () => {
          // The rules, baselines and candidates are files in the repo, changed by
          // reviewed PRs; only what people decided about candidates is on the data ref.
          const [baselines, coverage, candidates, decisions] = await Promise.all([
            client.fileFromRepo<BaselinesFile>(".factory/guardrails/baselines.json"),
            client.fileFromRepo<CoverageFile>(".factory/guardrails/coverage.json"),
            client.fileFromRepo<CandidatesFile>(".factory/guardrails/candidates.json"),
            client.fileFromRef<DecisionsFile>("guardrails/candidate-decisions.json"),
          ]);
          return { baselines, coverage, candidates: overlayDecisions(candidates, decisions) };
        };
  return usePolled(load, 60_000, [client?.repo]);
}

/**
 * The corrections the factory has hardened against, newest first, each with the
 * words that started it. Reads the hardening work items the ledger knows
 * about; a merged item's pipeline is only in its own file, so the most recent
 * few are opened.
 */
export function useCorrections(client: GitHubClient | null, ledger: LedgerFile | null): Loaded<readonly WorkItemDoc[]> {
  const ids = ledger === null ? null : correctionCandidates(ledger.open, ledger.recent);
  const load =
    client === null || ids === null
      ? null
      : async () => {
          const docs = await Promise.all(ids.map((id) => client.fileFromRef<WorkItemDoc>(`work-items/${id}.json`)));
          return correctionsOf(docs.filter((d): d is WorkItemDoc => d !== null));
        };
  return usePolled(load, 60_000, [client?.repo, ids?.join(",")]);
}

/**
 * What the Improvement page needs: the recent reviews.
 *
 * Polled slowly, because a review happens every few days, not every minute,
 * and only the most recent few are read in full: a factory a year old would
 * otherwise fetch hundreds of files to draw one page.
 */
export function useImprovement(client: GitHubClient | null): Loaded<{
  readonly reviews: readonly ReviewFile[];
}> {
  const load =
    client === null
      ? null
      : async () => {
          const reviewNames = await client.listFromRef("reviews");
          const reviews = await Promise.all(
            reviewNames.slice(0, 10).map((n) => client.fileFromRef<ReviewFile>(`reviews/${n}`)),
          );
          return { reviews: reviews.filter((r): r is ReviewFile => r !== null) };
        };
  return usePolled(load, 300_000, [client?.repo]);
}

export function useRun(client: GitHubClient | null, id: string | null): Loaded<RunFile | null> {
  const load =
    client === null || id === null ? null : () => client.fileFromRef<RunFile>(`runs/${id}.json`);
  return usePolled(load, 60_000, [client?.repo, id]);
}

/** What the verifier kept as proof for a work item: screenshots, recordings, logs. */
export function useVerifierReport(client: GitHubClient | null, workItem: string | null): Loaded<StoredRoleReport | null> {
  const load =
    client === null || workItem === null
      ? null
      : () => client.fileFromRef<StoredRoleReport>(`reports/${workItem}/verifier.json`);
  return usePolled(load, 60_000, [client?.repo, workItem]);
}

/** What the factory asked, for each item waiting on an answer. Keyed by issue number. */
export function useQuestions(
  client: GitHubClient | null,
  waiting: readonly Waiting[],
): Loaded<Readonly<Record<number, string | null>>> {
  const issues = waiting.flatMap((w) => (w.issue === null ? [] : [w.issue]));
  const load =
    client === null || issues.length === 0
      ? null
      : async () => {
          const entries = await Promise.all(
            issues.map(async (n) => [n, questionFrom(await client.issueComments(n))] as const),
          );
          return Object.fromEntries(entries);
        };
  return usePolled(load, 30_000, [client?.repo, issues.join(",")]);
}

/** The first request setup left, offered only while the factory has done nothing yet. */
export function useFirstRequest(client: GitHubClient | null, empty: boolean): Loaded<FirstRequest | null> {
  const load =
    client === null || !empty
      ? null
      : async () => readFirstRequest(await client.fileFromRepo<unknown>(".factory/first-request.json"));
  return usePolled(load, 120_000, [client?.repo, empty]);
}

/** The factory's settings, as the Factory page's controls read them. Bump `version` to read again after a change. */
export function useFactorySettings(client: GitHubClient | null, version = 0): Loaded<string | null> {
  const load = client === null ? null : async () => (await client.textFromRepo(FACTORY_YAML))?.text ?? null;
  return usePolled(load, 120_000, [client?.repo, version]);
}

/** Who the factory acts for: everyone with write access. Null when the token cannot list them. */
export function useWriters(client: GitHubClient | null): Loaded<readonly { login: string; role: string }[] | null> {
  const load =
    client === null
      ? null
      : async () => {
          try { return await client.writers(); } catch { return null; }
        };
  return usePolled(load, 300_000, [client?.repo]);
}

/** Routing detail for each open work item, keyed by id. */
export function useRouting(client: GitHubClient | null, open: readonly LedgerOpenItem[]): Loaded<Readonly<Record<string, WorkItemDoc>>> {
  const ids = routingCandidates(open);
  const load =
    client === null || ids.length === 0
      ? null
      : async () => {
          const docs = await Promise.all(ids.map((id) => client.fileFromRef<WorkItemDoc>(`work-items/${id}.json`)));
          return Object.fromEntries(docs.flatMap((d) => (d === null ? [] : [[d.id, d] as const])));
        };
  return usePolled(load, 60_000, [client?.repo, ids.join(",")]);
}

export function useStandingGoals(client: GitHubClient | null): Loaded<StandingGoalsFile | null> {
  const load = client === null ? null : () => client.fileFromRef<StandingGoalsFile>("standing-goals.json");
  return usePolled(load, 60_000, [client?.repo]);
}

/**
 * The conversation the factory has been having about a request.
 *
 * Shown in the dashboard so answering is a reply in a thread rather than
 * typing into a box with no idea what was already said. The log lives on the
 * data ref; a request that was never asked about has none, and that is not an
 * error — it just means this is the first thing anybody said.
 */
export interface BrainstormFile {
  readonly work_item: string;
  readonly turns: readonly { readonly at: string; readonly who: "factory" | "person"; readonly text: string }[];
  readonly understood: string | null;
  readonly open: readonly string[];
  readonly closed_at?: string;
  /** The run holding the conversation open, and when it last said so. */
  readonly holder?: string;
  readonly heartbeat_at?: string;
  /**
   * The words the conversation settled on and taught the person.
   *
   * `named` is the useful one for a surface: "what the factory thinks this is",
   * in one sentence, which is a far better line to show beside a request than
   * its issue title. The rest is there for anyone who wants to show the
   * vocabulary itself. All of it is the conversation's unverified claim — it
   * had no web access — so do not present a term as established fact.
   */
  readonly frame?: {
    readonly named?: string;
    readonly reading_taken?: string;
    readonly readings?: readonly { readonly problem: string; readonly term: string; readonly tells_it_apart: string }[];
    readonly terms?: readonly {
      readonly term: string;
      readonly means: string;
      readonly names: string;
      readonly prior_art?: string;
      readonly unlocks: string;
    }[];
    readonly neighbors?: readonly {
      readonly field: string;
      readonly carries_over: string;
      readonly breaks_down: string;
      readonly terms?: readonly string[];
    }[];
    readonly unmentioned?: readonly string[];
  };
}

/**
 * How long a heartbeat is worth trusting. The holder refreshes it on every
 * poll, so a gap this long means that job is gone rather than busy.
 * HEARTBEAT_STALE_MS in the runner, kept the same here on purpose.
 */
const HEARTBEAT_STALE_MS = 90_000;

/**
 * Is a job listening right now?
 *
 * The difference the person feels. Live, their reply is answered in seconds by
 * the session that asked the question. Not live, their comment starts a run,
 * which takes minutes to wake up. Those are two different experiences and the
 * interface has no business showing them the same way.
 */
export function conversationLive(b: BrainstormFile | null, now: Date = new Date()): boolean {
  if (b === null || b.closed_at !== undefined) return false;
  if (b.holder === undefined || b.heartbeat_at === undefined) return false;
  const beat = Date.parse(b.heartbeat_at);
  if (Number.isNaN(beat)) return false;
  // A heartbeat from the future is a clock disagreement, not liveness.
  return beat <= now.getTime() + 5_000 && now.getTime() - beat < HEARTBEAT_STALE_MS;
}

export function useBrainstorm(client: GitHubClient | null, workItem: string | null, version = 0): Loaded<BrainstormFile | null> {
  const load =
    client === null || workItem === null
      ? null
      : () => client.fileFromRef<BrainstormFile>(`brainstorms/${workItem}.json`);
  // Faster than the other polls: while a conversation is live the person is
  // sitting there waiting for a reply, and thirty seconds of nothing reads as
  // broken even when the answer arrived in five.
  return usePolled(load, 5_000, [client?.repo, workItem, version]);
}

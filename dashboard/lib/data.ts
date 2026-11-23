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

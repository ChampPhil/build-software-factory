"use client";

import type { BudgetFile, StepRecord } from "./spend";
import { isFactoryHealthIssue } from "./view";
import { routingCandidates } from "./routing";
import { FACTORY_YAML } from "./settings";

import { questionFrom, type Waiting } from "./questions";
import { readFirstRequest, type FirstRequest } from "./request";
import { useCallback, useEffect, useRef, useState } from "react";
import { GitHubClient, GitHubHttpError, type Auth, type PullSummary, type IssueSummary, type PullDetail, type PullFile, type CheckRunSummary, type WorkflowSummary, type WorkflowRunSummary } from "./github";
import type { IssueComment } from "./questions";
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

/** One row on the settings screen. It has a name and where it was read. No value. */
export interface WaitingSetting {
  readonly name: string;
  readonly where: string;
  readonly decision: "missing" | "use" | "fake" | "ignore" | "replace";
  readonly client: boolean;
}

/** The file the settings screen reads. It has no secret values. */
export interface WaitingSettings {
  readonly names: readonly WaitingSetting[];
  readonly dynamic: readonly string[];
  readonly sign_in: readonly string[];
  readonly waiting: number;
}

/**
 * The settings that are waiting on a decision.
 *
 * client: the signed-in dashboard, or null before sign-in.
 * version: bumps after a save so the list is read again.
 * Returns the wait file, or null when this repository has not scanned yet.
 */
export function useWaitingSettings(client: GitHubClient | null, version: number): Loaded<WaitingSettings | null> {
  const load = client === null ? null : () => client.fileFromRef<WaitingSettings>("env/wait.json");
  return usePolled(load, 15_000, [client?.repo, version]);
}

export function useIndex(client: GitHubClient | null): Loaded<IndexFile | null> {
  const load = client === null ? null : () => client.fileFromRef<IndexFile>("index.json");
  return usePolled(load, 60_000, [client?.repo]);
}

/**
 * The runner's monthly spend ledger, `budget.json` on the factory data ref.
 *
 * Same read as index.json and ledger.json. Null when the file is not there
 * yet. The Spend page uses it so an empty `recent_runs` list cannot hide
 * charges that were written here, including setup.
 *
 * client: the signed-in GitHub client, or null before sign-in.
 */
export function useBudget(client: GitHubClient | null): Loaded<BudgetFile | null> {
  const load = client === null ? null : () => client.fileFromRef<BudgetFile>("budget.json");
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


/* ------------------------------------------------------------------ GitHub's side of the factory */

/** Open pull requests. Bump `version` after an action to read again straight away. */
export function usePulls(client: GitHubClient | null, version = 0): Loaded<readonly PullSummary[]> {
  const load = client === null ? null : () => client.pulls("open");
  return usePolled(load, 30_000, [client?.repo, version]);
}

/** Open issues, without the pull requests GitHub lists among them. */
/** Open issues that are requests: the factory's own health issues are left out (see useHealthIssues). */
export function useIssues(client: GitHubClient | null, version = 0): Loaded<readonly IssueSummary[]> {
  const load = client === null ? null : async () => (await client.issues()).filter((i) => i.pull_request === undefined && !isFactoryHealthIssue(i));
  return usePolled(load, 30_000, [client?.repo, version]);
}

/** Issues about the factory's own health: workflow failures filed by gh-aw and factory_health items. */
export function useHealthIssues(client: GitHubClient | null, version = 0): Loaded<readonly IssueSummary[]> {
  const load = client === null ? null : async () => (await client.issues()).filter((i) => i.pull_request === undefined && isFactoryHealthIssue(i));
  return usePolled(load, 60_000, [client?.repo, version]);
}

export function usePull(client: GitHubClient | null, n: number | null, version = 0): Loaded<PullDetail | null> {
  const load =
    client === null || n === null
      ? null
      : async () => {
          try { return await client.pull(n); } catch (e) { if (e instanceof GitHubHttpError && e.status === 404) return null; throw e; }
        };
  return usePolled(load, 30_000, [client?.repo, n, version]);
}

export function usePullFiles(client: GitHubClient | null, n: number | null, version = 0): Loaded<readonly PullFile[]> {
  const load = client === null || n === null ? null : () => client.pullFiles(n);
  return usePolled(load, 120_000, [client?.repo, n, version]);
}

/** The checks on a commit. Empty rather than an error when the token cannot read checks. */
export function useCheckRuns(client: GitHubClient | null, sha: string | null): Loaded<readonly CheckRunSummary[]> {
  const load =
    client === null || sha === null
      ? null
      : async () => {
          try { return await client.checkRuns(sha); } catch { return []; }
        };
  return usePolled(load, 30_000, [client?.repo, sha]);
}

/** The comments on an issue or pull request, oldest first. */
export function useIssueComments(client: GitHubClient | null, n: number | null, version = 0): Loaded<readonly IssueComment[]> {
  const load = client === null || n === null ? null : () => client.issueComments(n);
  return usePolled(load, 20_000, [client?.repo, n, version]);
}

/** The work item files for a set of ids, keyed by id. A missing file is simply absent. */
export function useWorkItems(client: GitHubClient | null, ids: readonly string[]): Loaded<Readonly<Record<string, WorkItemDoc>>> {
  const key = ids.join(",");
  const load =
    client === null
      ? null
      : async () => {
          const docs = await Promise.all(ids.map((id) => client.fileFromRef<WorkItemDoc>(`work-items/${id}.json`).catch(() => null)));
          return Object.fromEntries(docs.flatMap((d) => (d === null ? [] : [[d.id, d] as const])));
        };
  return usePolled(load, 60_000, [client?.repo, key]);
}

/** Run files for a set of ids, in the order given. */
export function useRunFiles(client: GitHubClient | null, ids: readonly string[]): Loaded<readonly RunFile[]> {
  const key = ids.join(",");
  const load =
    client === null
      ? null
      : async () => {
          const runs = await Promise.all(ids.map((id) => client.fileFromRef<RunFile>(`runs/${id}.json`).catch(() => null)));
          return runs.filter((r): r is RunFile => r !== null);
        };
  return usePolled(load, 60_000, [client?.repo, key]);
}

/** Every step record for the given runs (`steps/<run>/*.json`), the ledger of what was actually spent. */
export function useStepRecords(client: GitHubClient | null, runIds: readonly string[]): Loaded<readonly StepRecord[]> {
  const key = runIds.join(",");
  const load =
    client === null
      ? null
      : async () => {
          const perRun = await Promise.all(
            runIds.map(async (id) => {
              const names = await client.listFromRef(`steps/${id}`).catch(() => [] as readonly string[]);
              const docs = await Promise.all(names.map((n) => client.fileFromRef<StepRecord>(`steps/${id}/${n}`).catch(() => null)));
              return docs.filter((d): d is StepRecord => d !== null);
            }),
          );
          return perRun.flat();
        };
  return usePolled(load, 60_000, [client?.repo, key]);
}

/**
 * The factory's workflows and their recent runs on GitHub Actions. Null when
 * the token cannot read Actions, which is a thing to say once on the Factory
 * page rather than an error on every page.
 */
/**
 * The sentence for a setup run that is still going, or null when setup is idle.
 *
 * The job name on the run is that sentence. Several computers at once are
 * joined, so the briefing says the same thing the setup chat says. A run
 * whose jobs cannot be read still says that setup is running.
 *
 * client: the signed-in GitHub client, or null before sign-in.
 * runs: recent workflow runs, or null while those are still loading.
 */
export function useSetupSentence(client: GitHubClient | null, runs: readonly WorkflowRunSummary[] | null): Loaded<string | null> {
  const setup = (runs ?? []).find((r) => r.status !== "completed" && /factory-setup/.test(`${r.path ?? ""} ${r.name}`));
  const load =
    client === null || runs === null
      ? null
      : async () => {
          if (setup === undefined) return null;
          try {
            const jobs = await client.workflowJobs(setup.id);
            const live = jobs.filter((j) => j.status !== "completed").map((j) => j.name);
            return live.length > 0 ? live.join(" ") : "Setup is running.";
          } catch {
            return "Setup is running.";
          }
        };
  return usePolled(load, 60_000, [client?.repo, setup?.id ?? 0, runs === null ? "loading" : "ready"]);
}

export function useActions(client: GitHubClient | null, version = 0): Loaded<{
  readonly workflows: readonly WorkflowSummary[];
  readonly runs: readonly WorkflowRunSummary[];
} | null> {
  const load =
    client === null
      ? null
      : async () => {
          try {
            const [workflows, runs] = await Promise.all([client.workflows(), client.workflowRuns()]);
            return { workflows: workflows.filter((w) => /factory-/.test(w.path)), runs };
          } catch {
            return null;
          }
        };
  return usePolled(load, 30_000, [client?.repo, version]);
}

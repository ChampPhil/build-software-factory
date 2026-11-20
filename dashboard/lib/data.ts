"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GitHubClient, GitHubHttpError, type Auth } from "./github";
import type {
  IndexFile, LedgerFile, LiveFile, RunFile, BaselinesFile, CoverageFile, CandidatesFile,
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
    setClient(token === null || repo === null ? null : new GitHubClient({ token, repo }));
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

  const run = useCallback(async () => {
    if (load === null) return;
    const mine = ++tick.current;
    try {
      const data = await load();
      if (tick.current === mine) setResult({ state: "ready", data, at: new Date() });
    } catch (err) {
      if (tick.current !== mine) return;
      const message =
        err instanceof GitHubHttpError ? err.human : ((err as Error).message ?? "Something went wrong.");
      setResult({ state: "error", error: message, retry: () => void run() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

  useEffect(() => {
    if (load === null) return;
    void run();
    if (!visible) return;
    const id = setInterval(() => void run(), everyMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, everyMs, visible, load === null]);

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
          const [baselines, coverage, candidates] = await Promise.all([
            client.fileFromRef<BaselinesFile>("guardrails/baselines.json"),
            client.fileFromRef<CoverageFile>("guardrails/coverage.json"),
            client.fileFromRef<CandidatesFile>("guardrails/candidates.json"),
          ]);
          return { baselines, coverage, candidates };
        };
  return usePolled(load, 60_000, [client?.repo]);
}

export function useRun(client: GitHubClient | null, id: string | null): Loaded<RunFile | null> {
  const load =
    client === null || id === null ? null : () => client.fileFromRef<RunFile>(`runs/${id}.json`);
  return usePolled(load, 60_000, [client?.repo, id]);
}

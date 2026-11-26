"use client";

import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { GitHubClient, IssueSummary, PullSummary } from "@/lib/github";
import { GitHubHttpError } from "@/lib/github";
import type { Loaded } from "@/lib/data";
import type { CandidatesFile, CoverageFile, BaselinesFile, IndexFile, LedgerFile, LiveFile } from "@/lib/types";
import type { FirstRequest } from "@/lib/request";
import { Dialog, autoGrow } from "@/components/ui";

/**
 * What every page shares: who is signed in, the client, the factory's core
 * records (read once by the shell, so moving between pages is instant and the
 * rate limit is spent once), and the three ways the interface talks back: a
 * toast for something done, a question for something that needs a word, and
 * the new-request form.
 */
export interface App {
  readonly repo: string;
  readonly demo: boolean;
  readonly client: GitHubClient;
  /** Bumped after every action, so the reads that depend on it run again at once. */
  readonly version: number;
  readonly bump: () => void;
  readonly index: Loaded<IndexFile | null>;
  readonly ledger: Loaded<LedgerFile | null>;
  readonly live: Loaded<readonly LiveFile[]>;
  readonly pulls: Loaded<readonly PullSummary[]>;
  readonly issues: Loaded<readonly IssueSummary[]>;
  readonly guardrails: Loaded<{ readonly baselines: BaselinesFile | null; readonly coverage: CoverageFile | null; readonly candidates: CandidatesFile | null }>;
  /** The factory's settings file as text; null when there is none. */
  readonly settings: Loaded<string | null>;
  readonly installed: boolean | null;
  readonly toast: (text: string) => void;
  /**
   * Run an action against GitHub and say how it went. Returns whether it worked.
   * A refusal (the demo, a missing permission) is said in words, never thrown.
   */
  readonly act: (fn: () => Promise<unknown>, done: string, optimistic?: import("@/lib/optimistic").Optimistic) => Promise<boolean>;
  /** Ask for a few words before an action: a reason, a note, a comment. Null when cancelled. */
  readonly ask: (q: Ask) => Promise<string | null>;
  readonly compose: (initial?: FirstRequest & { kind?: string }) => void;
}

export interface Ask {
  readonly title: string;
  readonly body?: string;
  readonly placeholder?: string;
  readonly confirm: string;
  /** A question that only needs a yes. */
  readonly noText?: boolean;
  readonly danger?: boolean;
  readonly initial?: string;
}

const Ctx = createContext<App | null>(null);
export const AppProvider = Ctx.Provider;

export function useApp(): App {
  const app = useContext(Ctx);
  if (app === null) throw new Error("useApp outside the signed-in shell");
  return app;
}

export function explain(e: unknown): string {
  if (e instanceof GitHubHttpError) return e.human;
  if (e instanceof Error && e.message !== "") return e.message;
  return "That did not go through. Try again in a moment.";
}

/** Toasts and the ask dialog, which the shell renders once. */
export function useTalkBack(): {
  toast: (text: string) => void;
  ask: (q: Ask) => Promise<string | null>;
  layer: ReactNode;
} {
  const [toasts, setToasts] = useState<readonly { id: number; text: string }[]>([]);
  const next = useRef(1);
  const toast = useCallback((text: string) => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-2), { id, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const [asking, setAsking] = useState<(Ask & { resolve: (v: string | null) => void }) | null>(null);
  const ask = useCallback((q: Ask) => new Promise<string | null>((resolve) => setAsking({ ...q, resolve })), []);
  const close = useCallback(
    (v: string | null) => {
      setAsking((a) => {
        a?.resolve(v);
        return null;
      });
    },
    [],
  );

  const layer = useMemo(
    () => (
      <>
        {asking !== null && <AskDialog q={asking} onDone={close} />}
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div className="toast" key={t.id}>
              <span>{t.text}</span>
              <button className="link" type="button" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
                Dismiss
              </button>
            </div>
          ))}
        </div>
      </>
    ),
    [asking, toasts, close],
  );
  return { toast, ask, layer };
}

function AskDialog({ q, onDone }: { q: Ask; onDone: (v: string | null) => void }) {
  const [text, setText] = useState(q.initial ?? "");
  const cancel = useCallback(() => onDone(null), [onDone]);
  return (
    <Dialog title={q.title} onClose={cancel} size="small">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (q.noText !== true && text.trim() === "") return;
          onDone(q.noText === true ? "" : text.trim());
        }}
      >
        {q.body !== undefined && <p>{q.body}</p>}
        {q.noText !== true && (
          <textarea
            className="field"
            rows={3}
            data-autofocus
            value={text}
            placeholder={q.placeholder}
            aria-label={q.title}
            onChange={(e) => {
              setText(e.target.value);
              autoGrow(e.target);
            }}
          />
        )}
        <div className="acts end">
          <button className="btn quiet" type="button" onClick={cancel}>
            Cancel
          </button>
          <button className={q.danger === true ? "btn danger" : "btn go"} type="submit" disabled={q.noText !== true && text.trim() === ""} {...(q.noText === true ? { "data-autofocus": true } : {})}>
            {q.confirm}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

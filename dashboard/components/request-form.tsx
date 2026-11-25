"use client";

import { useState } from "react";
import { buildRequest, REQUEST_KINDS, type FirstRequest, type RequestKind } from "@/lib/request";
import { useApp, explain } from "@/components/app";
import { Out } from "@/components/ui";

/**
 * Start work from the dashboard. It files an issue shaped like the factory's
 * own forms, so a request typed here and one opened on GitHub reach intake the
 * same way, and the factory answers on the issue and here.
 */
export function RequestForm({
  initial,
  first = false,
  onSent,
  onCancel,
}: {
  initial?: (FirstRequest & { kind?: string }) | undefined;
  first?: boolean;
  onSent?: (issue: { number: number; url: string }) => void;
  onCancel?: () => void;
}) {
  const { client, bump, toast } = useApp();
  const startKind = REQUEST_KINDS.some((k) => k.kind === initial?.kind) ? (initial?.kind as RequestKind) : "feature";
  const [kind, setKind] = useState<RequestKind>(startKind);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [details, setDetails] = useState(initial?.details ?? "");
  const [goal, setGoal] = useState(initial?.goal ?? "");
  const [state, setState] = useState<"idle" | "sending" | { error: string } | { number: number; url: string }>("idle");

  const built = buildRequest({ kind, title, details, goal });

  const send = async (): Promise<void> => {
    if (built === null) return;
    setState("sending");
    try {
      const issue = await client.createIssue(built.title, built.body, built.labels);
      setState({ number: issue.number, url: issue.html_url });
      toast(`Sent as issue #${issue.number}. The factory reads it within a minute.`);
      bump();
      onSent?.({ number: issue.number, url: issue.html_url });
    } catch (e) {
      setState({ error: explain(e) });
    }
  };

  if (typeof state === "object" && "number" in state) {
    return (
      <div className={first ? "request-form first" : "request-form"}>
        <p className="voice">Sent. The factory will ask what it needs to know on issue #{state.number}, and here.</p>
        <div className="acts">
          <Out href={state.url}>Open #{state.number} on GitHub</Out>
          {onCancel !== undefined && (
            <button className="btn" type="button" onClick={onCancel}>
              Done
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <form
      className={first ? "request-form first" : "request-form"}
      aria-label="New request"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="kinds" role="radiogroup" aria-label="Kind of request">
        {REQUEST_KINDS.map((k) => (
          <label className="kind" key={k.kind}>
            <input type="radio" name="kind" value={k.kind} checked={kind === k.kind} onChange={() => setKind(k.kind)} />
            <span>
              <b>{k.label}</b>
              {k.hint}
            </span>
          </label>
        ))}
      </div>
      <label className="lab" htmlFor="nr-title">
        {kind === "bug" ? "What's broken?" : "What do you want?"}
      </label>
      <input id="nr-title" className="field" required data-autofocus value={title} placeholder="One line, the way you'd title an issue" onChange={(e) => setTitle(e.target.value)} />
      <label className="lab" htmlFor="nr-body">
        Anything it should know <span className="opt">optional</span>
      </label>
      <textarea id="nr-body" className="field" rows={4} value={details} placeholder="Where it goes, who it's for, what it must not break" onChange={(e) => setDetails(e.target.value)} />
      <label className="lab" htmlFor="nr-goal">
        How you&rsquo;ll know it worked <span className="opt">optional</span>
      </label>
      <input id="nr-goal" className="field" value={goal} placeholder="For example: the receipt shows the card's last four digits" onChange={(e) => setGoal(e.target.value)} />
      {first && <p className="muted small">Setup suggested this one from your repository. Change it or write your own.</p>}
      {typeof state === "object" && "error" in state && <p className="warn" role="alert">{state.error}</p>}
      <div className="acts">
        <button className="btn go" type="submit" disabled={built === null || state === "sending"}>
          {state === "sending" ? "Sending…" : "Send to the factory"}
        </button>
        {onCancel !== undefined && (
          <button className="btn quiet" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <span className="muted small">Opens an issue as you. The factory replies there and here.</span>
      </div>
    </form>
  );
}

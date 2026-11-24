"use client";

import { useState } from "react";
import { useBrainstorm } from "@/lib/data";
import type { GitHubClient } from "@/lib/github";
import { buildRequest, REQUEST_KINDS, type FirstRequest, type RequestKind } from "@/lib/request";
import { waitingFor, type Waiting } from "@/lib/questions";

/**
 * Start work from the dashboard. It files an issue shaped like the factory's own
 * forms, so a request typed here and one opened on GitHub reach intake the same
 * way, and the factory answers on the issue either way.
 */
export function NewRequest({
  client,
  initial,
  onClose,
}: {
  client: GitHubClient;
  initial?: FirstRequest;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<RequestKind>("feature");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [details, setDetails] = useState(initial?.details ?? "");
  const [goal, setGoal] = useState(initial?.goal ?? "");
  const [state, setState] = useState<"idle" | "sending" | "failed" | { url: string }>("idle");

  const built = buildRequest({ kind, title, details, goal });

  const send = async (): Promise<void> => {
    if (built === null) return;
    setState("sending");
    try {
      const issue = await client.createIssue(built.title, built.body, built.labels);
      setState({ url: issue.html_url });
    } catch {
      setState("failed");
    }
  };

  if (typeof state === "object") {
    return (
      <section className="section" aria-label="New request">
        <p>
          Filed. The factory will comment on <a href={state.url}>the issue</a> as soon as it has read it.
        </p>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </section>
    );
  }

  return (
    <section className="section" aria-label="New request">
      <h2>New request</h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {REQUEST_KINDS.map((k) => (
          <button
            key={k.kind}
            className={k.kind === kind ? "btn primary" : "btn"}
            aria-pressed={k.kind === kind}
            title={k.hint}
            onClick={() => setKind(k.kind)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <label>
        <span className="row-meta">Title</span>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        <span className="row-meta">What do you want?</span>
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} />
      </label>
      <label>
        <span className="row-meta">Goal: what should be true when this is done?</span>
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} style={{ minHeight: 64 }} />
      </label>
      <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
        <button className="btn primary" disabled={built === null || state === "sending"} onClick={() => void send()}>
          {state === "sending" ? "Sending…" : "Send to the factory"}
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        {state === "failed" && (
          <span className="row-meta" role="alert">
            Could not file it. Check that your token can write issues, then try again.
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * The questions the factory asked before starting. Answering posts a comment on
 * the issue as the signed-in person, which is exactly what answering on GitHub
 * does: intake sees a trusted person's comment and puts the item back in the queue.
 * Nothing times a question out, so each shows how long it has waited.
 */
export function QuestionList({
  client,
  waiting,
  questions,
}: {
  client: GitHubClient;
  waiting: readonly Waiting[];
  questions: Readonly<Record<number, string | null>>;
}) {
  const [text, setText] = useState<Readonly<Record<string, string>>>({});
  const [sent, setSent] = useState<Readonly<Record<string, "sent" | "failed">>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const answer = async (id: string, issue: number): Promise<void> => {
    const body = (text[id] ?? "").trim();
    if (body === "") return;
    setBusy(id);
    try {
      await client.comment(issue, body);
      setSent((s) => ({ ...s, [id]: "sent" }));
    } catch {
      setSent((s) => ({ ...s, [id]: "failed" }));
    } finally {
      setBusy(null);
    }
  };

  const now = new Date();
  return (
    <div className="rows">
      {waiting.map(({ item, issue }) => {
        const result = sent[item.work_item];
        const question = issue === null ? null : (questions[issue] ?? null);
        return (
          <div className="row needs" key={item.work_item} style={{ display: "block" }}>
            <Thread client={client} workItem={item.work_item} />
            <div className="row-title">{question ?? "The factory has a question about this request."}</div>
            <div className="row-meta">
              <span className="mono">{item.work_item}</span>
              {waitingFor(item.created_at, now) !== null && <span>{waitingFor(item.created_at, now)}</span>}
              {issue !== null && <span>issue #{issue}</span>}
            </div>
            {issue === null ? (
              <div className="row-meta">This request did not come from an issue, so there is nowhere to answer. Send it again.</div>
            ) : result === "sent" ? (
              <div className="row-meta">Sent. The factory picks the request up again in a moment.</div>
            ) : (
              <div className="answer-field">
                <textarea
                  aria-label={`Answer for ${item.work_item}`}
                  value={text[item.work_item] ?? ""}
                  onChange={(e) => setText((t) => ({ ...t, [item.work_item]: e.target.value }))}
                  style={{ minHeight: 56 }}
                />
                <button
                  className="btn primary inline"
                  disabled={busy !== null || (text[item.work_item] ?? "").trim() === ""}
                  onClick={() => void answer(item.work_item, issue)}
                >
                  Answer
                </button>
              </div>
            )}
            {result === "failed" && (
              <div className="row-meta" role="alert">
                Could not send. Try again.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}


/**
 * What has already been said about this request.
 *
 * Answering a question with no sight of the conversation it belongs to is how
 * people end up repeating themselves, or answering a question the factory
 * stopped caring about two turns ago. The last exchange is shown by default
 * and the rest opens, because the useful context is usually the most recent
 * thing.
 */
function Thread({ client, workItem }: { client: GitHubClient; workItem: string }) {
  const convo = useBrainstorm(client, workItem);
  const [all, setAll] = useState(false);
  if (convo.state !== "ready" || convo.data === null || convo.data.turns.length === 0) return null;

  const turns = convo.data.turns;
  const shown = all ? turns : turns.slice(-2);
  return (
    <div className="thread">
      {!all && turns.length > shown.length && (
        <button className="thread-more" onClick={() => setAll(true)}>
          {turns.length - shown.length} earlier turn{turns.length - shown.length === 1 ? "" : "s"}
        </button>
      )}
      {shown.map((t, i) => (
        <div className={t.who === "factory" ? "turn factory" : "turn person"} key={`${t.at}-${i}`}>
          <span className="turn-who">{t.who === "factory" ? "The factory" : "You"}</span>
          <p>{t.text}</p>
        </div>
      ))}
      {convo.data.understood !== null && (
        <div className="turn understood">
          <span className="turn-who">What it has understood so far</span>
          <p>{convo.data.understood}</p>
        </div>
      )}
    </div>
  );
}

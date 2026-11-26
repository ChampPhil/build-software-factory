"use client";

import Link from "next/link";
import { useState } from "react";
import { conversationLive, useBrainstorm, useCheckRuns, useIssueComments, usePull, useVerifierReport } from "@/lib/data";
import { questionFrom } from "@/lib/questions";
import { isFrameTurn, plain, questionOf, sentence } from "@/lib/frame";
import type { Need } from "@/lib/view";
import { ago, pipeName, statusLabel, summaryOf, usd } from "@/lib/view";
import { evidenceOf } from "@/lib/evidence";
import type { IssueSummary } from "@/lib/github";
import { useApp } from "@/components/app";
import { Film } from "@/components/evidence";
import { Check, Cross, Spin, Out, autoGrow } from "@/components/ui";

export type Titles = (id: string | null | undefined, fallback: string) => string;
const requestHref = (id: string, tab?: string): string => `/request/?id=${encodeURIComponent(id)}${tab === undefined ? "" : `&tab=${tab}`}`;

/** One thing waiting on you, as the card that lets you deal with it in place. */
export function NeedCard({ need, title, cost, issues }: { need: Need; title: Titles; cost: (id: string | null) => number | null; issues: readonly IssueSummary[] }) {
  switch (need.kind) {
    case "question":
      return <QuestionCard id={need.item.work_item} issue={need.issue} title={title(need.item.work_item, need.item.work_item)} since={need.item.created_at} />;
    case "review":
      return <ReviewCard number={need.pull.number} workItem={need.item?.work_item ?? null} title={title(need.item?.work_item, need.pull.title)} sha={need.pull.head.sha} opened={need.pull.created_at} cost={cost(need.item?.work_item ?? null)} />;
    case "practice":
      return <PracticeCard number={need.pull.number} title={need.pull.title} opened={need.pull.created_at} />;
    case "escalated":
      return <EscalatedCard id={need.item.work_item} title={title(need.item.work_item, need.item.work_item)} target={need.item.pr ?? issueFrom(need.item.source_ref)} issue={issueFrom(need.item.source_ref)} cost={cost(need.item.work_item)} since={need.item.created_at} />;
    case "trust": {
      const issue = need.issue === null ? undefined : issues.find((i) => i.number === need.issue);
      return <TrustCard id={need.item.work_item} number={need.issue} title={title(need.item.work_item, issue?.title ?? need.item.work_item)} who={issue?.user?.login ?? "someone"} since={issue?.created_at ?? need.item.created_at} />;
    }
    case "outside":
      return <TrustCard id={null} number={need.issue.number} title={need.issue.title} who={need.issue.user?.login ?? "someone"} since={need.issue.created_at} />;
    case "ask":
      return (
        <article className="item">
          <div className="head">
            <div className="where">
              <span className="tag">Asked, no reply yet</span>
              <span>#{need.issue.number}</span>
              <span>opened {ago(need.issue.created_at)}</span>
            </div>
            <h3>{need.issue.title}</h3>
          </div>
          <div className="body">
            <p className="muted">The factory has not answered this yet. <Out href={need.issue.html_url}>Open it on GitHub</Out></p>
          </div>
        </article>
      );
    case "candidate":
      return <CandidateCard c={need.candidate} />;
  }
}

const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

const issueFrom = (ref: string | null | undefined): number | null => {
  const m = /^#(\d+)$/.exec(ref ?? "");
  return m === null ? null : Number(m[1]);
};

function QuestionCard({ id, issue, title, since }: { id: string; issue: number | null; title: string; since: string | undefined }) {
  const { client, act, version } = useApp();
  const convo = useBrainstorm(client, id, version);
  const comments = useIssueComments(client, issue, version);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const b = convo.state === "ready" ? convo.data : null;
  const lastTurn = b?.turns.filter((t) => t.who === "factory").at(-1)?.text ?? null;
  const question = lastTurn ?? (comments.state === "ready" ? questionFrom(comments.data) : null);
  const live = conversationLive(b);

  return (
    <article className="item ask">
      <div className="where">
        <span className="tag you">Your answer moves this on</span>
        {issue !== null && <span>#{issue}</span>}
        {since !== undefined && <span>asked {ago(since)}</span>}
      </div>
      <h3>
        <Link href={requestHref(id, "talk")}>{title}</Link>
      </h3>
      {b?.frame?.named !== undefined && b.frame.named.trim() !== "" && (
        <p className="named">
          <span>What it is</span>
          {sentence(b.frame.named)}
        </p>
      )}
      <p className="voice">{question === null ? "The factory has a question about this request." : isFrameTurn(plain(question)) ? questionOf(plain(question)) : plain(question)}</p>
      {issue === null ? (
        <p className="muted">This came from somewhere without an issue, so there&rsquo;s nowhere to answer it. Send it again as a new request.</p>
      ) : sent ? (
        <p className="listening">
          <Check /> Sent. {live ? "It's reading your answer now." : "The factory replies within about 2 minutes."}{" "}
          <Link href={requestHref(id, "talk")}>Carry on the conversation</Link>
        </p>
      ) : (
        <form
          className="answer"
          onSubmit={(e) => {
            e.preventDefault();
            const words = text.trim();
            if (words === "") return;
            setSent(true);
            void act(() => client.comment(issue, words), `Answered on #${issue}.`, `answered:${id}`).then((ok) => { if (!ok) setSent(false); });
          }}
        >
          <textarea className="field" rows={1} value={text} aria-label={`Your answer to ${title}`} placeholder="Answer here, or on the issue" onChange={(e) => { setText(e.target.value); autoGrow(e.target); }} />
          <button className="btn go" type="submit" disabled={text.trim() === ""}>
            Send
          </button>
          <span className="listening">
            {live ? (
              <>
                <span className="pulse" aria-hidden="true" />
                Listening now. A reply takes a few seconds.
              </>
            ) : (
              <>
                <span className="cold-dot" aria-hidden="true" />
                Answer now. The factory replies within about 2 minutes.
              </>
            )}
          </span>
        </form>
      )}
    </article>
  );
}

function ReviewCard({ number, workItem, title, sha, opened, cost }: { number: number; workItem: string | null; title: string; sha: string; opened: string; cost: number | null }) {
  const { client, act, ask, version, held } = useApp();
  const gone = held(`pr-gone:${number}`);
  const pr = usePull(client, number, version);
  const checks = useCheckRuns(client, sha);
  const report = useVerifierReport(client, workItem);
  const video = report.state === "ready" ? evidenceOf(report.data).find((e) => e.kind === "video") : undefined;
  const summary = pr.state === "ready" && pr.data !== null ? summaryOf(pr.data.body, 4) : [];
  const failed = checks.state === "ready" && checks.data.some((c) => c.conclusion === "failure" || c.conclusion === "timed_out");
  const running = checks.state === "ready" && checks.data.some((c) => c.status !== "completed");
  const detail = workItem === null ? null : requestHref(workItem, "pr");
  const issueOf = pr.state === "ready" && pr.data !== null ? /#(\d+)/.exec(pr.data.title)?.[1] : undefined;

  if (gone) return null;
  return (
    <article className="item proof">
      <div className="head">
        <div className="where">
          <span className="tag">{statusLabel({ status: "in_review" }, pr.state === "ready" ? pr.data : null, checks.state === "ready" ? checks.data : null)}</span>
          <span>PR #{number}{issueOf !== undefined ? ` for #${issueOf}` : ""}</span>
          <span>opened {ago(opened)}</span>
        </div>
        <h3>{detail === null ? title : <Link href={detail}>{title}</Link>}</h3>
      </div>
      {video !== undefined && (
        <div className="film-wrap">
          <Film client={client} item={video} />
        </div>
      )}
      <div className="body">
        {summary.length > 0 ? (
          <ul className="summary">
            {summary.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">{pr.state === "loading" ? "Reading what it changed…" : "The pull request has no summary. The diff says what changed."}</p>
        )}
        <div className="acts">
          <button
            className="btn go"
            type="button"
            onClick={() => void act(() => client.mergePull(number, "squash"), `Merged #${number}. The request closes and its branch goes.`, `pr-gone:${number}`)}
          >
            Merge #{number}
          </button>
          {detail !== null ? (
            <Link className="btn" href={detail}>
              All proof and the diff
            </Link>
          ) : (
            <a className="btn" href={`https://github.com/${client.repo}/pull/${number}`} target="_blank" rel="noopener noreferrer">
              Read it on GitHub
            </a>
          )}
          <button
            className="btn quiet"
            type="button"
            onClick={() => void (async () => {
              const words = await ask({ title: `Request changes on #${number}`, body: "The factory reads this as a correction and tries again.", placeholder: "What should change", confirm: "Request changes" });
              if (words !== null) await act(() => client.requestChanges(number, words), "Changes requested. The factory picks it up within a few minutes.");
            })()}
          >
            Request changes
          </button>
        </div>
        <div className="facts">
          <span>
            {running ? <Spin /> : failed ? <Cross /> : <Check />} {running ? "Checks running" : failed ? "A check failed" : "Checks passed"}
          </span>
          {cost !== null && (
            <span>
              <b>{usd(cost)}</b> to build
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function PracticeCard({ number, title, opened }: { number: number; title: string; opened: string }) {
  const { client, act, ask, version, held } = useApp();
  const pr = usePull(client, number, version);
  const summary = pr.state === "ready" && pr.data !== null ? summaryOf(pr.data.body, 3) : [];
  if (held(`pr-gone:${number}`)) return null;
  return (
    <article className="item">
      <div className="where">
        <span className="tag you">A practice to approve</span>
        <span>PR #{number}</span>
        <span>{ago(opened)}</span>
      </div>
      <h3>{cap(title.replace(/^Practice:\s*/i, ""))}</h3>
      {summary.length > 0 ? <p className="voice small">{summary.join(" ")}</p> : <p className="muted small">A standing instruction someone declared with /practice. Every agent follows it once it is merged.</p>}
      <div className="acts">
        <button className="btn" type="button" onClick={() => void act(() => client.mergePull(number, "squash"), "Adopted. Every agent follows it from the next run.", `pr-gone:${number}`)}>
          Adopt it
        </button>
        <button
          className="btn quiet"
          type="button"
          onClick={() => void (async () => {
            const ok = await ask({ title: `Turn down #${number}?`, body: "The pull request closes. Nothing changes for the agents.", confirm: "Turn it down", noText: true });
            if (ok !== null) await act(() => client.closePull(number), `Closed #${number}.`, `pr-gone:${number}`);
          })()}
        >
          Not this one
        </button>
        <Out href={`https://github.com/${client.repo}/pull/${number}`}>Read it on GitHub</Out>
      </div>
    </article>
  );
}

function EscalatedCard({ id, title, target, issue, cost, since }: { id: string; title: string; target: number | null; issue: number | null; cost: number | null; since: string | undefined }) {
  const { client, act, ask, version } = useApp();
  const comments = useIssueComments(client, target, version);
  const said = comments.state === "ready" ? questionFrom(comments.data) : null;
  return (
    <article className="item">
      <div className="where">
        <span className="tag stop">Stuck, needs you</span>
        {issue !== null && <span>#{issue}</span>}
        {since !== undefined && <span>{ago(since)}</span>}
      </div>
      <h3>
        <Link href={requestHref(id)}>{title}</Link>
      </h3>
      <p className="voice small">{said ?? "It used its attempts without passing the gates, and stopped rather than guess."}</p>
      <div className="acts">
        <Link className="btn" href={requestHref(id, "runs")}>
          Read what it tried
        </Link>
        {target !== null && (
          <button
            className="btn"
            type="button"
            onClick={() => void (async () => {
              const words = await ask({ title: "Reply, and hand it back", body: "Answer its question or say what to try. It starts again with your note.", placeholder: "What it should do", confirm: "Send and retry" });
              if (words !== null) await act(() => client.comment(target, `${words}\n\n/retry`), "Sent. It tries again with your note.");
            })()}
          >
            Reply and retry
          </button>
        )}
        <button
          className="btn quiet"
          type="button"
          onClick={() => void (async () => {
            const why = await ask({ title: "Drop this request?", body: "The factory stops working on it and closes its pull request with your reason.", placeholder: "Why", confirm: "Drop it", danger: true });
            if (why !== null) await act(() => client.dropRequests([id], why), "Dropped. Its pull request closes in a minute.");
          })()}
        >
          Drop it
        </button>
      </div>
      {cost !== null && (
        <div className="facts">
          <span>
            <b>{usd(cost)}</b> spent trying
          </span>
        </div>
      )}
    </article>
  );
}

function TrustCard({ id, number, title, who, since }: { id: string | null; number: number | null; title: string; who: string; since: string | undefined }) {
  const { client, act, ask, held } = useApp();
  if (number !== null && (held(`issue-gone:${number}`) || held(`issue-accepted:${number}`))) return null;
  return (
    <article className="item">
      <div className="where">
        <span className="tag you">Someone new asked</span>
        {number !== null && <span>#{number}</span>}
        <span>{who}</span>
        {since !== undefined && <span>{ago(since)}</span>}
      </div>
      <h3>{id === null ? title.replace(/^\[\w+\]\s*/, "") : <Link href={requestHref(id)}>{title}</Link>}</h3>
      <p className="muted">{who} can&rsquo;t start work here, so nothing is spent until one of you says so. Letting it start adds the factory:accept label.</p>
      {number !== null && (
        <div className="acts">
          <button className="btn" type="button" onClick={() => void act(() => client.addLabels(number, ["factory:accept"]), `#${number} can start. The factory reads it within a minute.`, `issue-accepted:${number}`)}>
            Let the factory start it
          </button>
          <button
            className="btn quiet"
            type="button"
            onClick={() => void (async () => {
              const ok = await ask({ title: `Close #${number}?`, body: `${who} sees it closed. You can reopen it later.`, confirm: "Close it", noText: true });
              if (ok !== null) await act(() => client.setIssueState(number, "closed"), `Closed #${number}.`, `issue-gone:${number}`);
            })()}
          >
            Close it
          </button>
          <Out href={`https://github.com/${client.repo}/issues/${number}`}>Read it on GitHub</Out>
        </div>
      )}
    </article>
  );
}

function CandidateCard({ c }: { c: Extract<Need, { kind: "candidate" }>["candidate"] }) {
  const { client, act, held } = useApp();
  const fix = c.proposed_fix === "static_rule" ? "a lint rule" : c.proposed_fix === "verification" ? "a check in verification" : c.proposed_fix === "api_change" ? "a change that makes the mistake impossible" : "whatever fits best";
  if (held(`candidate-decided:${c.id}`)) return null;
  return (
    <article className="item">
      <div className="where">
        <span className="tag">A rule it could add</span>
        <span>seen {c.occurrences} {c.occurrences === 1 ? "time" : "times"}</span>
      </div>
      <h3>
        <Link href="/guardrails/">{c.problem_class}</Link>
      </h3>
      {c.sources[0]?.quote !== undefined && <p className="voice small">&ldquo;{c.sources[0].quote}&rdquo;</p>}
      <p className="muted small">Adding it starts a hardening run that writes {fix}, with an example it must catch.</p>
      <div className="acts">
        <button className="btn" type="button" onClick={() => void act(() => client.decideCandidate(c.id, "accept"), "Accepted. Hardening starts shortly.", `candidate-decided:${c.id}`)}>
          Add the rule
        </button>
        <button className="btn quiet" type="button" onClick={() => void act(() => client.decideCandidate(c.id, "reject"), "Noted. It won't be proposed again.", `candidate-decided:${c.id}`)}>
          Not a rule
        </button>
      </div>
    </article>
  );
}

export { pipeName };

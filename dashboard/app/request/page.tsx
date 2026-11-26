"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useBrainstorm, useIssueComments, useRunFiles, useWorkItems } from "@/lib/data";
import { canMove, MOVABLE } from "@/lib/routing";
import { questionFrom } from "@/lib/questions";
import { sentence } from "@/lib/frame";
import {
  CLOSED_STATUSES, OPEN_STATUSES, SOURCE, ago, clock, issueOf, pipeName, requestIds, requestsFrom, runsFor, statusName, titleOf, usd, type Request,
} from "@/lib/view";
import type { RunFile, WorkItemDoc } from "@/lib/types";
import type { IssueSummary } from "@/lib/github";
import { useApp } from "@/components/app";
import { Conversation } from "@/components/conversation";
import { PullPane } from "@/components/pull";
import { LiveRun, RunCard } from "@/components/run-view";
import { Badge, Dialog, Loading, Out, Problem } from "@/components/ui";

type Tab = "talk" | "pr" | "runs" | "activity";

export default function RequestPage() {
  return (
    <Suspense fallback={<main className="wrap"><Loading what="the request" /></main>}>
      <OneRequest />
    </Suspense>
  );
}

/**
 * One request: the conversation about it, the pull request it became, the
 * runs it took and what happened when. Whichever needs the person opens
 * first; in conversation the chat is the page.
 */
function OneRequest() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const asked = params.get("tab") as Tab | null;
  const { client, ledger, issues, index } = useApp();
  const L = ledger.state === "ready" ? ledger.data : null;
  const ids = [...new Set([...requestIds(L), ...(id === "" ? [] : [id])])];
  const docs = useWorkItems(client, ids);
  const docMap = docs.state === "ready" ? docs.data : {};
  const issueList = issues.state === "ready" ? issues.data : [];
  const runIds = index.state === "ready" ? (index.data?.recent_runs ?? []) : [];
  const runs = useRunFiles(client, runIds.slice(0, 40));
  const convo = useBrainstorm(client, id === "" ? null : id);

  let request: Request | undefined = requestsFrom(L, docMap, issueList).find((r) => r.id === id);
  const doc: WorkItemDoc | undefined = docMap[id];
  if (request === undefined && doc !== undefined) request = fromDoc(doc, issueList);

  if (id === "") return <Missing why="No request was named in the address." />;
  if (ledger.state === "loading" || (request === undefined && docs.state === "loading")) {
    return (
      <main className="wrap">
        <Link className="back" href="/requests/">All requests</Link>
        <Loading what="the request" />
      </main>
    );
  }
  if (ledger.state === "error") return <main className="wrap"><Problem error={ledger.error} retry={ledger.retry} /></main>;
  if (request === undefined) return <Missing why={`There's no request called ${id} in the factory's records. It may be older than the records kept here.`} />;

  const r = request;
  const mine = runs.state === "ready" ? runsFor(runs.data, r.id) : [];
  const spent = mine.reduce((n, x) => n + x.cost_usd, 0);
  const hasTalk = r.issue !== null || (convo.state === "ready" && convo.data !== null);
  const tabs: { id: Tab; label: string; count?: number }[] = [];
  if (hasTalk) tabs.push({ id: "talk", label: "Conversation" });
  if (r.pr !== null) tabs.push({ id: "pr", label: "Pull request" });
  tabs.push({ id: "runs", label: "Runs", count: mine.length });
  tabs.push({ id: "activity", label: "Activity" });
  const fallback: Tab = r.status === "needs_info" && hasTalk ? "talk" : r.pr !== null ? "pr" : r.status === "running" || r.status === "escalated" ? "runs" : hasTalk ? "talk" : "activity";
  const tab: Tab = asked !== null && tabs.some((t) => t.id === asked) ? asked : fallback;
  const named = convo.state === "ready" ? convo.data?.frame?.named : undefined;

  const tabRow = (
    <div className="tabs" role="tablist" aria-label="Request">
      {tabs.map((t) => (
        <Link key={t.id} role="tab" aria-selected={tab === t.id} href={`/request/?id=${encodeURIComponent(r.id)}&tab=${t.id}`} replace scroll={false}>
          {t.label}
          {t.count !== undefined && <span> {t.count}</span>}
        </Link>
      ))}
    </div>
  );

  const head = (
    <header className="req-head">
      <div className="where">
        <Badge status={r.status} />
        <span>{r.issue === null ? "no issue" : `#${r.issue}`}</span>
        <span>{pipeName(r.pipeline)}</span>
        {r.pr !== null && <span>PR #{r.pr}</span>}
        {spent > 0 && <span>{usd(spent)} spent</span>}
      </div>
      <h1>{r.title}</h1>
      {named !== undefined && named.trim() !== "" && named !== r.title && (
        <p className="named">
          <span>What it is</span>
          {sentence(named)}
        </p>
      )}
    </header>
  );

  const pane =
    tab === "talk" ? (
      <Conversation request={r} />
    ) : tab === "pr" && r.pr !== null ? (
      <PullPane number={r.pr} workItem={r.id} />
    ) : tab === "runs" ? (
      <RunsPane request={r} runs={mine} loading={runs.state === "loading"} />
    ) : (
      <Activity request={r} runs={mine} />
    );

  if (tab === "talk") {
    return <TalkLayout request={r} head={head} tabRow={tabRow} spent={spent} runs={mine.length} pane={pane} />;
  }

  return (
    <main className="wrap">
      <Link className="back" href="/requests/">All requests</Link>
      {head}
      {tabRow}
      <div className="req-cols">
        <details className="m-details">
          <summary>
            Details: {statusName(r.status).toLowerCase()}, {pipeName(r.pipeline).toLowerCase()}
            {spent > 0 ? `, ${usd(spent)} spent` : ""}
          </summary>
          <Details request={r} spent={spent} runs={mine.length} />
        </details>
        <div className="req-main">
          <Callout request={r} />
          {pane}
        </div>
        <aside className="details" aria-label="Details">
          <Details request={r} spent={spent} runs={mine.length} />
        </aside>
      </div>
    </main>
  );
}

function TalkLayout({ request, head, tabRow, spent, runs, pane }: { request: Request; head: ReactNode; tabRow: ReactNode; spent: number; runs: number; pane: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  return (
    <main className="wrap talking">
      <Link className="back" href="/requests/">All requests</Link>
      {head}
      <div className="tabs-row">
        {tabRow}
        <button className="btn quiet small" type="button" onClick={() => setDrawer(true)}>
          Details
        </button>
      </div>
      <div className="req-main">
        <Callout request={request} />
        {pane}
      </div>
      {drawer && (
        <Dialog onClose={() => setDrawer(false)} size="drawer" label="Details">
          <div className="drawer-head">
            <h2>Details</h2>
            <button className="btn quiet small" type="button" onClick={() => setDrawer(false)}>
              Close
            </button>
          </div>
          <div className="details">
            <Details request={request} spent={spent} runs={runs} />
          </div>
        </Dialog>
      )}
    </main>
  );
}

function Missing({ why }: { why: string }) {
  return (
    <main className="wrap">
      <Link className="back" href="/requests/">All requests</Link>
      <header className="page-head">
        <h1>No such request</h1>
        <p className="rest">{why}</p>
      </header>
    </main>
  );
}

function fromDoc(doc: WorkItemDoc, issues: readonly IssueSummary[]): Request {
  const issue = issueOf(doc.source.ref);
  return {
    id: doc.id,
    title: titleOf(doc, issues.find((i) => i.number === issue), doc.id),
    status: doc.status,
    pipeline: doc.pipeline,
    pr: doc.pr,
    issue,
    priority: "normal",
    created_at: doc.created_at,
    merged_at: null,
    open: OPEN_STATUSES.includes(doc.status),
    doc,
  };
}

/** What the state asks of the person, said once above whatever tab is open. */
function Callout({ request: r }: { request: Request }) {
  const { client, act, ask, live, version, held } = useApp();
  const target = r.pr ?? r.issue;
  const comments = useIssueComments(client, r.status === "escalated" ? target : null, version);
  if (r.status === "escalated") {
    const said = comments.state === "ready" ? questionFrom(comments.data) : null;
    return (
      <div className="callout stop">
        <h2>Stuck, and waiting for you</h2>
        <p className="voice small">{said ?? "It used its attempts without passing the gates, and stopped rather than guess."}</p>
        <div className="acts">
          {target !== null && (
            <button
              className="btn go"
              type="button"
              onClick={() => void (async () => {
                const words = await ask({ title: "Reply, and hand it back", body: "Answer its question or say what to try. It starts again with your note.", placeholder: "What it should do", confirm: "Send and retry" });
                if (words !== null) await act(() => client.comment(target, `${words}\n\n/retry`), "Sent. It tries again with your note.");
              })()}
            >
              Reply and retry
            </button>
          )}
          <button className="btn" type="button" onClick={() => void act(() => client.retryRequest(r.id), "Started again from the first attempt.")}>
            Try again as it is
          </button>
          <DropButton id={r.id} />
        </div>
      </div>
    );
  }
  if (r.status === "waiting_trust" && r.issue !== null) {
    const issue = r.issue;
    if (held(`issue-gone:${issue}`)) return <p className="muted">Closed #{issue}.</p>;
    if (held(`issue-accepted:${issue}`)) return <p className="muted">#{issue} can start. The factory reads it within a minute.</p>;
    return (
      <div className="callout">
        <h2>Asked by someone who can&rsquo;t start work</h2>
        <p>Nothing is spent until one of you says so. Letting it start adds the <code>factory:accept</code> label.</p>
        <div className="acts">
          <button className="btn go" type="button" onClick={() => void act(() => client.addLabels(issue, ["factory:accept"]), `#${issue} can start.`, `issue-accepted:${issue}`)}>
            Let the factory start it
          </button>
          <button className="btn quiet" type="button" onClick={() => void act(() => client.setIssueState(issue, "closed"), `Closed #${issue}.`, `issue-gone:${issue}`)}>
            Close it
          </button>
        </div>
      </div>
    );
  }
  if (r.status === "queued") {
    return (
      <div className="callout">
        <h2>Queued</h2>
        <p>{r.priority === "high" ? "High priority, so it goes next." : "It starts when a slot frees up."}</p>
        <div className="acts">
          <DropButton id={r.id} />
        </div>
      </div>
    );
  }
  if (r.status === "running") {
    const going = live.state === "ready" ? live.data.find((l) => l.work_item === r.id) : undefined;
    return going === undefined ? null : <LiveRun live={going} />;
  }
  if (r.status === "duplicate") {
    const parent = r.doc?.parent ?? null;
    return (
      <div className="callout">
        <h2>
          Closed as a duplicate{parent !== null && <> of <Link href={`/request/?id=${encodeURIComponent(parent)}`}>{parent}</Link></>}
        </h2>
        <p>The factory folded it into the earlier request rather than build the same thing twice.</p>
        {r.issue !== null && <ReopenButton issue={r.issue} />}
      </div>
    );
  }
  if (r.status === "rejected") {
    return (
      <div className="callout">
        <h2>Turned down at triage</h2>
        <p>{r.doc?.routing?.reason ?? "It judged there was nothing worth doing here."}</p>
        {r.issue !== null && <ReopenButton issue={r.issue} />}
      </div>
    );
  }
  return null;
}

function DropButton({ id }: { id: string }) {
  const { client, act, ask } = useApp();
  return (
    <button
      className="btn quiet"
      type="button"
      onClick={() => void (async () => {
        const why = await ask({ title: "Drop this request?", body: "The factory stops working on it and closes its pull request with your reason.", placeholder: "Why", confirm: "Drop it", danger: true });
        if (why !== null) await act(() => client.dropRequests([id], why), "Dropped. Its pull request closes in a minute.");
      })()}
    >
      Drop the request
    </button>
  );
}

function ReopenButton({ issue }: { issue: number }) {
  const { client, act } = useApp();
  return (
    <div className="acts">
      <button className="btn" type="button" onClick={() => void act(() => client.setIssueState(issue, "open"), `Reopened #${issue}. The factory reads it again.`)}>
        Reopen #{issue}
      </button>
    </div>
  );
}

function Details({ request: r, spent, runs }: { request: Request; spent: number; runs: number }) {
  const { client, act, ask, issues, repo, held } = useApp();
  const convo = useBrainstorm(client, r.id);
  const frame = convo.state === "ready" ? convo.data?.frame : undefined;
  const other = frame?.readings?.find((x) => !(frame.reading_taken ?? "").toLowerCase().includes(x.term.toLowerCase()));
  const doc = r.doc;
  const issue = r.issue === null || issues.state !== "ready" ? undefined : issues.data.find((i) => i.number === r.issue);
  const movable = canMove(r.status);
  return (
    <>
      <dl>
        <dt>State</dt>
        <dd>
          <Badge status={r.status} />
        </dd>
        <dt>Kind of work</dt>
        <dd>
          {movable && (MOVABLE as readonly string[]).includes(r.pipeline) ? (
            <select
              className="field"
              aria-label="Move to another kind of work"
              value={r.pipeline}
              onChange={(e) => {
                const to = e.target.value;
                void act(() => client.moveRequest(r.id, to), `Moving it to ${pipeName(to).toLowerCase()}. It updates once the factory has applied it.`);
              }}
            >
              {MOVABLE.map((p) => (
                <option key={p} value={p}>
                  {pipeName(p)}
                </option>
              ))}
            </select>
          ) : (
            pipeName(r.pipeline)
          )}
          {doc?.routing !== undefined && (
            <small>
              {doc.routing.by === "person" ? "Chosen by a person" : doc.routing.by === "table" ? "Chosen by the routing table" : "Chosen by the chief of staff"}: {doc.routing.reason}
            </small>
          )}
          {(doc?.routing?.overrides ?? []).map((o) => (
            <small key={o.at}>
              {o.by} moved it from {pipeName(o.from).toLowerCase()} to {pipeName(o.to).toLowerCase()}, {ago(o.at)}
            </small>
          ))}
          {!movable && OPEN_STATUSES.includes(r.status) && <small>It can&rsquo;t move once work has started.</small>}
        </dd>
        <dt>Priority</dt>
        <dd>{r.priority === "high" ? "High" : "Normal"}</dd>
        {issue !== undefined && (
          <>
            <dt>Labels</dt>
            <dd>
              {issue.labels.map((l) => (
                <span className="chip" key={l.name}>
                  {l.name}
                  <button type="button" aria-label={`Remove ${l.name}`} onClick={() => void act(() => client.removeLabel(issue.number, l.name), `Removed ${l.name}.`)}>
                    ×
                  </button>
                </span>
              ))}
              <button
                className="chip add"
                type="button"
                onClick={() => void (async () => {
                  const name = await ask({ title: `Add a label to #${issue.number}`, placeholder: "For example: factory:accept", confirm: "Add label" });
                  if (name !== null) await act(() => client.addLabels(issue.number, [name]), `Added ${name}.`);
                })()}
              >
                Add label
              </button>
            </dd>
          </>
        )}
        {doc !== null && (
          <>
            <dt>Asked by</dt>
            <dd>
              {doc.source.actor === "factory" ? "The factory" : doc.source.actor}, from {SOURCE[doc.source.kind] ?? doc.source.kind}
            </dd>
          </>
        )}
        {r.created_at !== null && (
          <>
            <dt>Opened</dt>
            <dd>{clock(r.created_at)}</dd>
          </>
        )}
        {r.merged_at !== null && (
          <>
            <dt>Merged</dt>
            <dd>{clock(r.merged_at)}</dd>
          </>
        )}
        <dt>Spent</dt>
        <dd>
          {usd(spent)} over {runs} {runs === 1 ? "run" : "runs"}
        </dd>
        {frame?.reading_taken !== undefined && (
          <>
            <dt>How it read the request</dt>
            <dd>
              {sentence(frame.reading_taken)}
              {other !== undefined && <small>The other reading: {other.problem.charAt(0).toLowerCase() + other.problem.slice(1)}, which would mean {sentence(other.tells_it_apart)}</small>}
            </dd>
          </>
        )}
        {doc?.goal !== undefined && (
          <>
            <dt>What it&rsquo;s for</dt>
            <dd>{doc.goal}</dd>
          </>
        )}
        {doc?.success_check !== undefined && (
          <>
            <dt>How you&rsquo;ll know</dt>
            <dd>{doc.success_check}</dd>
          </>
        )}
        {r.pr !== null && (
          <>
            <dt>Pull request</dt>
            <dd>
              <Link href={`/request/?id=${encodeURIComponent(r.id)}&tab=pr`}>#{r.pr}</Link>
            </dd>
          </>
        )}
        {doc?.parent != null && (
          <>
            <dt>Part of</dt>
            <dd>
              <Link href={`/request/?id=${encodeURIComponent(doc.parent)}`}>{doc.parent}</Link>
            </dd>
          </>
        )}
      </dl>
      <div className="side-acts">
        {r.issue !== null &&
          (CLOSED_STATUSES.includes(r.status) || r.status === "merged" ? (
            <button className="btn" type="button" onClick={() => void act(() => client.setIssueState(r.issue!, "open"), `Reopened #${r.issue}.`)}>
              Reopen the issue
            </button>
          ) : (
            <button
              className="btn"
              type="button"
              disabled={held(`issue-gone:${r.issue}`)}
              onClick={() => void (async () => {
                const ok = await ask({ title: `Close #${r.issue}?`, body: "Closing the issue stops the factory working on it.", confirm: "Close it", noText: true });
                if (ok !== null) await act(() => client.setIssueState(r.issue!, "closed"), `Closed #${r.issue}.`, `issue-gone:${r.issue}`);
              })()}
            >
              {held(`issue-gone:${r.issue}`) ? "Closing…" : "Close the issue"}
            </button>
          ))}
        {r.open && <DropButton id={r.id} />}
        {r.issue !== null && <Out href={`https://github.com/${repo}/issues/${r.issue}`}>Open on GitHub</Out>}
      </div>
      <p className="ids">{r.id}</p>
    </>
  );
}

function RunsPane({ request: r, runs, loading }: { request: Request; runs: readonly RunFile[]; loading: boolean }) {
  const { live } = useApp();
  const going = live.state === "ready" ? live.data.filter((l) => l.work_item === r.id) : [];
  if (loading && runs.length === 0) return <Loading what="the runs" />;
  return (
    <>
      {r.status !== "running" && going.map((g) => <LiveRun key={g.run} live={g} />)}
      {runs.map((x, i) => (
        <RunCard key={x.id} run={x} open={i === 0} />
      ))}
      {runs.length === 0 && going.length === 0 && (
        <p className="muted">
          No runs yet.{" "}
          {r.status === "waiting_trust" ? "It starts once you let it." : r.status === "queued" ? "It starts when a slot frees up." : r.status === "needs_info" ? "It starts once the question is answered." : ""}
        </p>
      )}
    </>
  );
}

/** What happened, in order, from the factory's own records. */
function Activity({ request: r, runs }: { request: Request; runs: readonly RunFile[] }) {
  const doc = r.doc;
  const events: { at: string; who: string; text: string }[] = [];
  if (doc !== null) {
    events.push({ at: doc.created_at, who: doc.source.actor === "factory" ? "The factory" : doc.source.actor, text: `Asked for this, from ${SOURCE[doc.source.kind] ?? doc.source.kind}.` });
    if (doc.routing !== undefined) events.push({ at: doc.routing.at, who: doc.routing.by === "person" ? "A person" : "The factory", text: `Sent it to ${pipeName(doc.pipeline).toLowerCase()}. ${doc.routing.reason}` });
    for (const o of doc.routing?.overrides ?? []) events.push({ at: o.at, who: o.by, text: `Moved it from ${pipeName(o.from).toLowerCase()} to ${pipeName(o.to).toLowerCase()}.` });
  }
  for (const x of runs) {
    events.push({ at: x.started_at, who: "The factory", text: `Started a run (${x.id}).` });
    events.push({ at: x.ended_at, who: "The factory", text: `Finished: ${x.outcome.replace(/_/g, " ")}${x.pr != null ? `, PR #${x.pr}` : ""}, ${usd(x.cost_usd)}.` });
  }
  if (r.merged_at !== null) events.push({ at: r.merged_at, who: "GitHub", text: `Merged${r.pr !== null ? ` #${r.pr}` : ""}.` });
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return (
    <div className="thread compact">
      {events.length === 0 && <p className="muted">Nothing recorded yet beyond the request itself.</p>}
      {events.map((e, i) => (
        <div className="turn p" key={i}>
          <div className="who">
            <span>{e.who}</span>
            <span>{clock(e.at)}</span>
          </div>
          <div className="text">{e.text}</div>
        </div>
      ))}
    </div>
  );
}

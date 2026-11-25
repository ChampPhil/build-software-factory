"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useActions, useRun, useRunFiles, useVerifierReport, useWorkItems } from "@/lib/data";
import { costBreakdown, costMismatch } from "@/lib/metrics";
import { ago, clock, dur, outcomeName, pipeName, since, titleOf, usd } from "@/lib/view";
import type { RunFile } from "@/lib/types";
import { useApp } from "@/components/app";
import { Evidence } from "@/components/evidence";
import { LiveRun, StepsAndGates, WorkflowState } from "@/components/run-view";
import { Loading, OutcomeBadge, Out, Problem } from "@/components/ui";
import { EmptyFactoryNote } from "@/components/empty-factory";

export default function RunsPage() {
  return (
    <Suspense fallback={<main className="wrap"><Loading what="the runs" /></main>}>
      <Runs />
    </Suspense>
  );
}

function Runs() {
  const id = useSearchParams().get("id");
  return id === null || id === "" ? <AllRuns /> : <OneRun id={id} />;
}

const FILTERS: readonly { id: string; label: string; fits: (o: string) => boolean }[] = [
  { id: "all", label: "All", fits: () => true },
  { id: "running", label: "Running", fits: (o) => o === "running" },
  { id: "draft_pr", label: "Opened a PR", fits: (o) => o === "draft_pr" },
  { id: "merged", label: "Merged", fits: (o) => o === "merged" },
  { id: "escalated", label: "Handed to you", fits: (o) => o === "escalated" },
  { id: "failed", label: "Failed", fits: (o) => o === "failed" || o === "cancelled" },
  { id: "other", label: "Other", fits: (o) => ["duplicate", "rejected", "no_action"].includes(o) },
];

interface Row {
  readonly id: string;
  readonly work_item: string;
  readonly pipeline: string;
  readonly outcome: string;
  readonly started_at: string;
  readonly duration_sec: number | null;
  readonly cost: number;
  readonly pr: number | null;
}

/** Every time the factory worked on something: what it did, how long it took and what it cost. */
function AllRuns() {
  const { client, index, live, ledger, installed } = useApp();
  const ids = index.state === "ready" ? (index.data?.recent_runs ?? []) : [];
  const files = useRunFiles(client, ids.slice(0, 50));
  const L = ledger.state === "ready" ? ledger.data : null;
  const items = [...new Set([...(files.state === "ready" ? files.data.map((r) => r.work_item) : []), ...(live.state === "ready" ? live.data.map((l) => l.work_item) : [])])];
  const docs = useWorkItems(client, items);
  const title = (wi: string): string => titleOf(docs.state === "ready" ? docs.data[wi] : undefined, undefined, wi);
  const [filter, setFilter] = useState("all");

  const rows: Row[] = [
    ...(live.state === "ready" ? live.data : []).map((l) => ({ id: l.run, work_item: l.work_item, pipeline: l.pipeline, outcome: "running", started_at: l.started_at, duration_sec: null, cost: l.cost_usd_so_far ?? 0, pr: null })),
    ...(files.state === "ready" ? files.data : []).map((r) => ({ id: r.id, work_item: r.work_item, pipeline: r.pipeline, outcome: r.outcome, started_at: r.started_at, duration_sec: r.duration_sec ?? null, cost: r.cost_usd, pr: r.pr ?? null })),
  ];
  const fits = FILTERS.find((f) => f.id === filter)!.fits;
  const shown = rows.filter((r) => fits(r.outcome));

  return (
    <main className="wrap">
      <header className="page-head">
        <h1>Runs</h1>
        <p className="rest">Every time the factory worked on something: what it did, how long it took and what it cost.</p>
      </header>
      {index.state === "loading" && <Loading what="the runs" />}
      {index.state === "error" && <Problem error={index.error} retry={index.retry} />}
      {index.state === "ready" && index.data === null && L === null && <EmptyFactoryNote installed={installed} />}
      {index.state === "ready" && (
        <>
          <div className="toolbar">
            <div className="seg" role="tablist" aria-label="Filter by outcome">
              {FILTERS.map((f) => (
                <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>
                  {f.label} <span>{rows.filter((r) => f.fits(r.outcome)).length}</span>
                </button>
              ))}
            </div>
          </div>
          {filter === "other" && <p className="muted small">Duplicates, requests turned down at triage, and gardening runs that found nothing worth changing.</p>}
          <div className="table runs-t" role="table" aria-label="Runs">
            <div className="tr th" role="row">
              <span role="columnheader">Run</span>
              <span role="columnheader">Outcome</span>
              <span role="columnheader">Kind</span>
              <span role="columnheader">Started</span>
              <span role="columnheader">Took</span>
              <span role="columnheader" className="r">Cost</span>
            </div>
            {shown.map((r) => (
              <Link className="tr" role="row" key={r.id} href={r.outcome === "running" ? `/request/?id=${encodeURIComponent(r.work_item)}&tab=runs` : `/runs/?id=${encodeURIComponent(r.id)}`}>
                <span role="cell" className="t">
                  <b>{title(r.work_item)}</b>
                  <small>
                    {r.id}
                    {r.pr !== null ? `, PR #${r.pr}` : ""}
                  </small>
                </span>
                <span role="cell">
                  <OutcomeBadge outcome={r.outcome} />
                </span>
                <span role="cell">{pipeName(r.pipeline)}</span>
                <span role="cell">{ago(r.started_at)}</span>
                <span role="cell">{r.duration_sec === null ? `${since(r.started_at)} so far` : dur(r.duration_sec)}</span>
                <span role="cell" className="r">{usd(r.cost)}</span>
              </Link>
            ))}
            {shown.length === 0 && <p className="empty-row">{rows.length === 0 ? "No runs yet. Each run is recorded here when it finishes, with its steps, gates and cost." : "No runs match."}</p>}
          </div>
          <ActionsRuns />
        </>
      )}
    </main>
  );
}

/** The same work as GitHub Actions sees it: where a stuck or failed job is stopped or run again. */
function ActionsRuns() {
  const { client, act, version } = useApp();
  const actions = useActions(client, version);
  if (actions.state !== "ready" || actions.data === null || actions.data.runs.length === 0) return null;
  const runs = actions.data.runs.filter((r) => /factory-/.test(r.path ?? r.name)).slice(0, 15);
  if (runs.length === 0) return null;
  return (
    <section>
      <h2 className="sect">
        On GitHub Actions <span className="muted">the factory&rsquo;s workflow runs, newest first</span>
      </h2>
      <div className="table wf-t" role="table" aria-label="Workflow runs">
        {runs.map((r) => (
          <div className="tr" role="row" key={r.id}>
            <span role="cell" className="t">
              <b>{r.name.replace(/^factory-/, "")}</b>
              <small>
                {r.event.replace(/_/g, " ")}, {ago(r.created_at)}
              </small>
            </span>
            <span role="cell" className="wf-state">
              <WorkflowState run={r} />
            </span>
            <span role="cell" className="r">
              {r.status !== "completed" && (
                <button className="btn small" type="button" onClick={() => void act(() => client.cancelWorkflowRun(r.id), "Cancelling. What it spent so far is still counted.")}>
                  Cancel
                </button>
              )}
              {r.conclusion === "failure" && (
                <button className="btn small" type="button" onClick={() => void act(() => client.rerunFailedJobs(r.id), "Re-running the failed jobs.")}>
                  Re-run failed jobs
                </button>
              )}
              <Out href={r.html_url}>Log</Out>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function OneRun({ id }: { id: string }) {
  const { client, live, repo } = useApp();
  const run = useRun(client, id);
  const going = live.state === "ready" ? live.data.find((l) => l.run === id) : undefined;
  const wi = run.state === "ready" && run.data !== null ? run.data.work_item : (going?.work_item ?? null);
  const docs = useWorkItems(client, wi === null ? [] : [wi]);
  const doc = wi === null || docs.state !== "ready" ? undefined : docs.data[wi];
  const report = useVerifierReport(client, wi);

  if (run.state === "loading") return <main className="wrap"><Link className="back" href="/runs/">All runs</Link><Loading what="the run" /></main>;
  if (run.state === "error") return <main className="wrap"><Problem error={run.error} retry={run.retry} /></main>;
  const r: RunFile | null = run.data;
  if (r === null && going === undefined) {
    return (
      <main className="wrap">
        <Link className="back" href="/runs/">All runs</Link>
        <header className="page-head">
          <h1>No record for that run</h1>
          <p className="rest">Either the id is wrong, or the run hasn&rsquo;t finished: a run&rsquo;s record is written once, at its end.</p>
        </header>
      </main>
    );
  }
  const title = titleOf(doc, undefined, wi ?? id);
  const gap = r === null ? null : costMismatch(r);
  const cost = r === null ? null : costBreakdown(r);

  return (
    <main className="wrap">
      <Link className="back" href="/runs/">All runs</Link>
      <header className="req-head">
        <div className="where">
          <OutcomeBadge outcome={r?.outcome ?? "running"} />
          <span>{pipeName(r?.pipeline ?? going?.pipeline)}</span>
          <span>{id}</span>
        </div>
        <h1>{title}</h1>
      </header>
      <div className="req-cols">
        <div className="req-main">
          {going !== undefined && <LiveRun live={going} />}
          {r !== null && (
            <>
              <h2 className="sect">Steps and gates</h2>
              <StepsAndGates run={r} />
              {report.state === "ready" && report.data !== null && (
                <>
                  <h2 className="sect">What the verifier saw</h2>
                  <Evidence client={client} report={report.data} />
                </>
              )}
              {cost !== null && cost.rows.length > 0 && (
                <>
                  <h2 className="sect">What it cost</h2>
                  <div className="table cost-t" role="table" aria-label="Cost by step">
                    <div className="tr th" role="row">
                      <span role="columnheader">Step</span>
                      <span role="columnheader">Model</span>
                      <span role="columnheader">Tokens</span>
                      <span role="columnheader" className="r">Cost</span>
                    </div>
                    {cost.rows.map((c, i) => (
                      <div className="tr" role="row" key={i}>
                        <span role="cell">{c.label.replace(/ · attempt (\d+)/, ", try $1")}</span>
                        <span role="cell">{c.model.replace(/^claude-/, "")}</span>
                        <span role="cell">
                          {c.tokensIn.toLocaleString("en-US")} in, {c.tokensOut.toLocaleString("en-US")} out
                        </span>
                        <span role="cell" className="r">{usd(c.costUsd)}</span>
                      </div>
                    ))}
                  </div>
                  {gap !== null && <p className="muted small">The steps add up to {usd(r.cost_usd - gap)}, but the run recorded {usd(r.cost_usd)}. The run&rsquo;s own figure is used everywhere, so a step whose cost was never recorded doesn&rsquo;t vanish from the totals.</p>}
                </>
              )}
              {(r.artifacts?.expiring?.length ?? 0) > 0 && (
                <>
                  <h2 className="sect">Logs and video on GitHub</h2>
                  <ul className="plain-list">
                    {(r.artifacts?.expiring ?? []).map((a) => (
                      <li key={a.artifact_id}>
                        {a.kind}, artifact {a.artifact_id}
                        {a.expires_at !== undefined && (Date.parse(a.expires_at) < Date.now() ? ", expired" : `, kept until ${clock(a.expires_at)}`)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
        <aside className="details" aria-label="Details">
          <dl>
            <dt>For</dt>
            <dd>{wi !== null ? <Link href={`/request/?id=${encodeURIComponent(wi)}`}>{title}</Link> : title}</dd>
            {r !== null && (
              <>
                <dt>Outcome</dt>
                <dd>{outcomeName(r.outcome)}</dd>
                <dt>Started</dt>
                <dd>{clock(r.started_at)}</dd>
                <dt>Ended</dt>
                <dd>
                  {clock(r.ended_at)}, after {dur(r.duration_sec)}
                </dd>
                <dt>Cost</dt>
                <dd>{usd(r.cost_usd)}</dd>
                <dt>Done by</dt>
                <dd>{r.actor.kind === "agent" ? (r.actor.harness ?? "an agent").replace(/-/g, " ") : (r.actor.login ?? "a person")}</dd>
                {r.pr != null && (
                  <>
                    <dt>Pull request</dt>
                    <dd>
                      <Out href={`https://github.com/${repo}/pull/${r.pr}`}>#{r.pr}</Out>
                    </dd>
                  </>
                )}
                {(r.artifacts?.stored?.length ?? 0) > 0 && (
                  <>
                    <dt>Proof kept</dt>
                    <dd>{r.artifacts?.stored?.length} files</dd>
                  </>
                )}
              </>
            )}
          </dl>
          <p className="ids">{id}</p>
        </aside>
      </div>
    </main>
  );
}

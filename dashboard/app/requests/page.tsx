"use client";

import Link from "next/link";
import { useState } from "react";
import { useWorkItems } from "@/lib/data";
import { PIPE, REQUEST_FILTERS, ago, pipeName, requestIds, requestsFrom, sortRequests, SOURCE, type RequestFilter } from "@/lib/view";
import { useApp } from "@/components/app";
import { Badge, Loading, Problem } from "@/components/ui";
import { EmptyFactoryNote } from "@/components/empty-factory";

/** Everything the factory has been asked to do, whatever it came in as. */
export default function Requests() {
  const { client, ledger, issues, installed, compose } = useApp();
  const L = ledger.state === "ready" ? ledger.data : null;
  const docs = useWorkItems(client, requestIds(L, 60));
  const all = requestsFrom(L, docs.state === "ready" ? docs.data : {}, issues.state === "ready" ? issues.data : []);
  const [filter, setFilter] = useState<RequestFilter>("open");
  const [pipe, setPipe] = useState("all");
  const [q, setQ] = useState("");

  const fits = REQUEST_FILTERS.find((f) => f.id === filter)!.fits;
  const needle = q.trim().toLowerCase().replace(/^#/, "");
  const list = sortRequests(
    all
      .filter(fits)
      .filter((r) => pipe === "all" || r.pipeline === pipe)
      .filter((r) => needle === "" || r.title.toLowerCase().includes(needle) || String(r.issue ?? "").includes(needle) || r.id.includes(needle)),
  );

  return (
    <main className="wrap">
      <header className="page-head">
        <h1>Requests</h1>
        <p className="rest">Everything the factory has been asked to do: from issues, from here, from the nightly schedule and from its own reviews.</p>
      </header>
      {ledger.state === "loading" && <Loading what="the requests" />}
      {ledger.state === "error" && <Problem error={ledger.error} retry={ledger.retry} />}
      {ledger.state === "ready" && L === null && <EmptyFactoryNote installed={installed} />}
      {ledger.state === "ready" && (
        <>
          <div className="toolbar">
            <div className="seg" role="tablist" aria-label="Filter by state">
              {REQUEST_FILTERS.map((f) => (
                <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>
                  {f.label} <span>{all.filter(f.fits).length}</span>
                </button>
              ))}
            </div>
            <label>
              <span className="vh">Kind of work</span>
              <select className="field" value={pipe} onChange={(e) => setPipe(e.target.value)}>
                <option value="all">All kinds</option>
                {Object.entries(PIPE).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <input className="field find" type="search" value={q} placeholder="Filter by title or number" aria-label="Filter requests" onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="table req-t" role="table" aria-label="Requests">
            <div className="tr th" role="row">
              <span role="columnheader">Request</span>
              <span role="columnheader">State</span>
              <span role="columnheader">Kind</span>
              <span role="columnheader">From</span>
              <span role="columnheader">When</span>
            </div>
            {list.map((r) => (
              <Link className="tr" role="row" key={r.id} href={`/request/?id=${encodeURIComponent(r.id)}`}>
                <span role="cell" className="t">
                  <b>{r.title}</b>
                  <small>
                    {r.issue === null ? r.id : `#${r.issue}`}
                    {r.pr !== null ? `, PR #${r.pr}` : ""}
                    {r.priority === "high" ? ", high priority" : ""}
                  </small>
                </span>
                <span role="cell">
                  <Badge status={r.status} />
                </span>
                <span role="cell">{pipeName(r.pipeline)}</span>
                <span role="cell">{r.doc === null ? "" : r.doc.source.actor === "factory" ? (SOURCE[r.doc.source.kind] ?? r.doc.source.kind) : r.doc.source.actor}</span>
                <span role="cell">{ago(r.merged_at ?? r.created_at)}</span>
              </Link>
            ))}
            {list.length === 0 && (
              <p className="empty-row">
                {all.length === 0 ? (
                  <>
                    No requests yet.{" "}
                    <button className="link" type="button" onClick={() => compose()}>
                      Make the first one
                    </button>
                  </>
                ) : (
                  <>
                    No requests match.{" "}
                    <button className="link" type="button" onClick={() => { setFilter("all"); setPipe("all"); setQ(""); }}>
                      Show all
                    </button>
                  </>
                )}
              </p>
            )}
          </div>
        </>
      )}
    </main>
  );
}

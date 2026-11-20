"use client";

import { useMemo, useState } from "react";
import { readSession } from "@/lib/session";
import { useClient, useLedger } from "@/lib/data";
import { PageHead, Empty, Note, PipelineTag, Dot } from "@/components/primitives";
import { elapsedSince } from "@/lib/metrics";

const STATUS_TONE: Readonly<Record<string, "pass" | "fail" | "run" | "idle" | "define">> = {
  queued: "idle", waiting_trust: "idle", needs_info: "run", running: "run",
  in_review: "run", queued_to_merge: "run", merged: "pass", escalated: "fail",
  duplicate: "idle", rejected: "idle",
};

/** Where each request is. */
export default function Work() {
  const session = useMemo(() => readSession(), []);
  const auth = session === null ? null : { token: session.token, repo: session.repo };
  const client = useClient(auth);
  const ledger = useLedger(client, true);
  const [filter, setFilter] = useState<string>("all");

  if (ledger.state === "loading") {
    return (<><PageHead title="Work items" /><div className="note quiet">Reading the ledger…</div></>);
  }
  if (ledger.state === "error") {
    return (<><PageHead title="Work items" /><Note tone="bad">{ledger.error}</Note></>);
  }

  const open = ledger.data?.open ?? [];
  const recent = ledger.data?.recent ?? [];
  const pipelines = [...new Set(open.map((o) => o.pipeline))];
  const shown = filter === "all" ? open : open.filter((o) => o.pipeline === filter);

  return (
    <>
      <PageHead
        title="Work items"
        lede="Every request the factory is holding, whatever it came in as. The ledger is what each pipeline checks before starting work, so nothing is picked up twice."
      />

      {open.length === 0 && recent.length === 0 && (
        <Empty title="No work items yet">
          An issue, a review comment on one of the factory&rsquo;s pull requests, a CI failure on
          the default branch, or the nightly gardening schedule all become work items here.
        </Empty>
      )}

      {pipelines.length > 1 && (
        <div className="section" style={{ marginTop: 0, display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => setFilter("all")} aria-pressed={filter === "all"}>
            All {open.length}
          </button>
          {pipelines.map((p) => (
            <button key={p} className="btn" onClick={() => setFilter(p)} aria-pressed={filter === p}>
              {p.replace(/_/g, " ")} {open.filter((o) => o.pipeline === p).length}
            </button>
          ))}
        </div>
      )}

      {shown.length > 0 && (
        <div className="section">
          <h2>Open · {shown.length}</h2>
          <div className="rows">
            {shown.map((item) => (
              <div className="row" key={item.work_item} style={{ gridTemplateColumns: "auto 1fr auto auto auto auto" }}>
                <Dot tone={STATUS_TONE[item.status] ?? "run"} title={item.status} />
                <span className="row-title mono">{item.work_item}</span>
                <PipelineTag pipeline={item.pipeline} />
                <span className="row-meta">{item.status.replace(/_/g, " ")}</span>
                <span className="row-meta">
                  {item.created_at === undefined ? "" : `${elapsedSince(item.created_at)} old`}
                </span>
                {item.pr != null && session !== null ? (
                  <a className="btn" href={`https://github.com/${session.repo}/pull/${item.pr}`}>#{item.pr}</a>
                ) : (
                  <span className="row-meta">—</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="section">
          <h2>Finished in the last 30 days · {recent.length}</h2>
          <p className="lede">Older than this lives in the run files, which are kept indefinitely.</p>
          <div className="rows">
            {recent.map((item) => (
              <div className="row" key={item.work_item} style={{ gridTemplateColumns: "auto 1fr auto auto" }}>
                <Dot tone={STATUS_TONE[item.status] ?? "idle"} title={item.status} />
                <span className="row-title mono">{item.work_item}</span>
                <span className="row-meta">{item.status.replace(/_/g, " ")}</span>
                <span className="row-meta">
                  {item.merged_at === undefined ? "" : `${elapsedSince(item.merged_at)} ago`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

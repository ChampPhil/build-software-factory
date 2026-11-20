"use client";

import { useMemo } from "react";
import { readSession } from "@/lib/session";
import { useClient, useIndex, useLedger, useLive } from "@/lib/data";
import { PageHead, Empty, Note, PipelineTag, Pips, Dot } from "@/components/primitives";
import { board, groupByStation, STATIONS, elapsedSince, formatUsd, type BoardCard } from "@/lib/metrics";
import Link from "next/link";

/** What is running right now. Refreshes every five seconds while the tab is open. */
export default function Live() {
  const session = useMemo(() => readSession(), []);
  const auth = session === null ? null : { token: session.token, repo: session.repo };
  const client = useClient(auth);
  const ledger = useLedger(client, true);
  const live = useLive(client);
  const index = useIndex(client);

  const ledgerData = ledger.state === "ready" ? ledger.data : null;
  const liveData = live.state === "ready" ? live.data : [];
  const cards = board(ledgerData, liveData);
  const grouped = groupByStation(cards);
  const escalated = cards.filter((c) => c.escalated);

  const health = index.state === "ready" ? index.data?.health : undefined;
  const queue = ledgerData?.merge_queue ?? [];

  return (
    <>
      <PageHead
        title="Live"
        lede="Work moving through the factory. The board refreshes every five seconds; it pauses when this tab is in the background."
      />

      {health?.lock_files_current === false && (
        <Note>
          <b>Lock files need recompiling.</b> gh-aw refuses a compiled workflow that has fallen too
          far behind, so role workflows will not start until they are rebuilt. This is maintenance,
          not a broken run.
        </Note>
      )}

      {health?.gardening_schedule_active === false && (
        <Note>
          <b>Nightly gardening is paused.</b> GitHub disables scheduled workflows on a public
          repository after 60 days without activity. Re-enable it on the Factory page.
        </Note>
      )}

      {escalated.length > 0 && (
        <div className="section">
          <h2 style={{ color: "var(--fail)" }}>Escalated · {escalated.length}</h2>
          <p className="lede">These used all three attempts and stopped. They stay here until someone acts.</p>
          <div className="rows">
            {escalated.map((c) => (
              <div className="row" key={c.workItem} style={{ gridTemplateColumns: "auto 1fr auto auto" }}>
                <Dot tone="fail" />
                <span className="row-title mono">{c.workItem}</span>
                <PipelineTag pipeline={c.pipeline} />
                <Link className="btn" href="/">Act on it</Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {cards.length === 0 && ledger.state === "ready" && (
        <Empty title="Nothing in flight">
          The factory is idle. It starts when an issue is filed, when a review comment lands on one
          of its pull requests, when CI fails on the default branch, or on tonight&rsquo;s gardening
          schedule.
        </Empty>
      )}

      {cards.length > 0 && (
        <div className="section">
          <div className="board">
            {STATIONS.map((station) => {
              const list = grouped[station];
              return (
                <div className="station" key={station}>
                  <div className="station-head">
                    <b>{station}</b>
                    <span>{list.length}</span>
                  </div>
                  <div className="station-body">
                    {list.length === 0 ? (
                      <div className="station-empty">—</div>
                    ) : (
                      list.map((c) => <Card key={c.workItem} card={c} />)
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {queue.length > 0 && (
        <div className="section">
          <h2>Merge queue · {queue.length}</h2>
          <p className="lede">
            One at a time, in the order each became eligible. Each is re-checked against the latest
            default branch before it lands, which is what stops two pull requests that pass alone
            from breaking the build together.
          </p>
          <div className="rows">
            {queue.map((q, i) => (
              <div className="row" key={q.pr} style={{ gridTemplateColumns: "auto auto 1fr auto" }}>
                <Dot tone={i === 0 ? "run" : "idle"} title={i === 0 ? "being processed" : "waiting"} />
                <span className="row-meta">#{i + 1}</span>
                <a
                  className="row-title"
                  href={session === null ? "#" : `https://github.com/${session.repo}/pull/${q.pr}`}
                >
                  PR #{q.pr}
                </a>
                <span className="row-meta">eligible {elapsedSince(q.eligible_at)} ago</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Card({ card }: { card: BoardCard }) {
  const running = card.startedAt !== undefined && card.step !== undefined;
  const cls = card.escalated ? "card escalated" : running ? "card running" : "card";
  return (
    <div className={cls}>
      <div className="t mono">{short(card.workItem)}</div>
      <div className="m">
        <PipelineTag pipeline={card.pipeline} />
        {card.step !== undefined && <span>{card.step}</span>}
        {card.attempt !== undefined && card.of !== undefined && (
          <Pips attempt={card.attempt} of={card.of} failed={card.attempt - 1} />
        )}
      </div>
      <div className="m">
        {card.startedAt !== undefined && <span>{elapsedSince(card.startedAt)}</span>}
        {card.costUsd !== undefined && <span>{formatUsd(card.costUsd)}</span>}
        {card.pr != null && <span>PR #{card.pr}</span>}
      </div>
    </div>
  );
}

/** Work item ids are long; the tail is what distinguishes them. */
function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 3)}…${id.slice(-6)}` : id;
}

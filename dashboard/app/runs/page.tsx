"use client";

import { useMemo, useState } from "react";
import { readSession } from "@/lib/session";
import { useClient, useIndex, useRun, useVerifierReport } from "@/lib/data";
import { Evidence } from "@/components/evidence";
import { PageHead, Section, Empty, Note, PipelineTag, Dot, Pips, AsOf } from "@/components/primitives";
import { timeline, costBreakdown, costMismatch, formatDuration, formatUsd } from "@/lib/metrics";
import type { GitHubClient } from "@/lib/github";
import type { RunFile, RunGate } from "@/lib/types";

/**
 * Runs, and one run in detail.
 *
 * A static export has no dynamic routes, so the run id is a query parameter —
 * which also means a link to a run is a plain URL anyone can paste.
 */
export default function Runs() {
  const session = useMemo(() => readSession(), []);
  const auth = session === null ? null : { token: session.token, repo: session.repo };
  const client = useClient(auth);
  const index = useIndex(client);

  const [selected, setSelected] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("id");
  });

  const run = useRun(client, selected);
  const recent = index.state === "ready" ? (index.data?.recent_runs ?? []) : [];

  if (selected !== null) {
    return (
      <>
        <PageHead
          title="Run"
          lede={selected}
          actions={
            <button className="btn" onClick={() => { setSelected(null); history.pushState({}, "", "/runs/"); }}>
              All runs
            </button>
          }
        />
        {run.state === "loading" && <div className="note quiet">Reading the run…</div>}
        {run.state === "error" && <Note tone="bad">{run.error}</Note>}
        {run.state === "ready" && run.data === null && (
          <Empty title="No record for that run">
            Either the id is wrong, or the run&rsquo;s file has not been written yet. A run file is
            written once, at the end of the run.
          </Empty>
        )}
        {run.state === "ready" && run.data !== null && <RunDetail run={run.data} repo={session?.repo} client={client} />}
      </>
    );
  }

  return (
    <>
      <PageHead title="Runs" lede="Every run the factory has recorded, newest first." />
      <AsOf at={index.state === "ready" ? index.data?.updated_at : undefined} />
      {recent.length === 0 ? (
        <Empty title="No runs yet">
          Each run writes one file when it finishes, with its steps, gate attempts, evidence and
          cost. They appear here as soon as the first one completes.
        </Empty>
      ) : (
        <div className="rows">
          {recent.map((id) => (
            <div className="row" key={id} style={{ gridTemplateColumns: "1fr auto" }}>
              <button
                className="row-title mono"
                style={{ textAlign: "left" }}
                onClick={() => { setSelected(id); history.pushState({}, "", `/runs/?id=${id}`); }}
              >
                {id}
              </button>
              <span className="row-meta">open</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function RunDetail({ run, repo, client }: { run: RunFile; repo?: string | undefined; client: GitHubClient | null }) {
  const verifier = useVerifierReport(client, run.work_item);
  const rows = timeline(run);
  const { rows: costRows, total } = costBreakdown(run);
  const gap = costMismatch(run);

  return (
    <>
      <dl className="figures" style={{ maxWidth: 900 }}>
        <div className="figure">
          <dt>Outcome</dt>
          <dd style={{ fontSize: 20 }}>{run.outcome.replace(/_/g, " ")}</dd>
          <div className="sub">
            {run.actor.kind === "agent" ? (run.actor.harness ?? "agent") : (run.actor.login ?? "a person")}
          </div>
        </div>
        <div className="figure">
          <dt>Pipeline</dt>
          <dd style={{ fontSize: 20 }}><PipelineTag pipeline={run.pipeline} /></dd>
        </div>
        <div className="figure">
          <dt>Duration</dt>
          <dd>{formatDuration(run.duration_sec)}</dd>
        </div>
        <div className="figure">
          <dt>Cost</dt>
          <dd>{formatUsd(total)}</dd>
          {gap !== null && <div className="sub">{formatUsd(Math.abs(gap))} not attributed to a step</div>}
        </div>
      </dl>

      {run.pr != null && repo !== undefined && (
        <div className="section">
          <a className="btn primary" href={`https://github.com/${repo}/pull/${run.pr}`}>
            Open pull request #{run.pr}
          </a>
        </div>
      )}

      <Section title="Timeline" lede="Each step and each gate attempt, in the order they happened.">
        <div className="timeline">
          {rows.map((r, i) => (
            <div className={r.kind === "gate" ? "tl-row gate" : "tl-row"} key={i}>
              <span className="label">
                <Dot tone={toneFor(r.result)} title={r.result} />
                {r.label}
                {r.attempt !== undefined && r.kind === "gate" && (
                  <Pips attempt={r.attempt} of={3} failed={r.result === "fail" ? r.attempt : r.attempt - 1} />
                )}
              </span>
              <span className="num">{r.model ?? ""}</span>
              <span className="num">{formatDuration(r.durationSec)}</span>
              <span className="num">{r.costUsd === undefined ? "" : formatUsd(r.costUsd)}</span>
            </div>
          ))}
        </div>
      </Section>

      {run.gates.some((g) => (g.failures?.length ?? 0) > 0) && (
        <Section title="What the gates rejected" lede="Each failure, and the attempt it was found on.">
          <div className="rows">
            {run.gates.flatMap((g: RunGate) =>
              (g.failures ?? []).map((f, i) => (
                <div className="row" key={`${g.gate}-${g.attempt}-${i}`} style={{ gridTemplateColumns: "auto 1fr auto" }}>
                  <Dot tone="fail" />
                  <span>
                    <b>{f.rule}</b>
                    {f.file !== undefined && <span className="mono"> · {f.file}{f.line !== undefined && `:${f.line}`}</span>}
                    {f.message !== undefined && <div className="row-meta">{f.message}</div>}
                  </span>
                  <span className="row-meta">attempt {g.attempt}</span>
                </div>
              )),
            )}
          </div>
        </Section>
      )}

      <Section title="Cost" lede="Tokens and cost per step, read from the harness's own session log.">
        <div className="rows">
          {costRows.map((r, i) => (
            <div className="row" key={i} style={{ gridTemplateColumns: "1fr auto auto auto auto" }}>
              <span>{r.label}</span>
              <span className="row-meta">{r.model}</span>
              <span className="row-num row-meta">{r.tokensIn.toLocaleString("en-US")} in</span>
              <span className="row-num row-meta">{r.tokensOut.toLocaleString("en-US")} out</span>
              <span className="row-num">{formatUsd(r.costUsd)}</span>
            </div>
          ))}
        </div>
        {gap !== null && (
          <div style={{ marginTop: 12 }}>
            <Note tone="quiet">
              The steps add up to {formatUsd(total - gap)}, but the run recorded {formatUsd(total)}.
              The run&rsquo;s own figure is the one used everywhere, since a step whose cost was
              never recorded would otherwise vanish from the totals.
            </Note>
          </div>
        )}
      </Section>

      {client !== null && verifier.state === "ready" && verifier.data !== null && (
        <Section title="What the verifier saw" lede="The recording of the change working, then the screenshots. Play it here; GitHub's PR page can only show a still.">
          <Evidence client={client} report={verifier.data} />
        </Section>
      )}

      {(run.artifacts?.stored?.length ?? 0) > 0 && (
        <Section title="Evidence" lede="Kept for twelve months, because a reviewer often looks after the workflow artifacts expire.">
          <div className="rows">
            {(run.artifacts?.stored ?? []).map((a, i) => (
              <div className="row" key={i} style={{ gridTemplateColumns: "auto 1fr auto" }}>
                <span className="tag product_work">{a.kind}</span>
                <span>{a.caption ?? a.path}</span>
                <span className="row-meta">{a.expires_at === undefined ? "" : `expires ${a.expires_at}`}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {(run.artifacts?.expiring?.length ?? 0) > 0 && (
        <Section title="Logs and video" lede="Held as workflow artifacts, which GitHub deletes on its own schedule.">
          <div className="rows">
            {(run.artifacts?.expiring ?? []).map((a, i) => (
              <div className="row" key={i} style={{ gridTemplateColumns: "auto 1fr auto" }}>
                <span className="tag gardening">{a.kind}</span>
                <span className="mono">artifact {a.artifact_id}</span>
                <span className="row-meta">
                  {a.expires_at !== undefined && new Date(a.expires_at) < new Date()
                    ? "expired"
                    : a.expires_at === undefined ? "" : `expires ${a.expires_at}`}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function toneFor(result: string): "pass" | "fail" | "run" | "idle" {
  switch (result) {
    case "pass":
    case "ok":
      return "pass";
    case "fail":
    case "error":
    case "timeout":
    case "refused":
      return "fail";
    case "skipped":
      return "idle";
    default:
      return "run";
  }
}

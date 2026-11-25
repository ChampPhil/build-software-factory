"use client";

import Link from "next/link";
import type { LiveFile, RunFile } from "@/lib/types";
import type { WorkflowRunSummary } from "@/lib/github";
import { costMismatch } from "@/lib/metrics";
import { clock, dur, pathFor, since, stepName, STEP_SHORT, usd, shortRun, outcomeName } from "@/lib/view";
import { Check, Cross, OutcomeBadge, Pending, Spin, Tries } from "@/components/ui";

const model = (m: string | undefined): string => (m ?? "").replace(/^claude-/, "");

/** Each step and each gate attempt, in the order they happened. */
export function StepsAndGates({ run }: { run: RunFile }) {
  return (
    <>
      {run.steps.length === 0 ? (
        <p className="muted small">This run recorded no steps.</p>
      ) : (
        <ol className="steps-tl">
          {run.steps.map((s, i) => (
            <li className={s.exit ?? "ok"} key={i}>
              <span className="rung" aria-hidden="true" />
              <b>
                {stepName(s.role)}
                {(s.attempt ?? 1) > 1 ? `, try ${s.attempt}` : ""}
              </b>
              <span>{model(s.model)}</span>
              <span>{dur(s.duration_sec)}</span>
              <span>{s.tokens === undefined ? "" : `${(s.tokens.in + s.tokens.out).toLocaleString("en-US")} tokens`}</span>
              <span>{s.cost_usd === undefined ? "" : usd(s.cost_usd)}</span>
              <span className="exit">{s.exit === "ok" || s.exit === undefined ? "done" : s.exit}</span>
            </li>
          ))}
        </ol>
      )}
      {run.gates.length > 0 && (
        <div className="gates">
          {run.gates.map((g, i) => (
            <div className={`gate ${g.result}`} key={i}>
              {g.result === "pass" ? <Check /> : g.result === "fail" ? <Cross /> : <Pending />}
              <span>
                <b>{g.gate === "static" ? "Static gate" : "Verification gate"}</b>, try {g.attempt}
                {g.commit !== undefined && (
                  <>
                    , commit <code>{g.commit.slice(0, 7)}</code>
                  </>
                )}
                {g.coverage?.diff_pct !== undefined && `, ${g.coverage.diff_pct}% of new lines tested`}
                {g.result === "skipped" && ", skipped"}
                {(g.failures?.length ?? 0) > 0 && (
                  <ul>
                    {(g.failures ?? []).map((f, j) => (
                      <li key={j}>
                        <code>{f.rule}</code>
                        {f.file !== undefined && (
                          <>
                            {" "}in <code>{f.file}{f.line !== undefined ? `:${f.line}` : ""}</code>
                          </>
                        )}
                        {f.message !== undefined && `: ${f.message}`}
                      </li>
                    ))}
                  </ul>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** One run, folded, inside a request. */
export function RunCard({ run, open }: { run: RunFile; open: boolean }) {
  const gap = costMismatch(run);
  return (
    <details className="run-card" open={open}>
      <summary>
        <span className="t">
          {outcomeName(run.outcome)}
          {run.pr != null ? `, PR #${run.pr}` : ""}
        </span>
        <span className="m">
          {clock(run.started_at)}, {dur(run.duration_sec)}, {usd(run.cost_usd)}
        </span>
      </summary>
      <StepsAndGates run={run} />
      {gap !== null && <p className="muted small">The steps add up to {usd(run.cost_usd - gap)}; the run recorded {usd(run.cost_usd)}, which is the figure used everywhere.</p>}
      <div className="acts">
        <Link className="btn quiet" href={`/runs/?id=${encodeURIComponent(run.id)}`}>
          Open the run
        </Link>
      </div>
    </details>
  );
}

/** A run that is going now: where it is, how long, what it has spent. */
export function LiveRun({ live, title }: { live: LiveFile; title?: string }) {
  const path = pathFor(live.pipeline);
  const at = live.step === "gate" ? path.indexOf("gate") : path.indexOf(live.step);
  return (
    <section className="live-run" aria-label="Running now">
      {title !== undefined && <p className="muted small">{title}</p>}
      <p className="live-line">
        <Spin />
        {stepName(live.step)}
        {(live.attempt ?? 1) > 1 ? `, try ${live.attempt} of ${live.of ?? 3}` : ""}.
        <Tries attempt={live.attempt ?? 1} of={live.of ?? 3} />
      </p>
      <span className="trail" aria-hidden="true">
        {path.map((p, j) => (
          <i key={p} className={j < at ? "ok" : j === at ? "at" : ""}>
            {STEP_SHORT[p] ?? p}
          </i>
        ))}
      </span>
      <div className="live-figs">
        <div>
          <span className="fig">{since(live.started_at)}</span>
          <span>so far</span>
        </div>
        <div>
          <span className="fig">{usd(live.cost_usd_so_far)}</span>
          <span>spent so far</span>
        </div>
        <div>
          <span className="fig">{shortRun(live.run)}</span>
          <span>run</span>
        </div>
      </div>
    </section>
  );
}

/** A line in the rail for a run going now. */
export function RunLine({ live, title, href }: { live: LiveFile; title: string; href: string }) {
  const path = pathFor(live.pipeline);
  const at = path.indexOf(live.step === "gate" ? "gate" : live.step);
  return (
    <Link className="run-line" href={href}>
      <span className="t">{title}</span>
      <span className="s">
        {stepName(live.step)}
        {(live.attempt ?? 1) > 1 ? `, try ${live.attempt} of ${live.of ?? 3}` : ""} <Tries attempt={live.attempt ?? 1} of={live.of ?? 3} />
      </span>
      <span className="trail" aria-hidden="true">
        {path.map((p, j) => (
          <i key={p} className={j < at ? "ok" : j === at ? "at" : ""}>
            {STEP_SHORT[p] ?? p}
          </i>
        ))}
      </span>
      <span className="m">
        {since(live.started_at)}, {usd(live.cost_usd_so_far)}
      </span>
    </Link>
  );
}

export function WorkflowState({ run }: { run: WorkflowRunSummary }) {
  if (run.status !== "completed") return <><Spin /> Running</>;
  if (run.conclusion === "success") return <><Check /> Passed</>;
  if (run.conclusion === "cancelled" || run.conclusion === "skipped") return <>{run.conclusion === "cancelled" ? "Cancelled" : "Skipped"}</>;
  return <><Cross /> Failed</>;
}

export { OutcomeBadge };

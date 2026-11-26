"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useRunFiles, useStepRecords, useWorkItems } from "@/lib/data";
import { medianRequestToPr, minutesFromSteps, spendFromSteps } from "@/lib/spend";
import { projectToMonthEnd, shareUse } from "@/lib/metrics";
import { readSettings } from "@/lib/settings";
import { day, dur, outcomeName, pct, pipeName, plural, titleOf, usd } from "@/lib/view";
import type { DailyPoint } from "@/lib/types";
import { useApp } from "@/components/app";
import { Bar, Loading, Problem } from "@/components/ui";
import { EmptyFactoryNote } from "@/components/empty-factory";

const SHARE_NAME: Readonly<Record<string, string>> = { product_work: "Product work", gardening: "Gardening and hardening", review_and_benchmarks: "Reviews and practices" };

/** What the factory spends, against what it may, and what it got for it. */
export default function Spend() {
  const { client, index, settings, installed } = useApp();
  const ids = index.state === "ready" ? (index.data?.recent_runs ?? []) : [];
  const runs = useRunFiles(client, ids.slice(0, 40));
  const top = runs.state === "ready" ? [...runs.data].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 6) : [];
  const steps = useStepRecords(client, ids.slice(0, 60));
  const docs = useWorkItems(client, top.map((r) => r.work_item));

  if (index.state === "loading") return <Page><Loading what="the figures" /></Page>;
  if (index.state === "error") return <Page><Problem error={index.error} retry={index.retry} /></Page>;
  const data = index.data;
  if (data === null) {
    return (
      <Page>
        <EmptyFactoryNote installed={installed} />
        <p className="all-clear">Spend, budgets and how often its work merged without your edits show here once the factory has run.</p>
      </Page>
    );
  }
  const m = data.metrics;
  const budget = m.budget_usd ?? 0;
  const month = new Date().toISOString().slice(0, 7);
  // What was actually spent is the sum of the step records; the index total is only the fallback while they load.
  const spent = steps.state === "ready" && steps.data.length > 0 ? spendFromSteps(steps.data, month) : (m.spend_usd ?? 0);
  const billedMinutes = steps.state === "ready" ? minutesFromSteps(steps.data, month) : 0;
  const cycle = runs.state === "ready" ? medianRequestToPr(runs.data) : (m.cycle_time_p50_sec ?? null);
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const projected = projectToMonthEnd(spent, now);
  const read = settings.state === "ready" && settings.data !== null ? readSettings(settings.data) : null;
  const num = (k: string): number => (typeof read?.[k] === "number" ? read[k] : 0);
  const monthly = typeof read?.["monthly_budget"] === "number" ? read["monthly_budget"] : budget;
  const shares = read === null ? [] : shareUse({ ...data, metrics: { ...data.metrics, budget_usd: monthly } }, { product_work: num("share_product_work"), gardening: num("share_gardening"), review_and_benchmarks: num("share_review") });
  const merged = m.merged ?? 0;
  const clean = m.automation_rate === undefined ? null : Math.round(merged * m.automation_rate);

  return (
    <Page money>
      <section className="money-hero">
        <div>
          <div className="big">
            {usd(spent)}
            <small>{budget > 0 ? `of your ${usd(budget)} monthly budget` : "spent this month"}</small>
          </div>
          <p>
            Spent on models this month.
            {projected.known && <> At this pace the month ends near <b>{usd(projected.value)}</b>.</>} The budget is a hard stop: runs end before they would pass it.
          </p>
          {budget > 0 && (
            <div className="budget">
              <Bar size="big" fraction={spent / budget} mark={dayOfMonth / daysInMonth} label={`${pct(spent / budget)} of the budget used, ${pct(dayOfMonth / daysInMonth)} of the month gone`} />
              <div className="legend">
                <span>Start of the month</span>
                <span>Today, day {dayOfMonth}</span>
                <span>Day {daysInMonth}</span>
              </div>
            </div>
          )}
          <p className="muted small">
            <Link href="/factory/#settings">Change the budget</Link>
          </p>
        </div>
        <div>
          <div className="big">
            {m.automation_rate === undefined ? "None yet" : pct(m.automation_rate)}
            <small>merged with no edits from a person</small>
          </div>
          {clean !== null && merged > 0 && (
            <p>
              That&rsquo;s {clean} of the {merged} changes merged in the last {m.window_days} days. The other {merged - clean} needed a comment or a commit first.
            </p>
          )}
        </div>
      </section>

      <div className="cols">
        <div className="main-col">
          {(data.daily?.length ?? 0) > 1 && <Chart daily={data.daily ?? []} budget={budget} />}
          <h2 className="sect">Most expensive runs</h2>
          {runs.state === "loading" && <Loading what="the runs" />}
          {top.length > 0 && (
            <div className="table cost-t" role="table" aria-label="Most expensive runs">
              {top.map((r) => (
                <Link className="tr" role="row" key={r.id} href={`/runs/?id=${encodeURIComponent(r.id)}`}>
                  <span role="cell" className="t">
                    <b>{titleOf(docs.state === "ready" ? docs.data[r.work_item] : undefined, undefined, r.work_item)}</b>
                    <small>{outcomeName(r.outcome)}</small>
                  </span>
                  <span role="cell">{pipeName(r.pipeline)}</span>
                  <span role="cell">{dur(r.duration_sec)}</span>
                  <span role="cell" className="r">{usd(r.cost_usd)}</span>
                </Link>
              ))}
            </div>
          )}
          {runs.state === "ready" && top.length === 0 && <p className="muted">No runs recorded yet.</p>}
        </div>
        <aside className="rail">
          <section>
            <h2 className="part">By kind of work</h2>
            {Object.entries(m.by_pipeline ?? {}).map(([k, v]) => (
              <div className="lane-r" key={k}>
                <span>
                  {pipeName(k)}
                  {v.paused === true && <span className="warn"> paused</span>}
                </span>
                <b>{usd(v.spend_usd)}</b>
                <span className="bar">
                  <i style={{ width: `${spent === 0 ? 0 : ((v.spend_usd ?? 0) / spent) * 100}%` }} />
                </span>
                <small>
                  {v.merged ?? 0} of {plural(v.runs ?? 0, "run")} merged{v.actions_minutes !== undefined ? `, ${v.actions_minutes.toLocaleString("en-US")} Actions minutes` : ""}
                </small>
              </div>
            ))}
          </section>
          {shares.length > 0 && (
            <section>
              <h2 className="part">Against each share</h2>
              {shares.map((s) => (
                <div className="lane-r" key={s.share}>
                  <span>{SHARE_NAME[s.share] ?? s.share}</span>
                  <b>
                    {usd(s.spentUsd)} <span className="muted">of {usd(s.allowanceUsd)}</span>
                  </b>
                  <span className={s.fraction >= 1 ? "bar over" : "bar"}>
                    <i style={{ width: `${Math.min(1, s.fraction) * 100}%` }} />
                  </span>
                  {s.paused && <small className="warn">Paused until next month: its share is used.</small>}
                </div>
              ))}
            </section>
          )}
          <section>
            <h2 className="part">Other numbers</h2>
            <dl className="kv">
              {cycle !== null && (
                <>
                  <dt>Typical request to PR</dt>
                  <dd>{dur(cycle)}</dd>
                </>
              )}
              {billedMinutes > 0 && (
                <>
                  <dt>Actions minutes billed</dt>
                  <dd>{Math.round(billedMinutes).toLocaleString("en-US")}</dd>
                </>
              )}
              {m.cycle_time_p90_sec !== undefined && (
                <>
                  <dt>Slowest one in ten</dt>
                  <dd>over {dur(m.cycle_time_p90_sec)}</dd>
                </>
              )}
              <dt>Runs</dt>
              <dd>
                {m.runs}, {merged} merged{m.escalated !== undefined ? `, ${m.escalated} handed to a person` : ""}
              </dd>
              {m.revert_rate !== undefined && (
                <>
                  <dt>Reverted later</dt>
                  <dd>{pct(m.revert_rate, 1)}</dd>
                </>
              )}
              {m.human_interactions_per_pr != null && (
                <>
                  <dt>Corrections per PR</dt>
                  <dd>{m.human_interactions_per_pr.toFixed(1)}</dd>
                </>
              )}
              {m.actions_minutes !== undefined && (
                <>
                  <dt>Actions minutes</dt>
                  <dd>
                    {m.actions_minutes.toLocaleString("en-US")}
                    {m.actions_minutes_limit != null ? ` of ${m.actions_minutes_limit.toLocaleString("en-US")} free` : ""}
                  </dd>
                </>
              )}
            </dl>
            <p className="muted small">Over the last {m.window_days} days.</p>
          </section>
        </aside>
      </div>
    </Page>
  );
}

function Page({ children, money }: { children: ReactNode; money?: boolean }) {
  return (
    <main className="wrap">
      {money !== true && (
        <header className="page-head">
          <h1>Spend</h1>
          <p className="rest">What the factory spends, against what it may, and what it got for it.</p>
        </header>
      )}
      {children}
    </main>
  );
}

/** Each day's spend as a bar, and the running total as a line against the budget at the top. */
function Chart({ daily, budget }: { daily: readonly DailyPoint[]; budget: number }) {
  const W = 720;
  const H = 180;
  const bw = W / daily.length;
  const max = Math.max(0.01, ...daily.map((d) => d.spend_usd ?? 0));
  const total = daily.reduce((n, d) => n + (d.spend_usd ?? 0), 0);
  const top = Math.max(budget, total, 0.01);
  let run = 0;
  const line = daily
    .map((d, i) => {
      run += d.spend_usd ?? 0;
      return `${((i + 0.5) * bw).toFixed(1)},${(H - (run / top) * H).toFixed(1)}`;
    })
    .join(" ");
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H + 24}`} role="img" aria-label={`Daily spend over ${daily.length} days, ${usd(total)} in all`}>
        {budget > 0 && (
          <>
            <line x1="0" x2={W} y1={H - (budget / top) * H} y2={H - (budget / top) * H} stroke="currentColor" strokeOpacity=".35" strokeDasharray="4 4" />
            <text x={W} y={Math.max(12, H - (budget / top) * H - 4)} textAnchor="end" fontSize="12" fill="currentColor" fillOpacity=".6">
              {usd(budget)} budget
            </text>
          </>
        )}
        {daily.map((d, i) => {
          const h = ((d.spend_usd ?? 0) / max) * H * 0.55;
          return (
            <rect key={d.date} x={i * bw + 2} y={H - h} width={Math.max(1, bw - 4)} height={h} rx="2" fill="currentColor" fillOpacity=".22">
              <title>{`${day(d.date)}: ${usd(d.spend_usd)}, ${d.merged ?? 0} merged, ${d.runs ?? 0} runs`}</title>
            </rect>
          );
        })}
        <polyline points={line} fill="none" stroke="var(--you)" strokeWidth="2.5" strokeLinejoin="round" />
        <text x="0" y={H + 20} fontSize="12" fill="currentColor" fillOpacity=".6">
          {day(daily[0]?.date)}
        </text>
        <text x={W} y={H + 20} fontSize="12" textAnchor="end" fill="currentColor" fillOpacity=".6">
          {day(daily[daily.length - 1]?.date)}
        </text>
      </svg>
      <p className="muted small">Bars are each day&rsquo;s spend; point at one for the figure. The line is the running total.</p>
    </div>
  );
}

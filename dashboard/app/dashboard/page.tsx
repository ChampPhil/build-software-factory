"use client";

import { useMemo } from "react";
import { readSession } from "@/lib/session";
import { useClient, useFactorySettings, useIndex } from "@/lib/data";
import { EmptyFactoryNote } from "@/components/empty-factory";
import {
  PageHead, Section, Figure, Gauge, Bars, Note, Empty,
  asPct, asPct1, asUsd, asDuration, asCount, asDecimal,
} from "@/components/primitives";
import { headline, projectToMonthEnd, shareUse, series, formatUsd } from "@/lib/metrics";

/** How is the factory doing? */
export default function Dashboard() {
  const session = useMemo(() => readSession(), []);
  const auth = session === null ? null : { token: session.token, repo: session.repo };
  const client = useClient(auth);
  const index = useIndex(client);
  const settings = useFactorySettings(client);

  if (index.state === "loading") return <Loading />;
  if (index.state === "error") {
    return (
      <>
        <PageHead title="Dashboard" />
        <Note tone="bad">
          {index.error} <button className="btn" onClick={index.retry} style={{ marginLeft: 8 }}>Try again</button>
        </Note>
      </>
    );
  }

  const data = index.data;
  if (data === null) {
    return (
      <>
        <PageHead title="Dashboard" />
        <EmptyFactoryNote installed={settings.state === "ready" ? settings.data !== null : null} />
        <Empty title="No measurements yet">
          The factory writes its records as it works. Once the first run finishes, every number on
          this page fills in from the factory&rsquo;s own data.
        </Empty>
      </>
    );
  }

  const h = headline(data);
  const m = data.metrics;
  const spend = m.spend_usd ?? 0;
  const projection = projectToMonthEnd(spend, new Date());
  const shares = shareUse(data, { product_work: 60, gardening: 25, review_and_benchmarks: 15 });
  const runsSeries = series(data.daily, "runs");
  const mergedSeries = series(data.daily, "merged");
  const spendSeries = series(data.daily, "spend_usd");

  const minutesFraction =
    m.actions_minutes !== undefined && m.actions_minutes_limit != null && m.actions_minutes_limit > 0
      ? m.actions_minutes / m.actions_minutes_limit
      : null;

  return (
    <>
      <PageHead
        title="Dashboard"
        lede={`Last ${m.window_days} days. Runner ${data.factory.runner}, ${data.factory.harness}.`}
      />

      <dl className="figures">
        <Figure label="Autonomy" value={h.autonomy} format={asPct}
          sub="merged with no human code push" />
        <Figure label="Cycle time (p50)" value={h.cycleTimeP50} format={asDuration}
          sub={h.cycleTimeP90.known ? `p90 ${asDuration(h.cycleTimeP90.value)}` : undefined} />
        <Figure label="Cost per PR" value={h.costPerPr} format={asUsd}
          sub="including retries" />
        <Figure label="Spend" value={h.spendUsd} format={asUsd}
          sub={h.budgetUsd.known ? `of ${asUsd(h.budgetUsd.value)} budget` : "no budget set"} />
        <Figure label="Revert rate" value={h.revertRate} format={asPct1}
          sub="reverted within 14 days" />
        <Figure label="Human interactions / PR" value={h.humanInteractionsPerPr} format={asDecimal}
          sub="comments, change requests and human commits" />
        <Figure label="Runs" value={{ known: true, value: m.runs }} format={asCount}
          sub={`${m.merged ?? 0} merged, ${m.escalated ?? 0} escalated`} />
      </dl>

      <Section
        title="Budget"
        lede="Each pipeline pauses when its own share is used. Product work may spend what the others left, up to 110% of the total."
      >
        <div style={{ display: "grid", gap: 18, maxWidth: 680 }}>
          {shares.map((s) => (
            <Gauge
              key={s.share}
              name={shareName(s.share)}
              read={`${formatUsd(s.spentUsd)} of ${formatUsd(s.allowanceUsd)}`}
              fraction={s.fraction}
              tone={s.paused ? "fail" : s.fraction > 0.85 ? "run" : "pass"}
              markAt={1}
              markLabel="share"
              foot={s.paused ? "Paused: this share is used up." : undefined}
            />
          ))}
          {minutesFraction !== null && (
            <Gauge
              name="Actions minutes"
              read={`${asCount(Math.round(m.actions_minutes ?? 0))} of ${asCount(m.actions_minutes_limit ?? 0)}`}
              fraction={minutesFraction}
              tone={minutesFraction > 0.85 ? "run" : "pass"}
              markAt={1}
              markLabel="included"
              foot={
                minutesFraction > 0.85
                  ? "Close to the plan's included minutes. Gardening is usually what to lower."
                  : undefined
              }
            />
          )}
          {projection.known && (
            <div className="gauge-foot">
              At this rate, {formatUsd(projection.value)} by month end.
            </div>
          )}
          {!projection.known && <div className="gauge-foot">{projection.why}</div>}
        </div>
      </Section>

      {runsSeries.length > 0 && (
        <Section title="Per day" lede={`Runs, merges and spend over the last ${runsSeries.length} days.`}>
          <div style={{ display: "grid", gap: 22, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            <TrendBlock label="Runs" values={runsSeries.map((p) => p.value)} total={sum(runsSeries.map((p) => p.value))} />
            <TrendBlock label="Merged" values={mergedSeries.map((p) => p.value)} total={sum(mergedSeries.map((p) => p.value))} />
            <TrendBlock
              label="Spend"
              values={spendSeries.map((p) => p.value)}
              total={formatUsd(Math.round(sum(spendSeries.map((p) => p.value)) * 100) / 100)}
            />
          </div>
        </Section>
      )}

      {data.guardrails !== undefined && (
        <Section title="Guardrails" lede="How strict the codebase is, and how much cleanup is left.">
          <dl className="figures" style={{ maxWidth: 740 }}>
            <Figure label="Rules" value={{ known: true, value: data.guardrails.rules ?? 0 }} format={asCount} />
            <Figure
              label="Still baselined"
              value={{ known: true, value: data.guardrails.baselined ?? 0 }}
              format={asCount}
              sub={(data.guardrails.baselined ?? 0) === 0 ? "cleanup finished" : "gardening is clearing these"}
            />
            <Figure
              label="Coverage floor"
              value={
                data.guardrails.coverage_floor_pct === undefined
                  ? { known: false, why: "Not measured." }
                  : { known: true, value: data.guardrails.coverage_floor_pct / 100 }
              }
              format={asPct}
            />
            <Figure
              label="Candidates pending"
              value={{ known: true, value: data.guardrails.candidates_pending ?? 0 }}
              format={asCount}
              sub="mined corrections awaiting a decision"
            />
          </dl>
        </Section>
      )}
    </>
  );
}

function TrendBlock({ label, values, total }: { label: string; values: readonly number[]; total: number | string }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: "var(--ink-dim)" }}>{label}</span>
        <span style={{ fontWeight: 700, letterSpacing: "-0.02em" }}>{total}</span>
      </div>
      <Bars values={values} />
    </div>
  );
}

function shareName(share: string): string {
  switch (share) {
    case "product_work": return "Product work";
    case "gardening": return "Gardening and hardening";
    case "review_and_benchmarks": return "Reviews and practices";
    default: return share;
  }
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

function Loading() {
  return (
    <>
      <PageHead title="Dashboard" />
      <div className="note quiet">Reading the factory&rsquo;s records…</div>
    </>
  );
}

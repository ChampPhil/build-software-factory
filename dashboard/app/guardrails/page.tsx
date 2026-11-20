"use client";

import { useMemo } from "react";
import { readSession } from "@/lib/session";
import { useClient, useGuardrails } from "@/lib/data";
import { PageHead, Section, Gauge, Empty, Note, Figure, asCount, asPct } from "@/components/primitives";
import { ratchetBars, coverageGauge } from "@/lib/metrics";

/** How strict the codebase is, and how cleanup is going. */
export default function Guardrails() {
  const session = useMemo(() => readSession(), []);
  const auth = session === null ? null : { token: session.token, repo: session.repo };
  const client = useClient(auth);
  const g = useGuardrails(client);

  if (g.state === "loading") {
    return (
      <>
        <PageHead title="Guardrails" />
        <div className="note quiet">Reading the guardrails…</div>
      </>
    );
  }
  if (g.state === "error") {
    return (
      <>
        <PageHead title="Guardrails" />
        <Note tone="bad">
          {g.error} <button className="btn" onClick={g.retry} style={{ marginLeft: 8 }}>Try again</button>
        </Note>
      </>
    );
  }

  const { baselines, coverage, candidates } = g.data;
  const bars = ratchetBars(baselines, baselines);
  const gauge = coverageGauge(coverage);
  const pending = (candidates?.candidates ?? []).filter((c) => c.status === "pending");
  const active = bars.filter((b) => !b.retired && b.now > 0);
  const retired = bars.filter((b) => b.retired);

  if (baselines === null && coverage === null) {
    return (
      <>
        <PageHead title="Guardrails" />
        <Empty title="No guardrails recorded yet">
          Setup records the starting counts, and this page shows cleanup against them from the
          first night of gardening onward.
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Guardrails"
        lede="Every count here moves one way. A pull request that raises one, or lowers a floor, needs a person to approve it."
      />

      <dl className="figures" style={{ maxWidth: 820 }}>
        <Figure label="Rules with violations left" value={{ known: true, value: active.length }} format={asCount}
          sub={active.length === 0 ? "nothing left to clean" : "gardening is clearing these"} />
        <Figure label="Cleared" value={{ known: true, value: retired.length }} format={asCount}
          sub="baselines retired" />
        <Figure
          label="Coverage floor"
          value={gauge === null ? { known: false, why: "No coverage recorded." } : { known: true, value: gauge.floor / 100 }}
          format={asPct}
        />
        <Figure label="Candidates pending" value={{ known: true, value: pending.length }} format={asCount}
          sub="mined corrections awaiting a decision" />
      </dl>

      {gauge !== null && (
        <Section
          title="Coverage"
          lede="Diff coverage is the main check; total coverage trails its own high mark, so a small dip passes and a real fall does not."
        >
          <div style={{ display: "grid", gap: 18, maxWidth: 680 }}>
            <Gauge
              name="Total coverage"
              read={`${gauge.high}% high mark · ${gauge.floor}% floor`}
              fraction={gauge.high / 100}
              markAt={gauge.floor / 100}
              markLabel="floor"
              foot={`The floor sits ${gauge.headroom} point${gauge.headroom === 1 ? "" : "s"} under the high mark, and only ever rises.`}
            />
            <Gauge
              name="Diff coverage required"
              read={`${gauge.diffMin}% of changed lines`}
              fraction={gauge.diffMin / 100}
              tone="run"
              foot="Applies to every pull request, whatever the total is."
            />
            <Gauge
              name="Skipped tests"
              read={`${gauge.skips} of ${gauge.skipCap} allowed`}
              fraction={gauge.skipCap === 0 ? 0 : gauge.skips / gauge.skipCap}
              tone={gauge.skips >= gauge.skipCap ? "fail" : gauge.skips > gauge.skipCap * 0.7 ? "run" : "pass"}
              markAt={1}
              markLabel="cap"
              foot="A skip needs a reason, and the total is capped."
            />
          </div>
        </Section>
      )}

      {active.length > 0 && (
        <Section
          title="Cleanup"
          lede="Each rule went in behind a baseline so it could be enforced before the codebase was clean. Gardening lowers these a little every night, and never raises one."
        >
          <div style={{ display: "grid", gap: 16, maxWidth: 680 }}>
            {active.map((b) => (
              <Gauge
                key={b.rule}
                name={b.rule}
                read={`${b.now} left of ${b.atSetup}`}
                fraction={b.progress}
                tone={b.progress > 0 ? "pass" : "run"}
                foot={
                  b.progress === 0
                    ? `Across ${b.files || "?"} file${b.files === 1 ? "" : "s"}. Nothing cleared yet.`
                    : `Across ${b.files || "?"} file${b.files === 1 ? "" : "s"}.`
                }
              />
            ))}
          </div>
        </Section>
      )}

      {retired.length > 0 && (
        <Section title={`Cleared · ${retired.length}`} lede="These rules are at zero and enforced outright.">
          <div className="rows">
            {retired.map((b) => (
              <div className="row" key={b.rule} style={{ gridTemplateColumns: "1fr auto" }}>
                <span className="row-title">{b.rule}</span>
                <span className="row-meta">was {b.atSetup}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {pending.length > 0 && (
        <Section
          title={`Candidates · ${pending.length}`}
          lede="Problem classes mined from past corrections. Each is sorted by the strongest fix available: a change that makes the mistake impossible beats a rule that catches it."
        >
          <div className="rows">
            {pending.map((c) => (
              <div className="row" key={c.id} style={{ gridTemplateColumns: "1fr auto auto" }}>
                <div>
                  <div className="row-title">{c.problem_class}</div>
                  <div className="row-meta">
                    {c.occurrences} occurrence{c.occurrences === 1 ? "" : "s"}
                    {c.sources[0]?.quote !== undefined && <> · &ldquo;{c.sources[0].quote}&rdquo;</>}
                  </div>
                </div>
                <span className="tag hardening">{fixLabel(c.proposed_fix)}</span>
                {c.critical_logic === true && <span className="tag conflict">critical</span>}
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function fixLabel(fix: string): string {
  switch (fix) {
    case "api_change": return "change the API";
    case "static_rule": return "static rule";
    case "verification": return "verification";
    case "context": return "context line";
    default: return fix;
  }
}

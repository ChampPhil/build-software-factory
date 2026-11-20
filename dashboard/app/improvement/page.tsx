"use client";

import { useMemo } from "react";
import { readSession } from "@/lib/session";
import { useClient, useIndex, useImprovement } from "@/lib/data";
import { configPoints, verdictOf, scorerCards, type ConfigPoint } from "@/lib/metrics";
import { PageHead, Empty, Note, Section, Dot, asUsd, asPct } from "@/components/primitives";

/**
 * What the scheduled review found, and which configuration works best.
 *
 * The thing this page exists to prevent: adopting a change because its
 * benchmark number went up, when the difference is inside the noise of the
 * runs. So every comparison shows the spread, and a difference smaller than it
 * is labelled "no clear winner" rather than a win or a loss.
 */
export default function Improvement() {
  const session = useMemo(() => readSession(), []);
  const token = session?.token ?? null;
  const repoName = session?.repo ?? null;
  const auth = useMemo(
    () => (token === null || repoName === null ? null : { token, repo: repoName }),
    [token, repoName],
  );
  const client = useClient(auth);
  const index = useIndex(client);
  const improvement = useImprovement(client);

  const data = index.state === "ready" ? index.data : null;
  const imp = improvement.state === "ready" ? improvement.data : null;
  const lastReview = data?.health?.last_review;
  const repo = session?.repo;

  const points = useMemo(() => configPoints(imp?.results ?? []), [imp?.results]);
  // Numbered by score, and the same numbers label the dots, so a point on the
  // chart can be found in the list under it. Without them a dot is anonymous.
  const ranked = useMemo(
    () => [...points].sort((a, b) => b.score - a.score).map((p, i) => ({ ...p, rank: i + 1 })),
    [points],
  );
  const reviews = imp?.reviews ?? [];
  const latest = reviews[0];

  return (
    <>
      <PageHead
        title="Improvement"
        lede="The factory grades its own recent work every few days, and routes what it finds to hardening or to a change in its own definition."
      />

      {improvement.state === "error" && (
        <Note tone="bad">
          The review and benchmark records could not be read: {improvement.error}
        </Note>
      )}

      {lastReview === undefined && reviews.length === 0 ? (
        <Empty title="No review yet">
          The first review runs once there are enough finished runs to grade — by default after
          three days, or sooner if fifty runs land first. It scores recent work against the
          rubrics, groups the failures, and opens work items for the ones worth fixing.
        </Empty>
      ) : (
        <>
          {latest !== undefined && (
            <Section
              title="The last review"
              lede={`${latest.window.runs} run(s) between ${latest.window.from.slice(0, 10)} and ${latest.window.to.slice(0, 10)}, scored against the rubrics.`}
            >
              <div className="rows">
                {scorerCards(latest).map((c) => (
                  <div key={c.criterion} className="row" style={{ gridTemplateColumns: "1fr auto auto" }}>
                    <span className="row-title">
                      <Dot tone={c.passRate >= 0.9 ? "pass" : c.passRate >= 0.7 ? "run" : "fail"} />{" "}
                      {c.criterion}
                    </span>
                    <span className="row-num">{asPct(c.passRate)}</span>
                    <span className="row-num row-meta">{c.runs} scored</span>
                  </div>
                ))}
              </div>

              {latest.problems.length === 0 ? (
                <p className="lede">Nothing was worth routing: no criterion failed often enough.</p>
              ) : (
                <>
                  <div className="rows" style={{ marginTop: 16 }}>
                    {latest.problems.map((p) => (
                      <div key={p.title} className="row" style={{ gridTemplateColumns: "1fr auto auto" }}>
                        <span className="row-title">{p.title}</span>
                        <span className={`tag ${p.route === "definition" ? "definition" : "hardening"}`}>
                          {p.route === "definition" ? "definition change" : "hardening"}
                        </span>
                        <span className="row-num row-meta">
                          {p.runs.length} run{p.runs.length === 1 ? "" : "s"}
                          {p.pr !== undefined && repo !== undefined ? (
                            <>
                              {" · "}
                              <a href={`https://github.com/${repo}/pull/${p.pr}`}>#{p.pr}</a>
                            </>
                          ) : p.work_item !== undefined ? (
                            <> · {p.work_item}</>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Section>
          )}

          {reviews.length > 1 && (
            <Section title="Earlier reviews" lede="Oldest kept for comparison; a drop in a pass rate is the thing to look for.">
              <div className="rows">
                {reviews.slice(1).map((r) => (
                  <div key={r.id} className="row" style={{ gridTemplateColumns: "1fr auto" }}>
                    <span className="row-title mono">{r.id}</span>
                    <span className="row-num row-meta">
                      {r.window.runs} runs · {r.problems.length} problem
                      {r.problems.length === 1 ? "" : "s"} ·{" "}
                      {r.problems.filter((p) => p.route === "definition").length} to definition
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      <Section
        title="Cost against quality"
        lede={
          imp === null
            ? "Each configuration the factory has benchmarked, with the current one marked."
            : `Each configuration the factory has benchmarked, over ${imp.taskCount} frozen task(s). The current one is marked; a configuration on the frontier is one nothing else beats for the money.`
        }
      >
        {points.length === 0 ? (
          <Empty title="No comparison yet">
            A comparison runs when the review proposes a change to the factory&rsquo;s own
            definition. It runs the frozen benchmark tasks against both configurations, three
            times each, and only a gain larger than the run-to-run spread counts.
          </Empty>
        ) : (
          <>
            <Scatter points={ranked} />
            <div className="rows" style={{ marginTop: 16 }}>
              {ranked.map((p) => (
                  <div
                    key={`${p.label}-${p.at}`}
                    className="row"
                    style={{ gridTemplateColumns: "auto 1fr auto auto" }}
                  >
                    <span className="row-meta mono">{p.rank}</span>
                    <span className="row-title">
                      {p.current && <span className="tag definition">current</span>}
                      {p.onFrontier && !p.current && <span className="tag gardening">best for the cost</span>}
                      {(p.current || p.onFrontier) && " "}
                      {Object.keys(p.models).length === 0
                        ? p.label
                        : Object.entries(p.models)
                            .map(([role, model]) => `${role}: ${model}`)
                            .join(" · ")}
                    </span>
                    <span className="row-num">
                      {p.score.toFixed(2)} <span className="row-meta">±{p.spread.toFixed(2)}</span>
                    </span>
                    <span className="row-num row-meta">
                      {asUsd(p.costPerTask)} / task · {asPct(p.mustPassRate)} must-pass
                    </span>
                  </div>
                ))}
            </div>
          </>
        )}
      </Section>

      {imp !== null && imp.results.length > 0 && (
        <Section
          title="Comparisons run"
          lede="Every comparison, and what it decided. A difference smaller than the run-to-run spread decides nothing."
        >
          <div className="rows">
            {imp.results.map((r) => {
              const v = verdictOf(r);
              return (
                <div key={r.id} className="row" style={{ gridTemplateColumns: "auto 1fr auto" }}>
                  <span className="row-meta">{r.at.slice(0, 10)}</span>
                  <span className="row-title">
                    <Dot tone={v.verdict === "adopted" ? "pass" : v.verdict === "rejected" ? "fail" : "idle"} />{" "}
                    {v.verdict === "no_clear_winner" ? "No clear winner" : v.verdict === "adopted" ? "Adopted" : "Rejected"}
                    {r.pr !== undefined && repo !== undefined && (
                      <>
                        {" "}
                        <a href={`https://github.com/${repo}/pull/${r.pr}`}>#{r.pr}</a>
                      </>
                    )}
                    <span className="row-meta"> — {v.why}</span>
                  </span>
                  <span className="row-num row-meta">
                    {r.task_count} tasks × {r.repeats}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="How a change gets adopted">
        <p className="lede">
          A proposed change is run against at least ten frozen tasks, three times each side. It is
          adopted only if it beats the current configuration on the tasks that were failing, costs
          no more than a little extra, and regresses nothing that was passing. Where the difference
          sits inside the spread of the runs, the answer is no clear winner, and nothing changes.
        </p>
        {repo !== undefined && (
          <p className="lede">
            <a href={`https://github.com/${repo}/pulls?q=is%3Apr+label%3Afactory%3Adefinition`}>
              Definition pull requests
            </a>{" "}
            carry the benchmark result that justified them.
          </p>
        )}
      </Section>
    </>
  );
}

/**
 * Cost on the horizontal axis, score on the vertical, the frontier joined.
 *
 * Drawn as inline SVG rather than with a chart library: it is a dozen points,
 * the dashboard ships as a static file, and a library would be most of the
 * bundle.
 */
function Scatter({ points }: { points: readonly (ConfigPoint & { readonly rank: number })[] }) {
  const w = 560;
  const h = 260;
  const pad = { left: 52, right: 16, top: 16, bottom: 36 };

  const costs = points.map((p) => p.costPerTask);
  const scores = points.map((p) => p.score);
  const maxCost = Math.max(...costs) * 1.1 || 1;
  const minScore = Math.min(1, Math.min(...scores) - 0.3);
  const maxScore = Math.max(5, Math.max(...scores) + 0.3);

  const x = (cost: number) => pad.left + (cost / maxCost) * (w - pad.left - pad.right);
  const y = (score: number) =>
    h - pad.bottom - ((score - minScore) / (maxScore - minScore)) * (h - pad.top - pad.bottom);

  const frontier = [...points].filter((p) => p.onFrontier).sort((a, b) => a.costPerTask - b.costPerTask);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="scatter" role="img" aria-label="Cost against benchmark score for each configuration">
      <line x1={pad.left} y1={h - pad.bottom} x2={w - pad.right} y2={h - pad.bottom} className="axis" />
      <line x1={pad.left} y1={pad.top} x2={pad.left} y2={h - pad.bottom} className="axis" />
      {[1, 2, 3, 4, 5].filter((s) => s >= minScore && s <= maxScore).map((s) => (
        <g key={s}>
          <line x1={pad.left} y1={y(s)} x2={w - pad.right} y2={y(s)} className="gridline" />
          <text x={pad.left - 8} y={y(s) + 4} className="tick" textAnchor="end">
            {s}
          </text>
        </g>
      ))}
      <text x={pad.left} y={h - 8} className="tick">
        $0
      </text>
      <text x={w - pad.right} y={h - 8} className="tick" textAnchor="end">
        {asUsd(maxCost)} per task
      </text>

      {frontier.length > 1 && (
        <polyline
          className="frontier"
          points={frontier.map((p) => `${x(p.costPerTask)},${y(p.score)}`).join(" ")}
        />
      )}

      {points.map((p) => (
        <g key={`${p.label}-${p.at}`}>
          {/* The spread drawn as a bar, so a point whose number moves a lot
              cannot be read as a precise measurement. */}
          <line
            x1={x(p.costPerTask)}
            y1={y(Math.min(maxScore, p.score + p.spread))}
            x2={x(p.costPerTask)}
            y2={y(Math.max(minScore, p.score - p.spread))}
            className="spread"
          />
          <circle
            cx={x(p.costPerTask)}
            cy={y(p.score)}
            r={p.current ? 8 : 7}
            className={p.current ? "point current" : "point"}
          >
            <title>
              {`${p.rank}. ${
                Object.keys(p.models).length === 0
                  ? p.label
                  : Object.entries(p.models)
                      .map(([role, model]) => `${role}: ${model}`)
                      .join(", ")
              } — ${p.score.toFixed(2)} ±${p.spread.toFixed(2)}, ${asUsd(p.costPerTask)} per task`}
            </title>
          </circle>
          <text x={x(p.costPerTask)} y={y(p.score) + 3.5} className="point-rank" textAnchor="middle">
            {p.rank}
          </text>
        </g>
      ))}
    </svg>
  );
}

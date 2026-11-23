"use client";

import { useMemo } from "react";
import { readSession } from "@/lib/session";
import { useClient, useIndex, useImprovement } from "@/lib/data";
import { scorerCards } from "@/lib/metrics";
import { PageHead, Empty, Note, Section, Dot, asPct } from "@/components/primitives";

/**
 * What the scheduled review found.
 *
 * The review grades recent runs against the rubrics and files what it finds as
 * hardening work. A failure found in a hardening run is shown here and not
 * filed again, so hardening cannot feed itself; a person decides what to do
 * about those.
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

  const reviews = imp?.reviews ?? [];
  const latest = reviews[0];

  return (
    <>
      <PageHead
        title="Improvement"
        lede="The factory grades its recent work every few days and files what it finds as hardening work, which makes the codebase catch the same mistake next time."
      />

      {improvement.state === "error" && (
        <Note tone="bad">The review records could not be read: {improvement.error}</Note>
      )}

      {lastReview === undefined && reviews.length === 0 ? (
        <Empty title="No review yet">
          The first review runs three days after the factory&rsquo;s first run, even if only a few
          runs have finished. After that a review runs every three days once at least five runs
          are done, or sooner if fifty land first. It scores recent work against the rubrics,
          groups the failures, and opens hardening work for the ones worth fixing.
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
                <div className="rows" style={{ marginTop: 16 }}>
                  {latest.problems.map((p) => (
                    <div key={p.title} className="row" style={{ gridTemplateColumns: "1fr auto auto" }}>
                      <span className="row-title">{p.title}</span>
                      <span className="tag hardening">hardening</span>
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
              )}
            </Section>
          )}

          {latest?.unrouted !== undefined && latest.unrouted.length > 0 && (
            <Section
              title={`Hardening runs that scored badly · ${latest.unrouted.length}`}
              lede="Hardening work was graded too. These failures were not filed as new hardening work, so one bad run cannot start another. They are here for a person to look at."
            >
              <div className="rows">
                {latest.unrouted.map((u) => (
                  <div key={`${u.run}-${u.tag}`} className="row" style={{ gridTemplateColumns: "1fr auto" }}>
                    <span className="row-title">
                      <Dot tone="fail" /> {u.tag}
                      {u.detail !== undefined && <span className="row-meta"> — {u.detail}</span>}
                    </span>
                    <span className="row-num row-meta mono">{u.run}</span>
                  </div>
                ))}
              </div>
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
                      {r.problems.length === 1 ? "" : "s"}
                      {r.unrouted !== undefined && r.unrouted.length > 0 ? ` · ${r.unrouted.length} not routed` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </>
  );
}

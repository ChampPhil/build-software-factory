"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useCorrections, useImprovement } from "@/lib/data";
import { quoteOf, sourceLink, whereOf } from "@/lib/corrections";
import { day, pct, plural } from "@/lib/view";
import type { ReviewFile } from "@/lib/types";
import { useApp } from "@/components/app";
import { Bar, Loading, Out, Problem } from "@/components/ui";
import { EmptyFactoryNote } from "@/components/empty-factory";

const FIX: Readonly<Record<string, string>> = {
  static_rule: "a lint rule",
  verification: "a check in verification",
  api_change: "a change that makes the mistake impossible",
  context: "whichever of those fits",
};

/**
 * The checks that stop the same mistake twice. Most come from corrections
 * people made; every count here moves one way only, and a change that would
 * loosen one needs a person to approve it.
 */
export default function Guardrails() {
  const { client, guardrails, ledger, act, installed, compose, demo } = useApp();
  const corrections = useCorrections(client, ledger.state === "ready" ? ledger.data : null);
  const improvement = useImprovement(client);

  if (guardrails.state === "loading") return <Page><Loading what="the guardrails" /></Page>;
  if (guardrails.state === "error") return <Page><Problem error={guardrails.error} retry={guardrails.retry} /></Page>;
  const { baselines, coverage, candidates } = guardrails.data;
  const nothing = baselines === null && coverage === null && candidates === null;
  const all = candidates?.candidates ?? [];
  const pending = all.filter((c) => c.status === "pending");
  const decided = all.filter((c) => c.status !== "pending");
  const rules = Object.entries(baselines?.rules ?? {}).sort((a, b) => Number(a[1].retired === true) - Number(b[1].retired === true) || b[1].count - a[1].count);
  const reviews = improvement.state === "ready" ? improvement.data.reviews : [];
  const latest: ReviewFile | undefined = reviews[0];

  return (
    <Page>
      {nothing && <EmptyFactoryNote installed={installed} />}
      <div className="cols">
        <div className="main-col">
          <section>
            <h2 className="sect">
              Rules it could add {pending.length > 0 && <span className="count">{pending.length}</span>}
            </h2>
            {pending.length === 0 ? (
              <p className="muted">Nothing waiting. A candidate appears when people correct the same kind of thing more than once.</p>
            ) : (
              pending.map((c) => (
                <article className="cand" key={c.id}>
                  <h3>{c.problem_class}</h3>
                  <p>
                    Seen {plural(c.occurrences, "time")}
                    {c.first_seen !== undefined && c.last_seen !== undefined ? `, between ${day(c.first_seen)} and ${day(c.last_seen)}` : ""}.
                    {c.critical_logic === true ? " It touches critical logic, so a slip here costs more." : ""}
                  </p>
                  {c.sources.slice(0, 2).map((s, i) => (
                    <p className="voice small" key={i}>
                      {s.quote !== undefined ? <>&ldquo;{s.quote}&rdquo;</> : s.kind.replace(/_/g, " ")}
                      {s.pr !== undefined && <span className="muted small"> on #{s.pr}</span>}
                    </p>
                  ))}
                  <p className="muted small">Adding it starts a hardening run that writes {FIX[c.proposed_fix] ?? "a guardrail"}, with an example it must catch.</p>
                  <div className="acts">
                    <button className="btn go" type="button" onClick={() => void act(() => client.decideCandidate(c.id, "accept"), "Accepted. Hardening starts shortly.")}>
                      Add the rule
                    </button>
                    <button className="btn" type="button" onClick={() => void act(() => client.decideCandidate(c.id, "reject"), "Noted. It won't be proposed again.")}>
                      Not a rule
                    </button>
                  </div>
                </article>
              ))
            )}
            {decided.length > 0 && (
              <details className="past">
                <summary>{plural(decided.length, "decided earlier", "decided earlier")}</summary>
                <ul className="plain-list">
                  {decided.map((c) => (
                    <li key={c.id}>
                      <b>{c.problem_class}</b>: {c.status === "installed" ? "installed" : c.status === "accepted" ? "accepted, being written" : "turned down"}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section>
            <h2 className="sect">
              Installed rules <span className="muted">{plural(rules.length, "rule")}</span>
            </h2>
            {rules.length === 0 ? (
              <p className="muted">No rules recorded yet. Setup installs the first ones from the repository&rsquo;s history.</p>
            ) : (
              <>
                <div className="table rules-t" role="table" aria-label="Rules">
                  <div className="tr th" role="row">
                    <span role="columnheader">Rule</span>
                    <span role="columnheader">Where the old cases are</span>
                    <span role="columnheader">Checked by</span>
                    <span role="columnheader" className="r">Old cases left</span>
                  </div>
                  {rules.map(([id, r]) => (
                    <div className="tr" role="row" key={id}>
                      <span role="cell" className="t">
                        <code>{id}</code>
                        {r.recorded_at !== undefined && <small>since {day(r.recorded_at)}</small>}
                      </span>
                      <span role="cell">
                        {r.retired === true || r.count === 0
                          ? "None left: enforced outright."
                          : Object.keys(r.by_file ?? {}).length > 0
                            ? Object.entries(r.by_file ?? {}).map(([f, n]) => `${f} (${n})`).join(", ")
                            : "Spread across the codebase."}
                      </span>
                      <span role="cell">{r.native ?? "the factory"}</span>
                      <span role="cell" className="r">{r.count}</span>
                    </div>
                  ))}
                </div>
                <p className="muted small">Old cases are the violations that already existed when a rule went in. Gardening lowers them a little every night, and the number may only go down.</p>
              </>
            )}
          </section>

          <section>
            <h2 className="sect">The factory&rsquo;s self-review</h2>
            {improvement.state === "loading" && <Loading what="the reviews" />}
            {latest === undefined && improvement.state === "ready" && <p className="muted">No review yet. The factory grades its own recent work every few days.</p>}
            {latest !== undefined && Date.now() - Date.parse(latest.window.to) < 3 * 86_400_000 && (
              <p className="muted small">The last review is from {day(latest.window.to)}. The factory skips a scheduled review that is not due yet; Run a review now always starts one.</p>
            )}
            {latest !== undefined && <Review review={latest} onAsk={(title) => compose({ title, details: "", goal: "", kind: "harden" })} />}
            <div className="acts">
              <button className="btn small" type="button" onClick={() => void act(() => client.runWorkflowNow("factory-review.yml"), "The review is running. It shows here when it finishes.")}>
                Run a review now
              </button>
              {demo && <span className="muted small">In the demo this is refused, like every change.</span>}
            </div>
            {reviews.length > 1 && (
              <details className="past">
                <summary>{plural(reviews.length - 1, "earlier review")}</summary>
                <ul className="plain-list">
                  {reviews.slice(1).map((r) => (
                    <li key={r.id}>
                      {day(r.window.from)} to {day(r.window.to)}: {plural(r.window.runs, "run")}, {plural(r.problems.length, "problem")} sent to hardening.
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section>
            <h2 className="sect">Corrections it learned from</h2>
            <p className="muted">Each time a person corrects an agent (a review comment, a change request, a fix they pushed, or a word in a local session), the factory changes the codebase so the mistake doesn&rsquo;t come back.</p>
            {corrections.state === "ready" && corrections.data.length === 0 && <p className="muted">None yet.</p>}
            {corrections.state === "ready" && corrections.data.length > 0 && (
              <ul className="corrections">
                {corrections.data.map((i) => {
                  const link = sourceLink(i.body);
                  const quote = quoteOf(i.body);
                  return (
                    <li key={i.id}>
                      <p className="voice small">{quote === "" ? i.title : <>&ldquo;{quote}&rdquo;</>}</p>
                      <p className="muted small">
                        {i.source.actor} {whereOf(i)}. {i.status.replace(/_/g, " ")}.{" "}
                        <Link href={`/request/?id=${encodeURIComponent(i.id)}`}>The hardening request</Link>
                        {link !== null && <> <Out href={link}>Their words</Out></>}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <aside className="rail">
          <section>
            <h2 className="part">Coverage</h2>
            {coverage === null ? (
              <p className="muted">No coverage floor recorded.</p>
            ) : (
              <div className="cov">
                <Bar fraction={coverage.high_pct / 100} mark={coverage.floor_pct / 100} label={`${coverage.high_pct}% tested, floor ${coverage.floor_pct}%`} />
                <p>
                  <b>{coverage.high_pct}%</b> of lines are tested at best. A change may not take it below the floor of {coverage.floor_pct}%, and its own new lines need {coverage.diff_min_pct}%.
                </p>
                <p className="muted small">
                  {coverage.skips.count} of {coverage.skips.cap} allowed test skips used.
                </p>
              </div>
            )}
          </section>
          <section>
            <h2 className="part">How strict it is</h2>
            <p className="muted">
              {plural(rules.length, "rule")}, {plural(rules.filter(([, r]) => r.retired === true || r.count === 0).length, "enforced outright", "enforced outright")}, {plural(rules.reduce((n, [, r]) => n + (r.retired === true ? 0 : r.count), 0), "old case")} left to clear.
            </p>
          </section>
          {latest !== undefined && (
            <section>
              <h2 className="part">Last review</h2>
              <p className="muted">
                {day(latest.window.to)}, over {plural(latest.window.runs, "run")}. {pct(passRate(latest))} of scores passed.
              </p>
            </section>
          )}
        </aside>
      </div>
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <main className="wrap">
      <header className="page-head">
        <h1>Guardrails</h1>
        <p className="rest">The checks that stop the same mistake twice. Most come from corrections people made; each runs on every change before you see it.</p>
      </header>
      {children}
    </main>
  );
}

const passRate = (r: ReviewFile): number => (r.scores.length === 0 ? 0 : r.scores.filter((s) => s.score > 2).length / r.scores.length);

function Review({ review, onAsk }: { review: ReviewFile; onAsk: (title: string) => void }) {
  const by = new Map<string, number[]>();
  for (const s of review.scores) by.set(s.criterion, [...(by.get(s.criterion) ?? []), s.score]);
  const rows = [...by.entries()].map(([criterion, scores]) => ({ criterion, avg: scores.reduce((a, b) => a + b, 0) / scores.length })).sort((a, b) => a.avg - b.avg);
  return (
    <>
      <p>
        {plural(review.window.runs, "run")} from {day(review.window.from)} to {day(review.window.to)}, each scored out of 5.
      </p>
      <div className="scores">
        {rows.map((r) => (
          <div className="score" key={r.criterion}>
            <span>{r.criterion.replace(/_/g, " ")}</span>
            <span className="bar">
              <i style={{ width: `${(r.avg / 5) * 100}%` }} />
            </span>
            <b>{r.avg.toFixed(1)}</b>
          </div>
        ))}
      </div>
      {(review.problems.length > 0 || (review.unrouted?.length ?? 0) > 0) && (
        <>
          <h3 className="sub">What it found, and what it did about it</h3>
          <ul className="plain-list">
            {review.problems.map((p, i) => (
              <li key={i}>
                <b>{p.title}</b> ({plural(p.runs.length, "run")}). Sent to hardening
                {p.work_item !== undefined && (
                  <>
                    {" "}as <Link href={`/request/?id=${encodeURIComponent(p.work_item)}`}>{p.work_item}</Link>
                  </>
                )}
                {p.pr !== undefined ? `, merged in #${p.pr}` : ", queued"}.
              </li>
            ))}
            {(review.unrouted ?? []).map((u, i) => (
              <li key={`u${i}`}>
                <b>Left for you:</b> {u.reason} {u.detail ?? ""}{" "}
                <button className="link" type="button" onClick={() => onAsk(u.reason.replace(/\.$/, ""))}>
                  Make it a request
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

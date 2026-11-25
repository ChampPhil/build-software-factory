"use client";

import Link from "next/link";
import { useFirstRequest, useRunFiles, useStandingGoals, useWorkItems } from "@/lib/data";
import { liveGoals } from "@/lib/routing";
import { readSettings } from "@/lib/settings";
import { countWord, day, hourLocal, needsFrom, pct, pipeName, requestIds, titleOf, usd, whenLine, ago, clock } from "@/lib/view";
import type { WorkItemDoc } from "@/lib/types";
import { useApp } from "@/components/app";
import { NeedCard } from "@/components/needs";
import { RunLine } from "@/components/run-view";
import { RequestForm } from "@/components/request-form";
import { EmptyFactoryNote } from "@/components/empty-factory";
import { Bar, Check, Loading, Problem } from "@/components/ui";

/**
 * The briefing: the page a person opens first, every time.
 *
 * It answers three questions in sentences, in this order: what needs me, what
 * is happening, and what landed while I was away. Everything that needs a
 * person can be dealt with on this page; the rest of the dashboard is for
 * when they want to look closer.
 */
export default function Briefing() {
  const app = useApp();
  const { client, ledger, index, live, pulls, issues, guardrails, installed } = app;
  const L = ledger.state === "ready" ? ledger.data : null;
  const ids = requestIds(L);
  const docs = useWorkItems(client, ids);
  const docMap: Readonly<Record<string, WorkItemDoc>> = docs.state === "ready" ? docs.data : {};
  const issueList = issues.state === "ready" ? issues.data : [];
  const title = (id: string | null | undefined, fallback: string): string => {
    if (id == null) return fallback.replace(/^\[\w+\]\s*/, "");
    const doc = docMap[id];
    const open = L?.open.find((o) => o.work_item === id);
    const n = /^#(\d+)$/.exec(open?.source_ref ?? doc?.source.ref ?? "")?.[1];
    return titleOf(doc, n === undefined ? undefined : issueList.find((i) => i.number === Number(n)), fallback === id ? id : fallback);
  };
  const recentRuns = (index.state === "ready" ? (index.data?.recent_runs ?? []) : []).slice(0, 20);
  const runs = useRunFiles(client, recentRuns);
  const cost = (id: string | null): number | null => {
    if (id === null || runs.state !== "ready") return null;
    const mine = runs.data.filter((r) => r.work_item === id);
    return mine.length === 0 ? null : mine.reduce((n, r) => n + r.cost_usd, 0);
  };
  const goals = useStandingGoals(client);
  const untouched = ledger.state === "ready" && (L === null || (L.open.length === 0 && L.recent.length === 0));
  const first = useFirstRequest(client, untouched);

  const needs = needsFrom({
    ledger: L,
    pulls: pulls.state === "ready" ? pulls.data : [],
    issues: issueList,
    candidates: guardrails.state === "ready" ? (guardrails.data.candidates?.candidates ?? []) : [],
  });
  const going = live.state === "ready" ? live.data : [];
  const day1 = Date.now() - 36 * 3_600_000;
  const landed = (L?.recent ?? []).filter((r) => r.status === "merged" && r.merged_at !== undefined).slice(0, 6);
  const overnight = landed.filter((r) => Date.parse(r.merged_at ?? "") > day1).length;

  if (ledger.state === "loading") {
    return (
      <main className="wrap">
        <section className="lede">
          <p className="when">{whenLine()}</p>
          <h1>Waiting on you</h1>
        </section>
        <Loading what="the factory's records" />
      </main>
    );
  }

  if (ledger.state === "error") {
    return (
      <main className="wrap">
        <section className="lede">
          <h1>Waiting on you</h1>
        </section>
        <Problem error={ledger.error} retry={ledger.retry} />
      </main>
    );
  }

  if (untouched) {
    const suggestion = first.state === "ready" ? first.data : null;
    return (
      <main className="wrap">
        <section className="lede">
          <p className="when">{L === null ? "Nothing waiting on you yet." : `${whenLine()} Nothing is waiting on you.`}</p>
          <h1>{installed === false ? "There's no factory here yet." : "The factory is ready for its first request."}</h1>
          <p className="rest">
            Describe one change. It will ask you a few questions, build it, check it in a sandbox, and come back with a pull request and a recording of it working.
          </p>
        </section>
        <div className="cols">
          <div className="main-col">
            <EmptyFactoryNote installed={installed} />
            {installed === true && <RequestForm first={suggestion !== null} initial={suggestion ?? undefined} />}
          </div>
          <aside className="rail" aria-label="How it works">
            <section>
              <h2 className="part">How a request goes</h2>
              <ol className="how">
                <li><b>It asks.</b> One question at a time, until it can say what it&rsquo;s about to build.</li>
                <li><b>It builds.</b> Usually 10 to 40 minutes on GitHub Actions, inside your budget.</li>
                <li><b>It proves.</b> Drives your app in a sandbox and records what it sees.</li>
                <li><b>You merge.</b> From here; you shouldn&rsquo;t need to open GitHub.</li>
              </ol>
            </section>
          </aside>
        </div>
      </main>
    );
  }

  const head = needs.length === 0 ? "Nothing needs you." : `${countWord(needs.length)} ${needs.length === 1 ? "thing needs" : "things need"} you.`;
  const queued = (L?.open ?? []).filter((o) => o.status === "queued");
  const queue = L?.merge_queue ?? [];
  const m = index.state === "ready" ? index.data?.metrics : undefined;
  const budget = m?.budget_usd ?? 0;
  const goalList = liveGoals(goals.state === "ready" ? goals.data : null);
  const read = app.settings.state === "ready" && app.settings.data !== null ? readSettings(app.settings.data) : null;
  const hour = typeof read?.["gardening_hour"] === "number" ? read["gardening_hour"] : null;

  return (
    <main className="wrap">
      <section className="lede">
        <p className="when">{whenLine()}</p>
        <h1>{head}</h1>
        <p className="rest">
          {going.length === 0 ? "Nothing is running." : `${countWord(going.length)} ${going.length === 1 ? "run is" : "runs are"} going.`}{" "}
          {overnight > 0 ? (
            <>
              <a href="#landed">{countWord(overnight)} {overnight === 1 ? "change" : "changes"} landed</a> in the last day.
            </>
          ) : landed.length > 0 ? (
            <>
              The last change <a href="#landed">landed {ago(landed[0]?.merged_at)}</a>.
            </>
          ) : (
            "Nothing has landed yet."
          )}
        </p>
      </section>
      <div className="cols">
        <div className="main-col">
          <h2 className="part">Waiting on you</h2>
          {needs.length === 0 ? (
            <p className="all-clear">
              When something needs you, it shows up here first: a question to answer, a change to merge, or a request that got stuck.{" "}
              <button className="link" type="button" onClick={() => app.compose()}>
                Ask for something new
              </button>
            </p>
          ) : (
            <section className="needs" aria-label="Waiting on you">
              {needs.map((n, i) => (
                <NeedCard key={`${n.kind}-${i}`} need={n} title={title} cost={cost} issues={issueList} />
              ))}
            </section>
          )}
          {landed.length > 0 && (
            <section className="landed" id="landed" aria-labelledby="landed-h">
              <h2 className="part" id="landed-h">Landed recently</h2>
              <ul className="done-list">
                {landed.map((r) => {
                  const c = cost(r.work_item);
                  return (
                    <li key={r.work_item}>
                      <Link className="done" href={`/request/?id=${encodeURIComponent(r.work_item)}`}>
                        <Check />
                        <span>
                          <h3>{title(r.work_item, r.work_item)}</h3>
                          <p>
                            Merged {clock(r.merged_at)}
                            {r.pr != null ? ` in #${r.pr}` : ""}
                            {c !== null ? `, ${usd(c)}` : ""}.
                          </p>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
        <aside className="rail" aria-label="The factory right now">
          <section>
            <h2 className="part">Going now</h2>
            {going.length === 0 ? (
              <p className="muted">Nothing is running.</p>
            ) : (
              going.map((g) => <RunLine key={g.run} live={g} title={title(g.work_item, g.work_item)} href={`/request/?id=${encodeURIComponent(g.work_item)}&tab=runs`} />)
            )}
          </section>
          {(queued.length > 0 || queue.length > 0) && (
            <section>
              <h2 className="part">Up next</h2>
              <ul className="mini-list">
                {queued.map((q) => (
                  <li key={q.work_item}>
                    <Link href={`/request/?id=${encodeURIComponent(q.work_item)}`}>{title(q.work_item, q.work_item)}</Link>
                    <span>
                      {pipeName(q.pipeline)}
                      {q.priority === "high" ? ", high priority" : ""}
                    </span>
                  </li>
                ))}
                {queue.map((q) => (
                  <li key={q.pr}>
                    {q.work_item !== undefined ? <Link href={`/request/?id=${encodeURIComponent(q.work_item)}&tab=pr`}>{title(q.work_item, `PR #${q.pr}`)}</Link> : <b>PR #{q.pr}</b>}
                    <span>
                      PR #{q.pr} merges itself {Date.parse(q.eligible_at) > Date.now() ? `at ${clock(q.eligible_at)}` : "next"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {m !== undefined && (
            <section>
              <h2 className="part">This month</h2>
              <div className="meter">
                {budget > 0 && <Bar fraction={(m.spend_usd ?? 0) / budget} label={`${pct((m.spend_usd ?? 0) / budget)} of the budget`} />}
                <p>
                  <b>{usd(m.spend_usd)}</b>
                  {budget > 0 ? ` of your ${usd(budget)} budget.` : " spent."}
                  {m.automation_rate !== undefined && ` ${pct(m.automation_rate)} of merges needed no edits.`} <Link href="/spend/">Spend</Link>
                </p>
              </div>
            </section>
          )}
          <section>
            <h2 className="part">{goalList.length === 1 ? "Standing goal" : "Standing goals"}</h2>
            {goalList.length === 0 ? (
              <p className="muted">None. The factory takes requests in the order they come.</p>
            ) : (
              goalList.map((g) => (
                <p className="goal" key={g.id}>
                  {g.text}
                  <span>
                    {g.lane === null ? "Any work" : pipeName(g.lane)}
                    {g.until !== null ? `, until ${day(g.until)}` : ""}
                  </span>
                </p>
              ))
            )}
            <Link href="/factory/#goals">Manage goals</Link>
          </section>
          {index.state === "ready" && index.data?.health?.gardening_schedule_active !== false && (
            <section>
              <h2 className="part">Tonight</h2>
              <p className="muted">Gardening tidies the code nightly{hour === null ? "" : ` at ${hourLocal(hour)}`}, and lowers the guardrail baselines a little each time.</p>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}

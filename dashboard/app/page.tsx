"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { readSession } from "@/lib/session";
import { useClient, useLedger, useGuardrails, useQuestions, useFirstRequest, useFactorySettings } from "@/lib/data";
import { EmptyFactoryNote } from "@/components/empty-factory";
import { waitingOn } from "@/lib/questions";
import { NewRequest, QuestionList } from "@/components/request";
import { CandidateList } from "@/components/corrections";
import { PageHead, Section, Empty, Note, PipelineTag, Dot } from "@/components/primitives";
import { elapsedSince } from "@/lib/metrics";
import type { PullSummary, IssueSummary } from "@/lib/github";

/**
 * Waiting on you.
 *
 * The default page, because the question a person arrives with is "is anything
 * blocked on me?" — and the honest answer is usually "no", which this page
 * should be able to say plainly.
 */
export default function Home() {
  const session = useMemo(() => readSession(), []);
  const auth = session === null ? null : { token: session.token, repo: session.repo };
  const client = useClient(auth);
  const ledger = useLedger(client, true);
  const guardrails = useGuardrails(client);
  const pendingCandidates = (guardrails.state === "ready" ? guardrails.data.candidates?.candidates ?? [] : []).filter((c) => c.status === "pending");

  const [filing, setFiling] = useState(false);

  const [pulls, setPulls] = useState<readonly PullSummary[] | null>(null);
  const [issues, setIssues] = useState<readonly IssueSummary[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (client === null) return;
    let live = true;
    const load = async (): Promise<void> => {
      try {
        const [p, i] = await Promise.all([client.pulls("open"), client.issues()]);
        if (live) {
          setPulls(p);
          setIssues(i.filter((x) => x.pull_request === undefined));
          setProblem(null);
        }
      } catch (err) {
        if (live) setProblem((err as Error).message);
      }
    };
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [client]);

  const factoryPrs = (pulls ?? []).filter((p) => p.labels.some((l) => l.name.startsWith("factory:")));
  const toApprove = factoryPrs.filter((p) => p.draft || p.labels.some((l) => l.name === "factory:cleared"));
  const definitionPrs = factoryPrs.filter((p) => p.labels.some((l) => l.name === "factory:definition"));
  const escalated = (ledger.state === "ready" ? ledger.data?.open : undefined)?.filter(
    (i) => i.status === "escalated",
  ) ?? [];
  const waitingTrust = (ledger.state === "ready" ? ledger.data?.open : undefined)?.filter(
    (i) => i.status === "waiting_trust",
  ) ?? [];
  const needsInfo = (ledger.state === "ready" ? ledger.data?.open : undefined)?.filter(
    (i) => i.status === "needs_info",
  ) ?? [];

  const outside = (issues ?? []).filter(
    (i) =>
      !["OWNER", "MEMBER", "COLLABORATOR"].includes(i.author_association) &&
      !i.labels.some((l) => l.name === "factory:accept"),
  );

  const waiting = waitingOn(ledger.state === "ready" ? (ledger.data?.open ?? []) : []);
  const questions = useQuestions(client, waiting);
  // A factory that has done nothing yet gets one suggested first request, so the
  // first pull request needs no thinking.
  const untouched =
    ledger.state === "ready" && (ledger.data === null || (ledger.data.open.length === 0 && ledger.data.recent.length === 0));
  const factorySettings = useFactorySettings(client);
  const installed = factorySettings.state === "ready" ? factorySettings.data !== null : null;
  const firstRequest = useFirstRequest(client, untouched);
  const suggestion = firstRequest.state === "ready" ? firstRequest.data : null;

  const nothing =
    toApprove.length === 0 &&
    definitionPrs.length === 0 &&
    escalated.length === 0 &&
    waitingTrust.length === 0 &&
    needsInfo.length === 0 &&
    outside.length === 0 &&
    pendingCandidates.length === 0;

  return (
    <>
      <PageHead
        title="Waiting on you"
        lede="Everything that needs a person, oldest first. The factory keeps working on the rest."
        actions={<Link className="btn primary" href="/live">Watch it work</Link>}
      />

      {problem !== null && <Note tone="bad">{problem}</Note>}

      {ledger.state === "ready" && ledger.data === null && <EmptyFactoryNote installed={installed} />}

      {nothing && ledger.state === "ready" && ledger.data !== null && (
        <Empty title="Nothing is waiting on you">
          Every pull request is either still being worked on or already approved. Open Live to see
          what is in flight, or file a request and the factory will pick it up.
        </Empty>
      )}

      {escalated.length > 0 && (
        <Section
          title={`Escalations · ${escalated.length}`}
          lede="Work the factory could not finish. Each one used its three attempts."
        >
          <div className="rows">
            {escalated.map((item) => (
              <div className="row" key={item.work_item} style={{ gridTemplateColumns: "auto 1fr auto auto" }}>
                <Dot tone="fail" title="escalated" />
                <span className="row-title mono">{item.work_item}</span>
                <PipelineTag pipeline={item.pipeline} />
                {item.pr != null ? (
                  <a className="btn" href={prUrl(session?.repo, item.pr)}>PR #{item.pr}</a>
                ) : (
                  <span className="row-meta">no PR</span>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {toApprove.length > 0 && (
        <Section
          title={`Pull requests to approve · ${toApprove.length}`}
          lede="Read the evidence in the PR body first; the diff is below it."
        >
          <div className="rows">
            {toApprove.map((pr) => (
              <div className="row" key={pr.number} style={{ gridTemplateColumns: "auto 1fr auto auto auto" }}>
                <Dot tone={pr.draft ? "run" : "pass"} title={pr.draft ? "draft" : "ready"} />
                <a className="row-title" href={pr.html_url}>{pr.title}</a>
                {pipelineOf(pr) !== null && <PipelineTag pipeline={pipelineOf(pr)!} />}
                <span className="row-meta">{elapsedSince(pr.created_at)} old</span>
                <a className="btn" href={pr.html_url}>Review</a>
              </div>
            ))}
          </div>
        </Section>
      )}

      {definitionPrs.length > 0 && (
        <Section
          title={`Practices to approve · ${definitionPrs.length}`}
          lede="Standing instructions someone declared with /practice. Every agent will follow one once a trusted person approves it."
        >
          <div className="rows">
            {definitionPrs.map((pr) => (
              <div className="row" key={pr.number} style={{ gridTemplateColumns: "auto 1fr auto auto" }}>
                <Dot tone="define" />
                <a className="row-title" href={pr.html_url}>{pr.title}</a>
                <span className="row-meta">{elapsedSince(pr.created_at)} old</span>
                <a className="btn" href={pr.html_url}>Review</a>
              </div>
            ))}
          </div>
        </Section>
      )}

      {needsInfo.length > 0 && client !== null && (
        <Section
          title={`Questions · ${needsInfo.length}`}
          lede="The factory asked one thing before it writes any code. It waits until you answer; nothing times out."
        >
          <QuestionList client={client} waiting={waiting} questions={questions.state === "ready" ? questions.data : {}} />
        </Section>
      )}

      {untouched && suggestion !== null && client !== null && (
        <Section title="Your first request" lede="Suggested from your repository. Send it as it is, or change it first.">
          {filing ? (
            <NewRequest client={client} initial={suggestion} onClose={() => setFiling(false)} />
          ) : (
            <div className="rows">
              <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
                <div>
                  <div className="row-title">{suggestion.title}</div>
                  {suggestion.goal !== "" && <div className="row-meta">Goal: {suggestion.goal}</div>}
                </div>
                <button className="btn primary" onClick={() => setFiling(true)}>
                  Review and send
                </button>
              </div>
            </div>
          )}
        </Section>
      )}

      {pendingCandidates.length > 0 && client !== null && (
        <Section
          title={`Guardrail candidates · ${pendingCandidates.length}`}
          lede="Mistakes people have corrected before. Accept one and the factory changes the codebase so it cannot recur; reject it and it is not proposed again."
        >
          <CandidateList client={client} candidates={pendingCandidates} />
        </Section>
      )}

      {(outside.length > 0 || waitingTrust.length > 0) && (
        <Section
          title={`Outside requests · ${outside.length + waitingTrust.length}`}
          lede="From accounts the factory does not trust, including integrations' bots. Nothing starts until someone adds factory:accept."
        >
          <div className="rows">
            {outside.map((issue) => (
              <div className="row" key={issue.number} style={{ gridTemplateColumns: "auto 1fr auto auto" }}>
                <Dot tone="idle" />
                <a className="row-title" href={issue.html_url}>{issue.title}</a>
                <span className="row-meta">{issue.user?.login ?? "unknown"}</span>
                <a className="btn" href={issue.html_url}>Open</a>
              </div>
            ))}
            {waitingTrust.map((item) => (
              <div className="row" key={item.work_item} style={{ gridTemplateColumns: "auto 1fr auto" }}>
                <Dot tone="idle" />
                <span className="row-title mono">{item.work_item}</span>
                <PipelineTag pipeline={item.pipeline} />
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function pipelineOf(pr: PullSummary): "product_work" | "gardening" | "hardening" | "definition" | "conflict" | null {
  for (const l of pr.labels) {
    switch (l.name) {
      case "factory:product-work": return "product_work";
      case "factory:gardening": return "gardening";
      case "factory:hardening": return "hardening";
      case "factory:definition": return "definition";
      case "factory:conflict": return "conflict";
    }
  }
  return null;
}

function prUrl(repo: string | undefined, number: number): string {
  return repo === undefined ? "#" : `https://github.com/${repo}/pull/${number}`;
}

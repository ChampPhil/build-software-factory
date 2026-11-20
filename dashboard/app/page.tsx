"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { readSession } from "@/lib/session";
import { useClient, useLedger } from "@/lib/data";
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

  const nothing =
    toApprove.length === 0 &&
    definitionPrs.length === 0 &&
    escalated.length === 0 &&
    waitingTrust.length === 0 &&
    needsInfo.length === 0 &&
    outside.length === 0;

  return (
    <>
      <PageHead
        title="Waiting on you"
        lede="Everything that needs a person, oldest first. The factory keeps working on the rest."
        actions={<Link className="btn primary" href="/live">Watch it work</Link>}
      />

      {problem !== null && <Note tone="bad">{problem}</Note>}

      {ledger.state === "ready" && ledger.data === null && (
        <Note>
          No factory data on this repository yet. Once setup has run and the first work item goes
          through, this page fills in.
        </Note>
      )}

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
          title={`Definition changes · ${definitionPrs.length}`}
          lede="Changes to how the factory itself works. Each carries its benchmark result."
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

      {needsInfo.length > 0 && (
        <Section title={`Questions · ${needsInfo.length}`} lede="Triage needs one thing before it can start.">
          <div className="rows">
            {needsInfo.map((item) => (
              <div className="row" key={item.work_item} style={{ gridTemplateColumns: "auto 1fr auto" }}>
                <Dot tone="run" />
                <span className="row-title mono">{item.work_item}</span>
                <PipelineTag pipeline={item.pipeline} />
              </div>
            ))}
          </div>
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

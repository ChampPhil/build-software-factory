"use client";

import { useState } from "react";
import type { GitHubClient } from "@/lib/github";
import { quoteOf, sourceLink, whereOf } from "@/lib/corrections";
import type { CandidatesFile, WorkItemDoc } from "@/lib/types";

type Candidate = CandidatesFile["candidates"][number];

const FIX: Record<Candidate["proposed_fix"], string> = {
  api_change: "refactor",
  static_rule: "static rule",
  verification: "verification",
  // The hardener chooses among the three ways to change the codebase; a
  // candidate that fits none of them neatly leaves the choice to it.
  context: "hardener chooses",
};

/**
 * Problem classes mined from corrections, waiting for a person. Accept starts
 * hardening on one now; reject keeps it from being proposed again. Either goes
 * through the factory's intake, so nobody edits a file.
 */
export function CandidateList({ client, candidates }: { client: GitHubClient; candidates: readonly Candidate[] }) {
  const [sent, setSent] = useState<Readonly<Record<string, "accept" | "reject" | "failed">>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (id: string, decision: "accept" | "reject"): Promise<void> => {
    setBusy(id);
    try {
      await client.decideCandidate(id, decision);
      setSent((s) => ({ ...s, [id]: decision }));
    } catch {
      setSent((s) => ({ ...s, [id]: "failed" }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rows">
      {candidates.map((c) => {
        const result = sent[c.id];
        return (
          <div className="row needs" key={c.id} style={{ gridTemplateColumns: "1fr auto auto auto" }}>
            <div>
              <div className="row-title">{c.problem_class}</div>
              <div className="row-meta">
                <span>{c.occurrences} occurrence{c.occurrences === 1 ? "" : "s"}</span>
                {c.sources[0]?.quote !== undefined && <span>&ldquo;{c.sources[0].quote}&rdquo;</span>}
              </div>
            </div>
            <span className="tag hardening">{FIX[c.proposed_fix]}</span>
            {result === undefined || result === "failed" ? (
              <>
                <button className="btn primary" disabled={busy !== null} onClick={() => void decide(c.id, "accept")}>
                  Accept
                </button>
                <button className="btn" disabled={busy !== null} onClick={() => void decide(c.id, "reject")}>
                  Reject
                </button>
                {result === "failed" && <span className="row-meta" role="alert">Could not send. Try again.</span>}
              </>
            ) : (
              <span className="row-meta">{result === "accept" ? "Accepted. Hardening starts shortly." : "Rejected."}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** What the factory hardened against, with the correction that started each. */
export function CorrectionList({ items, repo }: { items: readonly WorkItemDoc[]; repo: string }) {
  return (
    <div className="rows">
      {items.map((i) => {
        const link = sourceLink(i.body);
        const quote = quoteOf(i.body);
        return (
          <div className="row" key={i.id} style={{ gridTemplateColumns: "1fr auto" }}>
            <div>
              <div className="row-title">{quote === "" ? i.title : quote}</div>
              <div className="row-meta">
                @{i.source.actor} {whereOf(i)}
                {link !== null && <> <a href={link} target="_blank" rel="noreferrer">their words</a></>}
                {i.pr !== null && <> <a href={`https://github.com/${repo}/pull/${i.pr}`} target="_blank" rel="noreferrer">hardening PR #{i.pr}</a></>}
              </div>
            </div>
            <span className="tag hardening">{i.status.replace(/_/g, " ")}</span>
          </div>
        );
      })}
    </div>
  );
}

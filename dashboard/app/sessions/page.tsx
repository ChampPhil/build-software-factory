"use client";

import { useMemo } from "react";
import { readSession } from "@/lib/session";
import { useClient, useGuardrails } from "@/lib/data";
import { PageHead, Empty, Note, Section } from "@/components/primitives";

/**
 * Captured local agent sessions, and the corrections mined from them.
 *
 * When capture is off the page says why, because "no sessions" and "sessions
 * are not being kept" are different situations and only one of them is
 * something to act on.
 */
export default function Sessions() {
  const session = useMemo(() => readSession(), []);
  const auth = session === null ? null : { token: session.token, repo: session.repo };
  const client = useClient(auth);
  const g = useGuardrails(client);

  const candidates = g.state === "ready" ? (g.data.candidates?.candidates ?? []) : [];
  const fromSessions = candidates.filter((c) => c.sources.some((s) => s.kind === "agent_chat"));

  return (
    <>
      <PageHead
        title="Sessions"
        lede="Local agent sessions captured from developers who opted in, and the corrections mined from them."
      />

      <Note tone="quiet">
        Capture is per developer and per machine: each hook asks once, and no answer means no
        capture. On a public repository nothing is captured at all unless the factory was set up
        with a private data repository, because a public repository cannot hold transcripts.
      </Note>

      {fromSessions.length === 0 ? (
        <div style={{ marginTop: 20 }}>
          <Empty title="No corrections from sessions yet">
            When someone corrects an agent working on this repository — &ldquo;no, use the API
            client&rdquo; — that correction is mined into a candidate here, and the recurring ones
            become rules rather than another line of prose nobody reads.
          </Empty>
        </div>
      ) : (
        <Section
          title="Corrections from sessions"
          count={fromSessions.length}
          lede="Grouped into problem classes. Fifteen instances of one correction is one candidate with fifteen occurrences."
        >
          <div className="rows">
            {fromSessions.map((c) => (
              <div className="row" key={c.id} style={{ gridTemplateColumns: "1fr auto auto" }}>
                <div>
                  <div className="row-title">{c.problem_class}</div>
                  {c.sources[0]?.quote !== undefined && (
                    <div className="row-meta">&ldquo;{c.sources[0].quote}&rdquo;</div>
                  )}
                </div>
                <span className="row-meta">{c.occurrences}×</span>
                <span className="tag hardening">{c.status}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

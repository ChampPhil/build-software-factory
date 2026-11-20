"use client";

import { useMemo } from "react";
import { readSession } from "@/lib/session";
import { useClient, useIndex } from "@/lib/data";
import { PageHead, Empty, Note } from "@/components/primitives";

/**
 * What the scheduled review found, and which configuration works best.
 *
 * The thing this page exists to prevent: adopting a change because its
 * benchmark number went up, when the difference is inside the noise of the
 * runs. So every comparison shows the spread, and says plainly when there is
 * no clear winner.
 */
export default function Improvement() {
  const session = useMemo(() => readSession(), []);
  const auth = session === null ? null : { token: session.token, repo: session.repo };
  const client = useClient(auth);
  const index = useIndex(client);

  const data = index.state === "ready" ? index.data : null;
  const lastReview = data?.health?.last_review;
  const repo = session?.repo;

  return (
    <>
      <PageHead
        title="Improvement"
        lede="The factory grades its own recent work every few days, and routes what it finds to hardening or to a change in its own definition."
      />

      {lastReview === undefined ? (
        <Empty title="No review yet">
          The first review runs once there are enough finished runs to grade — by default after
          three days, or sooner if fifty runs land first. It scores recent work against the
          rubrics, groups the failures, and opens work items for the ones worth fixing.
        </Empty>
      ) : (
        <>
          <Note tone="quiet">
            Most recent review: <span className="mono">{lastReview}</span>. Review reports are
            written to the factory&rsquo;s data ref;{" "}
            {repo !== undefined && (
              <a href={`https://github.com/${repo}/pulls?q=is%3Apr+label%3Afactory%3Adefinition`}>
                definition pull requests
              </a>
            )}{" "}
            carry the benchmark result that justified them.
          </Note>

          <div className="section">
            <h2>How a change gets adopted</h2>
            <p className="lede">
              A proposed change is run against at least ten frozen tasks, three times each side.
              It is adopted only if it beats the current configuration on the tasks that were
              failing, costs no more than a little extra, and regresses nothing that was passing.
              Where the difference sits inside the spread of the runs, the answer is no clear
              winner, and nothing changes.
            </p>
          </div>
        </>
      )}
    </>
  );
}

"use client";

/**
 * Reviewing and merging a pull request, here, rather than on GitHub.
 *
 * The rule this is built to: if somebody should not have to go to GitHub for
 * something, they should not — and merging what the factory built is the
 * thing they opened the dashboard to do. Every trip to GitHub to press a
 * button is the factory admitting it is a wrapper around someone else's
 * product.
 *
 * There is deliberately no separate approve step. Approve *is* merge: if they
 * want to merge from the factory they merge from the factory, and if they
 * want a line-by-line read there is a link to GitHub next to the diff.
 *
 * What is not rebuilt here: a diff viewer. A small diff renders inline,
 * because most of what the factory opens is small and flipping to another
 * site to read nine changed lines is absurd. A large one keeps its link.
 * Nobody needs a worse copy of a tool that already exists.
 */

import { useCallback, useEffect, useState } from "react";
import type { GitHubClient, PullFile, PullSummary } from "@/lib/github";

/** Past this, a diff is something to read on GitHub, not in a side panel. */
const INLINE_LIMIT = 400;

export function Review({
  client, pr, onDone,
}: {
  client: GitHubClient;
  pr: PullSummary;
  onDone: () => void;
}) {
  const [files, setFiles] = useState<readonly PullFile[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "merge" | "comment">(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    let live = true;
    client
      .pullFiles(pr.number)
      .then((f) => { if (live) setFiles(f); })
      .catch(() => { if (live) setFiles([]); });
    return () => { live = false; };
  }, [client, pr.number]);

  const merge = useCallback(async () => {
    setBusy("merge");
    setFailed(null);
    try {
      if (note.trim() !== "") await client.comment(pr.number, note.trim());
      await client.mergePull(pr.number);
      onDone();
    } catch (e) {
      // An error says what happened and what to do, in the interface's voice.
      setFailed(
        e instanceof Error && /405|not mergeable|blocked/i.test(e.message)
          ? "GitHub would not merge this: a required check has not passed, or the branch is behind. Open it on GitHub to see which."
          : `The merge did not go through: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(null);
    }
  }, [client, pr.number, note, onDone]);

  const say = useCallback(async () => {
    if (note.trim() === "") return;
    setBusy("comment");
    setFailed(null);
    try {
      await client.comment(pr.number, note.trim());
      setNote("");
      onDone();
    } catch (e) {
      setFailed(`The comment did not post: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [client, pr.number, note, onDone]);

  const changed = files === null ? null : files.reduce((n, f) => n + f.changes, 0);
  const big = changed !== null && changed > INLINE_LIMIT;

  return (
    <div className="review">
      <div className="review-head">
        <h3>{pr.title}</h3>
        <a className="row-meta" href={pr.html_url}>
          Open on GitHub
        </a>
      </div>

      {files === null && <p className="row-meta">Reading the diff…</p>}

      {files !== null && files.length === 0 && (
        <p className="row-meta">No files changed, which usually means the branch is already merged.</p>
      )}

      {files !== null && files.length > 0 && (
        <>
          <p className="row-meta">
            <span>
              {files.length} file{files.length === 1 ? "" : "s"}
            </span>
            <span className="mono">+{files.reduce((n, f) => n + f.additions, 0)}</span>
            <span className="mono">−{files.reduce((n, f) => n + f.deletions, 0)}</span>
          </p>

          {big ? (
            <p className="note quiet">
              {changed} changed lines is more than reads well in a panel. The diff is better on GitHub, and
              merging from here still works once you have read it.
            </p>
          ) : (
            <div className="diff">
              {files.map((f) => (
                <div className="diff-file" key={f.filename}>
                  <div className="diff-name mono">{f.filename}</div>
                  {f.patch === undefined ? (
                    <div className="diff-none">No text diff — a binary file, or one GitHub did not return.</div>
                  ) : (
                    <pre>
                      {f.patch.split("\n").map((line, i) => (
                        <div
                          key={i}
                          className={
                            line.startsWith("+") && !line.startsWith("+++")
                              ? "add"
                              : line.startsWith("-") && !line.startsWith("---")
                                ? "del"
                                : line.startsWith("@@")
                                  ? "hunk"
                                  : undefined
                          }
                        >
                          {line === "" ? " " : line}
                        </div>
                      ))}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {failed !== null && <p className="note bad">{failed}</p>}

      <label className="field review-say">
        Say something before merging, or on its own
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional. Posted on the pull request."
        />
      </label>

      <div className="review-actions">
        <button className="btn filled" onClick={() => void merge()} disabled={busy !== null}>
          {busy === "merge" ? "Merging…" : "Merge"}
        </button>
        <button className="btn" onClick={() => void say()} disabled={busy !== null || note.trim() === ""}>
          {busy === "comment" ? "Posting…" : "Comment only"}
        </button>
      </div>
    </div>
  );
}

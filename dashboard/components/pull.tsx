"use client";

import { useState } from "react";
import { useCheckRuns, useIssueComments, usePull, usePullFiles, useVerifierReport } from "@/lib/data";
import type { CheckRunSummary, PullFile } from "@/lib/github";
import { clock, summaryOf, ago } from "@/lib/view";
import { parsePatch } from "@/lib/diff";
import { useApp } from "@/components/app";
import { Evidence } from "@/components/evidence";
import { Check, Cross, Loading, Out, Pending, Problem, Spin, autoGrow } from "@/components/ui";

type Method = "squash" | "merge" | "rebase";
const METHOD_WORDS: Record<Method, string> = { squash: "Squash and merge", merge: "Merge", rebase: "Rebase and merge" };

/**
 * A pull request, read and merged here rather than on GitHub.
 *
 * The order is the order a reviewer wants: what it does in a few sentences,
 * the recording of it working, whether the checks passed, then the diff for
 * anyone who wants to read it line by line, with comments on any line. The
 * merge bar stays at the bottom of the screen the whole way down.
 */
export function PullPane({ number, workItem }: { number: number; workItem: string | null }) {
  const { client, repo, act, ask, version } = useApp();
  const pr = usePull(client, number, version);
  const files = usePullFiles(client, number, version);
  const sha = pr.state === "ready" && pr.data !== null ? pr.data.head.sha : null;
  const checks = useCheckRuns(client, sha);
  const report = useVerifierReport(client, workItem);
  const comments = useIssueComments(client, number, version);
  const [method, setMethod] = useState<Method>("squash");
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState("");

  if (pr.state === "loading") return <Loading what={`pull request #${number}`} />;
  if (pr.state === "error") return <Problem error={pr.error} retry={pr.retry} />;
  const p = pr.data;
  if (p === null) return <p className="muted">Pull request #{number} isn&rsquo;t on GitHub any more. It may have been deleted with its branch.</p>;

  const summary = summaryOf(p.body);
  const open = p.state === "open";
  const failing = checks.state === "ready" ? checks.data.filter((c) => c.conclusion === "failure" || c.conclusion === "timed_out") : [];
  const running = checks.state === "ready" ? checks.data.filter((c) => c.status !== "completed") : [];

  const merge = async (): Promise<void> => {
    await act(() => client.mergePull(number, method), `Merged #${number}. The request closes and its branch goes.`);
  };
  const requestChanges = async (): Promise<void> => {
    const words = await ask({ title: `Request changes on #${number}`, body: "Say what's wrong. The factory reads this as a correction and tries again; it also holds the pull request from merging itself.", placeholder: "What should change", confirm: "Request changes" });
    if (words !== null) await act(() => client.requestChanges(number, words), "Changes requested. The factory picks it up within a few minutes.");
  };
  const close = async (): Promise<void> => {
    const ok = await ask({ title: `Close #${number} without merging?`, body: "The branch stays, and you can reopen it on GitHub. The request goes back to the factory, which won't try this attempt again.", confirm: "Close it", noText: true, danger: true });
    if (ok !== null) await act(() => client.closePull(number), `Closed #${number} without merging.`);
  };
  const approve = async (): Promise<void> => {
    await act(() => client.approvePull(number), `Approved #${number}.`);
  };
  const commentOnLine = async (f: PullFile, line: number, side: "LEFT" | "RIGHT"): Promise<void> => {
    const words = await ask({ title: `Comment on ${f.filename}, line ${line}`, placeholder: "What's wrong with this line", confirm: "Comment" });
    if (words !== null) await act(() => client.createReviewComment(number, { body: words, commit: p.head.sha, path: f.filename, line, side }), "Commented on the line. The factory reads it as a correction.");
  };

  return (
    <div className="pr">
      {summary.length > 0 && (
        <ul className="pr-summary">
          {summary.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
      {p.merged && (
        <div className="merged-note">
          <Check /> Merged {clock(p.merged_at)}. The request is closed.
        </div>
      )}
      {!open && !p.merged && <div className="callout">Closed without merging. <Out href={p.html_url}>Reopen it on GitHub</Out></div>}

      {report.state === "ready" && <Evidence client={client} report={report.data} />}

      <div className="two">
        <section>
          <h2 className="sect">Checks</h2>
          {checks.state === "loading" && <Loading what="the checks" />}
          {checks.state === "ready" && <ChecksList checks={checks.data} />}
          {open && (
            <div className="check">
              {p.mergeable_state === "dirty" ? <Cross /> : p.mergeable_state === "behind" ? <Pending /> : <Check />}
              <span>
                {p.mergeable_state === "dirty"
                  ? "Conflicts with main. The factory rebuilds it on the current main when it next runs."
                  : p.mergeable_state === "behind"
                    ? "Behind main. Merging updates it first."
                    : p.mergeable_state === "blocked"
                      ? "Blocked by a rule on main, usually a required check or review."
                      : "Up to date with main. No conflicts."}
              </span>
            </div>
          )}
        </section>
        <section>
          <h2 className="sect">At a glance</h2>
          <dl className="kv">
            <dt>Change</dt>
            <dd>
              <span className="add">+{p.additions}</span> <span className="del">−{p.deletions}</span> in {p.changed_files} {p.changed_files === 1 ? "file" : "files"}
            </dd>
            <dt>Branch</dt>
            <dd>
              <code>{p.head.ref}</code> into <code>{p.base.ref}</code>
            </dd>
            <dt>Opened</dt>
            <dd>{ago(p.created_at)} by {p.user?.login ?? "someone"}</dd>
          </dl>
          {p.body !== null && p.body.trim() !== "" && (
            <details className="past">
              <summary>The whole description</summary>
              <pre className="log wrap-text">{p.body}</pre>
            </details>
          )}
          <p className="read-more">
            <Out href={p.html_url}>Open on GitHub</Out>
            <Out href={`https://github.com/${repo}/pull/${number}/files`}>The diff on GitHub</Out>
          </p>
        </section>
      </div>

      <h2 className="sect" id="diff">
        Files changed <span className="muted">{files.state === "ready" ? `${files.data.length} files, ${viewed.size} viewed` : ""}</span>
      </h2>
      {files.state === "loading" && <Loading what="the diff" />}
      {files.state === "error" && <Problem error={files.error} retry={files.retry} />}
      {files.state === "ready" && files.data.length === 0 && <p className="muted">No files changed, which usually means the branch is already merged.</p>}
      {files.state === "ready" && files.data.length > 0 && (
        <>
          {open && <p className="muted small">Select a line number to comment on that line.</p>}
          <div className="files">
            {files.data.map((f, i) => (
              <FileDiff
                key={f.filename}
                file={f}
                open={i === 0 && f.changes <= 400}
                viewed={viewed.has(f.filename)}
                onViewed={(v) => setViewed((s) => { const n = new Set(s); if (v) n.add(f.filename); else n.delete(f.filename); return n; })}
                {...(open ? { onLine: (line: number, side: "LEFT" | "RIGHT") => void commentOnLine(f, line, side) } : {})}
              />
            ))}
          </div>
        </>
      )}

      <h2 className="sect">Conversation on the pull request</h2>
      <div className="thread compact">
        {comments.state === "ready" && comments.data.length === 0 && <p className="muted">No comments yet.</p>}
        {comments.state === "ready" &&
          comments.data.map((c) => {
            const bot = c.user?.type === "Bot" || /\[bot\]$/.test(c.user?.login ?? "");
            return (
              <div className={bot ? "turn f" : "turn p"} key={c.id}>
                <div className="who">
                  <span>{bot ? "The factory" : (c.user?.login ?? "someone")}</span>
                  <span>{clock(c.created_at)}</span>
                </div>
                <div className="text">{c.body}</div>
              </div>
            );
          })}
      </div>
      <form
        className="compose"
        onSubmit={(e) => {
          e.preventDefault();
          const words = note.trim();
          if (words === "") return;
          void act(() => client.comment(number, words), "Commented on the pull request.").then((ok) => ok && setNote(""));
        }}
      >
        <textarea rows={1} value={note} aria-label="Comment on the pull request" placeholder={`Comment on #${number}`} onChange={(e) => { setNote(e.target.value); autoGrow(e.target); }} />
        <button className="btn" type="submit" disabled={note.trim() === ""}>
          Comment
        </button>
      </form>

      {open && (
        <div className="mergebar">
          <div className="in">
            <span className="what">
              {p.draft
                ? "Still a draft: the factory hasn't finished with it."
                : failing.length > 0
                  ? `${failing.length} ${failing.length === 1 ? "check failed" : "checks failed"}. GitHub may refuse the merge.`
                  : running.length > 0
                    ? "Checks are still running."
                    : "Merging closes the request and deletes the branch."}
            </span>
            <button className="btn quiet" type="button" onClick={() => void close()}>
              Close without merging
            </button>
            <button className="btn" type="button" onClick={() => void requestChanges()}>
              Request changes
            </button>
            <button className="btn" type="button" onClick={() => void approve()}>
              Approve
            </button>
            <span className="split">
              <button className="btn go" type="button" disabled={p.draft} onClick={() => void merge()}>
                {METHOD_WORDS[method]}
              </button>
              <select aria-label="How to merge" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                <option value="squash">Squash</option>
                <option value="merge">Merge commit</option>
                <option value="rebase">Rebase</option>
              </select>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function ChecksList({ checks }: { checks: readonly CheckRunSummary[] }) {
  if (checks.length === 0) return <p className="muted">No checks reported on this commit yet.</p>;
  return (
    <div className="checks">
      {checks.map((c) => (
        <div className="check" key={c.id}>
          {c.status !== "completed" ? <Spin /> : c.conclusion === "success" || c.conclusion === "neutral" || c.conclusion === "skipped" ? <Check /> : <Cross />}
          <span>
            <b>{c.name}</b>
            {c.output?.title != null && c.output.title !== "" ? `. ${c.output.title}` : c.status !== "completed" ? ". Running." : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function FileDiff({
  file, open, viewed, onViewed, onLine,
}: {
  file: PullFile;
  open: boolean;
  viewed: boolean;
  onViewed: (v: boolean) => void;
  onLine?: (line: number, side: "LEFT" | "RIGHT") => void;
}) {
  const lines = file.patch === undefined ? null : parsePatch(file.patch);
  return (
    <details className="file" open={open && !viewed}>
      <summary>
        <span className="fname">{file.filename}</span>
        <span className="delta">
          <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
        </span>
        <label className="viewed" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={viewed} onChange={(e) => onViewed(e.target.checked)} /> Viewed
        </label>
      </summary>
      {lines === null ? (
        <p className="muted small pad">No text diff: a binary file, or one too large for GitHub to return.</p>
      ) : (
        <div className="patch" aria-label={`Changes in ${file.filename}`}>
          {lines.map((l, i) =>
            l.kind === "@" ? (
              <div className="h" key={i}>
                <span />
                <span />
                <span>{l.text}</span>
              </div>
            ) : (
              <div className={l.kind === "+" ? "p" : l.kind === "-" ? "m" : ""} key={i}>
                {onLine === undefined ? (
                  <span className="ln">{l.now ?? l.old}</span>
                ) : (
                  <button
                    className="ln"
                    type="button"
                    aria-label={`Comment on line ${l.now ?? l.old}`}
                    onClick={() => onLine(l.now ?? l.old ?? 1, l.kind === "-" ? "LEFT" : "RIGHT")}
                  >
                    {l.now ?? l.old}
                  </button>
                )}
                <span>{l.kind === " " ? "" : l.kind}</span>
                <span>{l.text}</span>
              </div>
            ),
          )}
        </div>
      )}
    </details>
  );
}

/**
 * Purpose
 * -------
 * Pull two correction sources out of GitHub that the git history on disk
 * does not contain: review comments the author then acted on, and bug
 * issues that a commit closed. Phase 1 names both. Until this file existed,
 * the miner only saw reverts, fix subjects, written rules, and agent chats.
 *
 * Key terms
 * ---------
 * Review comment: a line note on a pull request, not the conversation under
 * the pull request. GitHub stores these on the pulls/comments API.
 * Applied: a later commit on that same pull request touches the file the
 * comment was left on. The comment asked for a change and the author changed
 * that file afterwards. The classifier still decides whether the words are
 * a lasting rule. "Looks good" on a file that later changed is noise.
 * Bug issue: a GitHub issue labelled bug. A closing commit is one the issue
 * timeline points at with a commit id. The title plus that link is evidence.
 * It is not a rule until the classifier quotes one.
 * Searched: the API was asked and answered, even when the answer was empty.
 * Not searched: there is no GitHub repo to ask, or `gh` failed. Those counts
 * stay null so setup cannot pretend the search happened.
 *
 * Exports
 * -------
 * repoSlug, findAppliedReviews, findClosedBugs, mineGithub.
 *
 * Non-obvious behavior
 * --------------------
 * A later commit whose file list is not on this machine still counts as
 * applied. Missing history must not hide a comment. A later commit whose
 * file list is known and does not include the comment's file does not count.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** One `gh` invocation. Tests pass a stub. The real one runs the GitHub CLI. */
export type GhRun = (args: readonly string[]) => Promise<string>;

export interface ReviewFinding {
  /** Stable id for the classifier, `review:<github id>`. */
  readonly id: string;
  readonly pr: number;
  readonly path: string;
  /** The comment body, which is what a person wrote. */
  readonly text: string;
  readonly at: string;
}

export interface BugFinding {
  /** Stable id for the classifier, `bug:<issue number>`. */
  readonly id: string;
  readonly issue: number;
  readonly text: string;
  readonly commit: string | null;
}

export interface GithubMining {
  /** Null when review comments were not searched. */
  readonly reviews: readonly ReviewFinding[] | null;
  /** Null when bug issues were not searched. */
  readonly bugs: readonly BugFinding[] | null;
  readonly note: string;
}

interface ReviewComment {
  readonly id?: number;
  readonly body?: string;
  readonly path?: string;
  readonly created_at?: string;
  readonly pull_request_url?: string;
}

interface PrCommit {
  readonly sha?: string;
  readonly commit?: { readonly committer?: { readonly date?: string } };
}

/**
 * `owner/name` from a git remote URL.
 *
 * remoteUrl: the output of `git remote get-url origin`.
 * Returns null when the remote is not a GitHub URL.
 */
export function repoSlug(remoteUrl: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Parse a GitHub JSON payload that may be one array or several concatenated
 * arrays from `gh api --paginate`.
 *
 * raw: the CLI's stdout.
 */
export function parseGhJson<T>(raw: string): readonly T[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const read = (value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  try {
    return read(JSON.parse(trimmed) as unknown);
  } catch {
    const out: T[] = [];
    for (const chunk of trimmed.split(/\n(?=\[)/)) {
      try {
        out.push(...read(JSON.parse(chunk) as unknown));
      } catch {
        // A warning line between pages. The pages that parsed still count.
      }
    }
    return out;
  }
}

/**
 * Review comments whose file changed again after the comment.
 *
 * repo: `owner/name`.
 * gh: runs the GitHub CLI.
 * filesInCommit: the paths a commit touched. Empty means this machine does
 * not have that commit, which still counts as applied when a later commit
 * exists. A non-empty list that omits the comment's path is not applied.
 */
export async function findAppliedReviews(opts: {
  readonly repo: string;
  readonly gh: GhRun;
  readonly filesInCommit?: (sha: string) => readonly string[] | Promise<readonly string[]>;
}): Promise<readonly ReviewFinding[]> {
  const filesInCommit = opts.filesInCommit ?? (() => []);
  const raw = await opts.gh(["api", "--paginate", `repos/${opts.repo}/pulls/comments?per_page=100`]);
  const comments = parseGhJson<ReviewComment>(raw).slice(0, 1000);
  const byPr = new Map<number, ReviewComment[]>();
  for (const c of comments) {
    const pr = /\/pulls\/(\d+)$/.exec(c.pull_request_url ?? "")?.[1];
    if (pr === undefined || c.id === undefined || !c.path || !c.body?.trim() || !c.created_at) continue;
    const n = Number(pr);
    const list = byPr.get(n) ?? [];
    list.push(c);
    byPr.set(n, list);
  }

  const out: ReviewFinding[] = [];
  for (const [pr, notes] of byPr) {
    let commits: readonly PrCommit[] = [];
    try {
      commits = parseGhJson<PrCommit>(await opts.gh(["api", "--paginate", `repos/${opts.repo}/pulls/${pr}/commits?per_page=100`]));
    } catch {
      continue;
    }
    for (const note of notes) {
      const later = commits.filter((commit) => {
        const date = commit.commit?.committer?.date;
        return typeof commit.sha === "string" && typeof date === "string" && date > (note.created_at ?? "");
      });
      if (later.length === 0) continue;
      let sawFiles = false;
      let hit = false;
      for (const commit of later) {
        const files = await Promise.resolve(filesInCommit(commit.sha ?? ""));
        if (files.length > 0) sawFiles = true;
        if (files.includes(note.path ?? "")) hit = true;
      }
      if (sawFiles && !hit) continue;
      out.push({
        id: `review:${note.id}`,
        pr,
        path: note.path ?? "",
        text: (note.body ?? "").trim(),
        at: note.created_at ?? "",
      });
    }
  }
  return out;
}

/**
 * Closed bug issues whose timeline names a commit.
 *
 * repo: `owner/name`.
 * gh: runs the GitHub CLI. A missing `bug` label is an empty search, not a
 * failure to search.
 */
export async function findClosedBugs(opts: { readonly repo: string; readonly gh: GhRun }): Promise<readonly BugFinding[]> {
  let listed = "";
  try {
    listed = await opts.gh([
    "issue", "list", "--repo", opts.repo, "--state", "closed", "--label", "bug",
    "--limit", "300", "--json", "number,title",
    ]);
  } catch {
    // No `bug` label, or issues are disabled. The search ran and found none.
    return [];
  }
  const issues = parseGhJson<{ number?: number; title?: string }>(listed).filter((i) => typeof i.number === "number");
  const out: BugFinding[] = [];
  for (const issue of issues.slice(0, 300)) {
    let timeline = "";
    try {
      timeline = await opts.gh(["api", "--paginate", `repos/${opts.repo}/issues/${issue.number}/timeline?per_page=100`]);
    } catch {
      continue;
    }
    const commit = parseGhJson<{ commit_id?: string | null }>(timeline)
      .map((e) => e.commit_id)
      .find((id) => typeof id === "string" && /^[0-9a-f]{7,40}$/i.test(id)) ?? null;
    if (commit === null) continue;
    const title = (issue.title ?? "").trim();
    out.push({
      id: `bug:${issue.number}`,
      issue: issue.number ?? 0,
      commit,
      text: title === "" ? `bug #${issue.number} closed by ${commit.slice(0, 8)}` : title,
    });
  }
  return out;
}

/**
 * Both GitHub sources, with nulls when the search did not run.
 *
 * repo: `owner/name`, or null when this checkout has no GitHub remote.
 * gh: runs the GitHub CLI.
 * filesInCommit: see findAppliedReviews.
 */
export async function mineGithub(opts: {
  readonly repo: string | null;
  readonly gh: GhRun;
  readonly filesInCommit?: (sha: string) => readonly string[] | Promise<readonly string[]>;
}): Promise<GithubMining> {
  if (opts.repo === null) {
    return { reviews: null, bugs: null, note: "GitHub history was not read: this checkout has no GitHub remote." };
  }
  let reviews: readonly ReviewFinding[] | null = null;
  let bugs: readonly BugFinding[] | null = null;
  const notes: string[] = [];
  try {
    reviews = await findAppliedReviews({
      repo: opts.repo,
      gh: opts.gh,
      ...(opts.filesInCommit === undefined ? {} : { filesInCommit: opts.filesInCommit }),
    });
  } catch (err) {
    notes.push(`review comments were not read: ${(err instanceof Error ? err.message : "gh failed").slice(0, 160)}`);
  }
  try {
    bugs = await findClosedBugs({ repo: opts.repo, gh: opts.gh });
  } catch (err) {
    notes.push(`bug issues were not read: ${(err instanceof Error ? err.message : "gh failed").slice(0, 160)}`);
  }
  if (reviews !== null && bugs !== null) {
    notes.push(`${reviews.length} applied review comment(s), ${bugs.length} bug issue(s) closed by a commit.`);
  }
  return { reviews, bugs, note: notes.join(" ") };
}

/** The GitHub CLI, from the checkout so `gh` sees that repo's auth. */
export function ghAt(root: string): GhRun {
  return async (args) => {
    const { stdout } = await exec("gh", [...args], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    return String(stdout);
  };
}

/**
 * Paths a commit touched, from the local git object. Empty when the commit
 * is not in this clone.
 *
 * root: the checkout.
 * sha: the commit.
 */
export async function filesInCommit(root: string, sha: string): Promise<readonly string[]> {
  try {
    const { stdout } = await exec("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sha], { cwd: root });
    return String(stdout).split("\n").map((l) => l.trim()).filter((l) => l !== "");
  } catch {
    return [];
  }
}

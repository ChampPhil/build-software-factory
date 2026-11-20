import type { GitHub } from "../lib/github.js";

/**
 * Human interactions per PR — how much steering the agents needed.
 *
 * Warp's team tracks this as the number that matters once automation rate
 * stops moving: a factory can merge most of its PRs without a human code push
 * and still cost a person an hour of back-and-forth on each one.
 *
 * What counts is steering, not approval. An approving review is the gate
 * working as designed, so it is not an interaction; a comment, a change
 * request, or a human pushing a commit to the branch all are.
 */

export interface Interactions {
  readonly comments: number;
  readonly change_requests: number;
  readonly human_commits: number;
  readonly total: number;
}

export interface InteractionInput {
  readonly issueComments: readonly { readonly user: { readonly login: string } | null }[];
  readonly reviewComments: readonly { readonly user: { readonly login: string } | null }[];
  readonly reviews: readonly {
    readonly user: { readonly login: string } | null;
    readonly state: string;
  }[];
  readonly commits: readonly {
    readonly author: { readonly login: string } | null;
    readonly committer: { readonly login: string } | null;
  }[];
  /** The PR's author, so an agent's own PR body and commits are not steering. */
  readonly prAuthor: string;
  /** App logins — `<slug>[bot]` — whose activity is the factory's own. */
  readonly appLogins: readonly string[];
}

export function countInteractions(input: InteractionInput): Interactions {
  const machine = new Set([
    ...input.appLogins.map((l) => l.toLowerCase()),
    input.prAuthor.toLowerCase(),
  ]);
  const isHuman = (login: string | null | undefined): boolean => {
    if (login === null || login === undefined) return false;
    const l = login.toLowerCase();
    // A `[bot]` suffix catches Dependabot and every other integration, which
    // are not people steering the agent either.
    return !machine.has(l) && !l.endsWith("[bot]");
  };

  const comments =
    input.issueComments.filter((c) => isHuman(c.user?.login)).length +
    input.reviewComments.filter((c) => isHuman(c.user?.login)).length +
    // A review left as a plain comment is a comment; an approval is the gate
    // working, not steering.
    input.reviews.filter((r) => isHuman(r.user?.login) && r.state === "COMMENTED").length;

  const change_requests = input.reviews.filter(
    (r) => isHuman(r.user?.login) && r.state === "CHANGES_REQUESTED",
  ).length;

  const human_commits = input.commits.filter(
    (c) => isHuman(c.author?.login) || isHuman(c.committer?.login),
  ).length;

  return { comments, change_requests, human_commits, total: comments + change_requests + human_commits };
}

export async function fetchInteractions(opts: {
  readonly gh: GitHub;
  readonly pr: number;
  readonly prAuthor: string;
  readonly appLogins: readonly string[];
}): Promise<Interactions | null> {
  const base = `repos/${opts.gh.repo}`;
  try {
    const [issueComments, reviewComments, reviews, commits] = await Promise.all([
      opts.gh.get<InteractionInput["issueComments"]>(`${base}/issues/${opts.pr}/comments?per_page=100`, {
        paginate: true,
      }),
      opts.gh.get<InteractionInput["reviewComments"]>(`${base}/pulls/${opts.pr}/comments?per_page=100`, {
        paginate: true,
      }),
      opts.gh.get<InteractionInput["reviews"]>(`${base}/pulls/${opts.pr}/reviews?per_page=100`, {
        paginate: true,
      }),
      opts.gh.get<InteractionInput["commits"]>(`${base}/pulls/${opts.pr}/commits?per_page=100`, {
        paginate: true,
      }),
    ]);
    return countInteractions({
      issueComments,
      reviewComments,
      reviews,
      commits,
      prAuthor: opts.prAuthor,
      appLogins: opts.appLogins,
    });
  } catch {
    // A metric is never worth failing a merge for. The field stays absent,
    // which the rollup reads as "not measured" rather than as zero.
    return null;
  }
}

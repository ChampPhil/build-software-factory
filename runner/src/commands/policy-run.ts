import { effectiveAssociation } from "../lib/github.js";
import { GitHub, type PullFile, type ReviewResponse } from "../lib/github.js";
import { loadPolicy, type Loader } from "../lib/config.js";
import { FactoryStore } from "../lib/store.js";
import { runPolicy, type PolicyResult } from "./policy.js";
import type { Association, Pipeline, PullRequestFacts } from "../lib/types.js";

/**
 * Wires `bsf policy` to GitHub: gather the PR's facts, run the check, report
 * it as a check run.
 *
 * It reads the changed-file list, the reviews and the labels. It never checks
 * out or runs the PR's code, and `policy.yaml` comes from the default branch,
 * so nothing inside the PR can change the verdict.
 */

export interface PolicyRunOptions {
  readonly gh: GitHub;
  readonly loader: Loader;
  readonly pr: number;
  readonly checkName: string;
  /** App logins whose approvals never count and whose rejections are gate signals. */
  readonly appLogins: readonly string[];
  readonly report: boolean;
}

const PIPELINE_LABELS: Readonly<Record<string, Pipeline>> = {
  "factory:product-work": "product_work",
  "factory:gardening": "gardening",
  "factory:hardening": "hardening",
  "factory:definition": "definition",
  "factory:conflict": "conflict",
};

/** A factory PR says which pipeline it belongs to with a label. */
export function pipelineFromLabels(labels: readonly string[]): Pipeline | undefined {
  for (const l of labels) {
    const p = PIPELINE_LABELS[l];
    if (p !== undefined) return p;
  }
  return undefined;
}

export async function gatherPullFacts(
  gh: GitHub,
  prNumber: number,
  declaredTestEdits: readonly string[] = [],
  trusted: readonly string[] = ["OWNER", "MEMBER", "COLLABORATOR"],
): Promise<PullRequestFacts> {
  const [pr, files, reviews] = await Promise.all([
    gh.pull(prNumber),
    gh.pullFiles(prNumber),
    gh.pullReviews(prNumber),
  ]);

  const labels = pr.labels.map((l) => l.name);
  const headRepo = pr.head.repo?.full_name ?? null;
  const baseRepo = pr.base.repo.full_name;

  // head.repo is null when the head repository has been deleted, which only
  // happens to forks — a same-repo PR's head repo is the repo itself and is
  // never null. So a null head repo is treated as a fork. Reading it as
  // same-repo would be the one direction that matters: it would let a PR that
  // came from outside past the fork check.
  const fromFork = headRepo === null || headRepo !== baseRepo;

  const facts: PullRequestFacts = {
    number: pr.number,
    head_sha: pr.head.sha,
    base_ref: pr.base.ref,
    author: pr.user.login,
    author_association: pr.author_association as Association,
    from_fork: fromFork,
    labels,
    changed_files: changedPaths(files),
    added_files: files.filter((f) => f.status === "added").map((f) => f.filename),
    reviews: await trustedReviews(gh, reviews, trusted),
    draft: pr.draft,
    declared_test_edits: declaredTestEdits,
  };

  const pipeline = (await pipelineFromLedger(gh, pr.number)) ?? pipelineFromLabels(labels);
  return pipeline === undefined ? facts : { ...facts, pipeline };
}

/**
 * The pipeline a factory PR belongs to is the pipeline of the work item it was
 * built for, as the data ref records it. That record is the factory's own; a
 * label is not, since anyone who can triage can add one.
 */
export async function pipelineFromLedger(gh: GitHub, pr: number): Promise<Pipeline | undefined> {
  try {
    const ledger = await new FactoryStore(gh).ledger(new Date().toISOString());
    const queued = ledger.merge_queue.find((q) => q.pr === pr);
    const item = ledger.open.find((o) => o.pr === pr);
    return (queued?.pipeline ?? item?.pipeline) as Pipeline | undefined;
  } catch {
    return undefined;
  }
}

/**
 * A rename touches both paths, so both are checked. Otherwise moving a
 * protected file out of the way would pass while moving one in would not.
 */
function changedPaths(files: readonly PullFile[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    out.add(f.filename);
    if (f.previous_filename !== undefined) out.add(f.previous_filename);
  }
  return [...out];
}

/**
 * GitHub's review response, as the policy's `Review` shape.
 *
 * Exported so the merge queue uses this and not its own mapping. It had one,
 * and it set `commit_id` and `author_is_bot` where the type wants `commit_sha`
 * and `is_app` — which silently disabled the "an approval does not carry to a
 * later commit" check in the one place that decides whether to merge.
 */
/** Reviews with each reviewer's association corrected from their real permission (see effectiveAssociation). */
export async function trustedReviews(
  gh: GitHub,
  reviews: readonly ReviewResponse[],
  trusted: readonly string[],
): Promise<PullRequestFacts["reviews"]> {
  return Promise.all(
    reviews.map(async (r) => {
      const base = toReview(r);
      return { ...base, author_association: (await effectiveAssociation(gh, base.author, base.author_association, trusted)) as Association };
    }),
  );
}

export function toReview(r: ReviewResponse): PullRequestFacts["reviews"][number] {
  const isApp = r.user?.type === "Bot" || /\[bot\]$/.test(r.user?.login ?? "");
  const state = r.state as "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  return {
    author: r.user?.login ?? "unknown",
    author_association: r.author_association as Association,
    state,
    submitted_at: r.submitted_at,
    ...(r.commit_id === undefined ? {} : { commit_sha: r.commit_id }),
    is_app: isApp,
  };
}

export async function runPolicyCommand(opts: PolicyRunOptions): Promise<PolicyResult> {
  // policy.yaml comes from the default branch, whatever the PR says.
  const policy = await loadPolicy(opts.loader);
  const pr = await gatherPullFacts(opts.gh, opts.pr, [], policy.trust.associations);

  const result = runPolicy({ policy, pr, appLogins: opts.appLogins });

  if (opts.report) {
    await opts.gh.reportCheck({
      name: opts.checkName,
      headSha: pr.head_sha,
      conclusion: result.conclusion === "success" ? "success" : "failure",
      title: result.conclusion === "success" ? "Policy passed" : "Policy failed",
      summary: summarize(result),
    });
  }
  return result;
}

export function summarize(result: PolicyResult): string {
  const lines: string[] = [];
  if (result.conclusion === "success") {
    lines.push("Every changed path is one this pipeline may change.");
  } else {
    lines.push(`${result.failures.length} problem(s):`, "");
    for (const f of result.failures) {
      lines.push(`**${f.kind}**`, "", f.message, "");
      if (f.files.length > 0) {
        for (const file of f.files.slice(0, 50)) lines.push(`- \`${file}\``);
        if (f.files.length > 50) lines.push(`- …and ${f.files.length - 50} more`);
        lines.push("");
      }
    }
  }
  if (result.notes.length > 0) {
    lines.push("---", "");
    for (const n of result.notes) lines.push(n, "");
  }
  return lines.join("\n");
}

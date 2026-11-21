import type { GitHub, PullResponse } from "../lib/github.js";
import { FactoryStore, LEDGER, runPath, workItemPath, json } from "../lib/store.js";
import { fetchInteractions } from "./interactions.js";
import { isEligible, queueOrder, nextAction, humanPrMayMerge, type QueueCandidate, type QueueAction } from "./merge-queue.js";
import { hasTrustedHumanApproval } from "./policy.js";
import { trustedReviews } from "./policy-run.js";
import type { Policy, Pipeline, Association } from "../lib/types.js";

/**
 * `bsf merge-queue` — one job works the whole queue, then exits (doc 07).
 *
 * Where the repo has GitHub's native merge queue, this only enables auto-merge
 * and lets GitHub sequence and re-test. Elsewhere it is the fallback queue:
 * it updates the head PR from main or merges it, one action per run, so each
 * PR is tested against what it will actually land on.
 *
 * "Gates passed" is read from the commit's check runs rather than from the
 * gate runner's own notes: a check run is durable, visible to the user, and
 * keyed by commit, so a PR that was pushed to after passing cannot merge on
 * the strength of the old result.
 */

export interface MergeOptions {
  readonly gh: GitHub;
  readonly now: string;
  readonly policy: Policy;
  readonly nativeQueue: boolean;
  readonly gatesCheck?: string;
  readonly policyCheck?: string;
  readonly autoMerge: Readonly<Record<string, boolean>>;
  readonly mergeMethod?: "merge" | "squash" | "rebase";
  /** The factory App's and recompiler App's logins; their reviews never approve. */
  readonly appLogins?: readonly string[];
  readonly apply?: boolean;
}

export interface MergeReport {
  readonly considered: number;
  readonly action: QueueAction;
  readonly applied: string | null;
  readonly blocked: readonly { readonly pr: number; readonly reason: string }[];
  readonly humanPrs: readonly { readonly pr: number; readonly reason: string }[];
}

interface CheckRun {
  readonly name: string;
  readonly conclusion: string | null;
}

/** Pipelines whose PRs always need a human, whatever the toggles say (doc 06). */
const ALWAYS_HUMAN: readonly Pipeline[] = ["definition"];

export async function runMergeCommand(opts: MergeOptions): Promise<MergeReport> {
  const store = new FactoryStore(opts.gh);
  const ledger = await store.ledger(opts.now);
  const gatesCheck = opts.gatesCheck ?? "factory/gates";
  const policyCheck = opts.policyCheck ?? "factory/policy";

  const list = await opts.gh.get<readonly PullResponse[]>(
    `repos/${opts.gh.repo}/pulls?state=open&per_page=100`,
    { paginate: true },
  );

  const candidates: QueueCandidate[] = [];
  const humanPrs: { pr: number; reason: string }[] = [];

  for (const brief of list) {
    // mergeable and mergeable_state come only from the single-PR endpoint.
    const pr = await opts.gh.pull(brief.number);
    const queued = ledger.merge_queue.find((q) => q.pr === pr.number);
    const item = ledger.open.find((o) => o.pr === pr.number);
    const pipeline = (queued?.pipeline ?? item?.pipeline) as Pipeline | undefined;

    const checks = await opts.gh.get<{ readonly check_runs: readonly CheckRun[] }>(
      `repos/${opts.gh.repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
    );
    const conclusionOf = (name: string): string | null =>
      checks.check_runs.find((c) => c.name === name)?.conclusion ?? null;

    const gatesPassed = conclusionOf(gatesCheck) === "success";
    const policyPassed = conclusionOf(policyCheck) === "success";
    const reviews = await opts.gh.pullReviews(pr.number);
    const approvedByHuman = hasTrustedHumanApproval({
      policy: opts.policy,
      pr: {
        number: pr.number,
        head_sha: pr.head.sha,
        base_ref: pr.base.ref,
        author: pr.user.login,
        author_association: pr.author_association as Association,
        from_fork: pr.head.repo === null || pr.head.repo.full_name !== pr.base.repo.full_name,
        labels: pr.labels.map((l) => l.name),
        changed_files: [],
        draft: pr.draft,
        reviews: await trustedReviews(opts.gh, reviews, opts.policy.trust.associations),
        ...(pipeline === undefined ? {} : { pipeline }),
      },
      appLogins: opts.appLogins ?? [],
    });

    if (pipeline === undefined) {
      // Human PRs: the factory adds checks, it does not take over merging. The
      // one thing it insists on is that a human PR is up to date with main, so
      // a human PR and a factory PR cannot each pass alone and break main.
      const may = humanPrMayMerge({
        up_to_date: pr.mergeable_state !== "behind",
        deterministic_gates_passed_on: gatesPassed ? pr.head.sha : null,
        head_sha: pr.head.sha,
      });
      humanPrs.push({ pr: pr.number, reason: may.reason });
      continue;
    }

    candidates.push({
      pr: pr.number,
      work_item: queued?.work_item ?? item?.work_item ?? "",
      pipeline,
      eligible_at: queued?.eligible_at ?? pr.updated_at ?? opts.now,
      gates_passed_on: gatesPassed && !pr.draft ? pr.head.sha : null,
      head_sha: pr.head.sha,
      approved_by_human: approvedByHuman,
      auto_merge_on: opts.autoMerge[pipeline] === true,
      up_to_date: pr.mergeable_state !== "behind",
      // A failed policy check is exactly the "needs a human whatever the
      // toggles say" case: it is what fires on a weakening or a protected path.
      needs_human_whatever_the_toggles: !policyPassed || ALWAYS_HUMAN.includes(pipeline),
      ...(pr.mergeable_state === "dirty" ? { conflicting: true } : {}),
    });
  }

  const action = nextAction(candidates);
  const eligible = queueOrder(candidates);
  const blocked = candidates
    .filter((c) => !eligible.some((e) => e.pr === c.pr))
    .map((c) => ({ pr: c.pr, reason: isEligible(c).reason }));

  let applied: string | null = null;
  if (opts.apply === true) {
    applied = await apply(opts, action, candidates);
    if (action.kind === "merge" && applied !== null) {
      const changes = [
        {
          path: LEDGER,
          content: json({
            ...ledger,
            updated_at: opts.now,
            merge_queue: ledger.merge_queue.filter((q) => q.pr !== action.pr),
          }),
        },
        // Counted here because this is the moment the PR is finished: a count
        // taken earlier would miss the last round of review, and one taken
        // later costs API calls on every rollup forever.
        ...(await interactionChanges(store, opts, action.pr, candidates)),
      ];
      await store.put(changes, `merge-queue: #${action.pr} merged`);
    }
  }

  return { considered: candidates.length, action, applied, blocked, humanPrs };
}

/**
 * Write the human-interaction count onto the run that produced this PR.
 *
 * The rollup then averages it with no further API calls. If anything here
 * fails the field simply stays absent, which the rollup reads as "not
 * measured" rather than as zero — a merge is never worth failing for a metric.
 */
async function interactionChanges(
  store: FactoryStore,
  opts: MergeOptions,
  pr: number,
  candidates: readonly QueueCandidate[],
): Promise<readonly { readonly path: string; readonly content: string }[]> {
  const head = candidates.find((c) => c.pr === pr);
  if (head === undefined || head.work_item === "") return [];

  const item = await store.get<{ readonly runs?: readonly string[] }>(
    workItemPath(head.work_item),
    "work-item",
  ).catch(() => null);
  const runId = item?.runs?.[item.runs.length - 1];
  if (runId === undefined) return [];

  // Typed rather than cast: `actor` is a string in the run schema, and
  // String() on an unknown would quietly write "[object Object]" as the PR
  // author, which would then count the agent's own comments as steering.
  const run = await store
    .get<Record<string, unknown> & { readonly actor?: string }>(runPath(runId), "run")
    .catch(() => null);
  if (run === null) return [];

  const interactions = await fetchInteractions({
    gh: opts.gh,
    pr,
    prAuthor: run.actor ?? "",
    appLogins: opts.appLogins ?? [],
  });
  if (interactions === null) return [];

  return [{ path: runPath(runId), content: json({ ...run, human_interactions: interactions }) }];
}

async function apply(
  opts: MergeOptions,
  action: QueueAction,
  candidates: readonly QueueCandidate[],
): Promise<string | null> {
  const head = candidates.find((c) => c.pr === action.pr);
  if (head === undefined) return null;
  const repo = opts.gh.repo;

  switch (action.kind) {
    case "not_eligible":
      return null;

    case "resolve_conflict":
      // The conflict pipeline rebases and re-clears; dispatching it here is
      // what makes a conflicting PR recover without anyone watching.
      await opts.gh.dispatchWorkflow("factory-run.yml", undefined, {
        work_item: head.work_item,
        reason: "conflict",
      });
      return `dispatched a resolution run for #${action.pr}`;

    case "update_from_main":
      await opts.gh.send("PUT", `repos/${repo}/pulls/${action.pr}/update-branch`, {
        expected_head_sha: head.head_sha,
      });
      return `updated #${action.pr} from main`;

    case "recheck":
      await opts.gh.dispatchWorkflow("factory-gates.yml", undefined, { pr: String(action.pr) });
      return `re-ran the gates on #${action.pr}`;

    case "merge": {
      if (opts.nativeQueue) {
        // With the native queue on, this hands the PR to GitHub, which builds
        // its own merge group and runs factory-gates on it.
        await opts.gh.send("PUT", `repos/${repo}/pulls/${action.pr}/merge`, {
          merge_method: opts.mergeMethod ?? "squash",
          sha: head.head_sha,
        });
        return `queued #${action.pr}`;
      }
      await opts.gh.send("PUT", `repos/${repo}/pulls/${action.pr}/merge`, {
        merge_method: opts.mergeMethod ?? "squash",
        sha: head.head_sha,
      });
      return `merged #${action.pr}`;
    }
  }
}

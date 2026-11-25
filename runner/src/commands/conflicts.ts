import type { GitHub, PullResponse } from "../lib/github.js";
import { FactoryStore } from "../lib/store.js";

/**
 * `bsf conflicts scan` — runs on every push to main (doc 07).
 *
 * GitHub computes mergeability asynchronously, so right after a push to main
 * an open PR's `mergeable` reads null for a short while. A null is "not known
 * yet", never "fine": treating it as fine would let a conflicting PR sit
 * unnoticed until someone looked. So this command retries the unknowns, and
 * says which ones it still could not determine rather than reporting them
 * clean.
 *
 * One rebuild goes out per scan, not one per conflicting PR. When main moves
 * under several PRs that touch the same file, rebuilding them all at once
 * rebuilds them all against the same main: each new PR is clean against main
 * and conflicts with its siblings, so the first to merge sends the rest back
 * for another rebuild. Five PRs on one file can cost twenty rebuilds that way,
 * each one a full builder run.
 *
 * Serialising costs nothing because the queue drains itself: a rebuild that
 * lands is a push to main, which is this scan's trigger. A rebuild that fails
 * or escalates makes no push, so factory-conflicts also runs when factory-run
 * completes — a run finishing is when the queue can move, and an idle factory
 * then runs nothing at all, where a timer would spend a fifth of a month's
 * free Actions minutes finding nothing. Re-dispatching the head while its
 * rebuild is still running is harmless: factory-run keeps one concurrency
 * group per work item, so the second dispatch waits and then finds the PR
 * already replaced and stands down.
 */

export interface ConflictsOptions {
  readonly gh: GitHub;
  readonly now: string;
  readonly retries?: number;
  readonly waitMs?: number;
  readonly ref?: string;
  readonly dispatch?: boolean;
  /**
   * A client on the workflow's own GITHUB_TOKEN, for the factory/conflicts
   * check. Its "Rebuild on main" button reaches a workflow only when the check
   * was created by GitHub Actions itself; one the App creates sends the click
   * to the App's webhook, which nothing listens on.
   */
  readonly checks?: GitHub;
}

export interface ConflictsReport {
  readonly conflicting: readonly { readonly pr: number; readonly work_item: string }[];
  readonly clean: readonly number[];
  readonly unknown: readonly number[];
  readonly dispatched: readonly string[];
  /** Conflicting, and waiting for the one ahead of it: one rebuild at a time. */
  readonly queued: readonly string[];
}

export async function runConflictsCommand(opts: ConflictsOptions): Promise<ConflictsReport> {
  const store = new FactoryStore(opts.gh);
  const ledger = await store.ledger(opts.now);
  const factoryPrs = new Map<number, string>();
  for (const o of ledger.open) if (o.pr != null) factoryPrs.set(o.pr, o.work_item);

  const conflicting: { pr: number; work_item: string }[] = [];
  const clean: number[] = [];
  const unknown: number[] = [];

  for (const [pr, workItem] of factoryPrs) {
    const state = await mergeability(opts, pr);
    if (state === "conflicting") conflicting.push({ pr, work_item: workItem });
    else if (state === "clean") clean.push(pr);
    else unknown.push(pr);
  }

  const ordered = rebuildOrder(conflicting, new Map(ledger.open.map((o) => [o.work_item, o.created_at ?? null])));

  const dispatched: string[] = [];
  const queued: string[] = [];
  if (opts.dispatch !== false) {
    const [head, ...waiting] = ordered;
    if (head !== undefined) {
      await requestRebuild(opts.gh, head.work_item, head.pr, opts.ref);
      dispatched.push(head.work_item);
    }
    for (const w of waiting) queued.push(w.work_item);

    // Every conflicting PR gets the check, so each one says what is happening
    // to it. A queued PR that said nothing would read as forgotten.
    if (opts.checks !== undefined) {
      for (let i = 0; i < ordered.length; i++) {
        const c = ordered[i]!;
        await conflictCheck(opts.checks, c.pr, i === 0 ? undefined : i).catch((e: Error) => {
          process.stderr.write(`could not put the factory/conflicts check on #${c.pr}: ${e.message}\n`);
        });
      }
    }
  } else {
    for (const c of ordered) queued.push(c.work_item);
  }

  return { conflicting, clean, unknown, dispatched, queued };
}

export interface Conflicting {
  readonly pr: number;
  readonly work_item: string;
}

/**
 * The order rebuilds go out in: oldest first.
 *
 * One at a time means something has to be passed over, so the order has to be
 * one a person can predict and one that cannot starve an item. Oldest first
 * does both: the thing that has waited longest is never the thing passed over
 * again. `created_at` where the ledger has it, then the PR number, which rises
 * with time, then the id — so two items with neither are still ordered the
 * same way on every scan rather than by whatever order the ledger happened to
 * list them in.
 */
export function rebuildOrder(
  conflicting: readonly Conflicting[],
  createdAt: ReadonlyMap<string, string | null>,
): readonly Conflicting[] {
  return [...conflicting].sort((a, b) => {
    const at = createdAt.get(a.work_item) ?? null;
    const bt = createdAt.get(b.work_item) ?? null;
    if (at !== null && bt !== null && at !== bt) return at < bt ? -1 : 1;
    if (at !== null && bt === null) return -1;
    if (at === null && bt !== null) return 1;
    return a.pr - b.pr || a.work_item.localeCompare(b.work_item);
  });
}

async function mergeability(
  opts: ConflictsOptions,
  pr: number,
): Promise<"conflicting" | "clean" | "unknown"> {
  const retries = opts.retries ?? 3;
  const waitMs = opts.waitMs ?? 2000;
  for (let i = 0; i <= retries; i++) {
    let doc: PullResponse;
    try {
      doc = await opts.gh.pull(pr);
    } catch {
      return "unknown";
    }
    if (doc.mergeable === true) return "clean";
    if (doc.mergeable === false) return "conflicting";
    // null: GitHub is still computing it. Asking again is the only way to
    // learn the answer; the request itself is what makes GitHub compute it.
    if (i < retries) await new Promise((r) => setTimeout(r, waitMs));
  }
  return "unknown";
}

/**
 * Start a rebuild: the builder makes the same change again on the current
 * main, as a new PR that replaces this one. Rebuilding rather than merging
 * main into the branch is what lets it work without the App ever holding the
 * `workflows` permission: a merge would carry main's workflow changes into a
 * push the App makes.
 */
export async function requestRebuild(gh: GitHub, workItem: string, pr: number, ref?: string): Promise<void> {
  // The PR travels with the request: a rebuild that waits in the queue while
  // an earlier one replaces that PR must find it gone and stand down, not
  // rebuild the replacement too.
  await gh.dispatchWorkflow("factory-run.yml", ref, { work_item: workItem, reason: "conflict", pr_number: String(pr) });
}

const CONFLICT_CHECK = "factory/conflicts";

/**
 * A grey check on the PR with a button that starts the rebuild again.
 *
 * `ahead` is how many rebuilds are in front of this one; leave it out for the
 * one being rebuilt now. A queued PR says so, because a PR that conflicts and
 * says nothing reads as forgotten, and the button is still there for someone
 * who does not want to wait their turn.
 */
export async function conflictCheck(checks: GitHub, pr: number, ahead?: number): Promise<void> {
  const p = await checks.pull(pr);
  const waiting = ahead !== undefined && ahead > 0;
  await checks.send("POST", `repos/${checks.repo}/check-runs`, {
    name: CONFLICT_CHECK,
    head_sha: p.head.sha,
    status: "completed",
    conclusion: "neutral",
    output: {
      title: waiting
        ? `Conflicts with main: queued behind ${ahead} other rebuild${ahead === 1 ? "" : "s"}`
        : "Conflicts with main: rebuilding on main",
      summary:
        (waiting
          ? "This branch conflicts with main. The factory rebuilds one change at a time, because rebuilding " +
            "several at once rebuilds them all against the same main and the first to merge sends the rest " +
            "back again. This one starts when the rebuild ahead of it lands. "
          : "This branch conflicts with main, so the factory is making the same change again on the current main, " +
            "as a new PR that replaces this one. ") +
        "An approval given here carries over when the rebuilt change adds the same lines and removes nothing new. " +
        "To start this one now instead of waiting, press **Rebuild on main** above.",
    },
    actions: [{ label: "Rebuild on main", description: "Remake this change on the current main", identifier: "rebuild" }],
  });
}

/** The "Rebuild on main" button was pressed on a PR's factory/conflicts check. */
export async function rebuildFromButton(gh: GitHub, pr: number, now: string): Promise<string> {
  const ledger = await new FactoryStore(gh).ledger(now);
  const item = ledger.open.find((o) => o.pr === pr);
  if (item === undefined) return `#${pr} is not an open factory work item's PR; nothing to rebuild`;
  await requestRebuild(gh, item.work_item, pr);
  return `started a rebuild of ${item.work_item} (#${pr}) on main`;
}

interface CompareResponse {
  readonly merge_base_commit?: { readonly sha: string };
  readonly files?: readonly { readonly filename: string; readonly status: string; readonly patch?: string; readonly previous_filename?: string }[];
}

function asDiff(files: CompareResponse["files"]): string {
  return (files ?? [])
    .map((f) =>
      `diff --git a/${f.previous_filename ?? f.filename} b/${f.filename}\n--- a/${f.previous_filename ?? f.filename}\n+++ b/${f.filename}\n` +
      (f.patch ?? `(${f.status}; no text diff)`) + "\n",
    )
    .join("");
}

/**
 * What the builder needs to rebuild a conflicting PR on main: the change it
 * made, and what main has since done to the same files.
 */
export async function rebuildContext(gh: GitHub, pr: number): Promise<{ change: string; mainSince: string; files: string[] }> {
  const p = await gh.pull(pr);
  const branch = await gh.get<CompareResponse>(`repos/${gh.repo}/compare/${p.base.ref}...${p.head.sha}`);
  const base = branch.merge_base_commit?.sha;
  const files = (branch.files ?? []).map((f) => f.filename);
  let mainSince = "";
  if (base !== undefined) {
    const main = await gh.get<CompareResponse>(`repos/${gh.repo}/compare/${base}...${p.base.ref}`);
    mainSince = asDiff((main.files ?? []).filter((f) => files.includes(f.filename)));
  }
  return { change: asDiff(branch.files), mainSince, files };
}

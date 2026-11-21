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

  const dispatched: string[] = [];
  if (opts.dispatch !== false) {
    for (const c of conflicting) {
      await requestRebuild(opts.gh, c.work_item, opts.ref);
      dispatched.push(c.work_item);
      if (opts.checks !== undefined) {
        await conflictCheck(opts.checks, c.pr).catch((e: Error) => {
          process.stderr.write(`could not put the factory/conflicts check on #${c.pr}: ${e.message}\n`);
        });
      }
    }
  }

  return { conflicting, clean, unknown, dispatched };
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
export async function requestRebuild(gh: GitHub, workItem: string, ref?: string): Promise<void> {
  await gh.dispatchWorkflow("factory-run.yml", ref, { work_item: workItem, reason: "conflict" });
}

const CONFLICT_CHECK = "factory/conflicts";

/** A grey check on the PR with a button that starts the rebuild again. */
export async function conflictCheck(checks: GitHub, pr: number): Promise<void> {
  const p = await checks.pull(pr);
  await checks.send("POST", `repos/${checks.repo}/check-runs`, {
    name: CONFLICT_CHECK,
    head_sha: p.head.sha,
    status: "completed",
    conclusion: "neutral",
    output: {
      title: "Conflicts with main: rebuilding on main",
      summary:
        "This branch conflicts with main, so the factory is making the same change again on the current main, " +
        "as a new PR that replaces this one. An approval given here carries over when the rebuilt change adds " +
        "the same lines and removes nothing new. If the rebuild does not finish, press **Rebuild on main** above to start it again.",
    },
    actions: [{ label: "Rebuild on main", description: "Remake this change on the current main", identifier: "rebuild" }],
  });
}

/** The "Rebuild on main" button was pressed on a PR's factory/conflicts check. */
export async function rebuildFromButton(gh: GitHub, pr: number, now: string): Promise<string> {
  const ledger = await new FactoryStore(gh).ledger(now);
  const item = ledger.open.find((o) => o.pr === pr);
  if (item === undefined) return `#${pr} is not an open factory work item's PR; nothing to rebuild`;
  await requestRebuild(gh, item.work_item);
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

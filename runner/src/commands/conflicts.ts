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
      await opts.gh.dispatchWorkflow("factory-run.yml", opts.ref, {
        work_item: c.work_item,
        reason: "conflict",
      });
      dispatched.push(c.work_item);
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

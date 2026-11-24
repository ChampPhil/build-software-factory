import type { GitHub } from "../lib/github.js";
import { FactoryStore } from "../lib/store.js";
import { INSTALL_RECORD, type InstallRecord } from "./uninstall.js";

/**
 * `bsf sync-settings` — applies branch protection from `factory.yaml` (doc 07).
 *
 * It adds checks and never removes a rule. That is not a convenience: the
 * user's own protection rules are theirs, and a factory that could drop one
 * would be a way to weaken the repo by editing a config file. So the merge is
 * one-way — the union of what is there and what the factory needs — and
 * anything that would loosen a setting is reported instead of applied.
 */

export interface SyncOptions {
  readonly gh: GitHub;
  readonly branch: string;
  readonly requiredChecks: readonly string[];
  readonly requireReview: boolean;
  readonly apply?: boolean;
}

interface Protection {
  readonly required_status_checks?: {
    readonly strict?: boolean;
    readonly contexts?: readonly string[];
    readonly checks?: readonly { readonly context: string; readonly app_id?: number | null }[];
  } | null;
  readonly required_pull_request_reviews?: {
    readonly required_approving_review_count?: number;
    readonly dismiss_stale_reviews?: boolean;
  } | null;
  readonly enforce_admins?: { readonly enabled?: boolean } | null;
  readonly allow_force_pushes?: { readonly enabled?: boolean } | null;
  readonly restrictions?: unknown;
}

export interface SyncReport {
  readonly existed: boolean;
  readonly added: readonly string[];
  readonly kept: readonly string[];
  readonly declinedToLoosen: readonly string[];
  readonly applied: boolean;
}

/**
 * Note, once, what the factory changed that is not a file.
 *
 * Written only on the first apply: afterwards `branch_protection_existed`
 * would describe the factory's own handiwork rather than what it found.
 */
async function recordInstall(gh: GitHub, what: { existed: boolean; added: readonly string[] }): Promise<void> {
  const store = new FactoryStore(gh);
  if ((await store.get<InstallRecord>(INSTALL_RECORD, "install-record")) !== null) return;
  const record: InstallRecord = {
    schema: "install-record/1",
    branch_protection_existed: what.existed,
    added_checks: [...what.added],
    created_labels: [],
    recorded_at: new Date().toISOString(),
  };
  await store.put(
    [{ path: INSTALL_RECORD, content: `${JSON.stringify(record, null, 2)}\n` }],
    "record what the install changed, so uninstall can undo it",
  );
}

export async function runSyncCommand(opts: SyncOptions): Promise<SyncReport> {
  const path = `repos/${opts.gh.repo}/branches/${opts.branch}/protection`;
  let current: Protection | null = null;
  try {
    current = await opts.gh.get<Protection>(path);
  } catch {
    // No protection yet, which is the common case on a personal repo.
    current = null;
  }

  const existingChecks = [
    ...(current?.required_status_checks?.contexts ?? []),
    ...(current?.required_status_checks?.checks ?? []).map((c) => c.context),
  ];
  const kept = [...new Set(existingChecks)];
  const added = opts.requiredChecks.filter((c) => !kept.includes(c));

  const declinedToLoosen: string[] = [];
  const existingReviews = current?.required_pull_request_reviews?.required_approving_review_count ?? 0;
  // If the repo already asks for more approvals than the factory needs, the
  // repo's number wins. The factory never lowers it.
  const reviewCount = Math.max(existingReviews, opts.requireReview ? 1 : 0);
  if (opts.requireReview === false && existingReviews > 0) {
    declinedToLoosen.push(`required_approving_review_count stays at ${existingReviews}`);
  }
  if (current?.enforce_admins?.enabled === true) {
    // Leaving this on means the factory App is held to the same checks, which
    // is the point; it is never turned off here.
    declinedToLoosen.push("enforce_admins stays on");
  }

  const body = {
    required_status_checks: {
      // "Strict" means a branch must be up to date with the base before it
      // merges. That is the setting behind "two PRs that pass alone cannot
      // break main together", so it is always on — it tightens, never loosens.
      strict: true,
      contexts: [...kept, ...added],
    },
    enforce_admins: current?.enforce_admins?.enabled ?? false,
    required_pull_request_reviews:
      reviewCount === 0
        ? null
        : {
            required_approving_review_count: reviewCount,
            dismiss_stale_reviews: current?.required_pull_request_reviews?.dismiss_stale_reviews ?? true,
          },
    restrictions: current?.restrictions ?? null,
    // Never widened: if force pushes were off, they stay off.
    allow_force_pushes: current?.allow_force_pushes?.enabled ?? false,
  };

  let applied = false;
  if (opts.apply === true && (added.length > 0 || current === null)) {
    await opts.gh.send("PUT", path, body);
    applied = true;
    // Record what this changed, once, so `bsf uninstall` can put it back.
    // Without it an uninstall has to guess whether protection was the
    // factory's doing, and the safe guess — leave everything — means the
    // factory cannot fully take itself out of a repository.
    await recordInstall(opts.gh, { existed: current !== null, added }).catch(() => undefined);
  }

  return { existed: current !== null, added, kept, declinedToLoosen, applied };
}

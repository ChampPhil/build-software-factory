/**
 * `bsf uninstall` — take the factory out of operation.
 *
 * Not "erase what the factory did". Everything it built is the repository's
 * now: the merged pull requests, the commits, the issues, the history. Those
 * stay, and so does `refs/factory/data`, the record of the work — it is only
 * removed if someone explicitly asks for it with `--purge-data`.
 *
 * What this removes is the machinery: the workflows that run agents, the
 * `.factory/` directory, the labels the factory created, and the required
 * checks it added to branch protection. After it, nothing runs on its own.
 *
 * Why this exists at all: nobody installs something into their repository
 * that they cannot get out again. "How do I remove this?" is the first
 * question a careful developer asks, and a project that cannot answer it has
 * not earned the install.
 *
 * Two things it cannot do itself, and says so rather than pretending:
 *   - The GitHub App can only be uninstalled by someone who administers the
 *     repository. This prints the exact page and then checks.
 *   - Branch protection the factory *tightened* is only partly reversible: it
 *     knows which checks it added, because sync-settings only ever adds, and
 *     it records whether protection existed before it arrived. Anything a
 *     person changed afterwards is theirs and is left alone.
 */

import type { GitHub } from "../lib/github.js";
import { FactoryStore } from "../lib/store.js";

/** Where the install's own record of what it changed lives on the data ref. */
export const INSTALL_RECORD = "install-record.json";

export interface InstallRecord {
  readonly schema: "install-record/1";
  /** Whether the default branch already had protection before the factory. */
  readonly branch_protection_existed: boolean;
  /** Checks the factory added, so uninstall removes exactly those. */
  readonly added_checks: readonly string[];
  /** Labels the factory created. */
  readonly created_labels: readonly string[];
  readonly recorded_at: string;
}

export interface UninstallOptions {
  readonly gh: GitHub;
  readonly branch: string;
  /** Paths in the checkout, so the caller can remove them on a branch. */
  readonly root: string;
  readonly purgeData?: boolean;
  readonly apply?: boolean;
}

export interface UninstallPlan {
  /** Files to delete, relative to the repository root. */
  readonly files: readonly string[];
  readonly labels: readonly string[];
  readonly checksToDrop: readonly string[];
  readonly dropProtectionEntirely: boolean;
  readonly dataRef: "kept" | "purged";
  readonly appInstallationId: number | null;
  readonly appSettingsUrl: string | null;
  /** Things a person has to finish, in the order they should do them. */
  readonly leftForYou: readonly string[];
}

/** Everything the factory installs, as path prefixes and globs. */
export function factoryPaths(files: readonly string[]): readonly string[] {
  return files.filter(
    (f) =>
      f.startsWith(".factory/") ||
      /^\.github\/workflows\/factory-[^/]+$/.test(f) ||
      f === ".github/ISSUE_TEMPLATE/factory-request.yml" ||
      f === ".github/ISSUE_TEMPLATE/factory-harden.yml" ||
      f === ".github/ISSUE_TEMPLATE/factory-ask.yml",
  );
}

/**
 * The checks to take out of branch protection.
 *
 * `sync-settings` only ever adds, so whatever the factory put there is still
 * there and is identified by name. A check a person added that happens to
 * share the prefix is not the factory's to remove, which is why this works
 * from the recorded list where one exists and from the known names otherwise.
 */
export function checksToDrop(record: InstallRecord | null, current: readonly string[]): readonly string[] {
  const known = ["factory/gates", "factory/policy"];
  const mine = record?.added_checks ?? known;
  return current.filter((c) => mine.includes(c));
}

export async function planUninstall(opts: UninstallOptions & { readonly files: readonly string[] }): Promise<UninstallPlan> {
  const store = new FactoryStore(opts.gh);
  const record = await store.get<InstallRecord>(INSTALL_RECORD, "install-record").catch(() => null);

  const files = factoryPaths(opts.files);

  const labels = await opts.gh
    .get<readonly { readonly name: string }[]>(`repos/${opts.gh.repo}/labels?per_page=100`)
    .then((ls) => ls.map((l) => l.name).filter((n) => n.startsWith("factory:")))
    .catch(() => []);

  let currentChecks: readonly string[] = [];
  let protectionExists = false;
  try {
    const p = await opts.gh.get<{
      readonly required_status_checks?: {
        readonly contexts?: readonly string[];
        readonly checks?: readonly { readonly context: string }[];
      } | null;
    }>(`repos/${opts.gh.repo}/branches/${opts.branch}/protection`);
    protectionExists = true;
    currentChecks = [
      ...new Set([
        ...(p.required_status_checks?.contexts ?? []),
        ...(p.required_status_checks?.checks ?? []).map((c) => c.context),
      ]),
    ];
  } catch {
    protectionExists = false;
  }

  const drop = checksToDrop(record, currentChecks);
  const remaining = currentChecks.filter((c) => !drop.includes(c));
  // Only take protection away entirely when the factory is what put it there
  // and nothing else is relying on it. A rule somebody else set stays.
  const dropProtectionEntirely =
    protectionExists && remaining.length === 0 && record?.branch_protection_existed === false;

  const installation = await opts.gh
    .get<{ readonly id: number }>(`repos/${opts.gh.repo}/installation`)
    .then((i) => i.id)
    .catch(() => null);

  const leftForYou: string[] = [];
  if (installation !== null) {
    leftForYou.push(
      `Uninstall the GitHub App. Only a repository admin can: ` +
        `https://github.com/settings/installations/${installation} — then run this again to confirm.`,
    );
  }
  if (protectionExists && record === null) {
    leftForYou.push(
      `No install record was found on the data ref, so the factory's own checks were identified by name. ` +
        `Check branch protection on ${opts.branch} yourself to be sure nothing of the factory's is left.`,
    );
  }
  if (opts.purgeData !== true) {
    leftForYou.push(
      `refs/factory/data is kept: it is the record of work the factory did, not part of the machinery. ` +
        `Remove it with \`git push origin :refs/factory/data\`, or re-run with --purge-data.`,
    );
  }

  return {
    files,
    labels,
    checksToDrop: drop,
    dropProtectionEntirely,
    dataRef: opts.purgeData === true ? "purged" : "kept",
    appInstallationId: installation,
    appSettingsUrl: installation === null ? null : `https://github.com/settings/installations/${installation}`,
    leftForYou,
  };
}

/**
 * Carry out the parts that are not file deletions.
 *
 * The files themselves are removed by the caller on a branch, because they sit
 * under protected paths: taking the factory out is a pull request like
 * anything else, and a person merges it. That is deliberate — an uninstall
 * that could rewrite `.github/workflows` without review would be a way to
 * disable a repository's checks from a config file.
 */
export async function applyUninstall(gh: GitHub, branch: string, plan: UninstallPlan): Promise<readonly string[]> {
  const done: string[] = [];

  for (const name of plan.labels) {
    await gh.send("DELETE", `repos/${gh.repo}/labels/${encodeURIComponent(name)}`).catch(() => undefined);
    done.push(`removed label ${name}`);
  }

  if (plan.dropProtectionEntirely) {
    await gh.send("DELETE", `repos/${gh.repo}/branches/${branch}/protection`).catch(() => undefined);
    done.push(`removed branch protection on ${branch}, which the factory had added`);
  } else if (plan.checksToDrop.length > 0) {
    const path = `repos/${gh.repo}/branches/${branch}/protection`;
    const current = await gh.get<Record<string, unknown>>(path).catch(() => null);
    if (current !== null) {
      const checks = current["required_status_checks"] as
        | { readonly contexts?: readonly string[]; readonly checks?: readonly { readonly context: string }[]; readonly strict?: boolean }
        | null
        | undefined;
      const kept = [
        ...new Set([...(checks?.contexts ?? []), ...(checks?.checks ?? []).map((c) => c.context)]),
      ].filter((c) => !plan.checksToDrop.includes(c));
      const reviews = current["required_pull_request_reviews"] as
        | { readonly required_approving_review_count?: number; readonly dismiss_stale_reviews?: boolean }
        | null
        | undefined;
      await gh.send("PUT", path, {
        required_status_checks: kept.length === 0 ? null : { strict: checks?.strict ?? true, contexts: kept },
        enforce_admins: (current["enforce_admins"] as { enabled?: boolean } | undefined)?.enabled ?? false,
        required_pull_request_reviews:
          reviews === null || reviews === undefined
            ? null
            : {
                required_approving_review_count: reviews.required_approving_review_count ?? 1,
                dismiss_stale_reviews: reviews.dismiss_stale_reviews ?? true,
              },
        restrictions: current["restrictions"] ?? null,
        allow_force_pushes:
          (current["allow_force_pushes"] as { enabled?: boolean } | undefined)?.enabled ?? false,
      });
      done.push(`removed ${plan.checksToDrop.join(", ")} from branch protection on ${branch}`);
    }
  }

  if (plan.dataRef === "purged") {
    await gh.send("DELETE", `repos/${gh.repo}/git/refs/factory/data`).catch(() => undefined);
    done.push("deleted refs/factory/data and the record of every run with it");
  }

  return done;
}

/** How the plan reads to a person. */
export function formatPlan(plan: UninstallPlan, applied: boolean): string {
  const lines: string[] = [];
  const verb = applied ? "Removed" : "Would remove";
  lines.push(`${verb} ${plan.files.length} file(s): the workflows, .factory/, and the issue forms.`);
  if (plan.labels.length > 0) lines.push(`${verb} ${plan.labels.length} label(s): ${plan.labels.join(", ")}.`);
  if (plan.dropProtectionEntirely) {
    lines.push(`${verb} branch protection, which the factory added and nothing else is using.`);
  } else if (plan.checksToDrop.length > 0) {
    lines.push(`${verb} these required checks: ${plan.checksToDrop.join(", ")}. Other rules are left alone.`);
  }
  lines.push(
    plan.dataRef === "purged"
      ? "Deleting refs/factory/data, and the record of every run with it."
      : "Keeping refs/factory/data. The work the factory did is yours; this only stops it running.",
  );
  lines.push("");
  lines.push("Your pull requests, commits and issues are untouched.");
  if (plan.leftForYou.length > 0) {
    lines.push("");
    lines.push("Left for you:");
    for (const l of plan.leftForYou) lines.push(`  - ${l}`);
  }
  return lines.join("\n");
}

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
 * `.factory/` is removed on this computer, not only in the pull request that
 * takes it off GitHub. The folder also holds files git never tracked (a
 * sandbox, a setup note). Those stay if only the tracked files are deleted,
 * and the person then has to ask for the folder to be removed. That ask is
 * part of uninstall, so the folder goes with the rest.
 *
 * Local branches named `factory/` go too, and so do the bookmarks git keeps
 * for those branches on GitHub (`origin/factory/...`). Deleting a bookmark
 * does not delete the branch on GitHub and does not close a pull request.
 * The branch you are standing on cannot be deleted until you leave it.
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

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GitHub } from "../lib/github.js";
import { FactoryStore } from "../lib/store.js";
import { parseYaml } from "../lib/yaml.js";

/**
 * The factory's folder in a checkout.
 *
 * The pull request deletes the tracked files under this name from GitHub.
 * The same folder on the person's computer also holds files that were never
 * committed. Uninstall removes the folder itself, so those files go too.
 */
export const LOCAL_FACTORY_DIR = ".factory";

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
  /** The correction hook is present in this checkout. */
  readonly localHook?: boolean;
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
  /** Actions secrets the factory stored. Deleted with the machinery. */
  readonly secrets: readonly string[];
  /** Actions variables the factory stored. Deleted with the machinery. */
  readonly variables: readonly string[];
  /**
   * What to do with `.github/dependabot.yml`. `edit` keeps the file and
   * drops the factory's runner entry. `delete` means that entry was the
   * whole file.
   */
  readonly dependabot: { readonly action: "keep" } | { readonly action: "edit"; readonly text: string } | { readonly action: "delete" };
  /** Remove the correction hook from `.claude/settings.local.json`. */
  readonly localHook: boolean;
  /**
   * A separate repository holding the factory's records, from
   * `data.repo` when `data.location` is `repo`. Null when records live here.
   */
  readonly dataRepo: string | null;
  /** Local branches named factory/..., including the one checked out. */
  readonly localBranches: readonly string[];
  /** Bookmarks such as origin/factory/setup. These live only on this computer. */
  readonly trackingBranches: readonly string[];
  /**
   * The factory branch checked out right now. Git will not delete it until
   * the checkout moves to another branch.
   */
  readonly currentFactoryBranch: string | null;
  /** Things a person has to finish, in the order they should do them. */
  readonly leftForYou: readonly string[];
}

/**
 * Actions secrets setup stores for the factory.
 *
 * The Anthropic key is revoked at Anthropic by the person who created it.
 * The copy in this repository is the factory's, and uninstall deletes it.
 */
export const FACTORY_SECRETS = ["ANTHROPIC_API_KEY", "FACTORY_APP_PRIVATE_KEY", "RECOMPILER_APP_PRIVATE_KEY"] as const;

/** Actions variables setup stores for the factory App and the recompiler App. */
export const FACTORY_VARIABLES = ["FACTORY_APP_CLIENT_ID", "FACTORY_APP_ID", "RECOMPILER_APP_CLIENT_ID"] as const;

/**
 * A label the factory creates that does not use the `factory:` prefix.
 *
 * Dependabot's runner-upgrade pull requests carry this name. The other
 * factory labels use a colon, so a prefix check never sees this one.
 */
export const FACTORY_EXTRA_LABELS = ["factory-runner-upgrade"] as const;

/**
 * Issue forms setup copies in, identified by the name and description it writes.
 *
 * The filenames are the ordinary ones (`bug.yml`, `feature.yml`), so a
 * repository that already had its own form under that name is left alone:
 * install skips an existing file, and uninstall only deletes a file whose
 * name and description are still the factory's sentences.
 */
export const FACTORY_ISSUE_FORMS: readonly { readonly path: string; readonly name: string; readonly description: string }[] = [
  { path: ".github/ISSUE_TEMPLATE/feature.yml", name: "Feature", description: "Ask the factory to add or change something." },
  { path: ".github/ISSUE_TEMPLATE/bug.yml", name: "Bug", description: "Something is broken. The factory will try to reproduce it first." },
  {
    path: ".github/ISSUE_TEMPLATE/harden.yml",
    name: "Harden this",
    description: "A mistake the factory (or anyone) keeps making. The factory changes the codebase so it cannot happen again.",
  },
  { path: ".github/ISSUE_TEMPLATE/tidy.yml", name: "Tidy this", description: "Clean something up without changing what it does." },
];

/** The issue-template config setup writes when the repository has none. */
export const FACTORY_ISSUE_CONFIG = ".github/ISSUE_TEMPLATE/config.yml";

/** The whole of that config file. Anything richer belongs to the repository. */
export const FACTORY_ISSUE_CONFIG_BODY = "blank_issues_enabled: true";

/** Everything the factory installs as its own files, as path prefixes. */
export function factoryPaths(files: readonly string[]): readonly string[] {
  return files.filter((f) => f.startsWith(".factory/") || /^\.github\/workflows\/factory-[^/]+$/.test(f));
}

/**
 * Whether this issue-form file is one setup wrote.
 *
 * Match is on the form's name and description, not on the filename alone.
 * A repository that already had `bug.yml` keeps it, because install does
 * not overwrite that file and the description will not be the factory's.
 *
 * @param path - Path relative to the repository root.
 * @param text - The file's contents.
 * @returns True when the file is still the factory's form or its config.
 */
export function isFactoryIssueForm(path: string, text: string): boolean {
  const norm = text.replace(/\r\n/g, "\n");
  if (path.replace(/\\/g, "/") === FACTORY_ISSUE_CONFIG) return norm.trim() === FACTORY_ISSUE_CONFIG_BODY;
  const form = FACTORY_ISSUE_FORMS.find((f) => f.path === path.replace(/\\/g, "/"));
  if (form === undefined) return false;
  const field = (key: string): string | undefined => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(norm)?.[1]?.trim();
  return field("name") === form.name && field("description") === form.description;
}

/**
 * Issue forms in this checkout that are still the factory's.
 *
 * @param root - The checkout the factory was installed into.
 * @returns Paths relative to `root`, in the order the forms are defined.
 */
export function factoryIssueForms(root: string): readonly string[] {
  const found: string[] = [];
  for (const rel of [...FACTORY_ISSUE_FORMS.map((f) => f.path), FACTORY_ISSUE_CONFIG]) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    if (isFactoryIssueForm(rel, text)) found.push(rel);
  }
  return found;
}

/**
 * Take the factory's runner entry out of a Dependabot config.
 *
 * Setup appends that entry to a file the repository may already use for
 * other dependencies. Those entries stay. When the factory's entry is the
 * whole file, the result is empty and the caller deletes the file.
 *
 * @param text - The current `.github/dependabot.yml` contents.
 * @returns The rewritten text, or an empty string when the file should be deleted. `removed` is false when the factory entry is not there.
 */
export function stripFactoryDependabot(text: string): { readonly text: string; readonly removed: boolean } {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let start = lines.findIndex((l) => l.includes("Added by the factory"));
  let end = -1;
  if (start >= 0) {
    end = lines.findIndex((l, i) => i >= start && l.includes("Upgrade the factory runner"));
    if (end < 0) end = lines.length - 1;
  } else {
    const label = lines.findIndex((l) => l.includes("factory-runner-upgrade"));
    if (label < 0) return { text, removed: false };
    start = label;
    while (start > 0 && !/^ {2}- /.test(lines[start] ?? "")) start -= 1;
    end = label;
    for (let i = label + 1; i < lines.length; i += 1) {
      if (/^ {2}- /.test(lines[i] ?? "") || /^[A-Za-z]/.test(lines[i] ?? "")) break;
      end = i;
    }
  }
  if (lines[end + 1] === "") end += 1;
  const body = [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n").replace(/\n{3,}/g, "\n\n");
  const hasEntry = /^ {2}- /m.test(body);
  if (!hasEntry) {
    const tops = body.split("\n").filter((l) => /^[A-Za-z_][\w-]*:/.test(l));
    if (tops.length > 0 && tops.every((t) => t.startsWith("version:") || t.startsWith("updates:"))) {
      return { text: "", removed: true };
    }
  }
  const normalized = body.endsWith("\n") || body === "" ? body : `${body}\n`;
  return { text: normalized.replace(/\n/g, newline), removed: true };
}

/**
 * The private repository the factory definition names, when records are stored there.
 *
 * @param text - The contents of `.factory/definition/factory.yaml`.
 * @returns `owner/name`, or null when records stay in this repository.
 */
export function dataRepoFromFactoryYaml(text: string): string | null {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return null;
  }
  const data = (doc as { data?: { location?: unknown; repo?: unknown } } | null)?.data;
  if (data?.location !== "repo" || typeof data.repo !== "string" || !/^[^/]+\/[^/]+$/.test(data.repo)) return null;
  return data.repo;
}

/**
 * Delete the factory folder in this checkout, including files git does not track.
 *
 * Tracked files under the folder are also listed in the plan, so the pull
 * request removes them from GitHub. This is the other half: the copy on this
 * computer. A second request to "remove .factory/" is not a separate decision.
 *
 * @param root - The checkout the factory was installed into.
 * @returns The path that was removed, or null when the folder was already absent.
 */
/**
 * A branch the factory opened on this computer.
 *
 * The name is `factory/` plus the rest: `factory/setup`, `factory/fix-login`,
 * `factory/uninstall`. The default branch is never this. A bookmark such as
 * `origin/factory/setup` is not a local branch; see `isFactoryTrackingName`.
 *
 * @param name - A short branch name, the kind `git branch` prints.
 * @returns True when uninstall should delete that local branch.
 */
export function isFactoryBranchName(name: string): boolean {
  return name.startsWith("factory/") && !name.includes("..") && !name.startsWith("-");
}

/**
 * A bookmark on this computer for a factory branch that exists on GitHub.
 *
 * `origin/factory/setup` is the usual shape. The part after the remote's name
 * has to be a factory branch. Deleting the bookmark does not delete the
 * branch on GitHub.
 *
 * @param name - A short remote-tracking name, the kind `git branch -r` prints.
 * @returns True when uninstall should drop that bookmark.
 */
export function isFactoryTrackingName(name: string): boolean {
  const slash = name.indexOf("/");
  if (slash < 0) return false;
  return isFactoryBranchName(name.slice(slash + 1));
}

/**
 * Factory branches and bookmarks in this checkout.
 *
 * @param root - The checkout the factory was installed into.
 * @returns Local `factory/` branches, `origin/factory/` bookmarks, and the
 *   factory branch checked out now, or null when the checkout is elsewhere.
 */
export function listFactoryBranches(root: string): {
  readonly local: readonly string[];
  readonly tracking: readonly string[];
  readonly current: string | null;
} {
  const git = (args: readonly string[]): string => {
    try {
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const lines = (args: readonly string[]): readonly string[] => git(args).split("\n").filter((l) => l !== "");
  const head = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    local: lines(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).filter(isFactoryBranchName),
    tracking: lines(["for-each-ref", "--format=%(refname:short)", "refs/remotes"]).filter(isFactoryTrackingName),
    current: isFactoryBranchName(head) ? head : null,
  };
}

/**
 * Delete factory branches and bookmarks on this computer.
 *
 * The branch that is checked out is left, because git refuses to delete it.
 * The caller switches to the default branch and deletes that one afterwards.
 *
 * @param root - The checkout the factory was installed into.
 * @returns Which names were deleted, and which factory branch is still checked out.
 */
export function removeLocalFactoryBranches(root: string): {
  readonly deletedLocal: readonly string[];
  readonly deletedTracking: readonly string[];
  readonly keptCurrent: string | null;
} {
  const listed = listFactoryBranches(root);
  const deletedLocal: string[] = [];
  const deletedTracking: string[] = [];
  for (const name of listed.local) {
    if (name === listed.current) continue;
    try {
      execFileSync("git", ["-C", root, "branch", "-D", name], { stdio: "ignore" });
      deletedLocal.push(name);
    } catch {
      // A worktree may still have this branch checked out. Leave it; the
      // uninstall notes say to delete it after leaving the branch.
    }
  }
  for (const name of listed.tracking) {
    try {
      execFileSync("git", ["-C", root, "branch", "-dr", name], { stdio: "ignore" });
      deletedTracking.push(name);
    } catch {
      // The bookmark was already gone.
    }
  }
  return { deletedLocal, deletedTracking, keptCurrent: listed.current };
}

export function removeLocalFactory(root: string): string | null {
  const dir = join(root, LOCAL_FACTORY_DIR);
  if (!existsSync(dir)) return null;
  rmSync(dir, { recursive: true, force: true });
  if (existsSync(dir)) {
    throw new Error(`could not remove ${dir}`);
  }
  return dir;
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

  const files = [...new Set([...factoryPaths(opts.files), ...factoryIssueForms(opts.root)])];

  let dependabot: UninstallPlan["dependabot"] = { action: "keep" };
  try {
    const stripped = stripFactoryDependabot(readFileSync(join(opts.root, ".github/dependabot.yml"), "utf8"));
    if (stripped.removed) dependabot = stripped.text === "" ? { action: "delete" } : { action: "edit", text: stripped.text };
  } catch {
    dependabot = { action: "keep" };
  }

  let dataRepo: string | null = null;
  try {
    dataRepo = dataRepoFromFactoryYaml(readFileSync(join(opts.root, ".factory/definition/factory.yaml"), "utf8"));
    if (dataRepo === opts.gh.repo) dataRepo = null;
  } catch {
    dataRepo = null;
  }

  const labels = await opts.gh
    .get<readonly { readonly name: string }[]>(`repos/${opts.gh.repo}/labels?per_page=100`)
    .then((ls) =>
      ls.map((l) => l.name).filter((n) => n.startsWith("factory:") || (FACTORY_EXTRA_LABELS as readonly string[]).includes(n)),
    )
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
    const where = dataRepo === null ? "this repository" : `this repository and ${dataRepo}`;
    leftForYou.push(
      `The run record is kept on ${where}: refs/factory/data, refs/factory/media, and any refs/factory/live run. ` +
        `It is the work the factory did, not the machinery. Re-run with --purge-data to delete those refs.`,
    );
  }
  if (dataRepo !== null) {
    leftForYou.push(
      `The private data repository ${dataRepo} still exists. Delete that repository on GitHub if it was only for the factory.`,
    );
  }
  leftForYou.push(
    "If you created an Anthropic key for this factory and use it nowhere else, revoke it at https://console.anthropic.com/settings/keys. " +
      "The copy stored on the repository is deleted with the other factory secrets.",
  );

  const branches = listFactoryBranches(opts.root);
  if (branches.current !== null) {
    leftForYou.push(
      `You are on ${branches.current}, so that local branch stays until you leave it. ` +
        `Switch to the default branch, then run \`git branch -D ${branches.current}\`.`,
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
    secrets: [...FACTORY_SECRETS],
    variables: [...FACTORY_VARIABLES],
    dependabot,
    localHook: opts.localHook === true,
    dataRepo,
    localBranches: branches.local,
    trackingBranches: branches.tracking,
    currentFactoryBranch: branches.current,
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

  for (const name of plan.secrets) {
    await gh.send("DELETE", `repos/${gh.repo}/actions/secrets/${encodeURIComponent(name)}`).catch(() => undefined);
    done.push(`removed secret ${name}`);
  }
  for (const name of plan.variables) {
    await gh.send("DELETE", `repos/${gh.repo}/actions/variables/${encodeURIComponent(name)}`).catch(() => undefined);
    done.push(`removed variable ${name}`);
  }

  if (plan.dataRef === "purged") {
    const repos = [gh.repo, ...(plan.dataRepo === null ? [] : [plan.dataRepo])];
    for (const repo of repos) {
      await deleteFactoryRefs(gh, repo);
      done.push(`deleted the factory refs on ${repo}`);
    }
  }

  return done;
}

/**
 * Delete the factory's refs on one repository: the record, the media, and
 * any run that was still marked in progress.
 *
 * @param gh - The GitHub client. The path names `repo` itself, so this can
 *   target the private data repository as well as the one being uninstalled.
 * @param repo - `owner/name` whose refs are deleted.
 */
async function deleteFactoryRefs(gh: GitHub, repo: string): Promise<void> {
  const drop = async (ref: string): Promise<void> => {
    await gh.send("DELETE", `repos/${repo}/git/refs/${ref}`).catch(() => undefined);
  };
  await drop("factory/data");
  await drop("factory/media");
  const listed = await gh
    .get<readonly { readonly ref?: string }[]>(`repos/${repo}/git/matching-refs/factory/live`)
    .catch((): readonly { readonly ref?: string }[] => []);
  for (const item of listed) {
    const ref = typeof item.ref === "string" ? item.ref.replace(/^refs\//, "") : "";
    if (ref !== "") await drop(ref);
  }
}

/** How the plan reads to a person. */
export function formatPlan(plan: UninstallPlan, applied: boolean): string {
  const lines: string[] = [];
  const verb = applied ? "Removed" : "Would remove";
  lines.push(`${verb} ${plan.files.length} file(s): the workflows, .factory/, and the issue forms.`);
  lines.push(
    applied
      ? "Removed the .factory/ folder on this computer, including anything that was never committed."
      : "Would remove the .factory/ folder on this computer, including anything that was never committed.",
  );
  if (plan.labels.length > 0) lines.push(`${verb} ${plan.labels.length} label(s): ${plan.labels.join(", ")}.`);
  if (plan.dropProtectionEntirely) {
    lines.push(`${verb} branch protection, which the factory added and nothing else is using.`);
  } else if (plan.checksToDrop.length > 0) {
    lines.push(`${verb} these required checks: ${plan.checksToDrop.join(", ")}. Other rules are left alone.`);
  }
  if (plan.dependabot.action === "delete") lines.push(`${verb} .github/dependabot.yml, which only tracked the factory runner.`);
  else if (plan.dependabot.action === "edit") lines.push(`${verb} the factory's runner entry from .github/dependabot.yml. The other entries stay.`);
  if (plan.secrets.length > 0) {
    lines.push(`${verb} the factory's Actions secrets and variables: ${[...plan.secrets, ...plan.variables].join(", ")}.`);
  }
  if (plan.localHook) lines.push(`${verb} the correction hook from .claude/settings.local.json on this computer.`);
  const localOnly = plan.localBranches.filter((b) => b !== plan.currentFactoryBranch);
  if (localOnly.length > 0) lines.push(`${verb} local branch(es) on this computer: ${localOnly.join(", ")}.`);
  if (plan.trackingBranches.length > 0) {
    lines.push(`${verb} local bookmark(s) ${plan.trackingBranches.join(", ")}. The branches on GitHub stay until you say to delete them.`);
  }
  if (plan.currentFactoryBranch !== null) {
    lines.push(`${plan.currentFactoryBranch} is the branch you are on, so it stays until you leave it.`);
  }
  const where = plan.dataRepo === null ? "this repository" : `this repository and ${plan.dataRepo}`;
  lines.push(
    plan.dataRef === "purged"
      ? `Deleting refs/factory/data, refs/factory/media, and any refs/factory/live run on ${where}.`
      : `Keeping the run record on ${where}. The work the factory did is yours; this only stops it running.`,
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

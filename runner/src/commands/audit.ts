import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { GitHub } from "../lib/github.js";

/**
 * `bsf audit` — runs on every push to main and asks one question: did anything
 * reach main without passing the gates (doc 07)?
 *
 * The gates run on PRs, so they can be skipped three ways: a direct push to
 * main, an admin merge past a failing check, and a compiled role workflow that
 * no longer matches its source. This checks all three against the commit that
 * was actually pushed, after the fact — which is the only place a bypass is
 * visible at all.
 */

export interface AuditOptions {
  readonly gh: GitHub;
  readonly commit: string;
  readonly root: string;
  readonly gatesCheck?: string;
  readonly policyCheck?: string;
  readonly workflowsDir?: string;
  /** FACTORY_APP_LOGINS as configured, for the rename check below. */
  readonly configuredAppLogins?: readonly string[];
  /** Injected by the tests so the retry below does not really sleep. */
  readonly waitMs?: (ms: number) => Promise<void>;
}

export type AuditFinding =
  | { readonly kind: "app_login_stale"; readonly detail: string }
  | { readonly kind: "direct_push"; readonly detail: string }
  | { readonly kind: "gate_not_run"; readonly detail: string }
  | { readonly kind: "gate_failed_but_merged"; readonly detail: string }
  | { readonly kind: "gate_pending"; readonly detail: string }
  | { readonly kind: "unconfirmed"; readonly detail: string }
  | { readonly kind: "lock_file_stale"; readonly detail: string }
  | { readonly kind: "lock_file_missing"; readonly detail: string };

export interface AuditReport {
  readonly commit: string;
  readonly findings: readonly AuditFinding[];
  readonly checked: readonly string[];
}

interface CommitDetail {
  readonly parents: readonly { readonly sha: string }[];
  readonly commit: { readonly message: string };
}
interface SearchResult {
  readonly total_count: number;
  readonly items: readonly { readonly number: number }[];
}
interface AssociatedPr {
  readonly number: number;
  readonly merged_at: string | null;
  readonly merge_commit_sha: string | null;
  readonly head: { readonly sha: string };
}
interface CheckRun {
  readonly name: string;
  readonly conclusion: string | null;
  readonly status?: string;
}

/**
 * Findings that mean something actually got past the gates. The rest are
 * things the audit could not establish, or states that are normal and outside
 * the repo's control — they are reported, but they do not fail the run and
 * they never open a revert PR.
 *
 * The distinction is the whole point of this command. `factory/policy` never
 * completes on a private repo on GitHub Free, so treating a check that has not
 * concluded as a check that failed made factory-audit fail on every single
 * push — six for six on the first live install — and the one signal that a
 * commit really had bypassed the gates was buried in noise nobody could act
 * on.
 */
const BLOCKING_KINDS = new Set(["direct_push", "gate_failed_but_merged", "gate_not_run", "app_login_stale", "stale_lock"]);

export function blockingFindings(findings: readonly AuditFinding[]): readonly AuditFinding[] {
  return findings.filter((f) => BLOCKING_KINDS.has(f.kind));
}

/**
 * Ask again when the first answer is the "not yet" one. GitHub links a commit
 * to its pull request a moment after the merge, and this audit is triggered by
 * that merge, so the first read is a coin flip.
 */
async function retrying<T>(
  get: () => Promise<T>,
  good: (v: T | null) => boolean,
  wait: (ms: number) => Promise<void>,
  delays: readonly number[] = [1500, 3000, 6000],
): Promise<T | null> {
  let last: T | null = await get().catch(() => null);
  if (good(last)) return last;
  for (const ms of delays) {
    await wait(ms);
    last = await get().catch(() => null);
    if (good(last)) return last;
  }
  return last;
}

export async function runAuditCommand(opts: AuditOptions): Promise<AuditReport> {
  const findings: AuditFinding[] = [];
  const checked: string[] = [];
  const gatesCheck = opts.gatesCheck ?? "factory/gates";
  const policyCheck = opts.policyCheck ?? "factory/policy";

  // 1. Did this commit arrive through a PR at all?
  checked.push("arrived through a pull request");
  const prs = await opts.gh.get<SearchResult>(
    `search/issues?q=${encodeURIComponent(`repo:${opts.gh.repo} is:pr sha:${opts.commit}`)}`,
  ).catch(() => null);

  const detail = await opts.gh.get<CommitDetail>(`repos/${opts.gh.repo}/commits/${opts.commit}`);
  const isMergeCommit = detail.parents.length > 1;

  // The pull requests that brought this commit to main. A merge, squash or
  // rebase commit is a new commit, so the gates ran on the PR's head, not on
  // it. The search above matches only a PR's head, so it misses all three.
  // Retried, because this audit runs on `push` — seconds after the merge that
  // created the commit — and GitHub's commit-to-PR association is eventually
  // consistent. Asking once and taking the first empty answer made the audit
  // report that the gates had never run on a commit whose gates had passed
  // half a minute earlier.
  // Only an empty list is worth asking again about: that is GitHub's "not
  // linked yet". An error means the question cannot be answered at all, and
  // repeating it just adds latency to a run that is already failing.
  const associated = await retrying(
    () => opts.gh.get<readonly AssociatedPr[]>(`repos/${opts.gh.repo}/commits/${opts.commit}/pulls?per_page=20`),
    (v) => !(Array.isArray(v) && v.length === 0),
    opts.waitMs ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  );
  const assocList: readonly AssociatedPr[] = Array.isArray(associated) ? (associated as readonly AssociatedPr[]) : [];
  const mergedPrs = assocList.filter((p) => p.merged_at !== null);

  if (prs === null && !Array.isArray(associated)) {
    findings.push({
      kind: "gate_not_run",
      detail: "could not ask GitHub which PR this commit came from, so nothing here is confirmed",
    });
  } else if ((prs?.total_count ?? 0) === 0 && mergedPrs.length === 0 && !isMergeCommit) {
    findings.push({
      kind: "direct_push",
      detail: `${opts.commit.slice(0, 8)} is on main with no pull request: the gates never saw it`,
    });
  }

  // 2. Did the gates report on it, and did they pass? On the commit itself
  // (a merge queue's commit, or a fast-forward), or, failing that, on the head
  // of the pull request that was merged to make it.
  checked.push("the gate checks reported success on this commit");
  const fetchRuns = async (sha: string): Promise<readonly CheckRun[]> =>
    (await opts.gh.get<{ readonly check_runs: readonly CheckRun[] }>(`repos/${opts.gh.repo}/commits/${sha}/check-runs?per_page=100`)).check_runs;
  const own = await fetchRuns(opts.commit);
  const exact = mergedPrs.filter((p) => p.merge_commit_sha === opts.commit);
  const heads = [...new Set((exact.length > 0 ? exact : mergedPrs).map((p) => p.head.sha).filter((h) => h !== opts.commit))];
  const viaPr: CheckRun[] = [];
  let headLookupFailed = false;
  for (const h of heads) {
    const runs = await fetchRuns(h).catch(() => null);
    if (runs === null) headLookupFailed = true;
    else viaPr.push(...runs);
  }
  for (const name of [gatesCheck, policyCheck]) {
    const run = own.find((c) => c.name === name) ?? viaPr.find((c) => c.name === name);
    if (run === undefined) {
      // Only an accusation when we know where to look. If the association was
      // never resolved, or reading the head's checks failed, the audit has
      // established nothing — and saying "the gates never ran" in that case is
      // how a healthy repo ends up with a red run and a revert PR.
      if (mergedPrs.length === 0 || headLookupFailed) {
        findings.push({
          kind: "unconfirmed",
          detail:
            `could not read the checks for ${name} on ${opts.commit.slice(0, 8)} — ` +
            `GitHub had not yet linked the commit to its pull request. Re-run this audit to confirm.`,
        });
      } else {
        findings.push({ kind: "gate_not_run", detail: `${name} never reported on ${opts.commit.slice(0, 8)}` });
      }
    } else if (run.status !== undefined && run.status !== "completed") {
      // Not a failure: nothing bypassed anything. `factory/policy` sits here
      // permanently on a private repo on GitHub Free, where a check can be
      // reported but never required, so it is reported and the audit passes.
      findings.push({
        kind: "gate_pending",
        detail:
          `${name} is still ${run.status} on ${opts.commit.slice(0, 8)}. ` +
          `On a private repository on GitHub Free this is its normal resting state and nothing is wrong.`,
      });
    } else if (run.conclusion !== "success" && run.conclusion !== "neutral" && run.conclusion !== "skipped") {
      findings.push({
        kind: "gate_failed_but_merged",
        detail: `${name} concluded ${run.conclusion ?? "nothing"} and the commit is on main anyway`,
      });
    }
  }

  // 3. Does the configured App login still match the App?
  checked.push("the configured App login matches the App's current slug");
  findings.push(...(await appLoginDrift(opts)));

  // 4. Is every compiled role workflow current with its source?
  checked.push("every .lock.yml matches the .md it was compiled from");
  findings.push(...(await staleLockFiles(opts.root, opts.workflowsDir ?? ".github/workflows")));

  return { commit: opts.commit, findings, checked };
}


/**
 * An App's login is its slug with `[bot]` appended, and renaming the App in
 * GitHub's settings changes the slug. The policy check uses that login to know
 * which approvals are the App's own; `appRequestedChanges` uses it to tell
 * gh-aw's protected-file objection from a human's.
 *
 * Nothing breaks loudly when it goes stale — the `[bot]` suffix check still
 * stops an App approval counting as a human's — but the gate signal from an
 * App's REQUEST_CHANGES would be missed. So a rename is reported here rather
 * than left to be discovered by a PR that merged when it should not have.
 */
async function appLoginDrift(opts: AuditOptions): Promise<readonly AuditFinding[]> {
  const configured = opts.configuredAppLogins ?? [];
  if (configured.length === 0) {
    return [
      {
        kind: "app_login_stale",
        detail:
          "FACTORY_APP_LOGINS was not passed to this step, so an App's request for changes is not " +
          "recognised as a gate signal. The factory workflows pass the token step's app-slug; " +
          "a workflow that does not was edited or predates that, and re-running the installer restores it.",
      },
    ];
  }

  let slug: string;
  try {
    // Only answers when the caller is the App itself, which is the case in
    // every factory workflow.
    const app = await opts.gh.get<{ readonly slug?: string }>("app");
    if (typeof app.slug !== "string" || app.slug === "") return [];
    slug = app.slug;
  } catch {
    // Running as a user rather than as the App: nothing to compare against,
    // and saying nothing beats inventing a finding.
    return [];
  }

  const expected = `${slug}[bot]`;
  if (configured.includes(expected)) return [];
  return [
    {
      kind: "app_login_stale",
      detail:
        `the App's login is now ${expected}, but FACTORY_APP_LOGINS says ` +
        `${configured.join(", ")}. Renaming a GitHub App changes its slug; update the variable.`,
    },
  ];
}

/**
 * gh-aw compiles `factory-role-<role>.md` into `.lock.yml`, and only the lock
 * file runs. A source edited without recompiling is therefore a workflow that
 * says one thing and does another — the gap the recompiler App closes (doc 10).
 *
 * gh-aw writes the hashes of the source's normalized frontmatter and body into
 * the lock file's first line, so staleness is decidable without gh-aw
 * installed. The hashes are computed with gh-aw's own implementation, vendored
 * under `vendor/gh-aw/` — the normalization resolves imports and merges them in
 * sorted order, and reimplementing that from the outside is how a check ends up
 * crying stale on every fresh clone. Timestamps are no use for the same reason:
 * git does not preserve mtimes.
 */
export async function staleLockFiles(root: string, dir: string): Promise<readonly AuditFinding[]> {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  const findings: AuditFinding[] = [];
  const hashes = loadHasher();

  for (const file of readdirSync(full).filter((f) => f.startsWith("factory-role-") && f.endsWith(".md"))) {
    const md = join(full, file);
    const lock = join(full, file.replace(/\.md$/, ".lock.yml"));
    if (!existsSync(lock)) {
      findings.push({ kind: "lock_file_missing", detail: `${file} has never been compiled` });
      continue;
    }
    const lockText = readFileSync(lock, "utf8");
    const wantFrontmatter = hashes.extractHashFromLockFile(lockText);
    const wantBody = hashes.extractBodyHashFromLockFile(lockText);

    // gh-aw's extractor returns an empty string, not null, for a lock file
    // with no metadata comment. Checking only for null let that case fall
    // through to the hash comparison, which reported it as drift — true, but
    // it hid the clearer reason: the file was compiled by a gh-aw older than
    // this check understands.
    if (isBlank(wantFrontmatter) || isBlank(wantBody)) {
      findings.push({
        kind: "lock_file_stale",
        detail:
          `${file}: its lock file carries no gh-aw-metadata hashes, which means it was ` +
          `compiled by a gh-aw older than this check understands — recompile it`,
      });
      continue;
    }

    const gotFrontmatter = await hashes.computeFrontmatterHash(md, {});
    const gotBody = await hashes.computeBodyHash(md, {});
    const drifted: string[] = [];
    if (gotFrontmatter !== wantFrontmatter) drifted.push("frontmatter");
    if (gotBody !== wantBody) drifted.push("body (the prompt)");
    if (drifted.length > 0) {
      findings.push({
        kind: "lock_file_stale",
        detail:
          `${file}: its ${drifted.join(" and ")} changed since it was compiled. ` +
          `The lock file is what runs, so the change is not in effect`,
      });
    }
  }
  return findings;
}

interface Hasher {
  computeFrontmatterHash(path: string, opts: object): Promise<string>;
  computeBodyHash(path: string, opts: object): Promise<string>;
  extractHashFromLockFile(text: string): string | null | undefined;
  extractBodyHashFromLockFile(text: string): string | null | undefined;
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

/** gh-aw's own hash implementation, vendored. See vendor/gh-aw/README.md. */
function loadHasher(): Hasher {
  const require_ = createRequire(import.meta.url);
  // Resolved relative to this file: src under vitest, dist in this repo, and
  // the single-file bundle vendored at .factory/bin/ in a user's repo, which
  // ships the hasher beside it.
  for (const rel of [
    "../../vendor/gh-aw/frontmatter_hash_pure.cjs",
    "../vendor/gh-aw/frontmatter_hash_pure.cjs",
    "./vendor/gh-aw/frontmatter_hash_pure.cjs",
  ]) {
    try {
      return require_(rel) as Hasher;
    } catch {
      /* try the next layout */
    }
  }
  throw new Error("vendor/gh-aw/frontmatter_hash_pure.cjs not found");
}

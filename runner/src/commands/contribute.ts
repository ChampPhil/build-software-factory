import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const execFileAsync = promisify(execFile);
import type { Candidate, CandidatesFile } from "../lib/types.js";
import type { GitHub } from "../lib/github.js";
import { NOISE } from "./mine.js";

/**
 * `bsf contribute-corrections` — a teammate adds the corrections from their
 * own machine to the factory's candidate list.
 *
 * The whole point of mining is that a correction someone already made is a
 * rule they already wanted. Setup mines the person who ran it; everyone else
 * on the team has a different set of them, and nothing was collecting those.
 *
 * Two constraints shape this, and they pull against each other:
 *
 * 1. **The quotes are from private conversations.** A candidate carries the
 *    teammate's own words — `problem_class` is literally a sentence they
 *    typed at an agent. So nothing is submitted by the command that mines:
 *    mining writes a file on their disk, prints exactly what would be
 *    shared, and stops. They read it, delete anything they would rather not
 *    share, and submit separately. Consent to read a session is not consent
 *    to publish from it.
 * 2. **`candidates.json` is shared state.** Other people's candidates are in
 *    it, some already accepted or installed. A contribution merges; it never
 *    replaces, and it never touches a candidate that has been decided.
 */

export interface Contribution {
  readonly schema: "contribution/1";
  readonly repo: string;
  readonly mined_at: string;
  readonly candidates: readonly Candidate[];
}

/** Normalized form for deciding whether two candidates are the same thing. */
export function classKey(problemClass: string): string {
  return problemClass
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    // The same filter the clusterer uses. With its own list these two
    // disagreed about what counts as the same problem: "must use apiClient
    // for network calls" and "network calls must use apiClient" differed by
    // the word "for", so one machine's contribution became a second
    // candidate for a problem already on the list.
    .filter((w) => w.length > 3 && !NOISE.has(w))
    .sort()
    .join(" ");
}

export interface MergeResult {
  readonly merged: CandidatesFile;
  /** Candidates that were not in the list before. */
  readonly added: readonly Candidate[];
  /** Candidates folded into one already there, with the id they joined. */
  readonly folded: readonly { readonly into: string; readonly occurrences: number }[];
  /** Skipped because an identical candidate was already decided. */
  readonly skipped: readonly { readonly problem_class: string; readonly status: string }[];
}

/** How many source quotes one candidate keeps. */
const MAX_SOURCES = 8;

export function mergeContribution(
  existing: CandidatesFile,
  incoming: readonly Candidate[],
  contributedBy: string | null,
): MergeResult {
  const byKey = new Map<string, Candidate>();
  for (const c of existing.candidates) byKey.set(classKey(c.problem_class), c);

  const out = [...existing.candidates];
  const added: Candidate[] = [];
  const folded: { into: string; occurrences: number }[] = [];
  const skipped: { problem_class: string; status: string }[] = [];

  for (const c of incoming) {
    const key = classKey(c.problem_class);
    const match = byKey.get(key);

    if (match === undefined) {
      const fresh: Candidate = {
        ...c,
        status: "pending",
        ...(contributedBy === null ? {} : { contributed_by: contributedBy }),
      };
      out.push(fresh);
      added.push(fresh);
      byKey.set(key, fresh);
      continue;
    }

    if (match.status !== "pending") {
      // Already decided. Re-raising it would ask the team to judge the same
      // thing twice, and silently reopening a rejection is worse.
      skipped.push({ problem_class: c.problem_class, status: match.status });
      continue;
    }

    // The same problem seen on another machine is more evidence for one
    // candidate, not a second candidate.
    const at = out.findIndex((x) => x.id === match.id);
    const sources = [...match.sources, ...c.sources].slice(0, MAX_SOURCES);
    const firsts = [match.first_seen, c.first_seen].filter((v): v is string => v !== undefined).sort();
    const lasts = [match.last_seen, c.last_seen].filter((v): v is string => v !== undefined).sort();
    const updated: Candidate = {
      ...match,
      occurrences: match.occurrences + c.occurrences,
      sources,
      ...(firsts[0] === undefined ? {} : { first_seen: firsts[0] }),
      ...(lasts.length === 0 ? {} : { last_seen: lasts[lasts.length - 1] }),
    };
    out[at] = updated;
    byKey.set(key, updated);
    folded.push({ into: match.id, occurrences: c.occurrences });
  }

  return {
    merged: { schema: "candidates/1", candidates: out },
    added,
    folded,
    skipped,
  };
}

/** A branch name that cannot collide with another contribution's. */
export function contributionBranch(login: string | null, now = new Date()): string {
  const who = (login ?? "anon").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 24);
  const day = now.toISOString().slice(0, 10);
  return `factory/corrections-${who}-${day}-${randomBytes(3).toString("hex")}`;
}

export function contributionBody(result: MergeResult, login: string | null, repoPath: string): string {
  const lines: string[] = [];
  lines.push(
    `Corrections mined from agent sessions on ${login === null ? "a teammate's" : `@${login}'s`} machine, ` +
      `for \`${repoPath}\`.`,
    "",
    "Each one is a moment someone told an agent it had got something wrong. " +
      "Accepting a candidate does not install anything by itself — hardening " +
      "turns an accepted candidate into an API change, a static rule, a " +
      "verification scenario or a line of context.",
    "",
  );

  if (result.added.length > 0) {
    lines.push(`### ${result.added.length} new candidate(s)`, "");
    lines.push("| Occurrences | Proposed fix | Problem class |", "| --- | --- | --- |");
    for (const c of result.added) {
      lines.push(`| ${c.occurrences} | \`${c.proposed_fix}\` | ${cell(c.problem_class)} |`);
    }
    lines.push("");
  }

  if (result.folded.length > 0) {
    lines.push(
      `### ${result.folded.length} already on the list`,
      "",
      "Seen on this machine too, so the occurrence counts went up rather than " +
        "the same problem being listed twice:",
      "",
    );
    for (const f of result.folded) lines.push(`- \`${f.into}\` +${f.occurrences}`);
    lines.push("");
  }

  if (result.skipped.length > 0) {
    lines.push(
      `### ${result.skipped.length} skipped`,
      "",
      "Already decided, so not re-raised:",
      "",
    );
    for (const s of result.skipped) lines.push(`- ${cell(s.problem_class)} — already **${s.status}**`);
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "The quotes come from private agent sessions on one person's machine. " +
      "They chose what to include before this was submitted, and they are the " +
      "person to ask about any of it.",
  );
  return lines.join("\n");
}

function cell(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 160);
}

export interface SubmitResult {
  readonly pull: number;
  readonly url: string;
  readonly branch: string;
  readonly merge: MergeResult;
}

export async function submitContribution(opts: {
  readonly gh: GitHub;
  readonly contribution: Contribution;
  readonly candidatesPath: string;
  readonly repoPath: string;
  readonly now?: Date;
  readonly git?: (args: readonly string[], cwd: string) => Promise<string>;
}): Promise<SubmitResult | { readonly nothing: string }> {
  const { gh, contribution, candidatesPath } = opts;
  const git = opts.git ?? runGit;
  const base = await gh.defaultBranch();
  const login = await gh.viewer();

  // The branch and the commit are made with git in a throwaway worktree, not
  // through the API. A teammate running this is in a clone of the repo
  // anyway, and git is the one route that works the same whether the data
  // repo is public, private, or behind a proxy that refuses ref writes.
  await git(["fetch", "--quiet", "origin", base], opts.repoPath);

  // Read the list from the fetched base, not from the working tree: a local
  // checkout may be behind, and merging into stale state would drop whatever
  // the team accepted since.
  const text = await readAtRef(git, opts.repoPath, `origin/${base}`, candidatesPath);
  const existing: CandidatesFile =
    text === null ? { schema: "candidates/1", candidates: [] } : (JSON.parse(text) as CandidatesFile);

  const merge = mergeContribution(existing, contribution.candidates, login);
  if (merge.added.length === 0 && merge.folded.length === 0) {
    return {
      nothing:
        merge.skipped.length > 0
          ? `every candidate here was already decided (${merge.skipped.length}); nothing to submit`
          : "nothing to submit",
    };
  }

  const branch = contributionBranch(login, opts.now);
  const work = mkdtempSync(join(tmpdir(), "bsf-contribution-"));
  try {
    await git(["worktree", "add", "--quiet", "-b", branch, work, `origin/${base}`], opts.repoPath);
    const file = join(work, candidatesPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(merge.merged, null, 2)}\n`);
    await git(["add", "--", candidatesPath], work);
    await git(
      [
        "commit",
        "--quiet",
        "-m",
        `Add ${merge.added.length} guardrail candidate(s) from ${login ?? "a teammate"}'s sessions`,
      ],
      work,
    );
    await git(["push", "--quiet", "origin", `${branch}:${branch}`], work);
  } finally {
    // Always, even on a failed push: a left-behind worktree makes the next
    // run fail on a branch name that already exists locally.
    await git(["worktree", "remove", "--force", work], opts.repoPath).catch(() => "");
    rmSync(work, { recursive: true, force: true });
  }

  let pull;
  try {
    pull = await gh.openPull({
      title: `Guardrail candidates from ${login === null ? "a teammate" : `@${login}`}'s sessions`,
      head: branch,
      base,
      body: contributionBody(merge, login, contribution.repo),
    });
  } catch (err) {
    // The branch is already pushed at this point. Saying so matters: without
    // it the obvious move is to run the whole thing again, which pushes a
    // second branch with the same contents and leaves the first behind.
    throw new Error(
      `the branch ${branch} was pushed, but opening the pull request failed: ${String(err)}\n` +
        `Open it by hand from ${branch} into ${base}, or delete that branch and run --submit again.`,
    );
  }

  return { pull: pull.number, url: pull.html_url, branch, merge };
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, encoding: "utf8" });
  return String(stdout);
}

/** A file's contents at a ref, or null when the ref does not have it. */
async function readAtRef(
  git: (args: readonly string[], cwd: string) => Promise<string>,
  repoPath: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    const out = await git(["show", `${ref}:${path}`], repoPath);
    // A ref that does not have the path makes git exit non-zero, but an empty
    // result is treated the same way rather than parsed as JSON.
    return out.trim() === "" ? null : out;
  } catch {
    return null;
  }
}

import { GitHubHttpError, type GitHubClient } from "./github";
import {
  FACTORY_YAML, GARDEN_WORKFLOW, SETTINGS_LABEL, SETTINGS, applySettings, describeValue, readSettings, replaceCron,
  type SettingChanges, type SettingsProblem,
} from "./settings";

/**
 * Change settings in one step, as the signed-in person.
 *
 * It opens a pull request with the change and merges it with the person's own
 * token. The factory's policy check counts a trusted person's settings-only
 * change as their approval, so there is no second step and nobody opens a file.
 * Agents never hold this token and their pipelines may not change the
 * definition, so the factory still cannot rewrite its own boundary.
 *
 * What it does not do: skip the check. It waits for `factory/policy` to pass on
 * the change, and when the check fails, or GitHub wants a review or a merge
 * queue, it leaves the pull request open and says so.
 */

export type Stage = "reading" | "opening" | "checking" | "merging";

export type SettingsOutcome =
  | { readonly status: "applied"; readonly pr: number; readonly url: string; readonly summary: readonly string[] }
  | { readonly status: "open"; readonly pr: number; readonly url: string; readonly reason: string }
  | { readonly status: "unchanged" }
  | { readonly status: "refused"; readonly problems: readonly SettingsProblem[] }
  | { readonly status: "failed"; readonly message: string };

export interface ApplyOptions {
  readonly onStage?: (s: Stage) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  /** How long to wait for the policy check before leaving the PR open. */
  readonly waitMs?: number;
  /**
   * The repo's enforcement mode, from `index.health.enforcement`.
   *
   * On `audit` — a private repository on GitHub Free — a check can be reported
   * but never required, and `factory/policy` therefore sits at `in_progress`
   * for ever. Waiting two minutes for it to finish and then saying "the check
   * has not finished yet" is how a saved setting looked like a setting that
   * had silently failed: the dashboard went on showing the old value with
   * nothing explaining why. When this says `audit`, say so at once instead.
   */
  readonly enforcement?: "branch_protection" | "audit" | null;
}

const POLICY_CHECK = "factory/policy";

interface CheckRun { readonly name: string; readonly conclusion: string | null; readonly status: string; readonly completed_at: string | null }

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A status code is not something to show a person; say what to fix. */
export function explainFailure(e: unknown): string {
  if (e instanceof GitHubHttpError) {
    if (e.status === 401) return "Your sign-in has expired. Sign in again.";
    if (e.status === 403 || e.status === 404) {
      return "Your token cannot make this change. It needs write access to the repository's contents and pull requests, and to its workflows when the cleanup time changes.";
    }
    if (e.status === 422) return "GitHub refused the change. Try again in a moment.";
    return `GitHub answered ${e.status}. Try again in a moment.`;
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}

export async function applySettingsChange(
  client: GitHubClient,
  changes: SettingChanges,
  opts: ApplyOptions = {},
): Promise<SettingsOutcome> {
  const stage = opts.onStage ?? (() => undefined);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 4000;
  const waitMs = opts.waitMs ?? 120_000;
  const repo = client.repo;

  try {
    stage("reading");
    const base = await client.defaultBranch();
    const tip = (await client.get<{ object: { sha: string } }>(`repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`)).object.sha;
    const file = await client.textFromRepo(FACTORY_YAML, base);
    if (file === null) return { status: "failed", message: "The factory's settings could not be found on the default branch." };

    const result = applySettings(file.text, changes);
    if (result.problems.length > 0) return { status: "refused", problems: result.problems };
    if (result.yaml === file.text) return { status: "unchanged" };

    let workflow: { text: string; sha: string } | null = null;
    if (result.cron !== null) {
      const current = await client.textFromRepo(GARDEN_WORKFLOW, base);
      const next = current === null ? null : replaceCron(current.text, result.cron);
      if (current === null || next === null) {
        return { status: "refused", problems: [{ id: "gardening_hour", message: "The cleanup schedule cannot be changed from here on this repository." }] };
      }
      workflow = { text: next, sha: current.sha };
    }

    const before = readSettings(file.text);
    const after = readSettings(result.yaml);
    const summary = Object.keys(changes).map((id) => {
      const s = SETTINGS.find((x) => x.id === id)!;
      return `${s.label}: ${describeValue(s, before[id] ?? null)} -> ${describeValue(s, after[id] ?? null)}`;
    });

    stage("opening");
    const branch = `factory-settings/${Date.now().toString(36)}`;
    await client.send("POST", `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: tip });
    const message = `Settings: ${summary.join("; ")}`;
    await client.send("PUT", `repos/${repo}/contents/${encodeURI(FACTORY_YAML)}`, {
      message, branch, sha: file.sha, content: toBase64(result.yaml),
    });
    if (workflow !== null) {
      await client.send("PUT", `repos/${repo}/contents/${encodeURI(GARDEN_WORKFLOW)}`, {
        message: "Settings: cleanup time", branch, sha: workflow.sha, content: toBase64(workflow.text),
      });
    }
    const pr = await client.send<{ number: number; html_url: string; head: { sha: string } }>("POST", `repos/${repo}/pulls`, {
      title: message,
      head: branch,
      base,
      body: `Changed from the dashboard by the signed-in person.\n\n${summary.map((l) => `- ${l}`).join("\n")}\n\nThe factory's policy check passes this on its author's say-so because only settings a person may change were touched.`,
    });
    await client.addLabels(pr.number, [SETTINGS_LABEL]);
    // GitHub's own clock for when the label landed: a check that finished before it ran without the label.
    const labelled = (await client.get<{ updated_at: string }>(`repos/${repo}/pulls/${pr.number}`)).updated_at;
    const url = pr.html_url;

    if (opts.enforcement === "audit") {
      return {
        status: "open",
        pr: pr.number,
        url,
        reason:
          "Saved as a pull request. On this repository GitHub does not offer required checks (free private plan), " +
          "so the factory cannot merge it by itself: you merge it. GitHub Pro or a public repository lets the factory merge by itself.",
      };
    }

    stage("checking");
    const deadline = Date.now() + waitMs;
    let verdict: "success" | "failure" | "waiting" = "waiting";
    let failureText = "";
    while (Date.now() < deadline) {
      const runs = (await client.get<{ check_runs: CheckRun[] }>(`repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`)).check_runs;
      const mine = runs
        .filter((r) => r.name === POLICY_CHECK && r.status === "completed" && r.completed_at !== null && r.completed_at >= labelled)
        .sort((a, b) => (a.completed_at! < b.completed_at! ? 1 : -1))[0];
      if (mine?.conclusion === "success") { verdict = "success"; break; }
      if (mine !== undefined) { verdict = "failure"; failureText = mine.conclusion ?? "failure"; break; }
      await sleep(pollMs);
    }
    if (verdict === "failure") {
      return { status: "open", pr: pr.number, url, reason: `The factory's check did not pass this (${failureText}). It stays open as a pull request for a person to review.` };
    }
    if (verdict === "waiting") {
      return { status: "open", pr: pr.number, url, reason: "The factory's check has not finished yet. It is open as a pull request and can be merged once the check passes." };
    }

    stage("merging");
    try {
      await client.send("PUT", `repos/${repo}/pulls/${pr.number}/merge`, { merge_method: "squash" });
    } catch (e) {
      if (e instanceof GitHubHttpError && (e.status === 405 || e.status === 409 || e.status === 422)) {
        return { status: "open", pr: pr.number, url, reason: "The check passed, but GitHub wants more before it merges (a review or the merge queue). It is open as a pull request." };
      }
      throw e;
    }
    try {
      await client.send("DELETE", `repos/${repo}/git/refs/heads/${branch}`);
    } catch {
      // A branch left behind is harmless.
    }
    return { status: "applied", pr: pr.number, url, summary };
  } catch (e) {
    return { status: "failed", message: explainFailure(e) };
  }
}

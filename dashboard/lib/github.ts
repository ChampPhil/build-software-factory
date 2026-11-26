import type { IssueComment } from "./questions";
import { PERMISSIONS, missingPermissionMessage, permissionForRequest, type PermissionNeed } from "./permissions";
/**
 * The dashboard's GitHub client, running in the browser with the user's own
 * token. No data passes through any server the maintainer runs.
 *
 * Reads are plain REST. Writes are the few things the dashboard does on the
 * user's behalf: approving a PR, posting a comment, creating an issue,
 * dispatching a workflow.
 */

const API_ORIGIN = "https://api.github.com";

export interface Auth {
  readonly token: string;
  readonly repo: string; // owner/name
}

export class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
    readonly method: string = "GET",
  ) {
    super(`GitHub ${status} on ${path}`);
    this.name = "GitHubHttpError";
  }

  /** A message worth showing a person, rather than a status code. */
  get human(): string {
    switch (this.status) {
      case 401:
        return "That token was refused. It may have expired, or been revoked.";
      case 403:
      case 404: {
        // A token missing a permission gets a bare 403 or 404. Naming the permission
        // turns that into something a person can fix.
        const perm = this.method === "GET" && this.status === 404 ? null : permissionForRequest(this.method, this.path);
        if (perm !== null) return missingPermissionMessage(perm);
        return this.status === 403
          ? "That token does not have permission for this. Check its repository access and permissions."
          : "Not found. Either it does not exist, or the token cannot see it.";
      }
      case 422:
        return "GitHub rejected the request as invalid.";
      default:
        return this.status >= 500
          ? "GitHub is having trouble. Try again in a moment."
          : `GitHub returned ${this.status}.`;
    }
  }
}

export interface RateLimit {
  readonly remaining: number;
  readonly limit: number;
  readonly resetAt: Date | null;
}

export interface PullFile {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch?: string;
}

export class GitHubClient {
  private lastRate: RateLimit | null = null;

  constructor(
    private readonly auth: Auth,
    // Wrapped, not `fetch` itself: kept as a property and called as `this.fetchImpl(...)`,
    // the browser's fetch runs with the client as `this` and throws "Illegal invocation".
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  get rateLimit(): RateLimit | null {
    return this.lastRate;
  }

  get repo(): string {
    return this.auth.repo;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    // The token goes to GitHub's API and nowhere else. A caller handing over any other
    // address is a bug, and it must fail before the Authorization header is built.
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith(API_ORIGIN + "/")) {
      throw new Error("Refusing to send the token anywhere but GitHub's API.");
    }
    const url = path.startsWith("https://") ? path : `${API_ORIGIN}/${path.replace(/^\//, "")}`;
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.auth.token}`,
        "x-github-api-version": "2022-11-28",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.headers ?? {}),
      },
    });

    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining !== null) {
      const reset = res.headers.get("x-ratelimit-reset");
      this.lastRate = {
        remaining: Number(remaining),
        limit: Number(res.headers.get("x-ratelimit-limit") ?? 0),
        resetAt: reset === null ? null : new Date(Number(reset) * 1000),
      };
    }
    return res;
  }

  /**
   * Whether the factory's data ref moved since `etag`. A 304 costs no rate limit,
   * so this is cheap enough to ask every few seconds while the page is visible.
   */
  async dataRefChanged(etag: string | null): Promise<{ readonly changed: boolean; readonly etag: string | null }> {
    const res = await this.request(`repos/${this.auth.repo}/git/ref/factory/data`, etag === null ? {} : { headers: { "if-none-match": etag } });
    if (res.status === 304) return { changed: false, etag };
    if (!res.ok) return { changed: false, etag };
    return { changed: etag !== null, etag: res.headers.get("etag") };
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.request(path);
    if (!res.ok) throw new GitHubHttpError(res.status, path, await res.text(), "GET");
    return (await res.json()) as T;
  }

  /** For a resource whose absence is a normal state, not an error. */
  async getOrNull<T>(path: string): Promise<T | null> {
    const res = await this.request(path);
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubHttpError(res.status, path, await res.text(), "GET");
    return (await res.json()) as T;
  }

  async send<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await this.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new GitHubHttpError(res.status, path, await res.text(), method);
    const text = await res.text();
    return (text === "" ? {} : JSON.parse(text)) as T;
  }

  /* ----------------------------------------------- the factory's own records */

  /**
   * Reads a file from a ref. The factory's data lives on `refs/factory/data`,
   * outside `refs/heads/`, so it never appears as a branch and writing to it
   * starts no workflow.
   */
  async fileFromRef<T>(path: string, ref = "refs/factory/data"): Promise<T | null> {
    const res = await this.getOrNull<{ content?: string; encoding?: string }>(
      `repos/${this.auth.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
    );
    if (res === null || res.content === undefined) return null;
    const text = decodeBase64(res.content);
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  /**
   * The JSON files in one directory of the data ref, newest name first.
   *
   * Reviews have no index: their ids are time-ordered,
   * so listing the directory and sorting by name gives newest first without a
   * second file to keep in step.
   */
  async listFromRef(dir: string, ref = "refs/factory/data"): Promise<readonly string[]> {
    const res = await this.getOrNull<{ name: string; type: string }[]>(
      `repos/${this.auth.repo}/contents/${encodeURI(dir)}?ref=${encodeURIComponent(ref)}`,
    );
    if (res === null) return [];
    return res
      .filter((e) => e.type === "file" && e.name.endsWith(".json"))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));
  }

  /**
   * A JSON file from the repository's default branch. The guardrails live
   * there (`.factory/guardrails/`), changed only by reviewed PRs, not on the
   * data ref.
   */
  async fileFromRepo<T>(path: string): Promise<T | null> {
    const res = await this.getOrNull<{ content?: string }>(
      `repos/${this.auth.repo}/contents/${encodeURI(path)}`,
    );
    if (res === null || res.content === undefined) return null;
    try {
      return JSON.parse(decodeBase64(res.content)) as T;
    } catch {
      return null;
    }
  }

  async defaultBranch(): Promise<string> {
    const repo = await this.get<{ default_branch: string }>(`repos/${this.auth.repo}`);
    return repo.default_branch;
  }

  /** Accept or reject a guardrail candidate. The factory's intake records it and, for accept, starts hardening on it. */
  async decideCandidate(id: string, decision: "accept" | "reject"): Promise<void> {
    await this.dispatchWorkflow("factory-intake.yml", await this.defaultBranch(), {
      kind: decision === "accept" ? "candidate_accept" : "candidate_reject",
      title: id,
    });
  }

  /** Send one dashboard decision to the factory's intake (the browser cannot write the data ref). */
  async dispatchIntake(kind: string, title: string, body?: string): Promise<void> {
    await this.dispatchWorkflow("factory-intake.yml", await this.defaultBranch(), {
      kind,
      title,
      ...(body === undefined ? {} : { body }),
    });
  }

  /** Move a request that has not started to another pipeline. The factory refuses it if work has begun. */
  async moveRequest(workItem: string, pipeline: string): Promise<void> {
    await this.dispatchIntake("route_override", workItem, pipeline);
  }

  async addStandingGoal(text: string, lane: string | null): Promise<void> {
    await this.dispatchIntake("standing_goal_add", text, lane ?? "");
  }

  async removeStandingGoal(id: string): Promise<void> {
    await this.dispatchIntake("standing_goal_remove", id);
  }

  /**
   * One file from the media ref, as bytes the browser can play or show.
   *
   * Asked for raw, so a recording is not wrapped in base64 JSON and is not cut
   * off at the 1 MB the JSON contents response allows.
   */
  async mediaFile(path: string, ref = "refs/factory/media"): Promise<Blob | null> {
    const url = `repos/${this.auth.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
    const res = await this.request(url, { headers: { accept: "application/vnd.github.raw+json" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubHttpError(res.status, url, await res.text());
    return await res.blob();
  }

  /** Lists the live-status refs, one per run in flight. */
  async liveRefs(): Promise<readonly { readonly ref: string; readonly sha: string }[]> {
    const res = await this.getOrNull<{ ref: string; object: { sha: string } }[]>(
      `repos/${this.auth.repo}/git/matching-refs/factory/live`,
    );
    if (res === null) return [];
    return res.map((r) => ({ ref: r.ref, sha: r.object.sha }));
  }

  /* ------------------------------------------------------------------- pulls */

  async pulls(state: "open" | "closed" | "all" = "open"): Promise<readonly PullSummary[]> {
    return this.get<PullSummary[]>(`repos/${this.auth.repo}/pulls?state=${state}&per_page=100`);
  }

  async issues(opts: { labels?: string; state?: "open" | "closed" } = {}): Promise<readonly IssueSummary[]> {
    const params = new URLSearchParams({ state: opts.state ?? "open", per_page: "100" });
    if (opts.labels !== undefined) params.set("labels", opts.labels);
    return this.get<IssueSummary[]>(`repos/${this.auth.repo}/issues?${params.toString()}`);
  }

  /* ------------------------------------------------------------------ writes */

  /** A new request becomes an issue, which the factory picks up like any other. */
  async createIssue(
    title: string,
    body: string,
    labels: readonly string[] = [],
  ): Promise<{ number: number; html_url: string }> {
    return this.send("POST", `repos/${this.auth.repo}/issues`, {
      title,
      body,
      ...(labels.length === 0 ? {} : { labels }),
    });
  }

  /** A text file on the default branch, with the sha an update must name. Null when it is not there. */
  async textFromRepo(path: string, ref?: string): Promise<{ text: string; sha: string } | null> {
    const q = ref === undefined ? "" : `?ref=${encodeURIComponent(ref)}`;
    const res = await this.getOrNull<{ content?: string; sha?: string }>(
      `repos/${this.auth.repo}/contents/${encodeURI(path)}${q}`,
    );
    if (res === null || res.content === undefined || res.sha === undefined) return null;
    return { text: decodeBase64(res.content), sha: res.sha };
  }

  /** People who can write to the repository, which is who the factory acts for. */
  async writers(): Promise<readonly { login: string; role: string }[]> {
    const rows = await this.get<{ login: string; role_name?: string; permissions?: Record<string, boolean> }[]>(
      `repos/${this.auth.repo}/collaborators?affiliation=all&per_page=100`,
    );
    return rows
      .filter((r) => r.permissions?.["push"] === true || r.permissions?.["admin"] === true)
      .map((r) => ({ login: r.login, role: r.role_name ?? (r.permissions?.["admin"] === true ? "admin" : "write") }));
  }

  /** The comments on an issue, oldest first. */
  async issueComments(number: number): Promise<readonly IssueComment[]> {
    return this.get<IssueComment[]>(`repos/${this.auth.repo}/issues/${number}/comments?per_page=100`);
  }

  async approvePull(number: number, body?: string): Promise<void> {
    await this.send("POST", `repos/${this.auth.repo}/pulls/${number}/reviews`, {
      event: "APPROVE",
      ...(body === undefined ? {} : { body }),
    });
  }

  async requestChanges(number: number, body: string): Promise<void> {
    await this.send("POST", `repos/${this.auth.repo}/pulls/${number}/reviews`, {
      event: "REQUEST_CHANGES",
      body,
    });
  }

  async comment(issueOrPr: number, body: string): Promise<void> {
    await this.send("POST", `repos/${this.auth.repo}/issues/${issueOrPr}/comments`, { body });
  }

  async addLabels(issueOrPr: number, labels: readonly string[]): Promise<void> {
    await this.send("POST", `repos/${this.auth.repo}/issues/${issueOrPr}/labels`, { labels });
  }

  /**
   * Merge a pull request.
   *
   * The dashboard's whole point is that somebody should not have to go to
   * GitHub for something the dashboard can do, and merging is the thing they
   * came here to do. There is no separate approve step: if they want to merge
   * from the factory they merge from the factory, and if they want a
   * line-by-line read the diff is here with a link to GitHub beside it.
   */
  async mergePull(number: number, method: "squash" | "merge" | "rebase" = "squash"): Promise<void> {
    await this.send("PUT", `repos/${this.repo}/pulls/${number}/merge`, { merge_method: method });
  }

  async setIssueState(number: number, state: "open" | "closed"): Promise<void> {
    await this.send("PATCH", `repos/${this.repo}/issues/${number}`, { state });
  }

  async removeLabel(number: number, label: string): Promise<void> {
    await this.send("DELETE", `repos/${this.repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
  }

  /** Re-run the jobs that failed in a workflow run, which is the common case. */
  async rerunFailedJobs(runId: number): Promise<void> {
    await this.send("POST", `repos/${this.repo}/actions/runs/${runId}/rerun-failed-jobs`);
  }

  /**
   * A pull request's changed files, with their patches.
   *
   * Rendered inline for a small diff, which is most of what the factory opens.
   * A big one keeps its link to GitHub rather than being rebuilt badly here:
   * nobody needs a worse version of a diff viewer that already exists.
   */
  async pullFiles(number: number): Promise<readonly PullFile[]> {
    return this.get<readonly PullFile[]>(`repos/${this.repo}/pulls/${number}/files?per_page=100`);
  }

  /**
   * Drop requests: the factory closes their pull requests with the reason and
   * stops working on them. Only someone who can start a workflow can do this,
   * which is the same set of people who can start work.
   */
  async dropRequests(workItems: readonly string[], why: string): Promise<void> {
    await this.dispatchWorkflow("factory-drop.yml", await this.defaultBranch(), {
      work_items: workItems.join(","),
      why,
    });
  }

  /** Start a request again from its first gate attempt, for one that was handed back. */
  async retryRequest(workItem: string): Promise<void> {
    await this.dispatchWorkflow("factory-run.yml", await this.defaultBranch(), { work_item: workItem });
  }

  /** The newest run of one workflow, for rows the shared recent-runs list does not cover. Cached for a minute. */
  private readonly lastRuns = new Map<number, { at: number; run: WorkflowRunSummary | null }>();
  async lastRunOf(workflowId: number): Promise<WorkflowRunSummary | null> {
    const hit = this.lastRuns.get(workflowId);
    if (hit !== undefined && Date.now() - hit.at < 60_000) return hit.run;
    const res = await this.get<{ workflow_runs: WorkflowRunSummary[] }>(`repos/${this.repo}/actions/workflows/${workflowId}/runs?per_page=1`);
    const run = res.workflow_runs[0] ?? null;
    this.lastRuns.set(workflowId, { at: Date.now(), run });
    return run;
  }

  /**
   * Run one of the factory's workflows that needs no input, now, on the default branch.
   *
   * Only factory-review has a "due" check of its own (it skips when it ran
   * recently), so it alone is sent `force`. Every other workflow here has no
   * due check to skip: they do their work or find nothing to do.
   */
  async runWorkflowNow(file: string): Promise<void> {
    await this.dispatchWorkflow(file, await this.defaultBranch(), file === "factory-review.yml" ? { force: "true" } : {});
  }

  /** One pull request in full: its body carries the factory's summary, and its state says whether it can merge. */
  async pull(number: number): Promise<PullDetail> {
    return this.get<PullDetail>(`repos/${this.repo}/pulls/${number}`);
  }

  /**
   * Close a pull request without merging it.
   *
   * The branch stays. Closing is how a person says "not this attempt": the
   * request goes back to the factory, which starts the next try from main.
   */
  async closePull(number: number): Promise<void> {
    await this.send("PATCH", `repos/${this.repo}/pulls/${number}`, { state: "closed" });
  }

  /**
   * Comment on one line of a pull request's diff, on the side the line is on.
   *
   * GitHub anchors the comment to a commit, so it stays on the line it was
   * written about even after the factory pushes again.
   */
  async createReviewComment(
    number: number,
    comment: { readonly body: string; readonly commit: string; readonly path: string; readonly line: number; readonly side: "LEFT" | "RIGHT" },
  ): Promise<void> {
    await this.send("POST", `repos/${this.repo}/pulls/${number}/comments`, {
      body: comment.body,
      commit_id: comment.commit,
      path: comment.path,
      line: comment.line,
      side: comment.side,
    });
  }

  /** The checks GitHub ran on a commit, for showing beside a pull request. */
  async checkRuns(sha: string): Promise<readonly CheckRunSummary[]> {
    const r = await this.get<{ check_runs: CheckRunSummary[] }>(`repos/${this.repo}/commits/${sha}/check-runs?per_page=100`);
    return r.check_runs;
  }

  /** The repository's workflows: the factory's own are the ones whose file starts with `factory-`. */
  async workflows(): Promise<readonly WorkflowSummary[]> {
    const r = await this.get<{ workflows: WorkflowSummary[] }>(`repos/${this.repo}/actions/workflows?per_page=100`);
    return r.workflows;
  }

  /** Recent workflow runs, newest first: what is running, and what failed and can be run again. */
  async workflowRuns(perPage = 50): Promise<readonly WorkflowRunSummary[]> {
    const r = await this.get<{ workflow_runs: WorkflowRunSummary[] }>(`repos/${this.repo}/actions/runs?per_page=${perPage}`);
    return r.workflow_runs;
  }

  /**
   * Stop a workflow run that is still going.
   *
   * What it spent so far is still spent; the factory's budget settlement reads
   * the run's own record, so a cancelled run is charged what it used and no more.
   */
  async cancelWorkflowRun(runId: number): Promise<void> {
    await this.send("POST", `repos/${this.repo}/actions/runs/${runId}/cancel`);
  }

  async dispatchWorkflow(workflow: string, ref: string, inputs: Record<string, string> = {}): Promise<void> {
    await this.send("POST", `repos/${this.auth.repo}/actions/workflows/${workflow}/dispatches`, {
      ref,
      inputs,
    });
  }

  /**
   * The repositories this user has the Software Factory app installed on.
   *
   * A user-to-server token can read its own installations, which is exactly
   * the list worth offering: every repository here is one the dashboard can
   * actually open. Returns an empty list rather than throwing, so a picker can
   * fall back to asking for the name.
   */
  async installedRepos(): Promise<readonly string[]> {
    try {
      const installs = await this.get<{ readonly installations?: readonly { readonly id: number }[] }>(
        "user/installations?per_page=100",
      );
      const names: string[] = [];
      for (const inst of installs.installations ?? []) {
        const repos = await this.get<{ readonly repositories?: readonly { readonly full_name: string }[] }>(
          `user/installations/${inst.id}/repositories?per_page=100`,
        ).catch(() => ({ repositories: [] as readonly { readonly full_name: string }[] }));
        for (const r of repos.repositories ?? []) if (r.full_name !== undefined) names.push(r.full_name);
      }
      return [...new Set(names)].sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  /**
   * Whether this token can do the things the dashboard offers.
   *
   * Reads are probed, one per permission, because a missing one is a 403 that can
   * be named now. Writes cannot be probed without changing something, so a missing
   * write permission is named when the request is refused (see `GitHubHttpError.human`).
   */
  async checkAccess(): Promise<AccessCheck> {
    const base = `repos/${this.auth.repo}`;
    const repoRes = await this.request(base);
    if (repoRes.status === 401) {
      return { ok: false, reason: "GitHub refused that token. It may be mistyped, expired or revoked." };
    }
    if (repoRes.status === 404 || repoRes.status === 403) {
      return {
        ok: false,
        reason:
          "The token cannot see this repository. Check the name, and that the token's repository access includes it (for a repository owned by an organization, the token must be made for that organization).",
      };
    }
    if (!repoRes.ok) throw new GitHubHttpError(repoRes.status, base, await repoRes.text(), "GET");
    const repo = (await repoRes.json()) as { permissions?: Record<string, boolean> };

    const probes: readonly (readonly [string, string])[] = [
      ["contents", `${base}/contents`],
      ["pull_requests", `${base}/pulls?per_page=1`],
      ["issues", `${base}/issues?per_page=1`],
      ["actions", `${base}/actions/workflows?per_page=1`],
      ["checks", `${base}/commits/HEAD/check-runs?per_page=1`],
    ];
    const results = await Promise.all(
      probes.map(async ([key, path]) => [key, (await this.request(path)).status] as const),
    );
    const missing: PermissionNeed[] = results
      .filter(([, status]) => status === 403)
      .flatMap(([key]) => PERMISSIONS.filter((p) => p.key === key));
    if (missing.length > 0) {
      const names = missing.map((m) => m.label).join(", ");
      return {
        ok: false,
        missing,
        reason: `This token is missing permissions: ${names}. Create it again with the link on this page, which fills them in, and paste the new token.`,
      };
    }

    const perms = repo.permissions ?? {};
    if (perms["push"] !== true) {
      return {
        ok: true,
        readOnly: true,
        reason: "This token can read but not write, so approving and commenting are unavailable.",
      };
    }
    return { ok: true, readOnly: false };
  }
}

export type AccessCheck =
  | { readonly ok: false; readonly reason: string; readonly missing?: readonly PermissionNeed[] }
  | { readonly ok: true; readonly readOnly: boolean; readonly reason?: string };

/** Base64 that works in the browser and in Node, for tests. */
export function decodeBase64(input: string): string {
  const clean = input.replace(/\s/g, "");
  if (typeof atob === "function") {
    const bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(clean, "base64").toString("utf8");
}

export interface PullSummary {
  readonly number: number;
  readonly title: string;
  readonly draft: boolean;
  readonly html_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly user: { readonly login: string } | null;
  readonly labels: readonly { readonly name: string }[];
  readonly head: { readonly ref: string; readonly sha: string };
}

export interface IssueSummary {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly created_at: string;
  readonly user: { readonly login: string } | null;
  readonly labels: readonly { readonly name: string }[];
  readonly author_association: string;
  /** The issue text; GitHub sends it on the list. */
  readonly body?: string | null;
  /** How many comments the issue has; GitHub always sends it. */
  readonly comments?: number;
  /** Present on PRs; absent on true issues. */
  readonly pull_request?: unknown;
}

export interface PullDetail extends PullSummary {
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly merged_at: string | null;
  readonly mergeable: boolean | null;
  /** "clean", "behind", "blocked", "dirty", "unstable" and so on; GitHub works it out after a moment, so it can be "unknown". */
  readonly mergeable_state: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changed_files: number;
  readonly base: { readonly ref: string };
}

export interface CheckRunSummary {
  readonly id: number;
  readonly name: string;
  /** "queued", "in_progress" or "completed". */
  readonly status: string;
  /** "success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", or null while running. */
  readonly conclusion: string | null;
  readonly html_url?: string;
  readonly output?: { readonly title?: string | null; readonly summary?: string | null };
}

export interface WorkflowSummary {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly state: string;
}

export interface WorkflowRunSummary {
  readonly id: number;
  readonly name: string;
  readonly path?: string;
  readonly workflow_id: number;
  /** "queued", "in_progress" or "completed". */
  readonly status: string;
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly html_url: string;
  readonly event: string;
  readonly head_branch?: string | null;
}

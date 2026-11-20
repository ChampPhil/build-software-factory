/**
 * The dashboard's GitHub client, running in the browser with the user's own
 * token. No data passes through any server the maintainer runs.
 *
 * Reads are plain REST. Writes are the few things the dashboard does on the
 * user's behalf: approving a PR, posting a comment, creating an issue,
 * dispatching a workflow.
 */

export interface Auth {
  readonly token: string;
  readonly repo: string; // owner/name
}

export class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
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
        return "That token does not have permission for this. Check its repository access and scopes.";
      case 404:
        return "Not found. Either it does not exist, or the token cannot see it.";
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

export class GitHubClient {
  private lastRate: RateLimit | null = null;

  constructor(
    private readonly auth: Auth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get rateLimit(): RateLimit | null {
    return this.lastRate;
  }

  get repo(): string {
    return this.auth.repo;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("https://") ? path : `https://api.github.com/${path.replace(/^\//, "")}`;
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

  async get<T>(path: string): Promise<T> {
    const res = await this.request(path);
    if (!res.ok) throw new GitHubHttpError(res.status, path, await res.text());
    return (await res.json()) as T;
  }

  /** For a resource whose absence is a normal state, not an error. */
  async getOrNull<T>(path: string): Promise<T | null> {
    const res = await this.request(path);
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubHttpError(res.status, path, await res.text());
    return (await res.json()) as T;
  }

  async send<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await this.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new GitHubHttpError(res.status, path, await res.text());
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
   * Reviews and benchmark results have no index: their ids are time-ordered,
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
  async createIssue(title: string, body: string): Promise<{ number: number; html_url: string }> {
    return this.send("POST", `repos/${this.auth.repo}/issues`, { title, body });
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

  async dispatchWorkflow(workflow: string, ref: string, inputs: Record<string, string> = {}): Promise<void> {
    await this.send("POST", `repos/${this.auth.repo}/actions/workflows/${workflow}/dispatches`, {
      ref,
      inputs,
    });
  }

  /** Whether this token can do the things the dashboard offers. */
  async checkAccess(): Promise<AccessCheck> {
    const repo = await this.getOrNull<{ permissions?: Record<string, boolean>; private: boolean }>(
      `repos/${this.auth.repo}`,
    );
    if (repo === null) {
      return { ok: false, reason: "The token cannot see this repository." };
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
  | { readonly ok: false; readonly reason: string }
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
  /** Present on PRs; absent on true issues. */
  readonly pull_request?: unknown;
}

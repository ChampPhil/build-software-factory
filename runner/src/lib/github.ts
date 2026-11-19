import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * A thin GitHub REST client, run through the `gh` CLI so it inherits whatever
 * credentials the job was given.
 *
 * REST only, deliberately: `gh`'s higher-level commands (`gh pr view`,
 * `gh repo view`) go through GraphQL, which some tokens and networks allow
 * while refusing the other, and the factory's jobs mint narrowly-scoped
 * tokens where that difference bites.
 */

export interface GitHubOptions {
  readonly repo: string; // owner/name
  readonly token?: string;
}

export class GitHubError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`GitHub request failed: ${path}\n${detail}`);
    this.name = "GitHubError";
  }
}

export class GitHub {
  constructor(private readonly opts: GitHubOptions) {}

  private env(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (this.opts.token !== undefined) env["GH_TOKEN"] = this.opts.token;
    return env;
  }

  /** GET a REST path, paginating when asked. */
  async get<T>(path: string, { paginate = false }: { paginate?: boolean } = {}): Promise<T> {
    const args = ["api", path];
    if (paginate) args.push("--paginate", "--slurp");
    try {
      const { stdout } = await exec("gh", args, {
        env: this.env(),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      const parsed = JSON.parse(String(stdout)) as unknown;
      // --slurp wraps each page in an array; flatten one level.
      if (paginate && Array.isArray(parsed)) {
        return (parsed as unknown[]).flat() as T;
      }
      return parsed as T;
    } catch (err) {
      throw new GitHubError(path, errText(err));
    }
  }

  /** POST, PATCH or PUT a REST path with a JSON body. */
  async send<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const args = ["api", "-X", method, path];
    if (body !== undefined) args.push("--input", "-");
    try {
      // The body goes in on stdin rather than as -f pairs, so a value
      // containing a newline or a quote survives intact.
      const { stdout } = await exec("gh", args, {
        env: this.env(),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        ...(body === undefined ? {} : { input: JSON.stringify(body) }),
      } as Parameters<typeof exec>[2]);
      const text = String(stdout).trim();
      return (text === "" ? {} : JSON.parse(text)) as T;
    } catch (err) {
      throw new GitHubError(path, errText(err));
    }
  }

  private get base(): string {
    return `repos/${this.opts.repo}`;
  }

  /* ------------------------------------------------------------- pull requests */

  async pull(number: number): Promise<PullResponse> {
    return this.get<PullResponse>(`${this.base}/pulls/${number}`);
  }

  async pullFiles(number: number): Promise<readonly PullFile[]> {
    return this.get<PullFile[]>(`${this.base}/pulls/${number}/files?per_page=100`, { paginate: true });
  }

  async pullReviews(number: number): Promise<readonly ReviewResponse[]> {
    return this.get<ReviewResponse[]>(`${this.base}/pulls/${number}/reviews?per_page=100`, { paginate: true });
  }

  /* --------------------------------------------------------------- check runs */

  /** Report a gate's verdict as a check run, which is what a required check reads. */
  async reportCheck(opts: {
    readonly name: string;
    readonly headSha: string;
    readonly conclusion: "success" | "failure" | "neutral" | "skipped";
    readonly title: string;
    readonly summary: string;
    readonly text?: string;
  }): Promise<void> {
    await this.send("POST", `${this.base}/check-runs`, {
      name: opts.name,
      head_sha: opts.headSha,
      status: "completed",
      conclusion: opts.conclusion,
      completed_at: new Date().toISOString(),
      output: {
        title: opts.title,
        // GitHub caps the summary at 65535 characters.
        summary: opts.summary.slice(0, 65000),
        ...(opts.text === undefined ? {} : { text: opts.text.slice(0, 65000) }),
      },
    });
  }

  /* ---------------------------------------------------------------- dispatches */

  async dispatchWorkflow(workflow: string, ref: string, inputs: Record<string, string>): Promise<void> {
    await this.send("POST", `${this.base}/actions/workflows/${workflow}/dispatches`, { ref, inputs });
  }

  /* ------------------------------------------------------------------ contents */

  /** Read a file at a ref. The gates read policy.yaml from the default branch. */
  async fileAtRef(path: string, ref: string): Promise<string | null> {
    try {
      const res = await this.get<{ content?: string; encoding?: string }>(
        `${this.base}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
      );
      if (res.content === undefined) return null;
      return Buffer.from(res.content, (res.encoding as BufferEncoding) ?? "base64").toString("utf8");
    } catch {
      return null;
    }
  }

  async defaultBranch(): Promise<string> {
    const r = await this.get<{ default_branch: string }>(this.base);
    return r.default_branch;
  }
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  return (e.stderr ?? e.stdout ?? e.message ?? String(err)).toString().trim();
}

/* ----------------------------------------------------------------- API shapes */

export interface PullResponse {
  readonly number: number;
  readonly draft: boolean;
  readonly head: { readonly sha: string; readonly repo: { readonly full_name: string } | null };
  readonly base: { readonly ref: string; readonly repo: { readonly full_name: string } };
  readonly user: { readonly login: string; readonly type: string };
  readonly author_association: string;
  readonly labels: readonly { readonly name: string }[];
  readonly mergeable_state?: string;
}

export interface PullFile {
  readonly filename: string;
  readonly status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  readonly previous_filename?: string;
}

export interface ReviewResponse {
  readonly user: { readonly login: string; readonly type: string } | null;
  readonly author_association: string;
  readonly state: string;
  readonly submitted_at: string;
  readonly commit_id: string;
}

import { spawn } from "node:child_process";

/**
 * Run a command with something on its stdin.
 *
 * `promisify(execFile)` has no `input` option — only the *Sync* variants and
 * `spawn` do. Passing one is silently ignored, so `gh api --input -` sat
 * waiting on a stdin that was never written and the proxy eventually returned
 * "Reading the request body timed out". Every POST, PATCH and PUT with a body
 * went out empty, `reportCheck` included, which is how every gate tells
 * GitHub its verdict. A cast on the options object had hidden the type error.
 */
function execWithInput(
  file: string,
  args: readonly string[],
  opts: {
    readonly env: NodeJS.ProcessEnv;
    /** Written to the child's stdin, which is then closed. */
    readonly input: string;
    readonly maxBuffer: number;
    /** Killed after this long. Default fifteen minutes. */
    readonly timeoutMs?: number;
  },
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    // A child that waits on stdin forever would hold a workflow job open
    // until the job's own limit, which is the whole budget rather than one
    // request. Nothing here reads stdin after the body.
    let killed = false;
    const timer = setTimeout(
      () => {
        killed = true;
        child.kill("SIGKILL");
        // Rejected here rather than waiting for `close`: that fires only once
        // every stdio pipe is closed, and a killed shell can leave a child
        // holding one open, which would make the timeout itself hang.
        reject(new Error(`${file} did not finish in time and was killed`));
      },
      opts.timeoutMs ?? 15 * 60 * 1000,
    );
    let stdout = "";
    let stderr = "";
    let overflow = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      if (stdout.length + d.length > opts.maxBuffer) overflow = true;
      else stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d.slice(0, 8192);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Already rejected by the timeout; a settled promise ignores this.
      if (killed) return;
      if (overflow) reject(new Error(`output exceeded ${opts.maxBuffer} bytes`));
      else if (code === 0) resolve({ stdout });
      else reject(Object.assign(new Error(stderr.trim() || `${file} exited ${String(code)}`), { stderr }));
    });
    // EPIPE if the child exits before reading it all, which is not an error
    // here: it already has what it needs, or it failed for its own reasons.
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input);
  });
}

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
  /** How long a single `gh` call may take. Default fifteen minutes. */
  readonly timeoutMs?: number;
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

  /** The `owner/repo` this client acts on. */
  get repo(): string {
    return this.opts.repo;
  }

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
      const { stdout } = await execWithInput("gh", args, {
        env: this.env(),
        input: "",
        maxBuffer: 64 * 1024 * 1024,
        ...(this.opts.timeoutMs === undefined ? {} : { timeoutMs: this.opts.timeoutMs }),
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
      const { stdout } = await execWithInput("gh", args, {
        env: this.env(),
        input: body === undefined ? "" : JSON.stringify(body),
        maxBuffer: 16 * 1024 * 1024,
        ...(this.opts.timeoutMs === undefined ? {} : { timeoutMs: this.opts.timeoutMs }),
      });
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

  /**
   * Mark a draft PR ready for review. REST has no endpoint for it, so this is
   * the one GraphQL call the runner makes.
   */
  async markReady(number: number): Promise<void> {
    const pr = await this.pull(number);
    if (!pr.draft || pr.node_id === undefined) return;
    await this.send("POST", "graphql", {
      query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
      variables: { id: pr.node_id },
    });
  }

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

  /** The check runs on a commit: name and conclusion, which is what the gates record. */
  async checkRunsFor(sha: string): Promise<readonly { name: string; conclusion: string | null }[]> {
    const r = await this.get<{ check_runs: { name: string; conclusion: string | null }[] }>(
      `${this.base}/commits/${sha}/check-runs?per_page=100`,
    );
    return r.check_runs.map((c) => ({ name: c.name, conclusion: c.conclusion }));
  }

  /** Report a gate's verdict as a check run, which is what a required check reads. */
  async reportCheck(opts: {
    readonly name: string;
    readonly headSha: string;
    /** "pending" leaves the check in progress (yellow): it waits on something, nothing is wrong. */
    readonly conclusion: "success" | "failure" | "neutral" | "skipped" | "pending";
    readonly title: string;
    readonly summary: string;
    readonly text?: string;
  }): Promise<void> {
    await this.send("POST", `${this.base}/check-runs`, {
      name: opts.name,
      head_sha: opts.headSha,
      ...(opts.conclusion === "pending"
        ? { status: "in_progress" }
        : { status: "completed", conclusion: opts.conclusion, completed_at: new Date().toISOString() }),
      output: {
        title: opts.title,
        // GitHub caps the summary at 65535 characters.
        summary: opts.summary.slice(0, 65000),
        ...(opts.text === undefined ? {} : { text: opts.text.slice(0, 65000) }),
      },
    });
  }

  /* ---------------------------------------------------------------- dispatches */

  /**
   * Start a workflow. With no ref, it runs on the repository's default branch.
   *
   * Seven callers used to pass a literal "main", so on any repository whose
   * default branch is anything else every dispatch the factory made failed.
   */
  async dispatchWorkflow(workflow: string, ref: string | undefined, inputs: Record<string, string>): Promise<void> {
    const on = ref ?? (await this.defaultBranch());
    await this.send("POST", `${this.base}/actions/workflows/${workflow}/dispatches`, { ref: on, inputs });
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

  async openPull(opts: {
    readonly title: string;
    readonly head: string;
    readonly base: string;
    readonly body: string;
  }): Promise<{ readonly number: number; readonly html_url: string }> {
    return this.send<{ number: number; html_url: string }>(`POST`, `${this.base}/pulls`, {
      title: opts.title,
      head: opts.head,
      base: opts.base,
      body: opts.body,
    });
  }

  /** The signed-in user, for recording who contributed. */
  async viewer(): Promise<string | null> {
    try {
      const r = await this.get<{ login?: string }>("user");
      return r.login ?? null;
    } catch {
      return null;
    }
  }
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  return (e.stderr ?? e.stdout ?? e.message ?? String(err)).toString().trim();
}

/* ----------------------------------------------------------------- API shapes */

export interface PullResponse {
  readonly number: number;
  readonly node_id?: string;
  readonly draft: boolean;
  readonly head: { readonly sha: string; readonly repo: { readonly full_name: string } | null };
  readonly base: { readonly ref: string; readonly repo: { readonly full_name: string } };
  readonly user: { readonly login: string; readonly type: string };
  readonly author_association: string;
  readonly labels: readonly { readonly name: string }[];
  /**
   * These four are only populated when a single PR is fetched, not in a list
   * response, and `mergeable` is null while GitHub is still computing it.
   */
  readonly mergeable_state?: string;
  readonly mergeable?: boolean | null;
  readonly updated_at?: string;
  readonly auto_merge?: unknown;
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

/**
 * The association to judge trust by. GitHub reports a private member of the
 * repo's organization as NONE or CONTRIBUTOR, even an owner, so an
 * association alone turns away the very people who own the repo. Where it
 * does not already grant trust, the person's actual permission on the repo
 * decides: write or above counts as a collaborator.
 */
export async function effectiveAssociation(
  gh: { repo: string; get<T>(path: string): Promise<T> },
  login: string,
  association: string,
  trusted: readonly string[],
): Promise<string> {
  if (trusted.includes(association) || /\[bot\]$/.test(login) || login === "" || login === "unknown") return association;
  try {
    const r = await gh.get<{ permission?: string; role_name?: string }>(
      `repos/${gh.repo}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    const p = r.role_name ?? r.permission ?? "none";
    return ["admin", "maintain", "write"].includes(p) ? "COLLABORATOR" : association;
  } catch {
    return association;
  }
}

/**
 * setup-world.ts — everything outside the process that a setup step touches, behind one interface.
 *
 * WHY THIS EXISTS
 *
 * The logic of each setup step used to be shell inside a workflow file: fetch
 * a branch, copy files, decide what failed, start the next workflow. Shell in
 * YAML cannot be run by a test, so none of it was ever tested, and a mistake
 * in it was only found by running setup on a real repository and waiting.
 *
 * The logic now lives in the runner (`setup-steps.ts`, `setup-pr.ts`), and
 * the things it needs from outside are listed here as one interface,
 * `SetupWorld`. On GitHub the interface is backed by the real services. In
 * the tests it is backed by a temporary git repository and plain objects, so
 * one test can walk the whole of setup with no model and no GitHub.
 *
 * KEY TERMS
 *
 *   - Record store: small JSON files on the factory's data ref
 *     (`refs/factory/data`). The setup record and the settings queue live
 *     there. `updateJson` reads, changes and writes one file as one step, so
 *     two jobs writing at once do not lose each other's change.
 *   - State branch: the git branch `factory/setup-state`. Each step saves
 *     what it produced under `.factory/setup-state/` on that branch, so a
 *     step started tomorrow can read what an earlier step wrote.
 *   - Remote: where the state branch and the pull request branch are pushed.
 *     On GitHub it is the repository's URL with the App's token in it. In a
 *     test it is the path of a bare git repository on disk.
 *   - Runner command: another `bsf` subcommand, run as its own process (for
 *     example `bsf sandbox trial`). The steps call those the same way the
 *     workflow shell used to.
 *
 * EXPORTS
 *
 *   - RunResult, SetupPull, SetupWorld: the interface.
 *   - Git: git commands in one checkout, with the remote's token kept out of
 *     every message.
 *   - STATE_BRANCH, STATE_DIR: the branch and the folder on it.
 *   - githubWorld: the real implementation, for use inside GitHub Actions.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DataRefStore } from "../lib/dataref.js";
import { GitHub } from "../lib/github.js";

/** The branch every setup step saves to. */
export const STATE_BRANCH = "factory/setup-state";

/** The folder on that branch that holds what the steps produced. */
export const STATE_DIR = ".factory/setup-state";

/** What a process returned. */
export interface RunResult {
  /** The exit code. Zero is success. */
  readonly code: number;
  /** Everything it printed, standard output first, then standard error. */
  readonly out: string;
}

/** The open setup pull request. */
export interface SetupPull {
  readonly number: number;
  readonly branch: string;
}

/** Everything outside the process that a setup step reads or changes. */
export interface SetupWorld {
  /** The checkout the step runs in. */
  readonly root: string;
  /** A scratch folder that is not in the checkout. */
  readonly temp: string;
  /** The repository's default branch. */
  readonly defaultBranch: string;
  /** The page of the run this step is part of, or null outside GitHub. */
  readonly runUrl: string | null;
  /** Git in the checkout, with the remote the branches are pushed to. */
  readonly git: Git;
  /** The current time as an ISO timestamp. */
  now(): string;
  /** Read one JSON file from the record store. Null when it does not exist. */
  readJson<T>(path: string): Promise<T | null>;
  /** Read, change and write one JSON file in the record store as one step. */
  updateJson<T, R>(path: string, step: (current: T | null) => { readonly next: T; readonly result: R }, message: string): Promise<R>;
  /** Start a workflow on the default branch. */
  dispatch(workflow: string, inputs?: Readonly<Record<string, string>>): Promise<void>;
  /** Open an issue with this title unless one is already open. */
  openIssueOnce(title: string, body: string): Promise<void>;
  /** Run another runner command and return what it printed. `env` is added to this process's environment. */
  bsf(args: readonly string[], env?: Readonly<Record<string, string>>): Promise<RunResult>;
  /** The open pull request whose branch starts with `factory/setup-`, or null. */
  findSetupPull(): Promise<SetupPull | null>;
  /** Open a pull request and return its number. */
  createPull(opts: { readonly title: string; readonly head: string; readonly base: string; readonly body: string }): Promise<number>;
  /** Replace a pull request's title and body. */
  updatePull(number: number, opts: { readonly title: string; readonly body: string }): Promise<void>;
  /** Add a comment to a pull request. */
  commentOnPull(number: number, body: string): Promise<void>;
  /** Print one line for the job log. */
  say(line: string): void;
  /** Set a step output that later steps in the job can read. */
  output(name: string, value: string): void;
  /** Add markdown to the job's summary page. */
  summary(markdown: string): void;
}

/**
 * Git commands in one checkout.
 *
 * Every message this class produces has the remote replaced by the words
 * "the repository", because on GitHub the remote is a URL with a token in it.
 */
export class Git {
  /**
   * cwd: the checkout the commands run in.
   * remote: where branches are fetched from and pushed to.
   */
  constructor(readonly cwd: string, readonly remote: string) {}

  /**
   * Run git and return what happened, without throwing.
   *
   * args: the arguments after `git`.
   * Returns the exit code and the combined output, with the remote redacted.
   */
  try(args: readonly string[]): RunResult {
    const done = spawnSync(
      "git",
      ["-c", "user.name=factory[bot]", "-c", "user.email=factory[bot]@users.noreply.github.com", "-c", "core.autocrlf=false", ...args],
      { cwd: this.cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    return { code: done.status ?? 1, out: this.redact(`${done.stdout ?? ""}${done.stderr ?? ""}`) };
  }

  /**
   * Run git and return its output, or throw when it failed.
   *
   * args: the arguments after `git`.
   */
  must(args: readonly string[]): string {
    const done = this.try(args);
    if (done.code !== 0) throw new Error(`git ${this.redact(args.join(" "))} failed:\n${done.out.trim()}`);
    return done.out;
  }

  /**
   * The contents of one file at a commit, exactly as stored.
   *
   * ref: a commit, branch or other revision.
   * path: the file's path from the repository root.
   * Returns the bytes, or null when the file or the revision does not exist.
   */
  bytesAt(ref: string, path: string): Buffer | null {
    const done = spawnSync("git", ["cat-file", "blob", `${ref}:${path}`], { cwd: this.cwd, maxBuffer: 256 * 1024 * 1024 });
    return done.status === 0 ? done.stdout : null;
  }

  /**
   * Copy a folder as it is at a commit into a folder on disk.
   *
   * ref: a commit, branch or other revision.
   * prefix: the folder inside the repository, such as `.factory/setup-state`.
   * dest: where to write it. Paths under `dest` keep the prefix, so the
   * result has the same layout as a checkout.
   * Returns how many files were written. Zero when the folder is not there.
   */
  exportTree(ref: string, prefix: string, dest: string): number {
    const listed = this.try(["ls-tree", "-r", "--name-only", "-z", ref, "--", prefix]);
    if (listed.code !== 0) return 0;
    let written = 0;
    for (const path of listed.out.split("\0").filter((p) => p !== "")) {
      const bytes = this.bytesAt(ref, path);
      if (bytes === null) continue;
      const target = join(dest, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      written += 1;
    }
    return written;
  }

  /**
   * Fetch the state branch from the remote.
   *
   * Returns the local name of what was fetched, or null when the branch does
   * not exist on the remote yet.
   */
  fetchState(): string | null {
    const tracking = `refs/remotes/origin/${STATE_BRANCH}`;
    const done = this.try(["fetch", "--quiet", this.remote, `+${STATE_BRANCH}:${tracking}`]);
    return done.code === 0 ? tracking : null;
  }

  /**
   * Delete the state branch on the remote, so a new setup starts from nothing.
   *
   * A branch left by an earlier setup would otherwise make the new one think
   * a step was already saved, or that its recipe was already booted.
   * Returns true when there was a branch and it was deleted.
   */
  dropState(): boolean {
    if (this.fetchState() === null) return false;
    return this.try(["push", "--quiet", this.remote, `:refs/heads/${STATE_BRANCH}`]).code === 0;
  }

  /**
   * Put the checkout on the state branch as the remote has it.
   *
   * When the remote has no such branch yet, the branch starts from whatever
   * is checked out now.
   * Returns the folder that holds the saved files.
   */
  openState(): string {
    const tracking = this.fetchState();
    if (tracking === null) this.must(["checkout", "--quiet", "-B", STATE_BRANCH]);
    else this.must(["checkout", "--quiet", "-B", STATE_BRANCH, tracking]);
    const dir = join(this.cwd, STATE_DIR);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Commit what changed under the state folder and push it.
   *
   * message: the commit message.
   * Returns false when nothing changed. Two steps push to this branch at the
   * same time (the journey list and the standard rules), so a refused push
   * is retried on top of whatever landed first, up to five times. Throws
   * when the branch still could not be updated.
   */
  saveState(message: string): boolean {
    this.must(["add", "--all", "--", STATE_DIR]);
    if (this.try(["diff", "--cached", "--quiet"]).code === 0) return false;
    this.must(["commit", "--quiet", "-m", message]);
    let last = "";
    for (let i = 1; i <= 5; i++) {
      const pushed = this.try(["push", "--quiet", this.remote, `HEAD:${STATE_BRANCH}`]);
      if (pushed.code === 0) return true;
      last = pushed.out;
      const tracking = this.fetchState();
      if (tracking !== null && this.try(["rebase", "--quiet", tracking]).code !== 0) this.try(["rebase", "--abort"]);
    }
    throw new Error(`the setup branch could not be updated:\n${last.trim()}`);
  }

  /**
   * Text with the remote taken out.
   *
   * text: anything that might be printed or recorded.
   */
  redact(text: string): string {
    return this.remote === "" ? text : text.split(this.remote).join("the repository");
  }
}

/**
 * The real world, for a step running inside GitHub Actions.
 *
 * root: the checkout the step runs in.
 * Returns null when `GITHUB_REPOSITORY` is not set, which means this process
 * is not in Actions and has no repository to act on. The App's token is read
 * from `GH_TOKEN` and is never printed.
 */
export function githubWorld(root: string): SetupWorld | null {
  const repo = process.env["GITHUB_REPOSITORY"];
  if (repo === undefined || repo === "") return null;
  const gh = new GitHub({ repo });
  const store = new DataRefStore(gh);
  const token = process.env["GH_TOKEN"] ?? "";
  // A test, or a person debugging, can point the branches at another remote.
  const remote = process.env["BSF_SETUP_REMOTE"] ?? `https://x-access-token:${token}@github.com/${repo}.git`;
  const server = process.env["GITHUB_SERVER_URL"] ?? "https://github.com";
  const runId = process.env["GITHUB_RUN_ID"];
  const cli = process.argv[1] ?? "";
  return {
    root,
    temp: process.env["RUNNER_TEMP"] ?? join(root, ".factory-tmp"),
    defaultBranch: process.env["DEFAULT_BRANCH"] ?? process.env["GITHUB_REF_NAME"] ?? "main",
    runUrl: runId === undefined ? null : `${server}/${repo}/actions/runs/${runId}`,
    git: new Git(root, remote),
    now: () => new Date().toISOString(),
    readJson: async <T>(path: string) => {
      const text = await store.read(path);
      return text === null ? null : (JSON.parse(text) as T);
    },
    updateJson: (path, step, message) => store.updateJson(path, step, message),
    dispatch: (workflow, inputs = {}) => gh.dispatchWorkflow(workflow, undefined, { ...inputs }),
    openIssueOnce: async (title, body) => {
      const open = await gh.get<{ title: string }[]>(`repos/${repo}/issues?state=open&per_page=100`);
      if (open.some((issue) => issue.title === title)) return;
      await gh.send("POST", `repos/${repo}/issues`, { title, body });
    },
    bsf: (args, env = {}) =>
      new Promise<RunResult>((resolve) => {
        // Printed as it arrives, so a boot that takes minutes is not a silent
        // job log, and kept, so the step can record why it failed.
        const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, ...env } });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          process.stdout.write(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          process.stderr.write(chunk);
        });
        child.on("error", (err) => resolve({ code: 1, out: `${out}${err.message}` }));
        child.on("close", (code) => resolve({ code: code ?? 1, out }));
      }),
    findSetupPull: async () => {
      const open = await gh.get<{ number: number; head: { ref: string } }[]>(`repos/${repo}/pulls?state=open&per_page=100`);
      const ours = open.filter((p) => p.head.ref.startsWith("factory/setup-")).sort((a, b) => a.number - b.number)[0];
      return ours === undefined ? null : { number: ours.number, branch: ours.head.ref };
    },
    createPull: async (opts) => (await gh.send<{ number: number }>("POST", `repos/${repo}/pulls`, opts)).number,
    updatePull: async (number, opts) => {
      await gh.send("PATCH", `repos/${repo}/pulls/${number}`, opts);
    },
    commentOnPull: async (number, body) => {
      await gh.send("POST", `repos/${repo}/issues/${number}/comments`, { body });
    },
    say: (line) => process.stdout.write(`${line}\n`),
    output: (name, value) => {
      const file = process.env["GITHUB_OUTPUT"];
      if (file === undefined) {
        process.stdout.write(`${name}=${value}\n`);
        return;
      }
      // The multi-line form, so a value with line breaks does not break the file.
      const mark = `__bsf_${Math.random().toString(36).slice(2)}`;
      appendFileSync(file, `${name}<<${mark}\n${value}\n${mark}\n`);
    },
    summary: (markdown) => {
      const file = process.env["GITHUB_STEP_SUMMARY"];
      if (file !== undefined && existsSync(dirname(file))) appendFileSync(file, `${markdown}\n`);
    },
  };
}

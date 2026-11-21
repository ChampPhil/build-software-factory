import type { GitHub } from "./github.js";
import type { Loader } from "./config.js";

/**
 * Read and write the factory's data refs.
 *
 * The factory's own files live at `refs/factory/data` and `refs/factory/media`
 * — refs outside `refs/heads/`, so they are not branches, do not appear in the
 * branch list, and a push to them starts no `push` workflow (doc 07). A team
 * CI that runs `on: push` would otherwise run on every factory write.
 *
 * Everything here goes through the Git Data API rather than `git push`,
 * because the workflows that write data have no checkout of the data ref and
 * a GitHub App token cannot push to a ref it has no checkout for.
 *
 * One commit per write, with the parent read at the start of the write: if
 * another writer moved the ref in between, the update is rejected and the
 * caller retries against the new head. Refs are updated without force, so a
 * concurrent write is never silently overwritten.
 */

export const DATA_REF = "refs/factory/data";
export const MEDIA_REF = "refs/factory/media";

interface RefResponse {
  readonly object: { readonly sha: string };
}
interface CommitResponse {
  readonly sha: string;
  readonly tree: { readonly sha: string };
}
interface TreeResponse {
  readonly sha: string;
  readonly truncated?: boolean;
  readonly tree: readonly TreeEntry[];
}
interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string | null;
  readonly size?: number;
}
interface BlobResponse {
  readonly content: string;
  readonly encoding: string;
}

/** A file to write, or — with `content: null` — to delete. */
export interface Change {
  readonly path: string;
  readonly content: string | null;
  /** "base64": content is already base64 (an image, a clip), stored as its bytes. */
  readonly encoding?: "utf8" | "base64";
}

export class RefMoved extends Error {
  constructor(public readonly ref: string) {
    super(`${ref} moved while this write was in flight`);
    this.name = "RefMoved";
  }
}

export class DataRefStore implements Loader {
  constructor(
    private readonly gh: GitHub,
    private readonly ref: string = DATA_REF,
  ) {}

  /** The commit the ref points at, or null when the ref does not exist yet. */
  async head(): Promise<string | null> {
    try {
      const r = await this.gh.get<RefResponse>(`${this.base}/git/ref/${this.shortRef}`);
      return r.object.sha;
    } catch {
      return null;
    }
  }

  private get base(): string {
    // Spelled out rather than left to gh's `{owner}/{repo}` placeholders,
    // which resolve from the checkout's git remote: the data-writing
    // workflows do not all have one.
    return `repos/${this.gh.repo}`;
  }

  private get shortRef(): string {
    return this.ref.replace(/^refs\//, "");
  }

  /** Every path on the ref, or the subset under a prefix. */
  async list(prefix = ""): Promise<readonly string[]> {
    const head = await this.head();
    if (head === null) return [];
    const tree = await this.treeOf(head);
    const paths = tree.tree.filter((e) => e.type === "blob").map((e) => e.path);
    // A tree over GitHub's entry limit comes back truncated. Saying so beats
    // silently returning a short list that a caller would read as "no more".
    if (tree.truncated === true) {
      throw new Error(
        `${this.ref} has more entries than one tree listing returns. ` +
          `Run the monthly rollup squash, or read a narrower prefix.`,
      );
    }
    return prefix === "" ? paths : paths.filter((p) => p.startsWith(prefix));
  }

  /** One file's text, or null when it is not on the ref. */
  async read(path: string): Promise<string | null> {
    const head = await this.head();
    const text = head === null ? null : await this.readAt(head, path);
    this.lastRead.set(path, text);
    return text;
  }

  /**
   * What this store last read at a path: the base a caller's change was made
   * from, so a write can be merged with whatever landed in between rather
   * than overwrite it. Undefined when this store never read it.
   */
  baseOf(path: string): string | null | undefined {
    return this.lastRead.get(path);
  }

  /** Record what a commit wrote, as the base for this store's next change. */
  wrote(path: string, text: string | null): void {
    this.lastRead.set(path, text);
  }

  private readonly lastRead = new Map<string, string | null>();

  /** One file's text as of a given commit on this ref. */
  async readAt(commit: string, path: string): Promise<string | null> {
    const tree = await this.treeOf(commit);
    const entry = tree.tree.find((e) => e.path === path && e.type === "blob");
    if (entry?.sha === undefined || entry.sha === null) return null;
    const cached = this.blobs.get(entry.sha);
    if (cached !== undefined) return cached;
    const blob = await this.gh.get<BlobResponse>(`${this.base}/git/blobs/${entry.sha}`);
    const text = blob.encoding !== "base64" ? blob.content : Buffer.from(blob.content, "base64").toString("utf8");
    this.blobs.set(entry.sha, text);
    return text;
  }

  // Commits and blobs never change once written, so one command reads each
  // at most once. Without this every read cost four API calls, and a rollup
  // reading every run and work item ran an App installation out of its hourly
  // limit. The ref's head is still read each time: other writers move it.
  private readonly trees = new Map<string, Promise<TreeResponse>>();
  private readonly blobs = new Map<string, string>();

  private treeOf(commit: string): Promise<TreeResponse> {
    let t = this.trees.get(commit);
    if (t === undefined) {
      t = (async () => {
        const c = await this.gh.get<CommitResponse>(`${this.base}/git/commits/${commit}`);
        return this.gh.get<TreeResponse>(`${this.base}/git/trees/${c.tree.sha}?recursive=1`);
      })();
      t.catch(() => this.trees.delete(commit));
      this.trees.set(commit, t);
    }
    return t;
  }

  /**
   * Write a set of files as one commit. Throws RefMoved if another writer got
   * there first, so the caller can re-read and retry rather than clobber.
   */
  async commit(changes: readonly Change[], message: string): Promise<string> {
    if (changes.length === 0) throw new Error("nothing to commit");
    const parent = await this.head();

    const entries: Record<string, unknown>[] = [];
    for (const c of changes) {
      if (c.content === null) {
        // A null sha on an existing path removes it from the new tree.
        entries.push({ path: c.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const blob = await this.gh.send<{ sha: string }>("POST", `${this.base}/git/blobs`, {
        // Binary content arrives base64 already. Encoding it again stored
        // every screenshot as base64 text, which no browser can show.
        content: c.encoding === "base64" ? c.content : Buffer.from(c.content, "utf8").toString("base64"),
        encoding: "base64",
      });
      entries.push({ path: c.path, mode: "100644", type: "blob", sha: blob.sha });
    }

    const base = parent === null ? undefined : (await this.treeOf(parent)).sha;
    const tree = await this.gh.send<{ sha: string }>("POST", `${this.base}/git/trees`, {
      tree: entries,
      ...(base === undefined ? {} : { base_tree: base }),
    });

    const commit = await this.gh.send<{ sha: string }>("POST", `${this.base}/git/commits`, {
      message,
      tree: tree.sha,
      parents: parent === null ? [] : [parent],
    });

    if (parent === null) {
      await this.gh.send("POST", `${this.base}/git/refs`, {
        ref: this.ref,
        sha: commit.sha,
      });
      return commit.sha;
    }

    try {
      await this.gh.send("PATCH", `${this.base}/git/refs/${this.shortRef}`, {
        sha: commit.sha,
        force: false,
      });
    } catch (err) {
      // Without force, GitHub rejects an update whose parent is no longer the
      // head. That is the concurrent-write case, not a failure of this write.
      const current = await this.head();
      if (current !== parent) throw new RefMoved(this.ref);
      throw err;
    }
    return commit.sha;
  }

  /** Write files, re-reading and reapplying once if another writer intervened. */
  async commitWithRetry(
    build: () => Promise<readonly Change[]>,
    message: string,
    attempts = 4,
  ): Promise<string> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.commit(await build(), message);
      } catch (err) {
        if (!(err instanceof RefMoved)) throw err;
        lastError = err;
        // Back off a little: concurrent writers are rollup, intake and the
        // end-of-run step, and they finish in well under a second.
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
      }
    }
    throw lastError;
  }

  /**
   * Replace the ref with a single parentless commit holding exactly the paths
   * given, reusing their existing blobs. This is how the media ref is bounded
   * (doc 07): deleting a file in a child commit leaves its blob reachable from
   * history, so the repository keeps paying for it. A parentless commit drops
   * the history, and with it everything not listed.
   *
   * Force is correct and necessary here: the new commit is deliberately not a
   * descendant of the old head. It is only ever used on the media ref.
   */
  async replaceWith(keep: readonly string[], message: string): Promise<string> {
    const head = await this.head();
    if (head === null) throw new Error(`${this.ref} does not exist`);
    const tree = await this.treeOf(head);
    const bySha = new Map(tree.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));

    const entries = keep.map((path) => {
      const sha = bySha.get(path);
      if (sha === undefined || sha === null) throw new Error(`${path} is not on ${this.ref}`);
      return { path, mode: "100644", type: "blob", sha };
    });

    // No base_tree: the new tree is exactly these entries and nothing else.
    const newTree = await this.gh.send<{ sha: string }>("POST", `${this.base}/git/trees`, {
      tree: entries,
    });
    const commit = await this.gh.send<{ sha: string }>("POST", `${this.base}/git/commits`, {
      message,
      tree: newTree.sha,
      parents: [],
    });
    await this.gh.send("PATCH", `${this.base}/git/refs/${this.shortRef}`, {
      sha: commit.sha,
      force: true,
    });
    return commit.sha;
  }

  /** Read and parse a JSON file, or null when it is absent. */
  async readJson<T>(path: string): Promise<T | null> {
    const text = await this.read(path);
    return text === null ? null : (JSON.parse(text) as T);
  }
}

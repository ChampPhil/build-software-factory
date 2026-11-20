import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { DataRefStore } from "../src/lib/dataref.js";
import type { GitHub } from "../src/lib/github.js";

/**
 * A GitHub that answers only the Git Data API's documented paths and rejects
 * anything else. The store once updated its ref at `git/<ref>` instead of
 * `git/refs/<ref>`, so the first write created the ref and every later write
 * failed with a 404 — on every user's repo, and in no test, because no test
 * checked a path against the real API's shape.
 */
function fakeGitHub(repo = "o/r") {
  const base = `repos/${repo}`;
  const blobs = new Map<string, string>();
  const trees = new Map<string, { path: string; sha: string }[]>();
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const refs = new Map<string, string>();
  const calls: string[] = [];
  const sha = (x: unknown) => createHash("sha1").update(JSON.stringify(x) + Math.random()).digest("hex");

  const get = async <T>(path: string): Promise<T> => {
    calls.push(`GET ${path}`);
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^${base}/git/ref/(.+)$`).exec(path))) {
      const s = refs.get(`refs/${m[1]}`);
      if (s === undefined) throw new Error("Not Found (HTTP 404)");
      return { object: { sha: s } } as T;
    }
    if ((m = new RegExp(`^${base}/git/commits/([0-9a-f]+)$`).exec(path))) {
      const c = commits.get(m[1] ?? "");
      if (c === undefined) throw new Error("Not Found (HTTP 404)");
      return { tree: { sha: c.tree }, parents: c.parents.map((p) => ({ sha: p })) } as T;
    }
    if ((m = new RegExp(`^${base}/git/trees/([0-9a-f]+)\\?recursive=1$`).exec(path))) {
      // GitHub's response carries the tree's own sha, which the store uses as
      // the base of the next tree.
      return { sha: m[1], tree: (trees.get(m[1] ?? "") ?? []).map((e) => ({ ...e, type: "blob", mode: "100644" })) } as T;
    }
    if ((m = new RegExp(`^${base}/git/blobs/([0-9a-f]+)$`).exec(path))) {
      return { content: Buffer.from(blobs.get(m[1] ?? "") ?? "").toString("base64"), encoding: "base64" } as T;
    }
    throw new Error(`not a GitHub endpoint: GET ${path}`);
  };

  const send = async <T>(method: string, path: string, body: Record<string, unknown>): Promise<T> => {
    calls.push(`${method} ${path}`);
    if (method === "POST" && path === `${base}/git/blobs`) {
      const s = sha(body);
      blobs.set(s, Buffer.from(String(body["content"]), "base64").toString("utf8"));
      return { sha: s } as T;
    }
    if (method === "POST" && path === `${base}/git/trees`) {
      const baseTree = typeof body["base_tree"] === "string" ? trees.get(body["base_tree"]) ?? [] : [];
      const entries = new Map(baseTree.map((e) => [e.path, e]));
      for (const e of body["tree"] as { path: string; sha: string | null }[]) {
        if (e.sha === null) entries.delete(e.path);
        else entries.set(e.path, { path: e.path, sha: e.sha });
      }
      const s = sha(body);
      trees.set(s, [...entries.values()]);
      return { sha: s } as T;
    }
    if (method === "POST" && path === `${base}/git/commits`) {
      const s = sha(body);
      commits.set(s, { tree: String(body["tree"]), parents: body["parents"] as string[] });
      return { sha: s } as T;
    }
    if (method === "POST" && path === `${base}/git/refs`) {
      const ref = String(body["ref"]);
      if (!/^refs\/.+\/.+/.test(ref)) throw new Error("ref must be fully qualified");
      if (refs.has(ref)) throw new Error("Reference already exists (HTTP 422)");
      refs.set(ref, String(body["sha"]));
      return {} as T;
    }
    const patch = new RegExp(`^${base}/git/refs/(.+)$`).exec(path);
    if (method === "PATCH" && patch) {
      const ref = `refs/${patch[1]}`;
      if (!refs.has(ref)) throw new Error("Not Found (HTTP 404)");
      refs.set(ref, String(body["sha"]));
      return {} as T;
    }
    throw new Error(`not a GitHub endpoint: ${method} ${path}`);
  };

  return { gh: { repo, get, send } as unknown as GitHub, calls, refs };
}

describe("the factory's data ref, against the Git Data API's real paths", () => {
  it("can be written more than once", async () => {
    const { gh, calls } = fakeGitHub();
    const store = new DataRefStore(gh);
    await store.commit([{ path: "a.json", content: "1" }], "first");
    await store.commit([{ path: "b.json", content: "2" }], "second");
    await store.commit([{ path: "a.json", content: "3" }], "third");
    expect(await store.read("a.json")).toBe("3");
    expect(await store.read("b.json")).toBe("2");
    // Created once, then updated at git/refs/<ref>.
    expect(calls.filter((c) => c.startsWith("POST") && c.endsWith("/git/refs"))).toHaveLength(1);
    expect(calls.filter((c) => c === "PATCH repos/o/r/git/refs/factory/data")).toHaveLength(2);
  });
});

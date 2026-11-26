import { describe, it, expect } from "vitest";
import { DataRefStore } from "../src/lib/dataref.js";
import type { GitHub } from "../src/lib/github.js";

/** A GitHub that answers the ref lookup and one tree, and counts the lookups. */
function fake() {
  const seen: string[] = [];
  const gh = {
    repo: "o/r",
    get: async (path: string) => {
      seen.push(path);
      if (path.includes("/git/ref/")) return { object: { sha: "c1" } };
      if (path.includes("/git/commits/")) return { tree: { sha: "t1" } };
      if (path.includes("/git/trees/")) return { sha: "t1", truncated: false, tree: [{ path: "a.json", type: "blob", sha: "b1" }] };
      if (path.includes("/git/blobs/")) return { content: Buffer.from("{}").toString("base64"), encoding: "base64" };
      return {};
    },
  } as unknown as GitHub;
  return { gh, refLookups: () => seen.filter((p) => p.includes("/git/ref/")).length };
}

describe("DataRefStore.pin (fix 2)", () => {
  it("looks the ref up once for many reads while pinned", async () => {
    const { gh, refLookups } = fake();
    const store = new DataRefStore(gh);
    await store.pin();
    await store.list();
    await store.read("a.json");
    await store.read("a.json");
    expect(refLookups()).toBe(1);
  });

  it("looks it up every time when not pinned", async () => {
    const { gh, refLookups } = fake();
    const store = new DataRefStore(gh);
    await store.list();
    await store.read("a.json");
    expect(refLookups()).toBe(2);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// An in-memory data ref: gardening is tested for what it files, not for the
// Git Data API calls the store makes.
const files = new Map<string, string>();
vi.mock("../src/lib/store.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/store.js")>();
  class FactoryStore {
    async get<T>(p: string): Promise<T | null> {
      const t = files.get(p);
      return t === undefined ? null : (JSON.parse(t) as T);
    }
    async ledger(now: string) {
      return (await this.get(real.LEDGER)) ?? real.emptyLedger(now);
    }
    async put(changes: { path: string; content: string | null }[]) {
      for (const c of changes) {
        if (c.content === null) files.delete(c.path);
        else {
          const schema = real.schemaFor(c.path);
          if (schema !== null) (await import("../src/lib/schema.js")).assertValid(schema, JSON.parse(c.content));
          files.set(c.path, c.content);
        }
      }
      return "sha";
    }
  }
  return { ...real, FactoryStore };
});

const { runGardenCommand, scopeOf, scopesOverlap, filesInBody } = await import("../src/commands/garden.js");
const { LEDGER } = await import("../src/lib/store.js");

const gh = { dispatchWorkflow: vi.fn(async () => undefined) } as never;
const NOW = "2026-11-21T08:00:00Z";
const drift = (problem_class: string, files: string[]) => ({
  kind: "untested_recent_behaviour" as const,
  problem_class,
  occurrences: 1,
  files,
  detail: "found by the gardener",
});

beforeEach(() => files.clear());

describe("gardening scopes", () => {
  it("treats a folder as covering the files under it", () => {
    expect(scopesOverlap(scopeOf(["src/"]), scopeOf(["src/util.js"]))).toBe(true);
    expect(scopesOverlap(scopeOf(["src"]), scopeOf(["src/db.js"]))).toBe(true);
    expect(scopesOverlap(scopeOf(["src/a.js"]), scopeOf(["lib/a.js"]))).toBe(false);
  });

  it("treats an item that names no files as repo-wide", () => {
    expect(scopesOverlap(scopeOf([]), scopeOf(["anything.js"]))).toBe(true);
  });

  it("reads back the files a filed item lists", () => {
    expect(filesInBody("detail\n\nFiles:\n- src/a.js\n- src/b.js")).toEqual(["src/a.js", "src/b.js"]);
  });
});

describe("runGardenCommand", () => {
  it("files one item when tonight's picks all change the same files", async () => {
    // What js-legacy got: five picks, each a different wording of "add the
    // first tests for src/", became five racing PRs.
    const r = await runGardenCommand({
      gh, now: NOW, root: ".", plan: true, scan: false, maxPrs: 5,
      baselines: { schema: "baselines/1", rules: {} },
      extra: [
        drift("add the first test suite for src/", ["src/"]),
        drift("add the repo's first tests and the runner", []),
        drift("tests for src/util.js and src/db.js", ["src/util.js", "src/db.js"]),
        drift("test eslint.config.mjs", ["eslint.config.mjs"]),
      ],
    });
    expect(r.picked.map((p) => p.problem_class)).toEqual([
      "add the first test suite for src/",
      "test eslint.config.mjs",
    ]);
    expect(r.scan.skipped.map((s) => s.reason)).toEqual([
      "overlaps files another gardening item is changing",
      "overlaps files another gardening item is changing",
    ]);
  });

  it("does not file over an open gardening item's files on a later night", async () => {
    await runGardenCommand({
      gh, now: NOW, root: ".", plan: true, scan: false, maxPrs: 5,
      baselines: { schema: "baselines/1", rules: {} },
      extra: [drift("tests for src/util.js", ["src/util.js"])],
    });
    const next = await runGardenCommand({
      gh, now: "2026-11-22T08:00:00Z", root: ".", plan: true, scan: false, maxPrs: 5,
      baselines: { schema: "baselines/1", rules: {} },
      extra: [drift("cover util helpers", ["src/util.js"]), drift("tests for src/db.js", ["src/db.js"])],
    });
    expect(next.picked.map((p) => p.problem_class)).toEqual(["tests for src/db.js"]);
    expect(JSON.parse(files.get(LEDGER)!).open).toHaveLength(2);
  });

  it("does not re-scan when the items were already picked", async () => {
    const r = await runGardenCommand({
      gh, now: NOW, root: "/nonexistent", plan: true, scan: false, maxPrs: 5,
      baselines: { schema: "baselines/1", rules: { r: { count: 2, by_file: { "x.ts": 2 } } } },
      extra: [],
    });
    expect(r.picked).toHaveLength(0);
  });
});

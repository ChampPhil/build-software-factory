import { describe, it, expect } from "vitest";
import {
  MIGRATIONS,
  planMigration,
  applyMigration,
  chainFor,
  majorOf,
  migratedPath,
  schemaSupport,
  diskIo,
  type Migration,
} from "../src/commands/migrate.js";
import { SCHEMA_NAMES } from "../src/lib/schema.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A pretend breaking change, so the machinery can be tested at schema 1.0. */
const renameOwner: Migration = {
  schema: "work-item",
  from: 1,
  to: 2,
  summary: "`owner` became `assignee`",
  up: (doc) => {
    const { owner, ...rest } = doc as { owner?: unknown };
    return { ...rest, schema: "work-item/2", assignee: owner ?? null };
  },
};

const splitAgain: Migration = {
  schema: "work-item",
  from: 2,
  to: 3,
  summary: "`assignee` became `assignees`",
  up: (doc) => ({
    ...doc,
    schema: "work-item/3",
    assignees: [(doc as { assignee?: unknown }).assignee].filter((v) => v !== null),
  }),
};

const REG = [renameOwner, splitAgain];
const permissive = () => [] as readonly string[];

function file(path: string, doc: unknown) {
  return { path, text: JSON.stringify(doc) };
}

describe("majorOf", () => {
  it("reads a schema tag", () => {
    expect(majorOf({ schema: "run/2" })).toEqual({ schema: "run", major: 2 });
  });
  it("refuses anything that is not a tag", () => {
    for (const bad of [null, {}, { schema: 3 }, { schema: "run" }, { schema: "run/x" }, { schema: "Run/1" }]) {
      expect(majorOf(bad)).toBeNull();
    }
  });
});

describe("chainFor", () => {
  it("walks every step to the newest major", () => {
    expect(chainFor("work-item", 1, REG).map((m) => m.to)).toEqual([2, 3]);
    expect(chainFor("work-item", 3, REG)).toEqual([]);
  });

  it("stops rather than looping on a registry that cycles", () => {
    const cycle: Migration[] = [
      { ...renameOwner, from: 1, to: 2 },
      { ...renameOwner, from: 2, to: 1 },
    ];
    expect(() => chainFor("work-item", 1, cycle)).toThrow(/does not terminate/);
  });
});

describe("planMigration", () => {
  it("names each file's chain and where it would be written", () => {
    const plan = planMigration([file("data/work-items/wi_A.json", { schema: "work-item/1", owner: "me" })], REG);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      schema: "work-item",
      from: 1,
      to: 3,
      writesTo: "data/work-items/wi_A.v3.json",
    });
    // Both summaries, so a release note can say what happened.
    expect(plan.items[0]!.summary).toContain("assignee");
    expect(plan.items[0]!.summary).toContain("assignees");
  });

  it("calls a file at the newest major current, not unknown", () => {
    const plan = planMigration([file("a.json", { schema: "work-item/3" })], REG);
    expect(plan.current).toEqual(["a.json"]);
    expect(plan.unknown).toEqual([]);
  });

  it("reports a gap in the chain instead of guessing across it", () => {
    // 2 -> 3 exists but 1 -> 2 does not: a release skipped a migration.
    const plan = planMigration([file("a.json", { schema: "work-item/1" })], [splitAgain]);
    expect(plan.items).toEqual([]);
    expect(plan.unknown[0]!.why).toMatch(/no migration from work-item\/1/);
  });

  it("skips a file with no tag and a file that is not JSON", () => {
    const plan = planMigration(
      [file("a.json", { hello: 1 }), { path: "b.json", text: "{oops" }],
      REG,
    );
    expect(plan.items).toEqual([]);
    expect(plan.unknown.map((u) => u.why)).toEqual([
      expect.stringContaining("no `schema` tag"),
      expect.stringContaining("not readable as JSON"),
    ]);
  });

  it("says plainly when a schema name is not one this runner has", () => {
    const plan = planMigration([file("a.json", { schema: "sprockets/1" })], REG);
    expect(plan.unknown[0]!.why).toMatch(/no schema by that name/);
  });

  it("at schema 1.0 the shipped registry has nothing to do", () => {
    const docs = SCHEMA_NAMES.map((n) => file(`${n}.json`, { schema: `${n}/1` }));
    const plan = planMigration(docs);
    expect(plan.items).toEqual([]);
    expect(plan.unknown).toEqual([]);
    expect(plan.current).toHaveLength(SCHEMA_NAMES.length);
  });
});

describe("applyMigration", () => {
  it("writes beside the original and leaves it untouched", () => {
    const written = new Map<string, string>();
    const original = { schema: "work-item/1", owner: "me", title: "t" };
    const plan = planMigration([file("data/wi_A.json", original)], REG);

    const res = applyMigration(plan, {
      read: () => JSON.stringify(original),
      write: (p, t) => void written.set(p, t),
      registry: REG,
      check: permissive,
    });

    expect(res.failed).toEqual([]);
    expect(res.migrated).toEqual([{ from: "data/wi_A.json", to: "data/wi_A.v3.json" }]);
    expect([...written.keys()]).toEqual(["data/wi_A.v3.json"]);
    const out = JSON.parse(written.get("data/wi_A.v3.json")!);
    expect(out).toMatchObject({ schema: "work-item/3", assignees: ["me"], title: "t" });
    expect(out).not.toHaveProperty("owner");
  });

  it("does not write a document the check rejects", () => {
    const written: string[] = [];
    const plan = planMigration([file("a.json", { schema: "work-item/1" })], REG);
    const res = applyMigration(plan, {
      read: () => JSON.stringify({ schema: "work-item/1" }),
      write: (p) => void written.push(p),
      registry: REG,
      check: () => ["/assignees: must be an array of strings"],
    });
    expect(written).toEqual([]);
    expect(res.migrated).toEqual([]);
    expect(res.failed[0]!.why).toContain("must be an array of strings");
  });

  it("the default check is the runner's own validator", () => {
    // A migration whose output claims a major this runner does not know must
    // fail, because no reader in this release could read what it wrote.
    const plan = planMigration([file("a.json", { schema: "work-item/1" })], REG);
    const res = applyMigration(plan, {
      read: () => JSON.stringify({ schema: "work-item/1" }),
      write: () => {
        throw new Error("must not write");
      },
      registry: REG,
    });
    expect(res.migrated).toEqual([]);
    expect(res.failed[0]!.why).toMatch(/unknown major 3/);
  });

  it("one bad file does not stop the rest", () => {
    const written: string[] = [];
    const plan = planMigration(
      [file("good.json", { schema: "work-item/1", owner: "a" }), file("bad.json", { schema: "work-item/1" })],
      REG,
    );
    const res = applyMigration(plan, {
      read: (p) => (p === "bad.json" ? "{broken" : JSON.stringify({ schema: "work-item/1", owner: "a" })),
      write: (p) => void written.push(p),
      registry: REG,
      check: permissive,
    });
    expect(written).toEqual(["good.json".replace(".json", ".v3.json")]);
    expect(res.failed.map((f) => f.path)).toEqual(["bad.json"]);
  });
});

describe("diskIo", () => {
  it("refuses to overwrite, so a second run cannot clobber the first", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-migrate-"));
    const path = join(dir, "a.v2.json");
    diskIo.write(path, "{}\n");
    expect(existsSync(path)).toBe(true);
    expect(() => diskIo.write(path, "{}\n")).toThrow(/never overwrites/);
    expect(readFileSync(path, "utf8")).toBe("{}\n");
  });

  it("creates the directory a migrated file needs", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-migrate-"));
    const path = join(dir, "nested", "deep", "a.v2.json");
    diskIo.write(path, "{}\n");
    expect(readFileSync(path, "utf8")).toBe("{}\n");
  });

  it("reads what the plan was built from", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-migrate-"));
    const path = join(dir, "a.json");
    writeFileSync(path, '{"schema":"work-item/1"}');
    expect(JSON.parse(diskIo.read(path))).toEqual({ schema: "work-item/1" });
  });
});

describe("migratedPath", () => {
  it("adds the major before the extension", () => {
    expect(migratedPath("data/runs/run_A.json", 2)).toBe("data/runs/run_A.v2.json");
  });
  it("leaves a path with no .json alone rather than mangling it", () => {
    expect(migratedPath("data/runs/run_A", 2)).toBe("data/runs/run_A");
  });
});

describe("schemaSupport", () => {
  it("publishes one line per schema, as doc 09 rule 5 requires", () => {
    const support = schemaSupport();
    expect(support.map((s) => s.schema)).toEqual([...SCHEMA_NAMES]);
    for (const s of support) {
      expect(s.writes).toBe(1);
      expect(s.reads).toEqual([1]);
    }
  });

  it("lists every major it can migrate from as one it reads", () => {
    const support = schemaSupport(REG).find((s) => s.schema === "work-item")!;
    expect(support.writes).toBe(3);
    expect(support.reads).toEqual([1, 2, 3]);
  });
});

describe("the shipped registry", () => {
  it("is empty at schema 1.0", () => {
    expect(MIGRATIONS).toEqual([]);
  });

  it("would only ever step one major at a time", () => {
    for (const m of MIGRATIONS) expect(m.to).toBe(m.from + 1);
  });

  it("would only name schemas this runner has", () => {
    for (const m of MIGRATIONS) expect(SCHEMA_NAMES).toContain(m.schema);
  });

  it("would have at most one migration out of any major", () => {
    const seen = new Set<string>();
    for (const m of MIGRATIONS) {
      const key = `${m.schema}/${m.from}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

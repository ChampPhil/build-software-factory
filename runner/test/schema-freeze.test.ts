import { describe, it, expect } from "vitest";
import {
  surfaceForDocument,
  surfaceForDirectory,
  compareSurface,
  readFrozen,
  type Surface,
} from "../src/commands/schema-freeze.js";
import { SCHEMA_DIR } from "../src/lib/schema.js";
import { join } from "node:path";
import { existsSync } from "node:fs";

function one(doc: unknown): Surface {
  return { "x.json": surfaceForDocument(doc) };
}

const base = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "id"],
  properties: {
    schema: { const: "x/1" },
    id: { type: "string", pattern: "^x_" },
    note: { type: "string", maxLength: 100 },
    kind: { type: "string", enum: ["a", "b"] },
    count: { type: "integer", minimum: 0 },
  },
};

function drifts(after: unknown) {
  return compareSurface(one(base), one(after));
}

function kinds(after: unknown) {
  return drifts(after).map((d) => `${d.kind} ${d.pointer} ${d.what}`);
}

describe("surfaceForDocument", () => {
  it("records each node's shape by pointer", () => {
    const s = surfaceForDocument(base);
    expect(s["/"]).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["id", "schema"],
      properties: ["count", "id", "kind", "note", "schema"],
    });
    expect(s["/properties/id"]).toEqual({ type: "string", pattern: "^x_" });
    expect(s["/properties/kind"]).toEqual({ type: "string", enum: ['"a"', '"b"'] });
  });

  it("does not walk into enum members or const values", () => {
    const s = surfaceForDocument(base);
    expect(Object.keys(s).some((k) => k.includes("/enum/"))).toBe(false);
    expect(Object.keys(s).some((k) => k.includes("/const"))).toBe(false);
  });

  it("escapes a property name containing a slash", () => {
    const s = surfaceForDocument({ properties: { "a/b": { type: "string" } } });
    expect(s["/properties/a~1b"]).toEqual({ type: "string" });
  });

  it("sorts a union type so key order never looks like a change", () => {
    const a = surfaceForDocument({ type: ["string", "null"] });
    const b = surfaceForDocument({ type: ["null", "string"] });
    expect(a["/"]).toEqual(b["/"]);
  });
});

describe("compareSurface — breaking", () => {
  it("an optional field becoming required", () => {
    const after = { ...base, required: ["schema", "id", "note"] };
    expect(kinds(after)).toEqual(["breaking / `note` became required"]);
  });

  it("a property removed, reported once and not again as a lost node", () => {
    const props = { ...base.properties } as Record<string, unknown>;
    delete props["note"];
    expect(kinds({ ...base, properties: props })).toEqual([
      "breaking /properties/note property removed",
    ]);
  });

  it("a type change", () => {
    const after = { ...base, properties: { ...base.properties, count: { type: "string" } } };
    expect(kinds(after)).toContain("breaking /properties/count type was integer, is string");
  });

  it("a pattern change, because the direction is not decidable", () => {
    const after = { ...base, properties: { ...base.properties, id: { type: "string", pattern: "^y_" } } };
    expect(kinds(after)).toEqual(["breaking /properties/id pattern changed"]);
  });

  it("an enum member removed", () => {
    const after = { ...base, properties: { ...base.properties, kind: { type: "string", enum: ["a"] } } };
    expect(kinds(after)).toEqual(['breaking /properties/kind enum member `"b"` removed']);
  });

  it("an enum added where anything used to be legal", () => {
    const after = { ...base, properties: { ...base.properties, note: { type: "string", maxLength: 100, enum: ["x"] } } };
    expect(kinds(after)).toContain("breaking /properties/note enum added where any value used to be legal");
  });

  it("additionalProperties closing", () => {
    const open = { ...base, additionalProperties: true };
    const closing = compareSurface(one(open), one(base));
    expect(closing.map((d) => d.kind)).toEqual(["breaking"]);
  });

  it("a bound tightening in either direction", () => {
    const tighterMax = { ...base, properties: { ...base.properties, note: { type: "string", maxLength: 50 } } };
    expect(kinds(tighterMax)).toEqual(["breaking /properties/note maxLength was 100, is 50"]);
    const tighterMin = { ...base, properties: { ...base.properties, count: { type: "integer", minimum: 1 } } };
    expect(kinds(tighterMin)).toEqual(["breaking /properties/count minimum was 0, is 1"]);
  });

  it("a bound appearing where there was none", () => {
    const after = { ...base, properties: { ...base.properties, id: { type: "string", pattern: "^x_", maxLength: 8 } } };
    expect(kinds(after)).toEqual(["breaking /properties/id maxLength added (8)"]);
  });

  it("a $ref repointed", () => {
    const was = { properties: { a: { $ref: "_common.json#/$defs/runId" } } };
    const now = { properties: { a: { $ref: "_common.json#/$defs/workItemId" } } };
    expect(compareSurface(one(was), one(now)).map((d) => d.kind)).toEqual(["breaking"]);
  });

  it("a schema file disappearing", () => {
    expect(compareSurface(one(base), {})).toEqual([
      { file: "x.json", pointer: "/", kind: "breaking", what: "the schema file is gone" },
    ]);
  });
});

describe("compareSurface — additive and widening", () => {
  it("a new optional property is additive, reported once", () => {
    const after = { ...base, properties: { ...base.properties, extra: { type: "string" } } };
    expect(kinds(after)).toEqual(["additive /properties/extra new property"]);
  });

  it("a required field becoming optional is additive", () => {
    const after = { ...base, required: ["schema"] };
    expect(kinds(after)).toEqual(["additive / `id` is no longer required"]);
  });

  it("a bound loosening or disappearing is additive", () => {
    const looser = { ...base, properties: { ...base.properties, note: { type: "string", maxLength: 500 } } };
    expect(kinds(looser)).toEqual(["additive /properties/note maxLength was 100, is 500"]);
    const gone = { ...base, properties: { ...base.properties, note: { type: "string" } } };
    expect(kinds(gone)).toEqual(["additive /properties/note maxLength removed"]);
  });

  it("tells two enum members apart when they are objects, not strings", () => {
    // Recorded as JSON: String() on each would make every object member
    // "[object Object]", so swapping one for another would look like no
    // change at all.
    const was = { enum: [{ a: 1 }, { b: 2 }] };
    const now = { enum: [{ a: 1 }, { b: 3 }] };
    const d = compareSurface(one(was), one(now)).map((x) => `${x.kind} ${x.what}`);
    expect(d).toEqual(["breaking enum member `{\"b\":2}` removed", "widening enum member `{\"b\":3}` added"]);
  });

  it("a new enum member is widening, not additive", () => {
    // This is the `cost_source: unknown` case: new data is legal that a
    // reader on the frozen major rejects, so it is called out on its own.
    const after = { ...base, properties: { ...base.properties, kind: { type: "string", enum: ["a", "b", "c"] } } };
    expect(kinds(after)).toEqual(['widening /properties/kind enum member `"c"` added']);
  });

  it("a new schema file is additive", () => {
    expect(compareSurface({}, one(base)).map((d) => `${d.kind} ${d.what}`)).toEqual([
      "additive new schema file",
    ]);
  });
});

describe("the frozen 1.0 surface", () => {
  const frozenPath = join(SCHEMA_DIR, "SURFACE.json");

  it("is committed", () => {
    expect(existsSync(frozenPath)).toBe(true);
  });

  it("records major 1", () => {
    expect(readFrozen(frozenPath).schema_major).toBe(1);
  });

  it("matches the live schemas with no breaking drift", () => {
    const drift = compareSurface(readFrozen(frozenPath).surface, surfaceForDirectory(SCHEMA_DIR));
    expect(drift.filter((d) => d.kind === "breaking")).toEqual([]);
  });

  it("matches the live schemas exactly, so a re-freeze is never silently needed", () => {
    const drift = compareSurface(readFrozen(frozenPath).surface, surfaceForDirectory(SCHEMA_DIR));
    expect(drift).toEqual([]);
  });

  it("covers every schema file, SURFACE.json itself excluded", () => {
    const frozen = readFrozen(frozenPath).surface;
    expect(Object.keys(frozen)).toContain("_common.json");
    expect(Object.keys(frozen)).not.toContain("SURFACE.json");
  });
});

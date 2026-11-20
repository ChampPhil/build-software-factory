import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const schema = JSON.parse(readFileSync(join(ROOT, "schema/factory.json"), "utf8")) as Record<string, unknown>;

type Node = { $ref?: string; properties?: Record<string, Node>; additionalProperties?: Node | boolean };

function deref(n: Node): Node {
  let cur = n;
  while (cur.$ref?.startsWith("#/") === true) {
    let x: unknown = schema;
    for (const k of cur.$ref.slice(2).split("/")) x = (x as Record<string, unknown>)[k];
    cur = x as Node;
  }
  return cur;
}

function resolves(path: readonly string[]): boolean {
  let node = schema as Node;
  for (const part of path) {
    node = deref(node);
    const next = node.properties?.[part];
    if (next !== undefined) node = next;
    else if (typeof node.additionalProperties === "object")
      node = node.additionalProperties;
    else return false;
  }
  return true;
}

describe("factory.yaml settings the CLI reads", () => {
  it("every one is a path the schema lets a user set", () => {
    // The schema forbids unknown keys, so a read of a path it does not define
    // always gets undefined and falls back to a hardcoded default — a setting
    // that looks configurable and is not. Thirteen of these had accumulated.
    const cli = readFileSync(join(ROOT, "runner/src/cli.ts"), "utf8");
    const reads = new Set<string>();
    for (const m of cli.matchAll(/\bcfg((?:\??\.[a-z_]+|\?\.\["[a-z_]+"\])+)/g)) {
      const path = (m[1] ?? "").replace(/\?/g, "").replace(/\["([a-z_]+)"\]/g, ".$1").split(".").filter(Boolean);
      reads.add(path.join("."));
    }
    expect(reads.size).toBeGreaterThan(5);
    const unreachable = [...reads].filter((p) => !resolves(p.split(".")));
    expect(unreachable, "read by the CLI but impossible to set in factory.yaml").toEqual([]);
  });
});

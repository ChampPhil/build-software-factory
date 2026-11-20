import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isSchemaFile } from "../lib/schema.js";
import { join } from "node:path";

/**
 * The schema freeze (doc 09, rules 1 and 2).
 *
 * Rule 1 says an additive change keeps the major version; rule 2 says a
 * breaking change bumps it and ships a migration. Nothing enforced that: a
 * one-line edit making an optional field required is a breaking change that
 * looks exactly like a typo fix in review, and every file already written
 * would stop validating.
 *
 * So the shape of every schema at the frozen major is recorded in
 * `schema/SURFACE.json`, and `bsf schema-surface --check` compares the live
 * schemas against it. Additive drift is reported and allowed. Breaking drift
 * fails, naming the pointer and what changed, so the author either undoes it
 * or does what rule 2 asks: bump the major and write the migration.
 */

/** What is remembered about one node, by JSON pointer. */
export interface NodeSurface {
  readonly type?: string;
  readonly properties?: readonly string[];
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly enum?: readonly string[];
  readonly const?: string;
  readonly pattern?: string;
  readonly ref?: string;
  /** Bounds, kept because tightening one invalidates data that was legal. */
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export type Surface = Record<string, Record<string, NodeSurface>>;

const BOUNDS = ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const;
/** A tighter value of these is breaking; a looser one is additive. */
const TIGHTENS_UPWARD = new Set(["minimum", "minLength", "minItems"]);

function surfaceOf(node: unknown): NodeSurface | null {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return null;
  const n = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (typeof n["type"] === "string") out["type"] = n["type"];
  else if (Array.isArray(n["type"])) out["type"] = [...(n["type"] as string[])].sort().join("|");

  if (typeof n["properties"] === "object" && n["properties"] !== null) {
    out["properties"] = Object.keys(n["properties"]).sort();
  }
  if (Array.isArray(n["required"])) out["required"] = [...(n["required"] as string[])].sort();
  if (typeof n["additionalProperties"] === "boolean") out["additionalProperties"] = n["additionalProperties"];
  if (Array.isArray(n["enum"])) {
    out["enum"] = (n["enum"] as unknown[]).map((v) => JSON.stringify(v) ?? "undefined").sort();
  }
  // A const may be any JSON value, so it is recorded as JSON: String() on an
  // object gives "[object Object]" for every one of them, and two different
  // consts would then look identical.
  if (n["const"] !== undefined) out["const"] = JSON.stringify(n["const"]);
  if (typeof n["pattern"] === "string") out["pattern"] = n["pattern"];
  if (typeof n["$ref"] === "string") out["ref"] = n["$ref"];
  for (const b of BOUNDS) if (typeof n[b] === "number") out[b] = n[b];

  return Object.keys(out).length === 0 ? null : (out);
}

/** Every node of one schema document, by pointer. */
export function surfaceForDocument(doc: unknown): Record<string, NodeSurface> {
  const nodes: Record<string, NodeSurface> = {};

  const walk = (node: unknown, pointer: string): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${pointer}/${i}`));
      return;
    }
    const s = surfaceOf(node);
    if (s !== null) nodes[pointer === "" ? "/" : pointer] = s;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      // `enum` members and `const` are values, not sub-schemas.
      if (key === "enum" || key === "const" || key === "examples") continue;
      walk(child, `${pointer}/${escapePointer(key)}`);
    }
  };

  walk(doc, "");
  return nodes;
}

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function surfaceForDirectory(dir: string): Surface {
  const out: Surface = {};
  for (const file of readdirSync(dir).filter(isSchemaFile).sort()) {
    out[file] = surfaceForDocument(JSON.parse(readFileSync(join(dir, file), "utf8")));
  }
  return out;
}

export interface Drift {
  readonly file: string;
  readonly pointer: string;
  readonly what: string;
  readonly kind: "breaking" | "additive" | "widening";
}

/**
 * Compare a live surface against the frozen one.
 *
 * `breaking` means data already written would stop validating, or a field a
 * reader relies on is gone. `widening` means new data is legal that an older
 * reader would reject — adding an enum member is the case that comes up — and
 * is called out separately rather than waved through as additive, because
 * doc 09's "readers ignore fields they don't know" covers unknown *fields*,
 * not unknown values of a field they do know.
 */
export function compareSurface(frozen: Surface, live: Surface): readonly Drift[] {
  const drift: Drift[] = [];
  const add = (file: string, pointer: string, kind: Drift["kind"], what: string) =>
    void drift.push({ file, pointer: pointer === "/" ? "/" : pointer, kind, what });

  for (const [file, frozenNodes] of Object.entries(frozen)) {
    const liveNodes = live[file];
    if (liveNodes === undefined) {
      add(file, "/", "breaking", "the schema file is gone");
      continue;
    }
    for (const [pointer, was] of Object.entries(frozenNodes)) {
      const now = liveNodes[pointer];
      if (now === undefined) {
        add(file, pointer, "breaking", "the node is gone");
        continue;
      }
      compareNode(file, pointer, was, now, add);
    }
    for (const pointer of Object.keys(liveNodes)) {
      if (frozenNodes[pointer] === undefined) add(file, pointer, "additive", "new node");
    }
  }
  for (const file of Object.keys(live)) {
    if (frozen[file] === undefined) add(file, "/", "additive", "new schema file");
  }

  // A removed or added property already explains every node beneath it; two
  // lines for one edit reads like two problems.
  const explained = drift
    .filter((d) => d.what === "property removed" || d.what === "new property")
    .map((d) => `${d.file}${d.pointer}`);
  return drift.filter((d) => {
    if (d.what !== "the node is gone" && d.what !== "new node") return true;
    const key = `${d.file}${d.pointer}`;
    return !explained.some((e) => key === e || key.startsWith(`${e}/`));
  });
}

function compareNode(
  file: string,
  pointer: string,
  was: NodeSurface,
  now: NodeSurface,
  add: (file: string, pointer: string, kind: Drift["kind"], what: string) => void,
): void {
  if (was.type !== now.type) {
    add(file, pointer, "breaking", `type was ${was.type ?? "unset"}, is ${now.type ?? "unset"}`);
  }
  if (was.ref !== now.ref) {
    add(file, pointer, "breaking", `$ref was ${was.ref ?? "unset"}, is ${now.ref ?? "unset"}`);
  }
  if (was.pattern !== now.pattern) {
    // Direction is not decidable from two regexes, so it is breaking.
    add(file, pointer, "breaking", "pattern changed");
  }
  if (was.const !== now.const) {
    add(file, pointer, "breaking", `const was ${was.const ?? "unset"}, is ${now.const ?? "unset"}`);
  }

  const at = pointer === "/" ? "" : pointer;
  for (const gone of (was.properties ?? []).filter((p) => !(now.properties ?? []).includes(p))) {
    add(file, `${at}/properties/${gone}`, "breaking", "property removed");
  }
  for (const fresh of (now.properties ?? []).filter((p) => !(was.properties ?? []).includes(p))) {
    add(file, `${at}/properties/${fresh}`, "additive", "new property");
  }

  for (const req of (now.required ?? []).filter((r) => !(was.required ?? []).includes(r))) {
    add(file, pointer, "breaking", `\`${req}\` became required`);
  }
  for (const opt of (was.required ?? []).filter((r) => !(now.required ?? []).includes(r))) {
    add(file, pointer, "additive", `\`${opt}\` is no longer required`);
  }

  if (was.additionalProperties !== now.additionalProperties) {
    const closed = now.additionalProperties === false;
    add(
      file,
      pointer,
      closed ? "breaking" : "additive",
      `additionalProperties was ${String(was.additionalProperties)}, is ${String(now.additionalProperties)}`,
    );
  }

  if (was.enum !== undefined || now.enum !== undefined) {
    const before = was.enum ?? [];
    const after = now.enum ?? [];
    if (was.enum !== undefined && now.enum === undefined) {
      add(file, pointer, "additive", "enum removed, so more values are legal");
    } else if (was.enum === undefined) {
      add(file, pointer, "breaking", "enum added where any value used to be legal");
    } else {
      for (const gone of before.filter((v) => !after.includes(v))) {
        add(file, pointer, "breaking", `enum member \`${gone}\` removed`);
      }
      for (const fresh of after.filter((v) => !before.includes(v))) {
        add(file, pointer, "widening", `enum member \`${fresh}\` added`);
      }
    }
  }

  for (const b of BOUNDS) {
    const before = was[b];
    const after = now[b];
    if (before === after) continue;
    if (before === undefined) {
      add(file, pointer, "breaking", `${b} added (${String(after)})`);
    } else if (after === undefined) {
      add(file, pointer, "additive", `${b} removed`);
    } else {
      const tighter = TIGHTENS_UPWARD.has(b) ? after > before : after < before;
      add(
        file,
        pointer,
        tighter ? "breaking" : "additive",
        `${b} was ${before}, is ${after}`,
      );
    }
  }
}

export interface FrozenFile {
  readonly frozen_at: string;
  readonly schema_major: number;
  readonly note: string;
  readonly surface: Surface;
}

export function readFrozen(path: string): FrozenFile {
  return JSON.parse(readFileSync(path, "utf8")) as FrozenFile;
}

export function writeFrozen(path: string, surface: Surface, frozenAt: string, major = 1): void {
  const doc: FrozenFile = {
    frozen_at: frozenAt,
    schema_major: major,
    note:
      "The shape of every schema at the frozen major. `bsf schema-surface --check` compares " +
      "the live schemas against this and fails on a breaking change. Regenerate with " +
      "`bsf schema-surface --freeze` only alongside an additive change, or alongside a major " +
      "bump that ships a migration in `bsf migrate`.",
    surface,
  };
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

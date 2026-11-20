import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_NAMES, validate, checkSchemaTag, type SchemaName } from "../lib/schema.js";

/**
 * `bsf migrate` — moving data across a breaking schema change (doc 09).
 *
 * Four rules from doc 09 shape all of this:
 *
 * 1. A new optional field keeps the major version, so most releases need no
 *    migration at all.
 * 2. A breaking change bumps the major and ships a migration here.
 * 3. **Old data is never rewritten in place.** A migration writes the new file
 *    next to the old one, and both are readable for at least twelve months.
 * 4. Config migrations arrive as a definition PR, so a human approves them —
 *    they are not applied by this command.
 *
 * Rule 3 is the one that shapes the code: a migration that edited files in
 * place would leave a half-migrated data ref if it failed in the middle, and
 * the data ref is the only record of what the factory has done.
 */

/** A migration from one major to the next, for one schema. */
export interface Migration {
  readonly schema: SchemaName;
  readonly from: number;
  readonly to: number;
  /** What changed, in a line, for the release notes and the PR body. */
  readonly summary: string;
  /** Pure: takes the old document, returns the new one. */
  readonly up: (doc: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * The registry. Empty at 1.0, which is the point: every schema is at major 1
 * and nothing has broken yet.
 *
 * It is not dead code. It is the shape a migration has to take, with the
 * machinery around it tested, so the first breaking change is a function and
 * a test rather than a scramble — and so `bsf migrate` can say "nothing to
 * do" with authority rather than because nobody wrote it yet.
 */
export const MIGRATIONS: readonly Migration[] = [];

export interface PlanItem {
  readonly path: string;
  readonly schema: string;
  readonly from: number;
  readonly to: number;
  readonly writesTo: string;
  readonly summary: string;
}

export interface MigratePlan {
  readonly items: readonly PlanItem[];
  readonly unknown: readonly { readonly path: string; readonly tag: string; readonly why: string }[];
  readonly current: readonly string[];
}

/** The major a path's document is at, from its own tag. */
export function majorOf(doc: unknown): { schema: string; major: number } | null {
  const tag = (doc as { schema?: unknown } | null)?.schema;
  if (typeof tag !== "string") return null;
  const m = /^([a-z-]+)\/(\d+)$/.exec(tag);
  if (m === null) return null;
  return { schema: m[1] as string, major: Number(m[2]) };
}

/** Where a migrated file is written: alongside the original, never over it. */
export function migratedPath(path: string, to: number): string {
  return path.replace(/\.json$/, `.v${to}.json`);
}

export function planMigration(
  files: readonly { readonly path: string; readonly text: string }[],
  registry: readonly Migration[] = MIGRATIONS,
): MigratePlan {
  const items: PlanItem[] = [];
  const unknown: { path: string; tag: string; why: string }[] = [];
  const current: string[] = [];

  for (const file of files) {
    let doc: unknown;
    try {
      doc = JSON.parse(file.text);
    } catch {
      unknown.push({ path: file.path, tag: "", why: "not readable as JSON" });
      continue;
    }
    const tagged = majorOf(doc);
    if (tagged === null) {
      unknown.push({ path: file.path, tag: "", why: "no `schema` tag, so its shape is not known" });
      continue;
    }

    const chain = chainFor(tagged.schema, tagged.major, registry);
    if (chain.length === 0) {
      const known = SCHEMA_NAMES.includes(tagged.schema as SchemaName);
      if (!known) {
        unknown.push({
          path: file.path,
          tag: `${tagged.schema}/${tagged.major}`,
          why: "this runner has no schema by that name",
        });
      } else if (newestMajor(tagged.schema, registry) === tagged.major) {
        current.push(file.path);
      } else {
        unknown.push({
          path: file.path,
          tag: `${tagged.schema}/${tagged.major}`,
          // A gap in the chain is worth naming: it means a migration was
          // skipped in a release, and guessing across it would corrupt data.
          why: `no migration from ${tagged.schema}/${tagged.major} to the version this runner writes`,
        });
      }
      continue;
    }

    const last = chain[chain.length - 1]!;
    items.push({
      path: file.path,
      schema: tagged.schema,
      from: tagged.major,
      to: last.to,
      writesTo: migratedPath(file.path, last.to),
      summary: chain.map((m) => m.summary).join("; "),
    });
  }

  return { items, unknown, current };
}

/** Every migration needed to get from `major` to the newest, in order. */
export function chainFor(
  schema: string,
  major: number,
  registry: readonly Migration[] = MIGRATIONS,
): readonly Migration[] {
  const chain: Migration[] = [];
  let at = major;
  for (;;) {
    const next = registry.find((m) => m.schema === schema && m.from === at);
    if (next === undefined) return chain;
    chain.push(next);
    at = next.to;
    // A cycle would mean a registry mistake; stopping beats looping.
    if (chain.length > 32) throw new Error(`migration chain for ${schema} does not terminate`);
  }
}

function newestMajor(schema: string, registry: readonly Migration[] = MIGRATIONS): number {
  return registry.filter((m) => m.schema === schema).reduce((a, m) => Math.max(a, m.to), 1);
}

export interface MigrateResult {
  readonly migrated: readonly { readonly from: string; readonly to: string }[];
  readonly failed: readonly { readonly path: string; readonly why: string }[];
}

/** Everything `applyMigration` touches outside itself. */
export interface MigrateIo {
  readonly read: (path: string) => string;
  readonly write: (path: string, text: string) => void;
  readonly registry?: readonly Migration[];
  /**
   * Checks a migrated document. The default is the runner's own validator,
   * which knows a major only once that major's schema file ships — and a
   * migration ships in the same release as the schema it migrates to, so by
   * the time a migration is in the registry its output is a shape the
   * validator knows. Injectable so the machinery can be tested without
   * inventing a second major in the real schema directory.
   */
  readonly check?: (schema: string, doc: Record<string, unknown>) => readonly string[];
}

function defaultCheck(schema: string, doc: Record<string, unknown>): readonly string[] {
  const name = schema as SchemaName;
  const tag = checkSchemaTag(name, doc);
  if (!tag.ok) return tag.errors.map((e) => e.message);
  const res = validate(name, doc);
  if (!res.ok) return res.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`);
  return [];
}

/**
 * Apply a plan. Each file is checked after migration and before being
 * written, so a migration that produces an invalid document fails loudly
 * rather than writing a file no reader will accept.
 */
export function applyMigration(plan: MigratePlan, io: MigrateIo): MigrateResult {
  const migrated: { from: string; to: string }[] = [];
  const failed: { path: string; why: string }[] = [];
  const registry = io.registry ?? MIGRATIONS;
  const check = io.check ?? defaultCheck;

  for (const item of plan.items) {
    try {
      let doc = JSON.parse(io.read(item.path)) as Record<string, unknown>;
      for (const m of chainFor(item.schema, item.from, registry)) doc = m.up(doc);

      const problems = check(item.schema, doc);
      if (problems.length > 0) {
        failed.push({ path: item.path, why: `the migrated file does not validate: ${problems.join("; ")}` });
        continue;
      }

      io.write(item.writesTo, `${JSON.stringify(doc, null, 2)}\n`);
      migrated.push({ from: item.path, to: item.writesTo });
    } catch (err) {
      failed.push({ path: item.path, why: String(err).slice(0, 200) });
    }
  }
  return { migrated, failed };
}

/** Read and write on disk, for the local case. */
export const diskIo = {
  read: (path: string): string => readFileSync(path, "utf8"),
  write: (path: string, text: string): void => {
    if (existsSync(path)) {
      // Never over an existing file, migrated or not: doc 09's rule is that
      // old data is not rewritten, and a second run must not clobber the
      // first run's output either.
      throw new Error(`${path} already exists; a migration never overwrites`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
};

/* ----------------------------------------------------------- the 1.0 freeze */

/**
 * What this runner reads and writes, which every release has to publish
 * (doc 09, rule 5) so a dashboard can warn about a repo whose runner is older
 * than the oldest version it supports.
 */
export interface SchemaSupport {
  readonly schema: string;
  readonly writes: number;
  readonly reads: readonly number[];
}

export function schemaSupport(registry: readonly Migration[] = MIGRATIONS): readonly SchemaSupport[] {
  return SCHEMA_NAMES.map((schema) => {
    const writes = newestMajor(schema, registry);
    // Everything it can migrate from, it can read.
    const reads = [writes];
    for (let major = writes - 1; major >= 1; major--) {
      if (chainFor(schema, major, registry).length > 0) reads.unshift(major);
    }
    return { schema, writes, reads };
  });
}

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv and ajv-formats are CommonJS. Static imports, so a bundler can follow
// them; Node's interop puts the export on `default`, and some bundler shapes
// nest it once more, so take whichever is a function.
type Ajv2020Type = InstanceType<typeof Ajv2020Module.default>;
const Ajv2020 = typeof Ajv2020Module === "function" ? Ajv2020Module : Ajv2020Module.default;
const addFormats = (
  typeof addFormatsModule === "function" ? addFormatsModule : (addFormatsModule as { default: unknown }).default
) as (ajv: Ajv2020Type) => unknown;
type AjvInstance = Ajv2020Type;

/**
 * Every file the skill, the runner and the dashboard share is validated on
 * every read and write (doc 09). Readers reject a major version they don't know.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from the compiled or source location to find /schema. */
function findSchemaDir(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "schema");
    try {
      if (readdirSync(candidate).some((f) => f === "_common.json")) return candidate;
    } catch {
      /* keep walking */
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`schema directory not found above ${start}`);
}

export const SCHEMA_DIR = findSchemaDir(here);

export type SchemaName =
  | "factory" | "policy" | "role" | "work-item" | "ledger" | "run" | "index"
  | "live" | "baselines" | "coverage" | "candidates" | "rubric" | "review"
  | "step-report" | "rulepack" | "sandbox" | "pr-report";

export const SCHEMA_NAMES: readonly SchemaName[] = [
  "factory", "policy", "role", "work-item", "ledger", "run", "index", "live",
  "baselines", "coverage", "candidates", "rubric", "review",
  "step-report", "rulepack", "sandbox", "pr-report",
] as const;

/** `schema: <name>/<major>` declared by each file. */
export const SCHEMA_MAJOR: Readonly<Record<SchemaName, number>> = Object.freeze(
  Object.fromEntries(SCHEMA_NAMES.map((n) => [n, 1])) as Record<SchemaName, number>,
);

/**
 * Not a schema: the frozen shape of every schema at the current major, used
 * by `bsf schema-surface --check`. It lives beside the schemas so that an
 * author editing one sees it, which means every reader of this directory has
 * to skip it by name.
 */
export const SURFACE_FILE = "SURFACE.json";

export function isSchemaFile(file: string): boolean {
  return file.endsWith(".json") && file !== SURFACE_FILE;
}

function buildAjv(): AjvInstance {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const files = readdirSync(SCHEMA_DIR).filter(isSchemaFile);
  // Register every schema under both its relative filename and its $id, so
  // "_common.json#/$defs/x" style refs resolve without a network fetch.
  for (const file of files) {
    const doc = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as Record<string, unknown>;
    ajv.addSchema(doc, file);
  }
  return ajv;
}

let ajvSingleton: AjvInstance | undefined;
function ajv(): AjvInstance {
  ajvSingleton ??= buildAjv();
  return ajvSingleton;
}

const validators = new Map<SchemaName, ValidateFunction>();

function validatorFor(name: SchemaName): ValidateFunction {
  const cached = validators.get(name);
  if (cached) return cached;
  const got = ajv().getSchema(`${name}.json`);
  if (!got) throw new Error(`schema ${name}.json is not registered`);
  validators.set(name, got);
  return got;
}

export interface ValidationFailure {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly ValidationFailure[] };

function format(errors: readonly ErrorObject[] | null | undefined): ValidationFailure[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath === "" ? "/" : e.instancePath,
    message: `${e.message ?? "invalid"}${
      e.params && Object.keys(e.params).length > 0 ? ` (${JSON.stringify(e.params)})` : ""
    }`,
  }));
}

/** Validate a parsed document against one of the shared schemas. */
export function validate(name: SchemaName, doc: unknown): ValidationResult {
  const v = validatorFor(name);
  if (v(doc)) return { ok: true };
  return { ok: false, errors: format(v.errors) };
}

/**
 * Reject a major version we don't know before validating, so an unreadable
 * file gives a version error rather than a wall of shape errors.
 */
export function checkSchemaTag(name: SchemaName, doc: unknown): ValidationResult {
  if (typeof doc !== "object" || doc === null) {
    return { ok: false, errors: [{ path: "/", message: "not an object" }] };
  }
  const tag = (doc as { schema?: unknown }).schema;
  if (typeof tag !== "string") {
    return { ok: false, errors: [{ path: "/schema", message: "missing schema tag" }] };
  }
  const [tagName, major] = tag.split("/");
  if (tagName !== name) {
    return { ok: false, errors: [{ path: "/schema", message: `expected ${name}/<major>, got ${tag}` }] };
  }
  const known = SCHEMA_MAJOR[name];
  if (Number(major) !== known) {
    return {
      ok: false,
      errors: [{ path: "/schema", message: `unknown major ${major}; this runner reads ${name}/${known}` }],
    };
  }
  return { ok: true };
}

export class SchemaError extends Error {
  constructor(
    readonly schemaName: SchemaName,
    readonly failures: readonly ValidationFailure[],
  ) {
    super(
      `${schemaName} is invalid:\n` +
        failures.map((f) => `  ${f.path}: ${f.message}`).join("\n"),
    );
    this.name = "SchemaError";
  }
}

/** Validate or throw. Used on every read and write. */
export function assertValid<T>(name: SchemaName, doc: unknown): T {
  const tag = checkSchemaTag(name, doc);
  if (!tag.ok) throw new SchemaError(name, tag.errors);
  const res = validate(name, doc);
  if (!res.ok) throw new SchemaError(name, res.errors);
  return doc as T;
}

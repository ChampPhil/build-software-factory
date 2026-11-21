import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import type { Options, ErrorObject } from "ajv";
import type { Ajv2020 as Ajv2020Type } from "ajv/dist/2020.js";

const require_ = createRequire(import.meta.url);
// gh-aw's schema declares draft-07, so it needs ajv's draft-07 validator,
// not the 2020-12 one the factory's own schemas use.
const Ajv = require_("ajv") as { new (opts?: Options): Ajv2020Type };
const addFormats = require_("ajv-formats") as (ajv: Ajv2020Type) => unknown;

/**
 * Validates the seven role workflows against gh-aw's OWN frontmatter schema,
 * vendored from github/gh-aw at the commit in vendor/ghaw-schema-source.txt.
 *
 * This is not `gh aw compile`. The compiler also resolves imports, mints the
 * lock file and runs its own semantic checks, and it remains the only real
 * proof. But the frontmatter schema is what the compiler validates against
 * first, so a workflow that fails here would certainly fail compilation, and
 * one that passes has cleared the largest class of error — an unknown key, a
 * wrong type, a value outside an enum.
 */

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "templates")) && existsSync(join(dir, "runner"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}

const ROOT = repoRoot();
const WORKFLOWS = join(ROOT, "templates/workflows");
const SCHEMA = join(ROOT, "runner/vendor/ghaw-main-workflow-schema.json");

const ROLES = [
  "triage", "spec", "builder", "verifier", "gardener", "hardener", "scorer",
  // The host-access variants (runner/scripts/host-variants.mjs) are compiled too, so they validate too.
  "builder-host", "verifier-host",
] as const;

function frontmatterText(role: string): string {
  const text = readFileSync(join(WORKFLOWS, `factory-role-${role}.md`), "utf8");
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (m?.[1] === undefined) throw new Error(`no frontmatter in ${role}`);
  return m[1];
}

/**
 * gh-aw frontmatter is YAML containing GitHub Actions `${{ }}` expressions in
 * places the schema types as number or boolean. The compiler substitutes those
 * before validating; here they are replaced with a type-correct placeholder so
 * the structure can be checked. A string field keeps its expression.
 */
function loadForValidation(role: string): unknown {
  const raw = frontmatterText(role);
  const doc = parseYaml(raw) as unknown;
  return coerceExpressions(doc);
}

const NUMERIC_KEYS = new Set(["attempt", "pr_number", "of", "max", "timeout-minutes"]);
const BOOLEAN_KEYS = new Set(["staged", "draft", "enabled", "required", "signed-commits"]);

function coerceExpressions(node: unknown, key?: string): unknown {
  if (typeof node === "string" && node.includes("${{")) {
    if (key !== undefined && NUMERIC_KEYS.has(key)) return 1;
    if (key !== undefined && BOOLEAN_KEYS.has(key)) return false;
    return node;
  }
  if (Array.isArray(node)) return node.map((v) => coerceExpressions(v));
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = coerceExpressions(v, k);
    }
    return out;
  }
  return node;
}

function buildValidator(): (doc: unknown) => { ok: boolean; errors: ErrorObject[] } {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,          // gh-aw's schema is not written for ajv strict mode
    validateFormats: false, // it uses formats ajv-formats doesn't define
  });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as Record<string, unknown>;
  const validate = ajv.compile(schema);
  return (doc: unknown) => {
    const ok = validate(doc);
    return { ok, errors: (validate.errors ?? []) };
  };
}

const validate = buildValidator();

function describeErrors(errors: readonly ErrorObject[]): string {
  return errors
    .slice(0, 25)
    .map((e) => `  ${e.instancePath || "/"}: ${e.message ?? ""} ${JSON.stringify(e.params ?? {})}`)
    .join("\n");
}

describe("gh-aw's own frontmatter schema", () => {
  it("is vendored, with the commit it came from recorded", () => {
    expect(existsSync(SCHEMA)).toBe(true);
    const sha = readFileSync(join(ROOT, "runner/vendor/ghaw-schema-source.txt"), "utf8").trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("compiles, so a failure below is the workflow's fault and not the harness's", () => {
    expect(() => buildValidator()).not.toThrow();
  });

  it("rejects a workflow with an unknown top-level key, so these tests can fail", () => {
    const res = validate({ on: { workflow_call: {} }, engine: "claude", not_a_real_gh_aw_key: true });
    expect(res.ok).toBe(false);
  });

  it("rejects a sandbox runtime outside gh-aw's four profiles", () => {
    // Also records what the schema does NOT constrain: `engine` as a bare
    // string is a catalog lookup, not an enum, so gh-aw accepts an unknown
    // engine id here and only fails at compile time. These tests cannot catch
    // a typo'd engine name.
    const bad = validate({
      on: { workflow_call: {} },
      engine: "claude",
      sandbox: { agent: { id: "awf", runtime: "not-a-profile" } },
    });
    expect(bad.ok).toBe(false);

    const unknownEngine = validate({ on: { workflow_call: {} }, engine: "gpt-9-turbo" });
    expect(unknownEngine.ok).toBe(true);
  });

  it("rejects a malformed sandbox mount", () => {
    const res = validate({
      on: { workflow_call: {} },
      engine: "claude",
      sandbox: { agent: { id: "awf", mounts: ["/no-destination"] } },
    });
    expect(res.ok).toBe(false);
  });
});

describe("the seven role workflows validate against it", () => {
  for (const role of ROLES) {
    it(`factory-role-${role}.md`, () => {
      const doc = loadForValidation(role);
      const res = validate(doc);
      if (!res.ok) {
        throw new Error(
          `factory-role-${role}.md does not satisfy gh-aw's frontmatter schema:\n${describeErrors(res.errors)}`,
        );
      }
      expect(res.ok).toBe(true);
    });
  }

  it("covers every role workflow in the templates directory", () => {
    const files = readdirSync(WORKFLOWS).filter((f) => f.startsWith("factory-role-"));
    expect(files).toHaveLength(ROLES.length);
  });
});

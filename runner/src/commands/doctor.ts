import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validate, type SchemaName } from "../lib/schema.js";
import { parseYaml } from "../lib/yaml.js";
import { staleLockFiles } from "./audit.js";
import type { GitHub } from "../lib/github.js";
import { loadManifest } from "./sandbox.js";

/**
 * `bsf doctor` — what is wrong with an installed factory.
 *
 * The skill's repair mode is required to "diagnose first and say what is
 * wrong, before changing anything", because a repair that silently fixes
 * three things teaches the user nothing about their own factory. This is that
 * diagnosis, and it changes nothing by design.
 *
 * It is not `bsf audit`. Audit asks whether something got past the gates on a
 * given commit. This asks whether the factory is installed and intact: the
 * files it needs, the secrets, the variables, the data ref, the workflows and
 * their lock files.
 */

export type Severity = "broken" | "degraded" | "note";

export interface Finding {
  readonly check: string;
  readonly severity: Severity;
  readonly detail: string;
  /** What would put it right. `null` when only a person can. */
  readonly repair: string | null;
}

export interface DoctorReport {
  readonly installed: boolean;
  readonly findings: readonly Finding[];
  readonly checked: readonly string[];
}

/**
 * The roles a factory configures: a model, a role file, a rubric.
 *
 * The conversation is not one of them. It shares triage's model and writes
 * nothing for a rubric to judge, so a factory installed before it existed is
 * not called broken for having no entry. Its compiled workflow is still
 * checked — that check walks the workflows directory rather than this list.
 */
const ROLES = ["triage", "spec", "builder", "verifier", "gardener", "hardener", "scorer"] as const;
type RoleName = (typeof ROLES)[number];
const CONTEXT = ["feature-map.md", "runbook.md", "fundamentals.md", "history.md"] as const;
const TRIGGERS = [
  "factory-intake.yml",
  "factory-run.yml",
  "factory-gates.yml",
  "factory-policy.yml",
  "factory-rollup.yml",
  "factory-merge.yml",
  "factory-garden.yml",
  "factory-audit.yml",
  "factory-conflicts.yml",
  "factory-review.yml",
  "factory-sync.yml",
] as const;

/** Secrets and variables the workflows read. Names only; values are never read. */
/**
 * Used only when no factory workflow is installed yet to read the real list
 * from. Once one is, the requirement is whatever the workflows reference.
 */
const FALLBACK_SECRETS = ["FACTORY_APP_PRIVATE_KEY"] as const;
const FALLBACK_VARS = ["FACTORY_APP_CLIENT_ID"] as const;

/**
 * The secrets and variables the installed factory workflows actually use.
 *
 * Derived rather than listed. A hardcoded list said ANTHROPIC_API_KEY while
 * every role workflow asked for MODEL_API_KEY, which nothing created — so a
 * repo could pass this check and then fail every role job at startup. Reading
 * the workflows means the requirement follows whichever engine each role uses,
 * with no map of engines to key names to keep in step.
 */
export function referencedInWorkflows(root: string): {
  secrets: string[];
  vars: string[];
  optionalVars: string[];
} {
  const dir = join(root, ".github", "workflows");
  const secrets = new Set<string>();
  const required = new Set<string>();
  const seen = new Set<string>();
  if (!existsSync(dir)) return { secrets: [], vars: [], optionalVars: [] };
  for (const f of readdirSync(dir)) {
    if (!/^factory-.*\.(md|ya?ml)$/.test(f) || f.endsWith(".lock.yml")) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      for (const m of line.matchAll(/\$\{\{[^}]*?\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (m[1] !== undefined && m[1] !== "GITHUB_TOKEN") secrets.add(m[1]);
      }
      for (const m of line.matchAll(/\$\{\{[^}]*?\bvars\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const name = m[1];
        if (name === undefined) continue;
        seen.add(name);
        // A variable bound only to an uppercase env name reaches a step that
        // can supply its own default, so its absence is the step's business.
        // Anywhere else — an engine's model, an App's client id, an action's
        // input — an empty string is configuration that is simply wrong.
        const key = /^\s*([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1] ?? "";
        if (!/^[A-Z][A-Z0-9_]*$/.test(key)) required.add(name);
      }
    }
  }
  return {
    secrets: [...secrets].sort(),
    vars: [...required].sort(),
    optionalVars: [...seen].filter((v) => !required.has(v)).sort(),
  };
}

export interface DoctorOptions {
  readonly root: string;
  /** Omitted for a local-only check: everything needing the API is skipped. */
  readonly gh?: GitHub;
  readonly dataRef?: string;
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const findings: Finding[] = [];
  const checked: string[] = [];
  const def = join(opts.root, ".factory/definition");

  const add = (check: string, severity: Severity, detail: string, repair: string | null) =>
    void findings.push({ check, severity, detail, repair });
  const did = (check: string) => void checked.push(check);

  /* ------------------------------------------------- is there a factory here */

  did("definition");
  if (!existsSync(join(def, "factory.yaml"))) {
    // Not a fault. The skill calls this to find out which mode it is in, and
    // "there is no factory here yet" is the answer that means plain setup.
    add(
      "definition",
      "note",
      ".factory/definition/factory.yaml is not there, so this repo has no factory yet",
      "run the setup skill to install one",
    );
    return { installed: false, findings, checked };
  }

  /* ---------------------------------------------------------- the definition */

  for (const [file, schema] of [
    ["factory.yaml", "factory"],
    ["policy.yaml", "policy"],
  ] as const) {
    const path = join(def, file);
    if (!existsSync(path)) {
      add("definition", "broken", `${file} is missing`, "restore it from the template, or re-run setup");
      continue;
    }
    const problem = yamlProblem(path, schema);
    if (problem !== null) {
      add(
        "definition",
        "broken",
        `${file} does not match its schema: ${problem}`,
        // Not repairable without a decision: the file holds the user's own
        // choices, and overwriting it with a template would discard them.
        null,
      );
    }
  }

  // Which roles this factory actually needs, from its own models block
  // rather than from a list here: a role no pipeline uses being absent is
  // not a fault, and the factory decides which those are.
  const config = readYaml(join(def, "factory.yaml"));
  const wantedRoles = rolesOf(config);

  did("roles");
  for (const role of wantedRoles) {
    if (!existsSync(join(def, "roles", `${role}.yaml`))) {
      add(
        "roles",
        // factory.yaml names a model for this role, so something expects to
        // run it; without its config that step fails rather than degrades.
        "broken",
        `roles/${role}.yaml is missing, but factory.yaml gives ${role} a model, so that step cannot run`,
        // Not "drop it from factory.yaml": the schema requires a model for
        // every role, so removing one makes factory.yaml invalid instead.
        "restore it from the template, or re-run setup",
      );
    }
  }

  did("context");
  for (const file of CONTEXT) {
    const path = join(def, "context", file);
    if (!existsSync(path)) {
      add("context", "degraded", `context/${file} is missing`, "re-run setup");
    } else if (readFileSync(path, "utf8").trim() === "") {
      // An empty context file is worse than a missing one: the roles load it
      // and get nothing, and nothing says why their work is poor.
      add("context", "degraded", `context/${file} is empty`, null);
    }
  }

  did("rubrics");
  for (const file of rubricsOf(config)) {
    if (!existsSync(join(def, "rubrics", file))) {
      add("rubrics", "degraded", `rubrics/${file} is missing, so that pipeline cannot be scored`, "re-run setup");
    }
  }

  /* ----------------------------------------------------------- the guardrails */

  did("guardrails");
  for (const [file, schema] of [
    ["baselines.json", "baselines"],
    ["candidates.json", "candidates"],
    ["coverage.json", "coverage"],
  ] as const) {
    const path = join(opts.root, ".factory/guardrails", file);
    if (!existsSync(path)) continue; // Legitimately absent on a clean repo.
    const problem = jsonProblem(path, schema);
    if (problem !== null) {
      add(
        "guardrails",
        "broken",
        `guardrails/${file} does not match its schema: ${problem}`,
        // The gates read these every run; a broken one fails every PR.
        null,
      );
    }
  }

  /* ------------------------------------------------------------- the workflows */

  did("workflows");
  const wf = join(opts.root, ".github/workflows");
  const roleWorkflows = wantedRoles;
  if (!existsSync(wf)) {
    add("workflows", "broken", ".github/workflows is not there", "re-run setup");
  } else {
    const present = new Set(readdirSync(wf));
    for (const file of TRIGGERS) {
      if (!present.has(file)) {
        add("workflows", "broken", `${file} is missing, so that part of the factory never fires`, "re-run setup");
      }
    }
    for (const role of roleWorkflows) {
      if (!present.has(`factory-role-${role}.md`)) {
        add("workflows", "broken", `factory-role-${role}.md is missing`, "re-run setup");
      }
    }
    findings.push(...(await staleLockFiles(opts.root, ".github/workflows")).map(lockFinding));
  }

  /* ------------------------------------------- what only the API can tell us */

  if (opts.gh === undefined) {
    add(
      "remote",
      "note",
      "secrets, variables and the data ref were not checked: no repo was given",
      "re-run with --repo OWNER/REPO",
    );
    return { installed: true, findings, checked };
  }

  const referenced = referencedInWorkflows(opts.root);
  // FACTORY_SANDBOX_ENV carries test-mode keys for sandboxes that need them.
  // Every role that starts a sandbox references it, but it is required only
  // when the manifest actually sources a variable from a secret.
  const needsSandboxSecret = (() => {
    const loaded = loadManifest(opts.root);
    return loaded.kind === "ok" && loaded.manifest.env.some((v) => v.secret !== undefined);
  })();
  // The recompiler App is optional; its credentials are needed only once
  // factory.yaml turns it on. Its workflow checks for them and stands down.
  const recompilerOn = (() => {
    try {
      const doc = parseYaml(readFileSync(join(opts.root, ".factory/definition/factory.yaml"), "utf8")) as {
        recompiler?: { enabled?: boolean };
      };
      return doc.recompiler?.enabled === true;
    } catch {
      return false;
    }
  })();
  const optional = (name: string): boolean =>
    (name === "FACTORY_SANDBOX_ENV" && !needsSandboxSecret) || (name.startsWith("RECOMPILER_APP_") && !recompilerOn);
  const fromWorkflows = referenced.secrets.filter((s) => !optional(s));
  const REQUIRED_SECRETS = fromWorkflows.length > 0 ? fromWorkflows : FALLBACK_SECRETS;
  const requiredVars = referenced.vars.filter((v) => !optional(v));
  const REQUIRED_VARS = requiredVars.length > 0 ? requiredVars : FALLBACK_VARS;

  did("secrets");
  const secretNames = await names(opts.gh, "actions/secrets", (r) => r.secrets);
  if (secretNames === null) {
    add("secrets", "note", "the secret list could not be read; the token may lack the scope", null);
  } else {
    for (const want of REQUIRED_SECRETS) {
      if (!secretNames.includes(want)) {
        add(
          "secrets",
          "broken",
          `the ${want} secret is not set, so every run that needs it fails`,
          // Only the user can: a secret's value must never pass through here.
          null,
        );
      }
    }
  }

  did("variables");
  const varNames = await names(opts.gh, "actions/variables", (r) => r.variables);
  if (varNames === null) {
    add("variables", "note", "the variable list could not be read", null);
  } else {
    for (const want of REQUIRED_VARS) {
      if (!varNames.includes(want)) {
        add("variables", "broken", `the ${want} variable is not set`, "re-run the App setup step");
      }
    }
  }

  did("data ref");
  const ref = opts.dataRef ?? "refs/factory/data";
  const hasRef = await refExists(opts.gh, ref);
  if (hasRef === null) {
    add("data ref", "note", `${ref} could not be checked`, null);
  } else if (!hasRef) {
    add(
      "data ref",
      "degraded",
      `${ref} does not exist yet, so there is no run history to read`,
      // Not broken: the first run creates it.
      "nothing — the first run creates it",
    );
  }

  return { installed: true, findings, checked };
}

function lockFinding(f: { readonly kind: string; readonly detail: string }): Finding {
  return {
    check: "workflows",
    // A stale lock file is the one gh-aw refuses to run, so the role silently
    // never starts. That is broken, not a note.
    severity: "broken",
    detail: f.detail,
    repair: "recompile with gh-aw, or let the recompiler App do it",
  };
}

/** The roles this factory names a model for, in a stable order. */
export function rolesOf(config: unknown): readonly RoleName[] {
  const models = (config as { models?: Record<string, unknown> } | null)?.models;
  if (models === undefined || models === null) return ROLES;
  const named = ROLES.filter((r) => models[r] !== undefined);
  // A factory with an empty or unrecognizable models block is checked against
  // every role rather than against none: silence here would hide a missing
  // role file behind a second mistake.
  return named.length === 0 ? ROLES : named;
}

/** One rubric per configured pipeline, plus the shared one. */
export function rubricsOf(config: unknown): readonly string[] {
  const pipelines = (config as { pipelines?: Record<string, unknown> } | null)?.pipelines;
  const names = pipelines === undefined || pipelines === null ? [] : Object.keys(pipelines);
  const wanted = names.length === 0 ? ["product_work", "gardening", "hardening", "definition"] : names;
  return [...wanted.map((n) => `${n}.yaml`), "shared.yaml"];
}

function readYaml(path: string): unknown {
  try {
    return parseYaml(readFileSync(path, "utf8"));
  } catch {
    // Already reported by the definition check; this one just falls back to
    // checking every role rather than failing twice for the same reason.
    return null;
  }
}

function yamlProblem(path: string, schema: SchemaName): string | null {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    return `could not be parsed (${String(err).slice(0, 120)})`;
  }
  return schemaProblem(schema, doc);
}

function jsonProblem(path: string, schema: SchemaName): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return `is not valid JSON (${String(err).slice(0, 120)})`;
  }
  return schemaProblem(schema, doc);
}

function schemaProblem(schema: SchemaName, doc: unknown): string | null {
  const res = validate(schema, doc);
  if (res.ok) return null;
  return res.errors
    .slice(0, 3)
    .map((e) => `${e.path} ${e.message}`)
    .join("; ");
}

async function names(
  gh: GitHub,
  path: string,
  pick: (r: { secrets?: { name: string }[]; variables?: { name: string }[] }) => { name: string }[] | undefined,
): Promise<readonly string[] | null> {
  try {
    const r = await gh.get<{ secrets?: { name: string }[]; variables?: { name: string }[] }>(
      `repos/${gh.repo}/${path}?per_page=100`,
    );
    return (pick(r) ?? []).map((s) => s.name);
  } catch {
    return null;
  }
}

async function refExists(gh: GitHub, ref: string): Promise<boolean | null> {
  try {
    await gh.get(`repos/${gh.repo}/git/${ref}`);
    return true;
  } catch (err) {
    if (/not found/i.test(String(err))) return false;
    return null;
  }
}

export function formatReport(report: DoctorReport): string {
  if (!report.installed) {
    return report.findings.map((f) => `${f.severity.padEnd(9)} ${f.detail}`).join("\n");
  }
  if (report.findings.length === 0) {
    return `nothing wrong (${report.checked.join(", ")} all checked)`;
  }
  const order: Record<Severity, number> = { broken: 0, degraded: 1, note: 2 };
  const lines = [...report.findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((f) => `${f.severity.padEnd(9)} ${f.check.padEnd(11)} ${f.detail}${f.repair === null ? "" : `\n${" ".repeat(22)}→ ${f.repair}`}`);
  const broken = report.findings.filter((f) => f.severity === "broken").length;
  return [
    ...lines,
    "",
    broken > 0
      ? `${broken} thing(s) broken. Nothing has been changed; fix these before relying on the factory.`
      : "Nothing broken. Nothing has been changed.",
  ].join("\n");
}

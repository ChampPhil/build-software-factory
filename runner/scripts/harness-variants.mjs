#!/usr/bin/env node
/**
 * Derive each agent workflow for a harness other than Claude Code.
 *
 * gh-aw fixes the engine at compile time, so switching harness is not a
 * setting: each role workflow has to be compiled with that engine. The base
 * templates are written for Claude Code; this rewrites their `engine:` block
 * for another harness and adds the harness's engine definition as an import,
 * and CI compiles the result into templates/harness/<id>/compiled. The
 * installer then ships the set that matches factory.yaml's `harness`.
 *
 * The threat-detection scan stays on Claude (Haiku): it is a separate, small
 * job, and a harness's own detection default may need a key the user does
 * not have (Cursor's names Copilot).
 *
 *   node scripts/harness-variants.mjs           write templates/harness/<id>/workflows
 *   node scripts/harness-variants.mjs --check   exit 1 if they are out of date
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOWS = join(ROOT, "templates/workflows");

/** The harnesses with a gh-aw engine definition, keyed by factory.yaml's `harness`. */
export const HARNESSES = {
  "cursor-cli": {
    id: "cursor-cli",
    engine: "cursor",
    definition: join(ROOT, "adapters/cursor-cli.md"),
    shared: "shared/cursor.md",
    // Cursor serves models through its own API, under its own names.
    note: "Cursor runs the model through its own API, so model ids are Cursor's (e.g. auto, sonnet-4.5).",
  },
};

const CLAUDE_ENGINE = /\nengine:\n  id: claude\n  model: \$\{\{ inputs\.model \}\}\n  env:\n(    [^\n]*\n)+/;

export function harnessVariant(source, name, harness) {
  const end = source.indexOf("\n---\n", 4);
  if (!source.startsWith("---\n") || end < 0) throw new Error(`${name}: no frontmatter`);
  let fm = source.slice(0, end + 1);
  const body = source.slice(end + 1);
  if (!CLAUDE_ENGINE.test(fm)) throw new Error(`${name}: no claude engine block to replace`);
  fm = fm.replace(
    CLAUDE_ENGINE,
    "\n# Derived by runner/scripts/harness-variants.mjs for the " + harness.engine + " engine.\n" +
      "engine:\n  id: " + harness.engine + "\n  model: ${{ inputs.model }}\n" +
      "imports:\n  - " + harness.shared + "\n",
  );
  // Detection keeps Claude Haiku; with a different main engine it no longer
  // inherits the main engine's env, so it is given the key itself.
  fm = fm.replace(
    /(\n    engine:\n      id: claude\n      model: claude-haiku-5-5\n      max-turns: 3\n)/,
    "$1      env:\n        ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n",
  );
  // The StepReport names the harness that did the work.
  fm = fm.replace(/run: bsf step-report --role /g, "run: bsf step-report --harness " + harness.id + " --role ");
  return fm + body;
}

export function agentWorkflows() {
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => CLAUDE_ENGINE.test(readFileSync(join(WORKFLOWS, f), "utf8")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [id, h] of Object.entries(HARNESSES)) {
    const out = join(ROOT, "templates/harness", id, "workflows");
    const want = new Map();
    for (const f of agentWorkflows()) want.set(f, harnessVariant(readFileSync(join(WORKFLOWS, f), "utf8"), f, h));
    want.set(h.shared, readFileSync(h.definition, "utf8"));
    for (const [f, text] of want) {
      const path = join(out, f);
      const have = existsSync(path) ? readFileSync(path, "utf8") : null;
      if (have === text) continue;
      if (check) {
        process.stderr.write(`${path} is out of date: run node runner/scripts/harness-variants.mjs\n`);
        stale++;
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
    }
  }
  process.exit(stale > 0 ? 1 : 0);
}

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Every place the runner starts a workflow must pass only inputs that
 * workflow declares, and every required one. GitHub rejects anything else
 * with a 422, at run time, on a user's repo: factory-conflicts dispatched
 * factory-run with `reason`, which it never declared, so no conflicting PR
 * was ever rebuilt (ts-webapp#33).
 */

const SRC = join(__dirname, "..", "src");
const WORKFLOWS = join(__dirname, "..", "..", "templates", "workflows");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

interface Call { file: string; workflow: string; keys: string[] }

/** The top-level keys of the object literal starting at `text[start]` ("{"). */
function topLevelKeys(text: string, start: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let token = "";
  let expectKey = true;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if ("({[".includes(ch)) { depth++; if (depth === 1) { expectKey = true; token = ""; } continue; }
    if (")}]".includes(ch)) {
      depth--;
      if (depth === 0) { if (expectKey && token !== "") keys.push(token); return keys; }
      continue;
    }
    if (depth !== 1) continue;
    if (/[A-Za-z0-9_]/.test(ch)) { if (expectKey) token += ch; continue; }
    if (ch === ":" ) { if (expectKey && token !== "") keys.push(token); expectKey = false; token = ""; continue; }
    if (ch === ",") { if (expectKey && token !== "") keys.push(token); expectKey = true; token = ""; continue; }
    if (!/\s/.test(ch) && expectKey) token = "";
  }
  return keys;
}

function calls(): Call[] {
  const out: Call[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    const re = /dispatchWorkflow\(\s*(?:[\w.?]+\s*\?\?\s*)?"([\w.-]+\.yml)"\s*,[^,]*,\s*\{/g;
    for (const m of text.matchAll(re)) {
      const brace = (m.index ?? 0) + m[0].length - 1;
      out.push({ file: file.slice(SRC.length + 1), workflow: m[1]!, keys: topLevelKeys(text, brace) });
    }
  }
  return out;
}

function declared(workflow: string): { inputs: Record<string, { required?: boolean; default?: unknown }> } | null {
  const doc = parseYaml(readFileSync(join(WORKFLOWS, workflow), "utf8")) as { on?: Record<string, unknown> };
  const on = doc.on ?? {};
  if (!("workflow_dispatch" in on)) return null;
  const wd = (on["workflow_dispatch"] ?? {}) as { inputs?: Record<string, { required?: boolean; default?: unknown }> };
  return { inputs: wd.inputs ?? {} };
}

describe("workflow dispatches from the runner", () => {
  const found = calls();

  it("finds the dispatch sites", () => {
    expect(found.length).toBeGreaterThan(5);
  });

  for (const c of found) {
    it(`${c.file} -> ${c.workflow} { ${c.keys.join(", ")} }`, () => {
      const d = declared(c.workflow);
      expect(d, `${c.workflow} has no workflow_dispatch trigger`).not.toBeNull();
      const names = Object.keys(d!.inputs);
      for (const k of c.keys) expect(names, `${c.workflow} does not declare input ${k}`).toContain(k);
      for (const [name, spec] of Object.entries(d!.inputs)) {
        if (spec.required === true && spec.default === undefined) {
          expect(c.keys, `${c.workflow} requires input ${name}`).toContain(name);
        }
      }
    });
  }
});

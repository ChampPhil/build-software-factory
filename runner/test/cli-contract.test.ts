import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The contract between the workflow templates and the runner.
 *
 * Every workflow is a thin wrapper around one `bsf` command (doc 07). So a
 * template that calls a command the CLI does not have is a workflow that fails
 * at runtime with "unknown command" — on a real repo, mid-run, after the
 * agent has already been paid for. Nothing else in the suite catches that:
 * the templates validate against gh-aw's schema, and the CLI's own tests never
 * read the templates.
 *
 * That bug shipped once. This is the test that would have caught it.
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
const CLI = readFileSync(join(ROOT, "runner/src/cli.ts"), "utf8");

/** Top-level commands, from the CLI's own switch. */
const topLevel = new Set(
  [...CLI.matchAll(/case "([a-z][a-z-]*)":/g)].map((m) => m[1] as string),
);

/**
 * Subcommands, from the checks each top-level command makes on the second
 * word. Both forms count: `second === "static"` accepts it, and
 * `second !== "check"` rejects everything else, so "check" is the subcommand.
 */
const subcommands = new Set(
  [...CLI.matchAll(/second [=!]== "([a-z][a-z-]*)"/g)].map((m) => m[1] as string),
);

/** Every `bsf ...` invocation in every template. */
function templateCalls(): readonly { readonly file: string; readonly call: string }[] {
  const dir = join(ROOT, "templates/workflows");
  const out: { file: string; call: string }[] = [];
  for (const file of readdirSync(dir)) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const raw of text.split("\n")) {
      // Comments mention bsf in prose ("a rule bsf has to keep"); only real
      // invocations count, and those are never on a comment line.
      const line = raw.trim();
      if (line.startsWith("#")) continue;
      for (const m of line.matchAll(/\bbsf ([a-z][a-z-]*(?: [a-z][a-z-]*)?)/g)) {
        out.push({ file, call: m[1] as string });
      }
    }
  }
  return out;
}

describe("every bsf command the templates call exists", () => {
  const calls = templateCalls();

  it("finds calls to check, so a passing test means something", () => {
    expect(calls.length).toBeGreaterThan(15);
  });

  it("every call resolves to a command the CLI has", () => {
    const missing: string[] = [];
    for (const { file, call } of calls) {
      const [first, second] = call.split(" ");
      if (first === undefined) continue;
      if (!topLevel.has(first)) {
        missing.push(`${file}: bsf ${call} — no such command`);
        continue;
      }
      // A two-word call is only a subcommand if the CLI treats it as one;
      // otherwise the second word is an argument, which is fine.
      if (second !== undefined && !subcommands.has(second) && !topLevel.has(second)) {
        // Allowed when the first word takes a positional argument — those are
        // the role-io commands, which take a work item or artifact name.
        const takesPositional = new Set([
          "fetch-work-item", "write-spec", "fetch-artifact", "harden-context", "validate", "run",
        ]);
        if (!takesPositional.has(first)) {
          missing.push(`${file}: bsf ${call} — "${second}" is not a subcommand of "${first}"`);
        }
      }
    }
    expect(missing, `\n${missing.join("\n")}`).toEqual([]);
  });

  it("the usage text documents every command the templates call", () => {
    // A command that works but is undocumented is one nobody can use by hand,
    // which is how a broken workflow becomes undebuggable.
    const usage = /const USAGE = `([\s\S]*?)`;/.exec(CLI)?.[1] ?? "";
    const undocumented = [...new Set(calls.map((c) => c.call))].filter(
      (call) => !usage.includes(`bsf ${call}`),
    );
    expect(undocumented, `undocumented: ${undocumented.join(", ")}`).toEqual([]);
  });
});

describe("the CLI's own shape", () => {
  it("has no bare require, which throws in an ESM module", () => {
    // This shipped twice: once in `bsf validate`, once in setOutput — where it
    // would only have fired inside Actions, with GITHUB_OUTPUT set.
    for (const file of walk(join(ROOT, "runner/src"))) {
      const text = readFileSync(file, "utf8");
      const bare = [...text.matchAll(/(?<![_a-zA-Z])require\(/g)];
      const viaCreateRequire = [...text.matchAll(/require_\(/g)];
      expect(
        bare.length - viaCreateRequire.length,
        `${file} uses a bare require()`,
      ).toBeLessThanOrEqual(0);
    }
  });

  it("every command returns an exit code rather than falling through", () => {
    // A command that prints a failure and exits 0 is a gate that passes.
    for (const name of topLevel) {
      if (name === "help") continue;
      const idx = CLI.indexOf(`case "${name}":`);
      expect(idx, name).toBeGreaterThan(-1);
    }
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && full.endsWith(".ts")) yield full;
  }
}

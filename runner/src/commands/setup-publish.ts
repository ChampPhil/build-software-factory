/**
 * Copy one setup step onto the branch the next step reads.
 *
 * Purpose:
 *     A later setup step used to read an artifact from the same GitHub run.
 *     That artifact is gone when the step is run again on its own, so the
 *     earlier work was redone. This copies the step's files into
 *     .factory/setup-state, which is committed on the branch factory/setup-state.
 *     Secret values are not copied. A recipe that pastes a password is refused
 *     and left uncopied.
 *
 * Key terms:
 *     - Setup state: the files earlier steps already produced. Journeys,
 *       the standard-rules patch, the recipe, and the boot log.
 *     - Recipe: manifest.json. Its env values are names or plain words.
 *       A vendor password in a value field is a refusal.
 *
 * Exports:
 *     - publishSetupStep: copy the allowlisted files, or report why not.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pastedSecrets } from "../lib/placeholders.js";

const ALLOWED = new Set([
  "manifest.json",
  "guardrails.patch",
  "guardrails.json",
  "trial.json",
  "journeys.md",
]);

/**
 * Copy one step's files into the setup-state directory.
 *
 * from: the directory the step wrote (an artifact download).
 * into: the setup-state directory in the checkout, usually
 * .factory/setup-state. Created if needed.
 * Returns the relative paths copied. Throws when the recipe pastes a
 * password, and copies nothing in that case.
 */
export function publishSetupStep(from: string, into: string): string[] {
  if (!existsSync(from)) throw new Error(`${from} does not exist`);
  const manifest = join(from, "manifest.json");
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { env?: unknown };
    const problems = pastedSecrets(Array.isArray(parsed.env) ? parsed.env : []);
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }
  const copied: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".env" || name.startsWith(".env.")) continue;
      const path = join(dir, name);
      const rel = relative(from, path).replace(/\\/g, "/");
      const info = statSync(path);
      if (info.isDirectory()) {
        if (rel === "context" || rel === "stubs" || rel === "report" || rel.startsWith("context/") || rel.startsWith("stubs/") || rel.startsWith("report/")) walk(path);
        continue;
      }
      const top = rel.split("/")[0] ?? rel;
      const allowedDir = rel.startsWith("context/") || rel.startsWith("stubs/") || rel.startsWith("report/");
      if (!allowedDir && !ALLOWED.has(top)) continue;
      const dest = join(into, rel);
      mkdirSync(join(dest, ".."), { recursive: true });
      cpSync(path, dest);
      copied.push(rel);
    }
  };
  walk(from);
  return copied.sort();
}

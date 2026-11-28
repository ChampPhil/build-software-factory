/**
 * Copy one setup step onto the directory the next step reads.
 *
 * Purpose:
 *     A later setup step used to read an artifact from the same GitHub run.
 *     That artifact is gone when the step is run again on its own, so the
 *     earlier work was redone. This copies the step's files into
 *     .factory/setup-state, which is committed on the branch factory/setup-state.
 *     Secret values are not copied. A recipe that pastes a password is refused
 *     and left uncopied. A journey list that drops a heading already on the
 *     finish line is not copied over the saved list. The rest of the step,
 *     including the recipe, is still saved. The writer cannot delete a journey.
 *
 * Key terms:
 *     - Setup state: the files earlier steps already produced. Journeys,
 *       the standard-rules patch, the recipe, and the boot log.
 *     - Recipe: manifest.json. Its env values are names or plain words.
 *       A vendor password in a value field is a refusal.
 *
 * Exports:
 *     - publishSetupStep: copy the allowlisted files, or report why not.
 *     - PublishResult: the paths copied, and the journey note when a heading
 *       was restored.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pastedSecrets } from "../lib/placeholders.js";
import { deletedJourneyProblem } from "./boot-checks.js";
import { finishLineJourneys } from "./env-state.js";

const ALLOWED = new Set([
  "manifest.json",
  "guardrails.patch",
  "guardrails.json",
  "trial.json",
  "journeys.md",
  "amend.json",
  "rules.done",
  "journeys.done",
]);

export interface PublishResult {
  readonly copied: readonly string[];
  /**
   * Set when the incoming journey list dropped a finish-line heading.
   * The saved list was kept. The recipe was still copied.
   */
  readonly journeysKept: string | null;
}

/**
 * Copy one step's files into the setup-state directory.
 *
 * from: the directory the step wrote (an artifact download).
 * into: the setup-state directory in the checkout, usually
 * .factory/setup-state. Created if needed.
 * Returns the paths copied. Throws when the recipe pastes a password, and
 * then nothing is copied. When the incoming journey list drops a heading
 * the saved list had, that file is not copied and the saved list stays.
 * A heading the writer added, which the saved list did not have, is appended.
 */
export function publishSetupStep(from: string, into: string): PublishResult {
  if (!existsSync(from)) throw new Error(`${from} does not exist`);
  const manifest = join(from, "manifest.json");
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { env?: unknown };
    const problems = pastedSecrets(Array.isArray(parsed.env) ? parsed.env : []);
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }
  const incomingJourneys = join(from, "context", "journeys.md");
  const existingJourneys = join(into, "context", "journeys.md");
  let journeysKept: string | null = null;
  let journeysFile: string | null = null;
  if (existsSync(incomingJourneys) && existsSync(existingJourneys)) {
    const originalText = readFileSync(existingJourneys, "utf8");
    const incomingText = readFileSync(incomingJourneys, "utf8");
    const problem = deletedJourneyProblem(finishLineJourneys(originalText), incomingText);
    if (problem !== null) {
      journeysKept = `${problem}. The saved journey list was kept.`;
      journeysFile = withAddedJourneys(originalText, incomingText);
    }
  }
  const copied: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".env" || name.startsWith(".env.")) continue;
      const path = join(dir, name);
      const rel = relative(from, path).replace(/\\/g, "/");
      if (rel === "context/journeys.md" && journeysKept !== null) continue;
      const info = statSync(path);
      if (info.isDirectory()) {
        if (rel === "context" || rel === "stubs" || rel === "report" || rel.startsWith("context/") || rel.startsWith("stubs/") || rel.startsWith("report/")) walk(path);
        continue;
      }
      const top = rel.split("/")[0] ?? rel;
      const allowedDir = rel.startsWith("context/") || rel.startsWith("stubs/") || rel.startsWith("report/");
      if (!allowedDir && !ALLOWED.has(top) && !ALLOWED.has(rel)) continue;
      const dest = join(into, rel);
      mkdirSync(join(dest, ".."), { recursive: true });
      cpSync(path, dest);
      copied.push(rel);
    }
  };
  walk(from);
  if (journeysFile !== null) {
    mkdirSync(join(into, "context"), { recursive: true });
    writeFileSync(existingJourneys, journeysFile);
    copied.push("context/journeys.md");
  }
  return { copied: copied.sort(), journeysKept };
}

/**
 * The saved journey list, plus any heading the writer added.
 *
 * original: the journey list already on the finish line.
 * incoming: the list the writer produced, which dropped at least one heading.
 * Returns the original text, with each new incoming section appended. A
 * renamed heading is not treated as the old one. The old section stays.
 */
function withAddedJourneys(original: string, incoming: string): string {
  const had = new Set(finishLineJourneys(original).map((h) => h.toLowerCase()));
  const added = sectionBlocks(incoming).filter((block) => !had.has(block.heading.toLowerCase()));
  if (added.length === 0) return original.endsWith("\n") ? original : `${original}\n`;
  const base = original.endsWith("\n") ? original : `${original}\n`;
  return `${base}\n${added.map((block) => block.text).join("\n\n")}\n`;
}

/**
 * One level-two section, heading plus the lines under it.
 *
 * markdown: a journey list.
 * Returns each ## section. The text before the first heading is left out.
 */
function sectionBlocks(markdown: string): readonly { readonly heading: string; readonly text: string }[] {
  const blocks: { heading: string; text: string }[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  const flush = (): void => {
    if (heading === null) return;
    blocks.push({ heading, text: [`## ${heading}`, ...lines].join("\n").trimEnd() });
  };
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      flush();
      heading = match[1].trim();
      lines = [];
      continue;
    }
    if (heading !== null) lines.push(line);
  }
  flush();
  return blocks;
}

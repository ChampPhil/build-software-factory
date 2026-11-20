import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { minimatch } from "minimatch";

/**
 * The checks a spec must pass before any code is written.
 *
 * Only what can be decided mechanically. Whether a plan honours a practice
 * that takes judgement is for the agents and the reviewer; a script that
 * claimed to check it would be checking words, not meaning.
 */

export interface SpecLike {
  readonly files?: readonly string[];
  readonly research?: readonly { readonly claim?: unknown; readonly source?: unknown }[];
}

export interface SpecGateInput {
  readonly spec: SpecLike;
  /** The repo checkout, to confirm a cited file exists. */
  readonly root: string;
  /** Glob patterns no pipeline may change without a trusted human. */
  readonly protectedPaths: readonly string[];
  /** Paths this pipeline is allowed to change despite their protection. */
  readonly pipelineExclusions?: readonly string[];
}

/**
 * A source is a reference, optionally followed by a note:
 *
 *   https://example.com/docs#section      a page in the world
 *   src/lib/money.ts:42 (formatCents)     a file, or a line of it, in the repo
 *   ran: npx vitest run lib/              an experiment the spec ran itself
 *
 * Only the reference is checked; the note is for the reader. An experiment
 * cannot be checked after the fact, so it is accepted when it names the
 * command, which is what lets a reviewer run it again.
 */
export const SOURCE_FORMS =
  'a URL ("https://…"), a repo path ("src/a.ts" or "src/a.ts:42"), or an experiment you ran ("ran: <command>"), each optionally followed by a note';

export function sourceProblem(source: string, root: string): string | null {
  const ran = /^ran:\s*(.*)$/s.exec(source);
  if (ran !== null) {
    return (ran[1] ?? "").trim() === "" ? `cites an experiment without its command: ${source}` : null;
  }
  const ref = (source.split(/\s+/)[0] ?? "").replace(/[,;.)]+$/, "");
  if (/^https?:\/\//.test(ref)) {
    try {
      new URL(ref);
      return null;
    } catch {
      return `cites a malformed URL: ${ref}`;
    }
  }
  const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(ref);
  const rel = normalize(m?.[1] ?? ref);
  if (rel.startsWith("..") || rel.startsWith("/")) return `cites a path outside the repo: ${ref}`;
  const full = join(root, rel);
  if (!existsSync(full)) {
    return `cites "${ref}", which is not a file in the repo. A source is ${SOURCE_FORMS}`;
  }
  const line = m?.[2] === undefined ? null : Number(m[2]);
  if (line !== null && statSync(full).isFile()) {
    const lines = readFileSync(full, "utf8").split("\n").length;
    if (line < 1 || line > lines) return `cites line ${line} of ${rel}, which has ${lines}`;
  }
  return null;
}

export function specProblems(input: SpecGateInput): readonly string[] {
  const problems: string[] = [];
  const research = input.spec.research ?? [];

  // Research the plan rests on. A plan with none is a plan from memory.
  if (research.length === 0) {
    problems.push("the spec cites no research: say what the plan rests on, in the codebase or beyond it, and where");
  }
  research.forEach((r, i) => {
    const claim = typeof r.claim === "string" ? r.claim.trim() : "";
    const source = typeof r.source === "string" ? r.source.trim() : "";
    if (claim === "") problems.push(`research ${i + 1} has no claim`);
    if (source === "") {
      problems.push(`research ${i + 1} ("${claim.slice(0, 60)}") has no source`);
      return;
    }
    const problem = sourceProblem(source, input.root);
    if (problem !== null) problems.push(`research ${i + 1} ${problem}`);
  });

  // A plan that needs a protected path fails the policy check after the
  // build has spent its attempt. Fail it here instead.
  for (const f of input.spec.files ?? []) {
    const excluded = (input.pipelineExclusions ?? []).some((e) => f.startsWith(e));
    if (!excluded && input.protectedPaths.some((p) => minimatch(f, p, { dot: true }))) {
      problems.push(`the plan changes ${f}, a protected path this pipeline may not touch`);
    }
  }
  return problems;
}

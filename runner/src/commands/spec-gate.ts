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
    if (/^https?:\/\//.test(source)) {
      try {
        new URL(source);
      } catch {
        problems.push(`research ${i + 1} cites a malformed URL: ${source}`);
      }
      return;
    }
    // path or path:line, inside the repo
    const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(source);
    const rel = normalize(m?.[1] ?? source);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      problems.push(`research ${i + 1} cites a path outside the repo: ${source}`);
      return;
    }
    const full = join(input.root, rel);
    if (!existsSync(full)) {
      problems.push(`research ${i + 1} cites ${rel}, which does not exist`);
      return;
    }
    const line = m?.[2] === undefined ? null : Number(m[2]);
    if (line !== null && statSync(full).isFile()) {
      const lines = readFileSync(full, "utf8").split("\n").length;
      if (line < 1 || line > lines) problems.push(`research ${i + 1} cites line ${line} of ${rel}, which has ${lines}`);
    }
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

/**
 * Purpose
 * -------
 * Refuse a setup survey that is a sketch, and refuse a fundamentals file
 * that copies the README or AGENTS.md. The survey is `assessment.md`. It is
 * shown in the setup pull request and deleted after that pull request
 * merges, so it is allowed to be long. The files every later run re-reads
 * stay short. Copying the README into fundamentals.md makes a second copy
 * that goes stale.
 *
 * Key terms
 * ---------
 * Survey: assessment.md. It has six sections. Each heading has to be there.
 * A short true sentence is enough. The check does not measure length and
 * does not require a digit. The mining section has to repeat the miner's
 * own summary sentence, so the counts cannot be invented.
 * Mining report: `.factory/guardrails/mining-report.json`, written by
 * `bsf mine-corrections`. Missing means the miner never ran. `classified:
 * false` means findings are still unlabelled, so setup is not finished.
 * Substantial line: a line of fundamentals.md that still has 48 characters
 * after the markdown marks are removed. Short words like "FastAPI" do not
 * count.
 * Copy: a substantial line that also appears in the README or AGENTS.md,
 * once whitespace is collapsed. The file fails when half or more of its
 * substantial lines are copies. A few shared sentences pass.
 *
 * Exports
 * -------
 * ASSESSMENT_SECTIONS, assessmentProblems, copiedFundamentals,
 * fundamentalsProblems, assessCheck, writeSurvey.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonAnswer, shapeProblems } from "../lib/structured.js";
import type { MiningReport } from "./mine-classify.js";
import { SURVEY_SHAPE, renderSurvey } from "./setup-shapes.js";

/** The sections a survey has to have, in the order a reader meets them. */
export const ASSESSMENT_SECTIONS = [
  "How it builds and tests",
  "The test check",
  "Patterns",
  "Where two patterns compete",
  "Coverage",
  "What mining found",
] as const;

/**
 * What is wrong with a survey. Empty means it is complete enough to merge.
 *
 * assessment: the markdown text. Empty string when the file is missing.
 * report: the mining report, or null when the miner has not run.
 */
export function assessmentProblems(assessment: string, report: MiningReport | null): readonly string[] {
  const problems: string[] = [];
  if (report === null) problems.push("the miner has not run: .factory/guardrails/mining-report.json is missing");
  else if (!report.classified) problems.push("mining findings are still unlabelled, so setup is not finished");
  else if (report.searched.reviews === null || report.searched.bugs === null) {
    problems.push("GitHub review comments or bug issues were not searched");
  }
  if (assessment.trim() === "") {
    problems.push("assessment.md is missing");
    return problems;
  }
  for (const title of ASSESSMENT_SECTIONS) {
    const body = sectionBody(assessment, title);
    if (body === null) {
      problems.push(`assessment.md is missing the section "${title}"`);
      continue;
    }
  }
  if (report !== null && report.summary !== "" && !assessment.includes(report.summary)) {
    problems.push("assessment.md does not include the miner's summary sentence");
  }
  return problems;
}

/**
 * The text under one heading, up to the next heading of the same rank.
 *
 * markdown: the file.
 * title: the heading text without the hashes.
 * Returns null when that heading is not there.
 */
function sectionBody(markdown: string, title: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${title.toLowerCase()}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * Substantial lines of fundamentals.md that also appear in the house docs.
 *
 * fundamentals: the file the factory would re-read on every run.
 * sources: README and AGENTS.md, joined. A line is a copy when its collapsed
 * text is at least 48 characters and that text appears in the sources.
 */
export function copiedFundamentals(fundamentals: string, sources: readonly string[]): readonly string[] {
  const haystack = sources.map(collapse).join("\n");
  if (haystack.trim() === "") return [];
  const copies: string[] = [];
  for (const raw of fundamentals.split(/\r?\n/)) {
    const cells = raw.split("|").map((c) => c.trim()).filter((c) => c !== "" && !/^[-:]+$/.test(c));
    const pieces = cells.length > 1 ? cells : [raw];
    for (const piece of pieces) {
      const text = collapse(piece.replace(/^#+\s*/, "").replace(/[*_`]/g, ""));
      if (text.length < 48) continue;
      if (haystack.includes(text)) copies.push(text);
    }
  }
  return copies;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Whether fundamentals.md copies the house docs badly enough to refuse it.
 *
 * copies: the lines `copiedFundamentals` returned.
 * substantial: how many lines were long enough to be compared.
 * Half or more is a second copy of the house docs. Fewer than that is a
 * sentence that happens to be said in both places.
 */
export function fundamentalsProblems(copies: readonly string[], substantial: number): readonly string[] {
  if (copies.length === 0 || substantial === 0) return [];
  if (copies.length * 2 >= substantial) {
    return [
      `fundamentals.md copies ${copies.length} line(s) from the README or AGENTS.md. Write only what those files do not already say.`,
      ...copies.slice(0, 8).map((c) => `  copied: ${c.slice(0, 120)}`),
    ];
  }
  return [];
}

/** How many fundamentals lines are long enough to compare. */
export function substantialLines(fundamentals: string): number {
  let n = 0;
  for (const raw of fundamentals.split(/\r?\n/)) {
    const cells = raw.split("|").map((c) => c.trim()).filter((c) => c !== "" && !/^[-:]+$/.test(c));
    const pieces = cells.length > 1 ? cells : [raw];
    for (const piece of pieces) {
      const text = collapse(piece.replace(/^#+\s*/, "").replace(/[*_`]/g, ""));
      if (text.length >= 48) n += 1;
    }
  }
  return n;
}

/**
 * Read the survey, the mining report, and the fundamentals file, and list
 * what is wrong. The caller prints the list and exits 1 when it is not empty.
 *
 * root: the checkout.
 * fundamentalsOnly: true in the setup pull-request job, which does not have
 * the survey. It only checks that fundamentals.md is not a copy.
 */
/**
 * Turn an accepted survey JSON file into `assessment.md`.
 *
 * from: the JSON the writer produced (`assessment.json`).
 * root: the checkout. The mining report is read from here so the miner's
 * own summary sentence is inserted by this program, and the markdown is
 * written to `assessment.md` at the root.
 * Returns 0 when the file was written, 1 when the JSON did not match the
 * survey's shape.
 */
export function writeSurvey(from: string, root: string): { readonly code: number; readonly lines: readonly string[] } {
  if (!existsSync(from)) return { code: 1, lines: [`${from} was not written`] };
  const parsed = readJsonAnswer(readFileSync(from, "utf8"));
  if ("problems" in parsed) return { code: 1, lines: parsed.problems.map((p) => `${from} ${p}`) };
  const problems = shapeProblems(SURVEY_SHAPE, parsed.value);
  if (problems.length > 0) return { code: 1, lines: problems.map((p) => `${from} ${p}`) };
  let miningSummary: string | null = null;
  const reportPath = join(root, ".factory/guardrails/mining-report.json");
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as Partial<MiningReport>;
      if (typeof report.summary === "string" && report.summary !== "") miningSummary = report.summary;
    } catch { /* the check will refuse an unreadable report; this write still inserts nothing */ }
  }
  const out = join(root, "assessment.md");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderSurvey(parsed.value as Record<string, string>, miningSummary));
  return { code: 0, lines: [`wrote ${out}`] };
}

export function assessCheck(root: string, fundamentalsOnly = false): readonly string[] {
  const problems: string[] = [];
  const fundamentalsPath = join(root, ".factory/definition/context/fundamentals.md");
  if (existsSync(fundamentalsPath)) {
    const fundamentals = readFileSync(fundamentalsPath, "utf8");
    const sources = houseDocs(root);
    const copies = copiedFundamentals(fundamentals, sources);
    problems.push(...fundamentalsProblems(copies, substantialLines(fundamentals)));
  } else if (fundamentalsOnly) {
    problems.push("fundamentals.md is missing");
  }
  if (fundamentalsOnly) return problems;

  const reportPath = join(root, ".factory/guardrails/mining-report.json");
  let report: MiningReport | null = null;
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8")) as MiningReport;
    } catch {
      problems.push("mining-report.json could not be read");
    }
  }
  const assessmentPath = join(root, "assessment.md");
  const assessment = existsSync(assessmentPath) ? readFileSync(assessmentPath, "utf8") : "";
  problems.push(...assessmentProblems(assessment, report));
  return problems;
}

/** README and AGENTS.md, wherever a checkout usually puts them. */
function houseDocs(root: string): string[] {
  const names = ["README.md", "README", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];
  const out: string[] = [];
  for (const name of names) {
    const path = join(root, name);
    if (existsSync(path)) out.push(readFileSync(path, "utf8"));
  }
  try {
    for (const name of readdirSync(join(root, "docs"))) {
      if (/^readme/i.test(name)) out.push(readFileSync(join(root, "docs", name), "utf8"));
    }
  } catch {
    // No docs folder. The root files are the house docs.
  }
  return out;
}

/**
 * setup-shapes.ts — the shapes the setup writer fills in, and the markdown the program writes from them.
 *
 * WHY THIS EXISTS
 *
 * The setup writer (a model run on GitHub) used to write the journey list as
 * markdown: a `##` heading per journey and labelled lines under it. The
 * recipe step then had to copy every heading exactly and add one more line
 * under each. A heading that was dropped or reworded was only noticed by a
 * regular expression several steps later, and setup stopped on an error that
 * named something else.
 *
 * Here the writer fills in JSON, and the program owns the markdown:
 *
 *   - The journey step writes `journeys.json`: a list of journeys.
 *   - The recipe step writes `recipe-journeys.json`: one entry per journey
 *     that is already saved, keyed by the journey's name. The shape for that
 *     file is built from the saved list, so a missing journey is a shape
 *     error that names the journey, and a journey cannot be dropped, renamed
 *     or added by the recipe step at all.
 *   - `context/journeys.md` is rendered from the accepted JSON.
 *
 * KEY TERMS
 *
 *   - Journey: one thing a person does in the product, with how they get
 *     there and what on the screen proves it worked.
 *   - Sandbox test: how the private copy of the app exercises a journey (the
 *     seeded user, the page, the click, the side effect).
 *   - Check: the name of one entry under `dependencies` in the recipe
 *     (`manifest.json`). Each such entry has a probe, a request the boot
 *     sends to the running app. A journey names the check that proves it was
 *     clicked, so the boot can tell exactly which journeys ran.
 *   - Shape: a JSON Schema for one file the writer fills in (see
 *     `lib/structured.ts`).
 *   - Survey: `assessment.md`, the long description of the repository shown
 *     in the setup pull request. It is written from `assessment.json`.
 *
 * EXPORTS
 *
 *   - Journey, JourneysFile: the saved list.
 *   - JOURNEY_LIST_SHAPE, recipeJourneysShape, NEW_JOURNEY_SHAPE,
 *     GUARDRAILS_SHAPE, SURVEY_SHAPE: the shapes.
 *   - SURVEY_FIELDS: the survey's sections, in order, with their field names.
 *   - duplicateNames, withSandboxTests, renderJourneys, journeysFromMarkdown,
 *     renderSurvey: what the program does with accepted answers.
 */

import type { Shape } from "../lib/structured.js";
import { parseJourneys } from "./journeys.js";

/** One journey on the finish line. */
export interface Journey {
  /** The heading, in a person's words. Unique in the list. */
  readonly name: string;
  /** The path a person takes to get there. */
  readonly how_a_person_gets_there: string;
  /** What on the screen or in the data shows it worked. */
  readonly what_proves_it: string;
  /** True when the person has to be signed in to do it. */
  readonly signed_in: boolean;
  /** How the private copy exercises it. Filled in by the recipe step. */
  readonly how_the_sandbox_tests_it?: string;
  /** The recipe check whose probe shows this journey was clicked. Filled in by the recipe step. */
  readonly check?: string;
}

/** The saved journey list: `journeys.json`. */
export interface JourneysFile {
  readonly schema: "journeys/1";
  readonly journeys: readonly Journey[];
}

/** One line of text: not empty, no line break, and not a markdown heading. */
const ONE_LINE = { type: "string", minLength: 1, pattern: "^(?!\\s*#)[^\\r\\n]+$" } as const;

/** The four fields the journey step fills in for each journey. */
const JOURNEY_FIELDS = {
  name: ONE_LINE,
  how_a_person_gets_there: ONE_LINE,
  what_proves_it: ONE_LINE,
  signed_in: { type: "boolean" },
} as const;

/** The two fields the recipe step adds to a journey. */
const SANDBOX_TEST_FIELDS = {
  how_the_sandbox_tests_it: ONE_LINE,
  // Empty is allowed: a library with no server has nothing to click.
  check: { type: "string", pattern: "^[^\\r\\n]*$" },
} as const;

/** `journeys.json` as the journey step writes it. */
export const JOURNEY_LIST_SHAPE: Shape = {
  type: "object",
  required: ["schema", "journeys"],
  additionalProperties: false,
  properties: {
    schema: { const: "journeys/1" },
    journeys: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "how_a_person_gets_there", "what_proves_it", "signed_in"],
        additionalProperties: false,
        properties: JOURNEY_FIELDS,
      },
    },
  },
};

/**
 * The shape of `recipe-journeys.json`, built from the journeys already saved.
 *
 * names: the name of every saved journey.
 * Returns a shape that requires exactly one entry per name under `tests` and
 * allows no other key, so the recipe step cannot drop, rename or add a
 * journey.
 */
export function recipeJourneysShape(names: readonly string[]): Shape {
  const test = {
    type: "object",
    required: ["how_the_sandbox_tests_it", "check"],
    additionalProperties: false,
    properties: SANDBOX_TEST_FIELDS,
  };
  return {
    type: "object",
    required: ["schema", "tests"],
    additionalProperties: false,
    properties: {
      schema: { const: "recipe-journeys/1" },
      tests: {
        type: "object",
        required: [...names],
        additionalProperties: false,
        properties: Object.fromEntries(names.map((name) => [name, test])),
      },
    },
  };
}

/** `new-journey.json`: the one journey a later look found missing, with its sandbox test. */
export const NEW_JOURNEY_SHAPE: Shape = {
  type: "object",
  required: ["schema", "journey"],
  additionalProperties: false,
  properties: {
    schema: { const: "new-journey/1" },
    journey: {
      type: "object",
      required: ["name", "how_a_person_gets_there", "what_proves_it", "signed_in", "how_the_sandbox_tests_it", "check"],
      additionalProperties: false,
      properties: { ...JOURNEY_FIELDS, ...SANDBOX_TEST_FIELDS },
    },
  },
};

/** `guardrails.json`: which standard rules were installed and which were left out. */
export const GUARDRAILS_SHAPE: Shape = {
  type: "object",
  required: ["installed", "skipped"],
  properties: {
    installed: {
      type: "array",
      items: {
        type: "object",
        required: ["rule", "tool", "file"],
        properties: { rule: { type: "string", minLength: 1 }, tool: { type: "string", minLength: 1 }, file: { type: "string", minLength: 1 } },
      },
    },
    skipped: {
      type: "array",
      items: {
        type: "object",
        required: ["rule", "why"],
        properties: { rule: { type: "string", minLength: 1 }, why: { type: "string", minLength: 1 } },
      },
    },
  },
};

/** The survey's sections, in the order a reader meets them, with the JSON field for each. */
export const SURVEY_FIELDS = [
  { field: "how_it_builds_and_tests", title: "How it builds and tests" },
  { field: "the_test_check", title: "The test check" },
  { field: "patterns", title: "Patterns" },
  { field: "where_two_patterns_compete", title: "Where two patterns compete" },
  { field: "coverage", title: "Coverage" },
  { field: "what_mining_found", title: "What mining found" },
] as const;

/** `assessment.json`: one piece of markdown per survey section. */
export const SURVEY_SHAPE: Shape = {
  type: "object",
  required: ["schema", ...SURVEY_FIELDS.map((s) => s.field)],
  additionalProperties: false,
  properties: {
    schema: { const: "survey/1" },
    ...Object.fromEntries(SURVEY_FIELDS.map((s) => [s.field, { type: "string", minLength: 1 }])),
  },
};

/**
 * Journey names that appear more than once.
 *
 * journeys: the list to check.
 * Returns each repeated name once. Case and surrounding spaces do not make
 * two names different, because the rendered headings would read the same.
 */
export function duplicateNames(journeys: readonly { readonly name: string }[]): readonly string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const j of journeys) {
    const key = j.name.trim().toLowerCase();
    if (seen.has(key)) twice.add(j.name.trim());
    seen.add(key);
  }
  return [...twice];
}

/**
 * The saved journeys with the recipe step's sandbox tests added.
 *
 * saved: the journeys already on the finish line.
 * tests: the accepted `tests` object from `recipe-journeys.json`, keyed by
 * journey name.
 * Returns the same journeys in the same order, each with its sandbox test.
 * A name with no entry keeps what it had, which cannot happen for an
 * accepted file because its shape requires every name.
 */
export function withSandboxTests(
  saved: readonly Journey[],
  tests: Readonly<Record<string, { readonly how_the_sandbox_tests_it: string; readonly check: string }>>,
): readonly Journey[] {
  return saved.map((journey) => {
    const test = tests[journey.name];
    if (test === undefined) return journey;
    return { ...journey, how_the_sandbox_tests_it: test.how_the_sandbox_tests_it, check: test.check };
  });
}

/**
 * The journey list as markdown, for the people and roles that read it.
 *
 * file: the accepted journey list.
 * Returns `journeys.md`. One `##` heading per journey, then one labelled
 * line per field that has a value. The labels are the ones `parseJourneys`
 * reads, so the cheap look for a new journey keeps working on this file.
 */
export function renderJourneys(file: JourneysFile): string {
  const lines: string[] = [
    "# Journeys",
    "",
    "The things a person does in this product. Setup writes this file from `journeys.json`; edit that file, not this one.",
    "",
  ];
  for (const journey of file.journeys) {
    lines.push(`## ${journey.name}`, "");
    lines.push(`How a person gets there: ${journey.how_a_person_gets_there}`);
    lines.push(`What proves it: ${journey.what_proves_it}`);
    lines.push(`Signed in: ${journey.signed_in ? "yes" : "no"}`);
    if (journey.how_the_sandbox_tests_it !== undefined) {
      lines.push(`How the sandbox tests it: ${journey.how_the_sandbox_tests_it}`);
    }
    if (journey.check !== undefined && journey.check !== "") lines.push(`Proved by the check: ${journey.check}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Read a journey list back out of markdown this program rendered.
 *
 * markdown: a `journeys.md` file.
 * Returns the journeys. This is only for a repository that has the markdown
 * and no `journeys.json` beside it; the JSON is the source everywhere else.
 */
export function journeysFromMarkdown(markdown: string): readonly Journey[] {
  const signedIn = new Map<string, boolean>();
  const checks = new Map<string, string>();
  let current: string | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading?.[1] !== undefined) {
      current = heading[1].trim();
      continue;
    }
    if (current === null) continue;
    const signed = /^signed in:\s*(yes|no)\s*$/i.exec(line);
    if (signed?.[1] !== undefined) signedIn.set(current, signed[1].toLowerCase() === "yes");
    const check = /^proved by the check:\s*(.+)$/i.exec(line);
    if (check?.[1] !== undefined) checks.set(current, check[1].trim());
  }
  return parseJourneys(markdown)
    .filter((j) => j.reaches !== "" || j.proves !== "")
    .map((j) => ({
      name: j.title,
      how_a_person_gets_there: j.reaches,
      what_proves_it: j.proves,
      signed_in: signedIn.get(j.title) ?? /sign[ -]?in/i.test(`${j.title} ${j.reaches}`),
      ...(j.tests === "" ? {} : { how_the_sandbox_tests_it: j.tests }),
      ...(checks.has(j.title) ? { check: checks.get(j.title) ?? "" } : {}),
    }));
}

/**
 * The survey as markdown.
 *
 * survey: the accepted `assessment.json`, one piece of markdown per section.
 * miningSummary: the sentence the miner itself wrote about what it searched,
 * or null when the miner has not run. The program puts it in, so the counts
 * in the survey are the miner's and cannot be misquoted.
 * Returns `assessment.md`.
 */
export function renderSurvey(survey: Readonly<Record<string, string>>, miningSummary: string | null): string {
  const lines: string[] = ["# Survey", ""];
  for (const section of SURVEY_FIELDS) {
    lines.push(`## ${section.title}`, "");
    if (section.field === "what_mining_found" && miningSummary !== null && miningSummary !== "") {
      lines.push(miningSummary, "");
    }
    lines.push((survey[section.field] ?? "").trim(), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * structured.ts — an answer with a fixed shape, checked, and asked for again a bounded number of times.
 *
 * WHY THIS EXISTS
 *
 * Several things the factory asks a model for have to come back in one exact
 * shape: the list of journeys, how the sandbox tests each journey, the labels
 * on mined findings, the setup survey. They used to come back as prose that
 * a regular expression then picked apart. When the prose drifted (a heading
 * dropped, a line reworded) the regular expression quietly read less than was
 * written, and the mistake surfaced several steps later as an unrelated
 * failure.
 *
 * The rule now is the same everywhere:
 *
 *   1. The answer is JSON, and there is a written-down shape for it.
 *   2. The answer is checked against that shape. Every difference is listed
 *      in words the writer can act on ("/journeys/0: is missing
 *      "what_proves_it"").
 *   3. A refused answer is asked for again, with that list. At most three
 *      answers are read.
 *   4. After the third refusal the step fails, and the list of differences is
 *      the recorded reason.
 *
 * Anything a person reads (markdown) is then written by the program from the
 * accepted JSON, never by the model.
 *
 * KEY TERMS
 *
 *   - Shape: a JSON Schema object (draft 2020-12). "Schema" already means the
 *     shared files in `/schema` in this codebase, so the ones a model fills
 *     in are called shapes here.
 *   - Problem: one sentence saying where an answer differs from its shape.
 *   - Attempt: one answer that was read. Three is the limit (MAX_ATTEMPTS).
 *   - Attempt log: a small JSON file that counts attempts across separate
 *     runs of a command. An agent that runs `bsf setup submit` three times is
 *     three processes, so the count has to live on disk.
 *
 * EXPORTS
 *
 *   - MAX_ATTEMPTS: how many answers are read before the step fails.
 *   - shapeProblems: every difference between a value and a shape.
 *   - readJsonAnswer: parse text that should be one JSON value.
 *   - fillShape: ask, check, and ask again with the problems, up to the limit.
 *   - readAttempts, recordAttempt: the attempt log.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ErrorObject } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";

// ajv is CommonJS. Node's interop puts the class on `default`, and some
// bundler shapes hand back the class itself, so take whichever is a function.
const Ajv2020 = typeof Ajv2020Module === "function" ? Ajv2020Module : Ajv2020Module.default;

/** How many answers are read before a step fails. */
export const MAX_ATTEMPTS = 3;

/** A JSON Schema object describing the one accepted form of an answer. */
export type Shape = Readonly<Record<string, unknown>>;

/** What `fillShape` returns: the accepted value, or the problems with the last answer. */
export type Filled<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: number }
  | { readonly ok: false; readonly problems: readonly string[]; readonly attempts: number };

/** What the attempt log holds for one step. */
export interface AttemptLog {
  /** How many answers have been read so far. */
  readonly attempts: number;
  /** Whether the last answer read was accepted. */
  readonly accepted: boolean;
  /** The problems with the last answer. Empty when it was accepted. */
  readonly problems: readonly string[];
}

/**
 * Every difference between a value and a shape, one sentence each.
 *
 * shape: the JSON Schema the value has to match.
 * value: the parsed answer.
 * Returns an empty list when the value matches. The sentences name the place
 * (a JSON pointer such as `/journeys/0`) and say what is wrong there.
 */
export function shapeProblems(shape: Shape, value: unknown): readonly string[] {
  // A fresh instance per call: shapes built at run time (one required field
  // per saved journey) would otherwise pile up in one instance's cache.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const check = ajv.compile(shape);
  if (check(value)) return [];
  return [...new Set((check.errors ?? []).map(problemSentence))];
}

/**
 * One validator error as a sentence a writer can act on.
 *
 * error: what the validator reported.
 * Returns the place and what is wrong there.
 */
function problemSentence(error: ErrorObject): string {
  const where = error.instancePath === "" ? "/" : error.instancePath;
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "required") return `${where}: is missing "${String(params["missingProperty"])}"`;
  if (error.keyword === "additionalProperties") {
    return `${where}: has "${String(params["additionalProperty"])}", which is not part of the shape`;
  }
  if (error.keyword === "enum") return `${where}: must be one of ${JSON.stringify(params["allowedValues"])}`;
  if (error.keyword === "const") return `${where}: must be exactly ${JSON.stringify(params["allowedValue"])}`;
  if (error.keyword === "type") return `${where}: must be ${String(params["type"])}`;
  if (error.keyword === "minLength") return `${where}: must not be empty`;
  if (error.keyword === "minItems") return `${where}: must have at least ${String(params["limit"])} item(s)`;
  if (error.keyword === "pattern") return `${where}: must be one line of text, with no line break and no leading "#"`;
  return `${where}: ${error.message ?? "is not valid"}`;
}

/**
 * Parse text that should be one JSON value.
 *
 * text: what the model or the file contained.
 * Returns the value, or one problem saying it is not JSON. Text wrapped in a
 * markdown code fence is unwrapped first, because that is the commonest way
 * a correct answer arrives looking wrong.
 */
export function readJsonAnswer(text: string): { readonly value: unknown } | { readonly problems: readonly string[] } {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  const body = fenced?.[1] ?? text;
  try {
    return { value: JSON.parse(body) as unknown };
  } catch (err) {
    return { problems: [`/: is not JSON (${(err as Error).message})`] };
  }
}

/**
 * Ask for an answer, check it, and ask again with the problems, up to the limit.
 *
 * shape: the JSON Schema the answer has to match.
 * ask: gets the answer. It is given null the first time, and afterwards the
 * problems with the previous answer together with that answer, so the writer
 * can correct it instead of starting over. It returns a parsed value, a
 * string to parse as JSON, or null when no answer could be had at all.
 * check: extra rules a schema cannot state (a quote has to be copied from
 * the finding it labels). It returns problems in the same form.
 * attempts: how many answers to read. Three unless a test says otherwise.
 * Returns the accepted value and how many answers it took, or the problems
 * with the last answer. A null from `ask` ends it at once: an unreachable
 * model is not a wrong answer, and asking again would spend the same failure.
 */
export async function fillShape<T>(opts: {
  readonly shape: Shape;
  readonly ask: (refused: { readonly problems: readonly string[]; readonly answer: string } | null) => Promise<unknown>;
  readonly check?: (value: T) => readonly string[];
  readonly attempts?: number;
}): Promise<Filled<T>> {
  const limit = opts.attempts ?? MAX_ATTEMPTS;
  let refused: { problems: readonly string[]; answer: string } | null = null;
  for (let attempt = 1; attempt <= limit; attempt++) {
    const raw = await opts.ask(refused);
    if (raw === null || raw === undefined) {
      return { ok: false, problems: ["/: no answer came back"], attempts: attempt };
    }
    let value: unknown = raw;
    let problems: readonly string[] = [];
    if (typeof raw === "string") {
      const parsed = readJsonAnswer(raw);
      if ("problems" in parsed) problems = parsed.problems;
      else value = parsed.value;
    }
    if (problems.length === 0) problems = shapeProblems(opts.shape, value);
    if (problems.length === 0 && opts.check !== undefined) problems = opts.check(value as T);
    if (problems.length === 0) return { ok: true, value: value as T, attempts: attempt };
    refused = { problems, answer: typeof raw === "string" ? raw : JSON.stringify(raw) };
  }
  return { ok: false, problems: refused?.problems ?? [], attempts: limit };
}

/**
 * The attempt log at a path, or a fresh one when nothing was read yet.
 *
 * path: where the log is kept.
 * Returns the count so far. An unreadable log counts as no attempts.
 */
export function readAttempts(path: string): AttemptLog {
  if (!existsSync(path)) return { attempts: 0, accepted: false, problems: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AttemptLog>;
    return {
      attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
      accepted: parsed.accepted === true,
      problems: Array.isArray(parsed.problems) ? parsed.problems.filter((p): p is string => typeof p === "string") : [],
    };
  } catch {
    return { attempts: 0, accepted: false, problems: [] };
  }
}

/**
 * Count one more answer in the attempt log.
 *
 * path: where the log is kept. Its folder is created when missing.
 * problems: what was wrong with this answer. Empty means it was accepted.
 * Returns the log as it now stands.
 */
export function recordAttempt(path: string, problems: readonly string[]): AttemptLog {
  const before = readAttempts(path);
  const next: AttemptLog = { attempts: before.attempts + 1, accepted: problems.length === 0, problems };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * setup-round.ts — check what the setup writer produced, and save only what passed.
 *
 * WHY THIS EXISTS
 *
 * The setup writer is a model run on GitHub. It leaves its files in one
 * folder (a "round"). Two different processes look at that folder:
 *
 *   1. Inside the writer's own run, the writer has to call
 *      `bsf setup submit`. That command checks the round and prints exactly
 *      what is wrong, so the writer can correct it. It reads at most three
 *      answers and then tells the writer to stop.
 *   2. After the writer's run, a separate job the writer cannot touch calls
 *      `bsf setup finish`, which runs the same check again and saves the
 *      round only when it passes. So the check is not something the writer
 *      can skip: an unchecked or refused round is never saved, and the
 *      problems the check found become the step's recorded failure.
 *
 * Both use `checkRound`, so what the writer is told and what the save
 * enforces cannot drift apart.
 *
 * KEY TERMS
 *
 *   - Round: the folder of files one writer run produced.
 *   - Focus: which job the writer was given. `journeys` writes the journey
 *     list. `standards` installs the standard rules. `recipe` writes the
 *     sandbox recipe and how each saved journey is tested. `one-journey`
 *     adds a single journey to a finished setup. `amendment` changes the
 *     recipe because a role reported the sandbox could not do something.
 *   - Brief: `amend.json` in the round, written before the writer starts. It
 *     names the focus and carries the saved journey list, so the writer's
 *     own check can be done without reaching outside the run.
 *   - Recipe: `manifest.json`, the sandbox definition.
 *   - Check (of a journey): the name of a recipe dependency whose probe
 *     shows the journey was clicked (see `setup-shapes.ts`).
 *   - State folder: `.factory/setup-state/` on the branch
 *     `factory/setup-state`, where accepted rounds are saved.
 *
 * EXPORTS
 *
 *   - Focus, focusOf: which job a step is.
 *   - RoundContext, RoundCheck, checkRound: the check.
 *   - acceptRound: the check, then the save into the state folder.
 *   - savedJourneys: the journey list already saved.
 *   - submitRound: the writer's own check, with the three-answer limit.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_ATTEMPTS, readAttempts, readJsonAnswer, recordAttempt, shapeProblems, type Shape } from "../lib/structured.js";
import { pastedSecrets } from "../lib/placeholders.js";
import { appHasSignIn } from "./boot-checks.js";
import { loadManifestAt, type SandboxManifest } from "./sandbox.js";
import type { SetupStep } from "./setup-record.js";
import {
  GUARDRAILS_SHAPE, JOURNEY_LIST_SHAPE, NEW_JOURNEY_SHAPE, duplicateNames, journeysFromMarkdown, recipeJourneysShape,
  renderJourneys, withSandboxTests, type Journey, type JourneysFile,
} from "./setup-shapes.js";

/** Which job the writer was given. */
export type Focus = "journeys" | "standards" | "recipe" | "one-journey" | "amendment";

const FOCUSES: readonly Focus[] = ["journeys", "standards", "recipe", "one-journey", "amendment"];

/** What the check needs to know that is not in the round itself. */
export interface RoundContext {
  /** The repository checkout, read to see whether the app has sign-in. */
  readonly root: string;
  /** The journeys already saved. Empty before the journey step has run. */
  readonly saved: readonly Journey[];
  /** Sign-in vendors the person took off the finish line. */
  readonly skippedSignIn: readonly string[];
}

/** What the check found. */
export type RoundCheck =
  | {
      readonly ok: true;
      /** The journey list to save, or null when this focus does not change it. */
      readonly journeys: JourneysFile | null;
    }
  | {
      readonly ok: false;
      /** The kind of failure, as a short stable word. */
      readonly code: string;
      /** Every problem, one sentence each, naming the file and the place. */
      readonly problems: readonly string[];
    };

/**
 * Which job a step is, given the request setup was started with.
 *
 * step: the setup step that is running.
 * request: the text setup was started with. Empty or null for a first
 * setup. JSON with `"focus":"one-journey"` asks for one new journey.
 * Anything else is an amendment.
 */
export function focusOf(step: SetupStep, request: string | null): Focus {
  if (step === "journeys") return "journeys";
  if (step === "rules") return "standards";
  if (request === null || request.trim() === "") return "recipe";
  try {
    const parsed = JSON.parse(request) as { focus?: unknown };
    if (parsed !== null && typeof parsed === "object" && parsed.focus === "one-journey") return "one-journey";
  } catch { /* not JSON: an amendment written as text */ }
  return "amendment";
}

/**
 * Read one JSON file the writer had to produce and check it against a shape.
 *
 * dir: the round.
 * name: the file's name inside the round.
 * shape: what it has to look like.
 * Returns the parsed value, or the problems with the file's name in front.
 */
function readShaped(dir: string, name: string, shape: Shape): { readonly value: unknown } | { readonly code: string; readonly problems: readonly string[] } {
  const path = join(dir, name);
  if (!existsSync(path)) return { code: "missing-file", problems: [`${name} was not written`] };
  const parsed = readJsonAnswer(readFileSync(path, "utf8"));
  if ("problems" in parsed) return { code: "shape", problems: parsed.problems.map((p) => `${name} ${p}`) };
  const problems = shapeProblems(shape, parsed.value);
  if (problems.length > 0) return { code: "shape", problems: problems.map((p) => `${name} ${p}`) };
  return { value: parsed.value };
}

/**
 * Journeys whose check does not name something the boot can probe.
 *
 * journeys: the journeys to look at. One with no `check` field is skipped.
 * manifest: the recipe.
 * Returns one sentence per problem. A recipe that starts no server has
 * nothing to click, so it has no problems of this kind.
 */
function checkNameProblems(journeys: readonly Journey[], manifest: SandboxManifest): readonly string[] {
  if ((manifest.commands.run ?? "").trim() === "") return [];
  const byName = new Map((manifest.dependencies ?? []).map((d) => [d.name, d]));
  const problems: string[] = [];
  for (const journey of journeys) {
    if (journey.check === undefined) continue;
    if (journey.check === "") {
      problems.push(`"${journey.name}": "check" is empty, and this recipe starts a server. Name the dependency whose probe shows the journey was clicked.`);
      continue;
    }
    const dependency = byName.get(journey.check);
    if (dependency === undefined) {
      problems.push(`"${journey.name}": the check "${journey.check}" is not the name of an entry under "dependencies" in manifest.json`);
    } else if (dependency.probe === null) {
      problems.push(`"${journey.name}": the dependency "${journey.check}" has no probe, so the boot cannot show the journey was clicked`);
    }
  }
  return problems;
}

/**
 * Check one round against the shapes and rules for its focus.
 *
 * focus: which job the writer was given.
 * dir: the round.
 * ctx: the checkout, the saved journeys, and the skipped sign-ins.
 * Returns the journey list to save when everything passed, or the code and
 * the full list of problems. Nothing is written.
 */
export function checkRound(focus: Focus, dir: string, ctx: RoundContext): RoundCheck {
  const bad = (code: string, problems: readonly string[]): RoundCheck => ({ ok: false, code, problems });
  if (!existsSync(dir) || readdirSync(dir).length === 0) return bad("no-output", ["the writer left no files"]);

  if (focus === "journeys") {
    const read = readShaped(dir, "journeys.json", JOURNEY_LIST_SHAPE);
    if ("problems" in read) return bad(read.code, read.problems);
    const file = read.value as JourneysFile;
    const twice = duplicateNames(file.journeys);
    if (twice.length > 0) return bad("shape", twice.map((name) => `journeys.json: two journeys are named "${name}"`));
    if (ctx.skippedSignIn.length === 0 && appHasSignIn(ctx.root) && !file.journeys.some((j) => j.signed_in)) {
      return bad("missing-signed-in-journey", ['this app has sign-in, and no journey in journeys.json has "signed_in": true']);
    }
    return { ok: true, journeys: file };
  }

  if (focus === "standards") {
    const read = readShaped(dir, "guardrails.json", GUARDRAILS_SHAPE);
    if ("problems" in read) return bad(read.code, read.problems);
    const decided = read.value as { installed: readonly unknown[] };
    const patch = join(dir, "guardrails.patch");
    if (decided.installed.length > 0 && (!existsSync(patch) || statSync(patch).size === 0)) {
      return bad("missing-file", ["guardrails.json lists installed rules, and guardrails.patch is missing or empty"]);
    }
    return { ok: true, journeys: null };
  }

  const loaded = loadManifestAt(join(dir, "manifest.json"));
  if (loaded.kind === "missing") return bad("missing-file", ["manifest.json was not written"]);
  if (loaded.kind === "invalid") return bad("shape", loaded.errors.map((e) => `manifest.json ${e}`));
  const pasted = pastedSecrets(loaded.manifest.env);
  if (pasted.length > 0) return bad("password-in-recipe", pasted);
  if (focus === "amendment") return { ok: true, journeys: null };

  if (focus === "recipe") {
    if (ctx.saved.length === 0) return bad("no-journeys", ["no journey list is saved, so the recipe has nothing to test"]);
    const read = readShaped(dir, "recipe-journeys.json", recipeJourneysShape(ctx.saved.map((j) => j.name)));
    if ("problems" in read) return bad(read.code, read.problems);
    const tests = (read.value as { tests: Record<string, { how_the_sandbox_tests_it: string; check: string }> }).tests;
    const journeys = withSandboxTests(ctx.saved, tests);
    const problems = checkNameProblems(journeys, loaded.manifest);
    if (problems.length > 0) return bad("shape", problems.map((p) => `recipe-journeys.json ${p}`));
    return { ok: true, journeys: { schema: "journeys/1", journeys } };
  }

  const read = readShaped(dir, "new-journey.json", NEW_JOURNEY_SHAPE);
  if ("problems" in read) return bad(read.code, read.problems);
  const added = (read.value as { journey: Journey }).journey;
  const journeys = [...ctx.saved, added];
  if (duplicateNames(journeys).length > 0) {
    return bad("shape", [`new-journey.json: a journey named "${added.name}" is already on the list`]);
  }
  const problems = checkNameProblems([added], loaded.manifest);
  if (problems.length > 0) return bad("shape", problems.map((p) => `new-journey.json ${p}`));
  return { ok: true, journeys: { schema: "journeys/1", journeys } };
}

/**
 * Copy a folder from the round into the state folder, replacing what was there.
 *
 * from: the folder in the round. Nothing happens when it does not exist.
 * to: the folder in the state folder.
 * A file whose name starts with `.env` is never copied, so a writer that
 * left an environment file behind cannot get it saved.
 */
function replaceFolder(from: string, to: string): void {
  if (!existsSync(from) || !statSync(from).isDirectory()) return;
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      const name = source.split(/[\\/]/).pop() ?? "";
      return name !== ".env" && !name.startsWith(".env.");
    },
  });
}

/**
 * Check one round and, when it passes, save it into the state folder.
 *
 * focus: which job the writer was given.
 * dir: the round.
 * stateDir: the state folder in the checkout.
 * ctx: the checkout, the saved journeys, and the skipped sign-ins.
 * Returns what `checkRound` returned. When it did not pass, nothing in the
 * state folder is changed.
 */
export function acceptRound(focus: Focus, dir: string, stateDir: string, ctx: RoundContext): RoundCheck {
  const check = checkRound(focus, dir, ctx);
  if (!check.ok) return check;
  mkdirSync(join(stateDir, "context"), { recursive: true });
  const copy = (name: string): void => {
    if (existsSync(join(dir, name))) cpSync(join(dir, name), join(stateDir, name));
  };

  if (focus === "journeys") {
    writeFileSync(join(stateDir, "journeys.done"), "done\n");
  } else if (focus === "standards") {
    copy("guardrails.json");
    if (existsSync(join(dir, "guardrails.patch"))) copy("guardrails.patch");
    else rmSync(join(stateDir, "guardrails.patch"), { force: true });
    writeFileSync(join(stateDir, "rules.done"), "done\n");
  } else {
    copy("manifest.json");
    copy("research-domains.txt");
    replaceFolder(join(dir, "stubs"), join(stateDir, "stubs"));
    replaceFolder(join(dir, "report"), join(stateDir, "report"));
    const context = join(dir, "context");
    if (existsSync(context)) {
      for (const name of readdirSync(context)) {
        // The journey list is rendered below from the accepted JSON. A copy
        // the writer wrote by hand is not read.
        if (!name.endsWith(".md") || name === "journeys.md") continue;
        cpSync(join(context, name), join(stateDir, "context", name));
      }
    }
  }

  if (check.journeys !== null) {
    writeFileSync(join(stateDir, "journeys.json"), `${JSON.stringify(check.journeys, null, 2)}\n`);
    writeFileSync(join(stateDir, "context", "journeys.md"), renderJourneys(check.journeys));
  }
  return check;
}

/**
 * The journey list already saved.
 *
 * stateDir: the state folder, or null to skip it.
 * root: the checkout, read when the state folder has no list (a finished
 * setup keeps the list under `.factory/definition/context/`).
 * Returns the journeys, or an empty list when none were ever saved.
 */
export function savedJourneys(stateDir: string | null, root: string): readonly Journey[] {
  const places = [
    ...(stateDir === null ? [] : [join(stateDir, "journeys.json")]),
    join(root, ".factory/definition/context/journeys.json"),
  ];
  for (const path of places) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<JourneysFile>;
      if (Array.isArray(parsed.journeys)) return parsed.journeys;
    } catch { /* unreadable: try the next place */ }
  }
  const markdown = join(root, ".factory/definition/context/journeys.md");
  if (existsSync(markdown)) return journeysFromMarkdown(readFileSync(markdown, "utf8"));
  return [];
}

/**
 * The writer's own check of its round, with the three-answer limit.
 *
 * dir: the round. Its `amend.json` says which focus this is and carries the
 * saved journeys.
 * root: the repository checkout.
 * Returns the exit code and the lines to print: 0 when the round is
 * accepted, 1 when it was refused and may be corrected, 2 when three answers
 * were already refused or the brief is missing. The count is kept in
 * `submit.json` in the round, because each call is a separate process.
 */
export function submitRound(dir: string, root: string): { readonly code: number; readonly lines: readonly string[] } {
  const briefPath = join(dir, "amend.json");
  let brief: { focus?: unknown; journeys?: unknown; skipped_sign_in?: unknown } = {};
  try {
    brief = JSON.parse(readFileSync(briefPath, "utf8")) as typeof brief;
  } catch {
    return { code: 2, lines: [`${briefPath} is missing or is not JSON. This command runs inside a setup step, which writes that file first.`] };
  }
  const focus = FOCUSES.find((f) => f === brief.focus);
  if (focus === undefined) {
    return { code: 2, lines: [`${briefPath} does not name a focus this command knows: ${JSON.stringify(brief.focus)}`] };
  }
  const logPath = join(dir, "submit.json");
  const before = readAttempts(logPath);
  if (!before.accepted && before.attempts >= MAX_ATTEMPTS) {
    return {
      code: 2,
      lines: [
        `${MAX_ATTEMPTS} answers were already refused. Stop here and do not change the files again.`,
        "This step has failed. The next run is given the problems below.",
        ...before.problems.map((p) => `- ${p}`),
      ],
    };
  }
  const check = checkRound(focus, dir, {
    root,
    saved: Array.isArray(brief.journeys) ? (brief.journeys as Journey[]) : [],
    skippedSignIn: Array.isArray(brief.skipped_sign_in) ? (brief.skipped_sign_in as string[]) : [],
  });
  if (check.ok) {
    // Running the command again on an accepted round is not another answer.
    if (!before.accepted) recordAttempt(logPath, []);
    return { code: 0, lines: ["accepted"] };
  }
  const after = recordAttempt(logPath, check.problems);
  const lines = [`Answer ${after.attempts} of ${MAX_ATTEMPTS} was not accepted:`, ...check.problems.map((p) => `- ${p}`)];
  if (after.attempts >= MAX_ATTEMPTS) {
    lines.push("That was the last answer. Stop here and do not change the files again. This step has failed, and the next run is given these problems.");
  } else {
    lines.push("Correct exactly these and run the same command again.");
  }
  return { code: 1, lines };
}

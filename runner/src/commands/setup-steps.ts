/**
 * setup-steps.ts — what each setup workflow does, as code a test can run.
 *
 * WHY THIS EXISTS
 *
 * Setup is a chain of GitHub workflows. Each one used to carry its own logic
 * as shell inside the workflow file: is everything ready, what does the
 * writer get told, was the writer's work saved, what failed, what starts
 * next. None of that could be tested, and its failure messages were fixed
 * sentences that did not say what went wrong.
 *
 * Each of those pieces is one function here, and each workflow step is one
 * `bsf setup ...` command that calls it. Everything from outside the process
 * arrives through `SetupWorld` (see `setup-world.ts`), so a test can run the
 * whole chain against a temporary repository.
 *
 * THE CHAIN
 *
 *   start      checks the settings, then starts the journey list and the
 *              standard rules side by side (or, for a request against a
 *              finished setup, the recipe).
 *   plan       runs before each writer: holds the step while a setting is
 *              unanswered, and writes the writer's brief.
 *   finish     runs after each writer: checks what it wrote, saves it, and
 *              starts the next step, or records why it failed.
 *   boot       boots the saved recipe and clicks the journeys.
 *   (pr)       opens the pull request; that one is in `setup-pr.ts`.
 *
 * KEY TERMS
 *
 *   - Writer: the model run that produces a step's files.
 *   - Brief: the JSON the writer is handed (`amend.json`): which job it has,
 *     the saved journeys, the last boot, and the failure it is there to fix.
 *   - Round: the folder of files the writer produced.
 *   - Request: the text a setup against an already finished factory was
 *     started with: an amendment, or one new journey.
 *   - Stop: setup records the failure, opens the issue "Setup stopped", and
 *     starts nothing. See `setup-record.ts` for when.
 *   - Settings screen: where the person answers configuration names. A step
 *     is held, not failed, while a name has no answer.
 *
 * EXPORTS
 *
 *   - failStep, passStep: record a failure or a success.
 *   - readyStep, startStep, planStep, finishStep, bootStep, statusStep.
 *   - judgeBoot, bootDetail: what a boot log means.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { namesFromBootLog } from "./boot-checks.js";
import { missingCredentials } from "./credentials.js";
import { NEXT_PATH, WAIT_PATH, type SetupNext, type WaitFile } from "./env-state.js";
import type { TrialReport } from "./sandbox.js";
import {
  SETUP_RECORD_PATH, STEP_WORKFLOW, noteFailure, noteSuccess, readRecord, statusLines,
  type Failure, type SetupRecord, type SetupStage, type SetupStep,
} from "./setup-record.js";
import { acceptRound, focusOf, savedJourneys, type Focus } from "./setup-round.js";
import type { Journey } from "./setup-shapes.js";
import type { SetupWorld } from "./setup-world.js";

/** The stage setup is in while a given step runs. */
const STAGE_OF: Readonly<Record<SetupStep, SetupStage>> = {
  start: "settings",
  journeys: "journeys-and-rules",
  rules: "journeys-and-rules",
  recipe: "recipe",
  boot: "boot",
  pr: "pr",
};

/** Why setup stopped, as the sentence the issue shows. */
const STOP_REASON = {
  same: "The step failed for the same reason twice in a row.",
  limit: "The step failed three times in a row.",
  "no-retry": "This failure is not one that running a step again can fix.",
} as const;

/**
 * Record a failure with its full reason, then start the right step again or stop.
 *
 * world: the outside world.
 * failure: the step that failed, the kind of failure, and what went wrong in full.
 * retry: the step to start again, or null when no step can fix this.
 * then: `pr` when the recipe, once written again, should go straight to the
 * pull request instead of a boot.
 * Returns 1 when a step was started again and 2 when setup stopped.
 */
export async function failStep(
  world: SetupWorld,
  failure: { readonly step: SetupStep; readonly code: string; readonly detail: string },
  retry: SetupStep | null,
  then: "boot" | "pr" = "boot",
): Promise<number> {
  const now = world.now();
  const noted: Failure = { ...failure, at: now, run: world.runUrl };
  const stop = await world.updateJson<SetupRecord, keyof typeof STOP_REASON | null>(
    SETUP_RECORD_PATH,
    (current) => {
      const before = readRecord(current, now);
      // The store may run this twice when another job wrote at the same
      // moment. A failure already noted at this instant is not noted again.
      const row = (before.failures[failure.step] ?? []).filter((f) => f.at !== now);
      const result = noteFailure({ ...before, failures: { ...before.failures, [failure.step]: row } }, noted);
      const why = result.stop ?? (retry === null ? "no-retry" : null);
      if (why !== null || retry === null) {
        return {
          next: { ...result.record, stage: "stopped", waiting_on: 'you. Setup stopped. The issue "Setup stopped" has the reason.', retry: null },
          result: why,
        };
      }
      return {
        next: {
          ...result.record,
          stage: STAGE_OF[retry],
          waiting_on: `${STEP_WORKFLOW[retry]}, started again and given the reason for the last failure`,
          retry: { workflow: STEP_WORKFLOW[retry], because: noted },
        },
        result: null,
      };
    },
    "Record a setup failure",
  );
  world.say(`The ${failure.step} step failed (${failure.code}):`);
  for (const line of noted.detail.split("\n")) world.say(`  ${line}`);
  if (stop !== null || retry === null) {
    await world.openIssueOnce(
      "Setup stopped",
      [
        "Setup stopped and did not start the step again.",
        "",
        `**Step:** ${failure.step}`,
        `**Why it stopped:** ${STOP_REASON[stop ?? "no-retry"]}`,
        "",
        "**What went wrong**",
        "",
        "~~~text",
        noted.detail,
        "~~~",
        "",
        ...(world.runUrl === null ? [] : [`Run: ${world.runUrl}`, ""]),
        "`bsf setup status` prints this again. After the cause is fixed, run **factory-setup** from the Actions tab to start over.",
      ].join("\n"),
    );
    world.say("Setup has stopped.");
    return 2;
  }
  if (retry === "recipe") {
    await world.updateJson<SetupNext, true>(NEXT_PATH, () => ({ next: { after_recipe: then }, result: true }), "Where the next recipe goes");
  }
  await world.dispatch(STEP_WORKFLOW[retry]);
  world.say(`started ${STEP_WORKFLOW[retry]} again`);
  return 1;
}

/**
 * Record that a step succeeded, and where setup is now.
 *
 * world: the outside world.
 * step: the step that succeeded, or null when no step did and only the
 * stage is changing (setup is being held on a setting).
 * change: the stage setup is now in, what it is waiting on, and any other
 * field of the record to replace.
 */
export async function passStep(
  world: SetupWorld,
  step: SetupStep | null,
  change: Partial<SetupRecord> & { readonly stage: SetupStage; readonly waiting_on: string },
): Promise<void> {
  const now = world.now();
  await world.updateJson<SetupRecord, true>(
    SETUP_RECORD_PATH,
    (current) => {
      const before = readRecord(current, now);
      const after = step === null ? before : noteSuccess(before, step, now);
      return { next: { ...after, ...change, updated_at: now }, result: true };
    },
    "Record where setup is",
  );
}

/**
 * The setup record as it stands.
 *
 * world: the outside world.
 */
async function currentRecord(world: SetupWorld): Promise<SetupRecord> {
  return readRecord(await world.readJson<SetupRecord>(SETUP_RECORD_PATH), world.now());
}

/**
 * The last JSON object a runner command printed.
 *
 * out: everything the command printed.
 * Returns the parsed object from the last line that is one, or null.
 */
function lastJsonLine(out: string): Record<string, unknown> | null {
  for (const line of out.split(/\r?\n/).reverse()) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch { /* not this line */ }
  }
  return null;
}

/**
 * Sign-in vendors the person took off the finish line.
 *
 * world: the outside world.
 */
async function skippedSignIn(world: SetupWorld): Promise<readonly string[]> {
  const parsed = lastJsonLine((await world.bsf(["env", "skipped"])).out);
  const list = parsed?.["skipped_sign_in"];
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Whether setup can start at all: `bsf setup ready`.
 *
 * world: the outside world. This step has no App token, so it writes no
 * record; it only sets the `ready` output and the job summary.
 * opts.trusted: the folder holding the factory files fetched from the
 * default branch.
 * opts.event: the GitHub event that started the workflow.
 * opts.env: the environment, carrying the three true-or-false words that
 * say whether each credential exists (see `credentials.ts`).
 * opts.repo: `owner/name`.
 * opts.branch: the branch the workflow runs on, for the summary.
 * Returns 0 always. A setup that is not ready is waiting on the person; it
 * has not failed.
 */
export async function readyStep(
  world: SetupWorld,
  opts: {
    readonly trusted: string;
    readonly event: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly repo: string;
    readonly branch: string;
  },
): Promise<number> {
  // A push gets here whenever the runner or the definition changes, which
  // includes every factory upgrade. Once a sandbox is frozen, setup has
  // already happened: designing it again costs model credits for nothing and
  // can replace a sandbox that works. Redoing it is a deliberate act.
  if (opts.event === "push" && existsSync(join(opts.trusted, ".factory/sandbox/manifest.json"))) {
    world.output("ready", "false");
    world.summary([
      "### Setup already finished",
      "",
      "This repository has a frozen sandbox, so a change to the factory's runner or",
      "definition does not design it again. To redo setup on purpose, run",
      "**factory-setup** from the Actions tab.",
    ].join("\n"));
    world.say("setup already finished");
    return 0;
  }
  const missing = missingCredentials(["app", "model"], opts.env);
  // The job token cannot list secrets, so the doctor alone would call a
  // missing key fine. It still catches a factory that is half installed.
  const doctor = await world.bsf(["doctor", "--repo", opts.repo, "--root", opts.trusted]);
  if (missing.length === 0 && doctor.code === 0) {
    world.output("ready", "true");
    world.say("setup can start");
    return 0;
  }
  world.output("ready", "false");
  world.summary([
    "### Setup is waiting on you",
    "",
    `The factory's definition is on \`${opts.branch}\`, but it cannot run yet:`,
    "",
    ...missing.map((m) => `- ${m}`),
    "",
    doctor.out.trim(),
    "",
    "Finish those, then run **factory-setup** from the Actions tab, or ask",
    "your coding agent to carry on with the software factory setup.",
  ].join("\n"));
  for (const m of missing) world.say(`missing: ${m}`);
  return 0;
}

/**
 * Hold a step while a setting has no answer.
 *
 * world: the outside world.
 * workflow: the workflow to start again once every setting is answered.
 * inputs: the inputs to start it with.
 * Returns true when nothing is waiting and the step may go on.
 */
async function settingsAnswered(world: SetupWorld, workflow: string, inputs: Readonly<Record<string, string>>): Promise<boolean> {
  const scan = await world.bsf(["env", "scan", "--hold", workflow, "--inputs", JSON.stringify(inputs)]);
  if (scan.code === 0) return true;
  await passStep(world, null, {
    stage: "settings",
    waiting_on: `you. Some settings have no answer yet. Answer them on the settings screen, and ${workflow} starts by itself.`,
  });
  world.summary("### Settings are waiting\n\nThe settings screen has the list. Nothing starts until every name has an answer.");
  return false;
}

/**
 * Start setup: `bsf setup start`.
 *
 * world: the outside world.
 * request: empty for a first setup. Otherwise the amendment or new-journey
 * request, which goes straight to the recipe.
 * Returns 0. A setup held on a setting has not failed.
 */
export async function startStep(world: SetupWorld, request: string): Promise<number> {
  const now = world.now();
  const asked = request.trim() === "" ? null : request;
  // A new setup forgets the last one: its failures, its "recipe already
  // started" mark, and the files it saved. Left in place, those would make
  // this setup think a step was already done or a recipe already booted.
  await world.updateJson<SetupRecord, true>(
    SETUP_RECORD_PATH,
    () => ({ next: { ...readRecord(null, now), request: asked }, result: true }),
    "A new setup starts",
  );
  await world.updateJson("env/recipe-started.json", () => ({ next: { token: "" }, result: true }), "A new setup can start the recipe");
  await world.updateJson<SetupNext, true>(NEXT_PATH, () => ({ next: { after_recipe: "boot" }, result: true }), "A new setup boots its recipe");
  if (world.git.dropState()) world.say("cleared what the last setup saved");
  if (!(await settingsAnswered(world, "factory-setup.yml", { amend: request }))) {
    world.output("ready", "false");
    return 0;
  }
  world.output("ready", "true");
  if (asked !== null) {
    await world.dispatch(STEP_WORKFLOW.recipe, { amend: request });
    await passStep(world, null, { stage: "recipe", waiting_on: `the writer, changing the recipe (${STEP_WORKFLOW.recipe})` });
    world.say(`started ${STEP_WORKFLOW.recipe}`);
    return 0;
  }
  await world.dispatch(STEP_WORKFLOW.journeys);
  await world.dispatch(STEP_WORKFLOW.rules);
  await passStep(world, null, {
    stage: "journeys-and-rules",
    waiting_on: `the writer, writing the journey list and the standard rules (${STEP_WORKFLOW.journeys}, ${STEP_WORKFLOW.rules})`,
  });
  world.say(`started ${STEP_WORKFLOW.journeys} and ${STEP_WORKFLOW.rules}`);
  return 0;
}

/**
 * The parts of the last boot a writer needs, small enough to hand over.
 *
 * trial: the saved boot log, or null when nothing was booted yet.
 * Returns the summary, the steps that failed with the end of their output,
 * and the probes that failed. Steps and probes that passed are left out.
 */
function lastBootFor(trial: TrialReport | null): Record<string, unknown> | null {
  if (trial === null) return null;
  return {
    claimed: trial.claimed,
    reached: trial.reached,
    summary: trial.summary,
    failed_steps: trial.steps.filter((s) => !s.ok).map((s) => ({ step: s.step, command: s.command, exit: s.exit, output_end: s.tail.slice(-3000) })),
    failed_probes: (trial.probes ?? []).filter((p) => !p.ok).map((p) => ({ check: p.dependency, path: p.path, what_happened: p.detail.slice(0, 600) })),
    sign_in: trial.sign_in ?? null,
  };
}

/**
 * Run before a writer: `bsf setup plan --step NAME`.
 *
 * Holds the step while a setting is unanswered. Otherwise writes the brief
 * the writer is handed.
 *
 * world: the outside world.
 * step: journeys, rules, or recipe.
 * input: the request this workflow run was started with. Empty on a first
 * setup and on a retry; the recorded request is used then.
 * Returns 0. Sets the outputs `ready` (true or false) and, when ready,
 * `amend` (the brief, as JSON).
 */
export async function planStep(world: SetupWorld, step: "journeys" | "rules" | "recipe", input: string): Promise<number> {
  const inputs: Record<string, string> = step === "recipe" ? { amend: input } : {};
  if (!(await settingsAnswered(world, STEP_WORKFLOW[step], inputs))) {
    world.output("ready", "false");
    return 0;
  }
  const record = await currentRecord(world);
  const request = input.trim() !== "" ? input : record.request;
  const focus = focusOf(step, request);
  const because = record.retry !== null && record.retry.workflow === STEP_WORKFLOW[step] ? record.retry.because : null;
  const brief: Record<string, unknown> = {
    focus,
    last_failure: because === null ? null : { step: because.step, code: because.code, detail: because.detail },
  };
  if (focus === "journeys") brief["skipped_sign_in"] = await skippedSignIn(world);
  if (step === "recipe") {
    const tracking = world.git.fetchState();
    const read = (name: string): string | null => (tracking === null ? null : world.git.bytesAt(tracking, `.factory/setup-state/${name}`)?.toString("utf8") ?? null);
    let saved: readonly Journey[] = [];
    try {
      // A request to add one journey starts from the finished setup's list,
      // not from a list an earlier try of this same request already added to.
      const text = focus === "one-journey" ? null : read("journeys.json");
      if (text !== null) saved = (JSON.parse(text) as { journeys?: Journey[] }).journeys ?? [];
    } catch { /* an unreadable saved list is an empty one */ }
    if (saved.length === 0) saved = savedJourneys(null, world.root);
    let trial: TrialReport | null = null;
    try {
      const text = read("trial.json");
      if (text !== null) trial = JSON.parse(text) as TrialReport;
    } catch { /* no usable boot log */ }
    const listed = lastJsonLine((await world.bsf(["env", "list"])).out);
    const names = Array.isArray(listed?.["names"]) ? (listed["names"] as { name?: string; decision?: string }[]) : [];
    brief["fakes"] = names.filter((n) => n.decision === "fake").map((n) => n.name);
    brief["journeys"] = saved;
    brief["last_boot"] = lastBootFor(trial);
    if (request !== null && request.trim() !== "") {
      try {
        brief["request"] = JSON.parse(request) as unknown;
      } catch {
        brief["request"] = request;
      }
    }
  }
  world.output("ready", "true");
  world.output("amend", JSON.stringify(brief));
  world.say(`the writer's job: ${focus}`);
  return 0;
}

/**
 * Run after a writer: `bsf setup finish --step NAME --from DIR`.
 *
 * Checks the round, saves it on the state branch, and starts the next step.
 * A round that does not pass is not saved, and the problems found are the
 * recorded reason.
 *
 * world: the outside world.
 * step: journeys, rules, or recipe.
 * from: the round the writer uploaded. It may not exist when the writer's
 * job died before uploading anything.
 * input: the request this workflow run was started with, as in `planStep`.
 * writer: how the writer's job ended (`success`, `failure`, `cancelled`),
 * used only to explain a round that is not there.
 * Returns 0 when the step was saved, 1 when it was started again, 2 when
 * setup stopped.
 */
export async function finishStep(
  world: SetupWorld,
  step: "journeys" | "rules" | "recipe",
  from: string,
  input: string,
  writer: string,
): Promise<number> {
  const record = await currentRecord(world);
  const request = input.trim() !== "" ? input : record.request;
  const focus: Focus = focusOf(step, request);
  const stateDir = world.git.openState();
  const check = acceptRound(focus, from, stateDir, {
    root: world.root,
    // As in `planStep`: one new journey is added to the finished setup's list.
    saved: savedJourneys(focus === "one-journey" ? null : stateDir, world.root),
    skippedSignIn: focus === "journeys" ? await skippedSignIn(world) : [],
  });
  if (!check.ok) {
    const lines = [...check.problems];
    if (check.code === "no-output") lines.push(`The writer's job ended as: ${writer === "" ? "unknown" : writer}.`);
    return failStep(world, { step, code: check.code, detail: lines.join("\n") }, step);
  }
  try {
    world.git.saveState(`Save the ${focus} step`);
  } catch (err) {
    return failStep(world, { step, code: "save-failed", detail: (err as Error).message }, step);
  }
  world.say(`saved the ${focus} step`);

  if (step === "recipe") {
    const next = await world.updateJson<SetupNext, "boot" | "pr">(
      NEXT_PATH,
      (current) => ({ next: { after_recipe: "boot" }, result: current?.after_recipe ?? "boot" }),
      "The recipe's next step",
    );
    await world.dispatch(STEP_WORKFLOW[next]);
    await passStep(world, "recipe", {
      stage: next,
      waiting_on: next === "boot"
        ? `the boot of the saved recipe (${STEP_WORKFLOW.boot})`
        : `the pull request being opened (${STEP_WORKFLOW.pr})`,
    });
    world.say(`started ${STEP_WORKFLOW[next]}`);
    return 0;
  }

  const other: SetupStep = step === "journeys" ? "rules" : "journeys";
  if (!existsSync(join(stateDir, "journeys.done")) || !existsSync(join(stateDir, "rules.done"))) {
    await passStep(world, step, {
      stage: "journeys-and-rules",
      waiting_on: `the writer, still on the ${other === "rules" ? "standard rules" : "journey list"} (${STEP_WORKFLOW[other]})`,
    });
    world.say("waiting for the other step");
    return 0;
  }
  // Both are saved. Whichever of the two jobs gets here first starts the
  // recipe; the mark below stops the other from starting it a second time.
  const hash = createHash("sha256");
  for (const name of ["journeys.json", "guardrails.json", "guardrails.patch"]) {
    const path = join(stateDir, name);
    hash.update(existsSync(path) ? readFileSync(path) : "");
  }
  const token = hash.digest("hex");
  const first = await world.updateJson<{ token?: string }, boolean>(
    "env/recipe-started.json",
    (current) => (current?.token === token ? { next: current, result: false } : { next: { token }, result: true }),
    "The recipe can start",
  );
  if (!first) {
    await passStep(world, step, { stage: "recipe", waiting_on: `the writer, writing the recipe (${STEP_WORKFLOW.recipe})` });
    world.say("the recipe is already starting");
    return 0;
  }
  await world.dispatch(STEP_WORKFLOW.recipe);
  await passStep(world, step, { stage: "recipe", waiting_on: `the writer, writing the recipe (${STEP_WORKFLOW.recipe})` });
  world.say(`started ${STEP_WORKFLOW.recipe}`);
  return 0;
}

/**
 * A boot log as the full reason for a failure.
 *
 * trial: the boot log.
 * Returns the one-line summary, then each failed step with the end of its
 * output, then each failed probe with what the app did.
 */
export function bootDetail(trial: TrialReport): string {
  const lines: string[] = [trial.summary.trim() === "" ? "the boot did not meet the finish line" : trial.summary.trim()];
  lines.push(`The recipe claimed "${trial.claimed}" and the boot reached "${trial.reached}".`);
  for (const step of trial.steps.filter((s) => !s.ok)) {
    lines.push("", `The ${step.step} step failed${step.exit === null ? "" : ` (exit ${step.exit})`}: ${step.command ?? ""}`.trimEnd());
    const tail = step.tail.trim();
    if (tail !== "") lines.push(tail.split("\n").slice(-30).join("\n"));
  }
  if (trial.sign_in !== undefined && !trial.sign_in.ok) lines.push("", `Sign-in did not produce a session: ${trial.sign_in.detail}`);
  for (const probe of (trial.probes ?? []).filter((p) => !p.ok)) {
    lines.push("", `The check "${probe.dependency}" on ${probe.path} did not pass: ${probe.detail}`);
  }
  return lines.join("\n");
}

/** What a boot log means for setup. */
export type BootVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "screen"; readonly names: readonly string[] }
  | { readonly kind: "writer"; readonly code: string; readonly detail: string };

/**
 * Decide what a boot log means.
 *
 * trial: the boot log.
 * journeys: the saved journeys, each naming the check that proves it.
 * Returns `ok` when the finish line was met; `screen` with the names when
 * the running app asked for a setting it did not get or a vendor refused a
 * key, because the writer must not invent a value; and otherwise `writer`
 * with the kind of failure and the full reason.
 */
export function judgeBoot(trial: TrialReport, journeys: readonly Journey[]): BootVerdict {
  const log = [trial.summary, ...trial.steps.map((s) => s.tail)].join("\n");
  const fromLog = namesFromBootLog(log);
  const names = [...new Set([
    ...(trial.return_to_screen ?? []), ...fromLog.missing, ...(trial.rejected_names ?? []), ...fromLog.rejected,
  ])].sort();
  if (names.length > 0) return { kind: "screen", names };
  // Journeys can only be clicked once the app is up. A boot that never
  // reached "renders" is a missed boot, not a missed click.
  if (trial.reached === "renders") {
    const passed = new Set((trial.probes ?? []).filter((p) => p.ok).map((p) => p.dependency));
    const missed = journeys.filter((j) => j.check !== undefined && j.check !== "" && !passed.has(j.check));
    if (missed.length > 0) {
      return {
        kind: "writer",
        code: "journeys-not-clicked",
        detail: [
          "These journeys were not clicked by the boot:",
          ...missed.map((j) => `- "${j.name}": its check "${j.check ?? ""}" did not pass`),
          "",
          bootDetail(trial),
        ].join("\n"),
      };
    }
  }
  if (trial.reached !== trial.claimed) return { kind: "writer", code: "boot-missed", detail: bootDetail(trial) };
  return { kind: "ok" };
}

/**
 * Boot the saved recipe and click the journeys: `bsf setup boot`.
 *
 * world: the outside world.
 * Returns 0 when the boot met the finish line or setup is now held on a
 * setting, 1 when the recipe step was started again with the reason, 2 when
 * setup stopped.
 */
export async function bootStep(world: SetupWorld): Promise<number> {
  const stateDir = world.git.openState();
  const manifest = join(stateDir, "manifest.json");
  if (!existsSync(manifest)) {
    return failStep(world, { step: "boot", code: "missing-file", detail: "No recipe is saved on the setup branch, so there is nothing to boot." }, "recipe");
  }
  const sha = createHash("sha256").update(readFileSync(manifest)).digest("hex");
  const secrets = await world.bsf(["sandbox", "secrets", "--file", manifest]);
  if (secrets.code !== 0) {
    return failStep(world, { step: "boot", code: "password-in-recipe", detail: secrets.out.trim() }, "recipe");
  }
  const bootedPath = join(stateDir, "booted.sha");
  const savedTrial = join(stateDir, "trial.json");
  if (existsSync(bootedPath) && readFileSync(bootedPath, "utf8").trim() === sha) {
    let last = "";
    try {
      last = bootDetail(JSON.parse(readFileSync(savedTrial, "utf8")) as TrialReport);
    } catch { /* no earlier boot log to quote */ }
    return failStep(world, {
      step: "boot",
      code: "already-booted",
      detail: `The recipe is the same file that was booted last time, so booting it again would fail the same way.${last === "" ? "" : `\nThat boot ended like this:\n${last}`}`,
    }, "recipe");
  }

  const trialPath = join(world.temp, "trial", "trial.json");
  mkdirSync(join(world.temp, "trial"), { recursive: true });
  const ran = await world.bsf(["sandbox", "trial", "--candidate", manifest, "--out", trialPath]);
  if (!existsSync(trialPath)) {
    const end = ran.out.trim().split("\n").slice(-30).join("\n");
    const empty: TrialReport = {
      schema: "sandbox-trial/1", claimed: "renders", reached: "static", steps: [], app_url: null, app_status: null, screenshot: null,
      summary: `The boot produced no log.${end === "" ? "" : ` Its output ended:\n${end}`}`,
    };
    writeFileSync(trialPath, `${JSON.stringify(empty, null, 2)}\n`);
  }
  const trial = JSON.parse(readFileSync(trialPath, "utf8")) as TrialReport;
  const verdict = judgeBoot(trial, savedJourneys(stateDir, world.root));

  if (verdict.kind === "screen") {
    await world.bsf(["env", "apply"], { DECISIONS: JSON.stringify({ replace: verdict.names }), RESUME: "false" });
    await world.bsf(["env", "scan", "--hold", STEP_WORKFLOW.boot]);
    await passStep(world, null, {
      stage: "settings",
      waiting_on: `you. The running app asked for a setting it did not get, or a vendor refused a key: ${verdict.names.join(", ")}. Answer on the settings screen, and the boot starts again by itself.`,
    });
    world.say(`held on the settings screen: ${verdict.names.join(", ")}`);
    return 0;
  }

  writeFileSync(bootedPath, `${sha}\n`);
  writeFileSync(savedTrial, readFileSync(trialPath));
  world.git.saveState("Record the boot");
  if (verdict.kind === "ok") {
    await world.dispatch(STEP_WORKFLOW.pr);
    await passStep(world, "boot", { stage: "pr", waiting_on: `the pull request being opened (${STEP_WORKFLOW.pr})` });
    world.say("the boot met the finish line");
    return 0;
  }
  return failStep(world, { step: "boot", code: verdict.code, detail: verdict.detail }, "recipe");
}

/**
 * Say where setup is and why: `bsf setup status`.
 *
 * world: the outside world.
 * live: what can be seen right now and is not in the record: which
 * credentials are missing and which setup workflows are running. The caller
 * looks those up, because a person's own login can see them and a job's
 * token cannot.
 * json: true to print the record and the live facts as JSON.
 * Returns 0.
 */
export async function statusStep(
  world: Pick<SetupWorld, "readJson" | "say">,
  live: { readonly missing: readonly string[]; readonly running: readonly { readonly name: string; readonly url: string }[] },
  json: boolean,
): Promise<number> {
  const record = await world.readJson<SetupRecord>(SETUP_RECORD_PATH);
  const wait = await world.readJson<WaitFile>(WAIT_PATH);
  const settingsWaiting = (wait?.names ?? []).filter((n) => n.decision === "missing" || n.decision === "replace").map((n) => n.name);
  if (json) {
    world.say(JSON.stringify({ record, missing: live.missing, settings_waiting: settingsWaiting, running: live.running }, null, 2));
    return 0;
  }
  for (const line of statusLines(record, { missing: live.missing, settingsWaiting, running: live.running })) world.say(line);
  return 0;
}

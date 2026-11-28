/**
 * setup-record.ts — where setup is, what it is waiting on, and why the last failure happened.
 *
 * WHY THIS EXISTS
 *
 * Setup is a chain of separate GitHub workflows: the journey list and the
 * standard rules, then the recipe, then the boot, then the pull request. When
 * one of them failed, the only thing written down was a fixed sentence such
 * as "the recipe was not saved". The real reason (which journey was missing,
 * which build step broke) stayed in a log nobody was pointed at. The step
 * that ran again was told nothing, and "the same failure twice" compared two
 * copies of the fixed sentence, so it was always true.
 *
 * This file is the one record every setup step reads and writes. It keeps:
 *
 *   - the stage setup has reached, and what it is waiting on, in words;
 *   - every failure with its full reason;
 *   - which workflow was started again, and the failure it has to fix.
 *
 * `bsf setup status` prints it. The next run of a step is handed the failure
 * that caused it.
 *
 * KEY TERMS
 *
 *   - Step: one unit that can fail: journeys, rules, recipe, boot, or pr.
 *   - Stage: where the whole of setup is: before those steps, in one of
 *     them, done, or stopped.
 *   - Failure: a step, a short code that names the kind of failure
 *     (`shape`, `boot-missed`), and the detail: the full text of what went
 *     wrong. Never a secret value.
 *   - Same reason: two failures of one step with the same code and the same
 *     detail, once things that differ on every run (hashes, timings, run
 *     numbers) are taken out.
 *   - Stop: setup does not start the step again. It happens when a step
 *     fails for the same reason twice in a row, or three times in a row for
 *     any reasons. This is a limit on retries, not a repair of anything.
 *
 * EXPORTS
 *
 *   - SETUP_RECORD_PATH, MAX_FAILURES, STEP_WORKFLOW.
 *   - SetupStep, SetupStage, Failure, SetupRecord.
 *   - emptyRecord, readRecord, sameReason, noteFailure, noteSuccess,
 *     statusLines.
 */

/** Where the record lives on the factory's data ref. */
export const SETUP_RECORD_PATH = "env/setup.json";

/** How many times in a row one step may fail before setup stops. */
export const MAX_FAILURES = 3;

/** The longest failure detail that is kept. Longer text keeps its start and its end. */
const MAX_DETAIL = 6000;

export type SetupStep = "start" | "journeys" | "rules" | "recipe" | "boot" | "pr";

export type SetupStage = "not-started" | "settings" | "journeys-and-rules" | "recipe" | "boot" | "pr" | "done" | "stopped";

/** The workflow that runs each step. */
export const STEP_WORKFLOW: Readonly<Record<SetupStep, string>> = {
  start: "factory-setup.yml",
  journeys: "factory-setup-journeys.yml",
  rules: "factory-setup-rules.yml",
  recipe: "factory-setup-recipe.yml",
  boot: "factory-setup-boot.yml",
  pr: "factory-setup-pr.yml",
};

/** One failure of one step, with its full reason. */
export interface Failure {
  readonly step: SetupStep;
  /** The kind of failure, as a short stable word. */
  readonly code: string;
  /** What actually went wrong, in full. No secret values. */
  readonly detail: string;
  /** When it happened, as an ISO timestamp. */
  readonly at: string;
  /** The GitHub run that failed, when known. */
  readonly run: string | null;
}

/** The whole record. */
export interface SetupRecord {
  readonly stage: SetupStage;
  /** Who or what setup is waiting on, as one sentence. */
  readonly waiting_on: string;
  /** Failures in a row for each step, oldest first. Emptied when the step succeeds. */
  readonly failures: Readonly<Partial<Record<SetupStep, readonly Failure[]>>>;
  /** The most recent failure of any step. Kept after a later success, as history. */
  readonly last_failure: Failure | null;
  /** The workflow that was started again, and the failure it is there to fix. */
  readonly retry: { readonly workflow: string; readonly because: Failure } | null;
  /** The request this setup was started with: an amendment or one new journey. Null for a first setup. */
  readonly request: string | null;
  /** The setup pull request, once it is open. */
  readonly pull: number | null;
  readonly updated_at: string;
}

/**
 * A record for a setup that has not run a step yet.
 *
 * now: the current time as an ISO timestamp.
 * request: the amendment or new-journey request it was started with, or null.
 */
export function emptyRecord(now: string, request: string | null = null): SetupRecord {
  return {
    stage: "not-started",
    waiting_on: "setup to start",
    failures: {},
    last_failure: null,
    retry: null,
    request,
    pull: null,
    updated_at: now,
  };
}

/**
 * A record read from storage, with anything missing filled in.
 *
 * raw: the parsed JSON, or null when nothing was stored.
 * now: the current time, used only when there is no record.
 */
export function readRecord(raw: unknown, now: string): SetupRecord {
  if (raw === null || typeof raw !== "object") return emptyRecord(now);
  const got = raw as Partial<SetupRecord>;
  return { ...emptyRecord(now), ...got, failures: got.failures ?? {} };
}

/**
 * The text of a failure with the parts that differ on every run removed.
 *
 * detail: the failure's full text.
 * Returns lower-case text with runs of spaces collapsed and long hex
 * strings, durations and run numbers replaced, so two runs that failed the
 * same way compare equal.
 */
function comparable(detail: string): string {
  return detail
    .toLowerCase()
    .replace(/\b[0-9a-f]{12,}\b/g, "<hash>")
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|seconds|m|min)\b/g, "<time>")
    .replace(/\/runs\/\d+/g, "/runs/<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether two failures happened for the same reason.
 *
 * a: one failure.
 * b: another failure of the same step.
 */
export function sameReason(a: Failure, b: Failure): boolean {
  return a.step === b.step && a.code === b.code && comparable(a.detail) === comparable(b.detail);
}

/**
 * Keep a long detail readable: its start and its end, with the middle cut.
 *
 * detail: the full text.
 */
function bounded(detail: string): string {
  const text = detail.trim();
  if (text.length <= MAX_DETAIL) return text;
  const half = Math.floor(MAX_DETAIL / 2);
  return `${text.slice(0, half)}\n[... ${text.length - MAX_DETAIL} characters left out ...]\n${text.slice(-half)}`;
}

/**
 * Add a failure to the record and say whether setup has to stop.
 *
 * record: the record so far.
 * failure: what just went wrong.
 * Returns the next record and why setup stops: "same" when this step failed
 * for the same reason last time, "limit" when it has now failed three times
 * in a row, or null when the step may be started again.
 */
export function noteFailure(record: SetupRecord, failure: Failure): {
  readonly record: SetupRecord;
  readonly stop: "same" | "limit" | null;
} {
  const kept: Failure = { ...failure, detail: bounded(failure.detail) };
  const before = record.failures[failure.step] ?? [];
  const previous = before[before.length - 1];
  const row = [...before, kept];
  let stop: "same" | "limit" | null = null;
  if (previous !== undefined && sameReason(previous, kept)) stop = "same";
  else if (row.length >= MAX_FAILURES) stop = "limit";
  return {
    record: {
      ...record,
      failures: { ...record.failures, [failure.step]: row },
      last_failure: kept,
      updated_at: failure.at,
    },
    stop,
  };
}

/**
 * Clear a step's failures after it succeeded.
 *
 * record: the record so far.
 * step: the step that just succeeded.
 * now: the current time as an ISO timestamp.
 * Returns the next record. A retry that named this step's workflow is
 * cleared too, because the thing it was started to fix is fixed.
 */
export function noteSuccess(record: SetupRecord, step: SetupStep, now: string): SetupRecord {
  const failures = { ...record.failures };
  delete failures[step];
  const retry = record.retry !== null && record.retry.workflow === STEP_WORKFLOW[step] ? null : record.retry;
  return { ...record, failures, retry, updated_at: now };
}

/** What each stage is called when it is printed. */
const STAGE_NAMES: Readonly<Record<SetupStage, string>> = {
  "not-started": "not started",
  settings: "the settings (step 1 of 5)",
  "journeys-and-rules": "the journey list and the standard rules (step 2 of 5)",
  recipe: "the recipe (step 3 of 5)",
  boot: "the boot (step 4 of 5)",
  pr: "the pull request (step 5 of 5)",
  done: "done",
  stopped: "stopped",
};

/**
 * The record as the lines `bsf setup status` prints.
 *
 * record: the record, or null when setup has never written one.
 * live: what is true right now and is not in the record: credentials that
 * are missing, settings still waiting for an answer, and setup workflows
 * that are running. Each list may be empty.
 * Returns the lines, in the order a person needs them: where setup is, what
 * it is waiting on, then the last failure with its full reason.
 */
export function statusLines(
  record: SetupRecord | null,
  live: {
    readonly missing: readonly string[];
    readonly settingsWaiting: readonly string[];
    readonly running: readonly { readonly name: string; readonly url: string }[];
  },
): readonly string[] {
  const lines: string[] = [];
  lines.push(`Step: ${STAGE_NAMES[record?.stage ?? "not-started"]}`);
  if (live.missing.length > 0) {
    lines.push("Waiting on: you. Setup cannot run until these exist:");
    for (const name of live.missing) lines.push(`  - ${name}`);
  } else if (live.settingsWaiting.length > 0) {
    lines.push(`Waiting on: you. ${live.settingsWaiting.length} setting(s) need an answer on the settings screen:`);
    for (const name of live.settingsWaiting) lines.push(`  - ${name}`);
  } else {
    lines.push(`Waiting on: ${record?.waiting_on ?? "setup to start"}`);
  }
  if (live.running.length > 0) {
    lines.push("Running now:");
    for (const run of live.running) lines.push(`  - ${run.name}  ${run.url}`);
  } else if (record !== null && record.stage !== "done" && record.stage !== "stopped" && record.stage !== "not-started") {
    lines.push("Running now: nothing");
  }
  if (record?.pull !== null && record?.pull !== undefined) lines.push(`Pull request: #${record.pull}`);
  const failure = record?.last_failure ?? null;
  if (failure === null) {
    lines.push("Last failure: none");
    return lines;
  }
  const row = record?.failures[failure.step] ?? [];
  const count = row.length === 0 ? "the step has succeeded since" : `${row.length} in a row`;
  lines.push(`Last failure: ${failure.step}, ${failure.code}, at ${failure.at} (${count})`);
  if (failure.run !== null) lines.push(`  run: ${failure.run}`);
  for (const line of failure.detail.split("\n")) lines.push(`  ${line}`);
  if (record?.retry !== null && record?.retry !== undefined) {
    lines.push(`Started again: ${record.retry.workflow}, with that reason`);
  }
  return lines;
}

/**
 * What the person decided for each configuration name, and what is still waiting.
 *
 * Purpose:
 *     The scan finds names. This file says what those names mean once the
 *     person has chosen, and it builds the list the screen and the dashboard
 *     show. It does not read or write secret values. A name is "use it" when
 *     its key is already in FACTORY_SANDBOX_ENV. "Fake it" and "ignore this
 *     key" are remembered here, and either can be undone.
 *
 * Key terms:
 *     - Use it: the value lives in the GitHub secret. Only the key is known
 *       here.
 *     - Fake it: a real production credential. The boot may stand in for it.
 *       The value is never stored.
 *     - Ignore this key: the name is not an app setting. Choosing it once
 *       remembers the name so the scan does not pause on it again.
 *     - Replace: a development key the vendor rejected. The old decision
 *       stays for every other name. This name is waiting for a new value.
 *     - Queue: a factory job that was about to start. It stays here until
 *       the list has no undecided names, and then it is started. It is not
 *       thrown away.
 *
 * Exports:
 *     - emptyDecisions, parseDecisions: the remembered choices.
 *     - applyChoice: one screen choice, including undo.
 *     - buildWait: the list, the count, and the queue.
 *     - waitingCount: how many names still block a job.
 */

import { isBuiltinSkip, isClientName, type ConfigNameScan, type SignInVendor } from "./env-names.js";

/** One remembered choice. Values are never stored. */
export interface EnvDecisions {
  /** Names the person marked to fake. A local stand-in is allowed only for these. */
  readonly fake: readonly string[];
  /** Names the person chose to ignore. The scan does not ask again. */
  readonly ignore: readonly string[];
  /** Names whose current value was rejected and must be replaced. */
  readonly replace: readonly string[];
  /** Sign-in vendors taken off the finish line. */
  readonly skipped_sign_in: readonly string[];
}

/** How the screen shows one name. */
export type DecisionKind = "missing" | "use" | "fake" | "ignore" | "replace";

/** One row of the screen. */
export interface WaitName {
  readonly name: string;
  readonly where: string;
  readonly decision: DecisionKind;
  /** True when the browser bundle reads this name, so it has to be present at build. */
  readonly client: boolean;
}

/** A job that paused before any model ran. */
export interface QueuedJob {
  readonly workflow: string;
  readonly inputs: Readonly<Record<string, string>>;
}

/** The file the dashboard reads. It has no secret values. */
export interface WaitFile {
  readonly names: readonly WaitName[];
  readonly dynamic: readonly string[];
  readonly sign_in: readonly SignInVendor[];
  readonly queue: readonly QueuedJob[];
  readonly waiting: number;
}

export const DECISIONS_PATH = "env/decisions.json";
export const WAIT_PATH = "env/wait.json";
export const NEXT_PATH = "env/setup-next.json";
export const FAILURES_PATH = "env/failures.json";
export const JOURNEY_HEADINGS_PATH = "env/journey-headings.json";

/** Where the recipe workflow goes after it saves. Boot is the usual next step. */
export interface SetupNext {
  readonly after_recipe: "boot" | "pr";
}

/**
 * No choices yet.
 *
 * Returns an empty decisions object. Every list is empty, so every scanned
 * name that is not already in the secret is still missing.
 */
export function emptyDecisions(): EnvDecisions {
  return { fake: [], ignore: [], replace: [], skipped_sign_in: [] };
}

/**
 * Read decisions from JSON that may be missing or the wrong shape.
 *
 * raw: parsed JSON, or null when the file does not exist.
 * Returns the four lists. Anything that is not a string is dropped.
 */
export function parseDecisions(raw: unknown): EnvDecisions {
  const obj = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const list = (key: string): string[] => {
    const v = obj[key];
    if (!Array.isArray(v)) return [];
    return [...new Set(v.filter((x): x is string => typeof x === "string" && x !== ""))].sort();
  };
  return {
    fake: list("fake"),
    ignore: list("ignore"),
    replace: list("replace"),
    skipped_sign_in: list("skipped_sign_in"),
  };
}

/**
 * Apply one choice from the screen.
 *
 * decisions: the choices so far.
 * name: the configuration name, or a sign-in vendor when choice is skip.
 * choice: use, fake, ignore, undo, or skip. Use means the value was put in
 * the secret by the caller; this function only forgets a fake, ignore, or
 * replace mark for that name. Undo puts the name back to undecided.
 * Returns the next decisions. The input is not changed.
 */
export function applyChoice(decisions: EnvDecisions, name: string, choice: "use" | "fake" | "ignore" | "undo" | "skip"): EnvDecisions {
  const drop = (list: readonly string[]): string[] => list.filter((x) => x !== name);
  const add = (list: readonly string[]): string[] => [...new Set([...list, name])].sort();
  if (choice === "skip") {
    return { ...decisions, skipped_sign_in: add(decisions.skipped_sign_in) };
  }
  if (choice === "undo") {
    return {
      fake: drop(decisions.fake),
      ignore: drop(decisions.ignore),
      replace: drop(decisions.replace),
      skipped_sign_in: drop(decisions.skipped_sign_in),
    };
  }
  const base: EnvDecisions = {
    fake: drop(decisions.fake),
    ignore: drop(decisions.ignore),
    replace: drop(decisions.replace),
    skipped_sign_in: decisions.skipped_sign_in,
  };
  if (choice === "fake") return { ...base, fake: add(base.fake) };
  if (choice === "ignore") return { ...base, ignore: add(base.ignore) };
  return base;
}

/**
 * Merge a batch of choices. Names in undo are cleared. Then fake, ignore,
 * and skip are applied. Replace is kept unless the name was just used.
 *
 * current: the choices on record.
 * patch: the screen's save. use is the names whose values were written into
 * the secret by the caller.
 * Returns the merged decisions.
 */
export function mergeDecisions(current: EnvDecisions, patch: {
  readonly use?: readonly string[];
  readonly fake?: readonly string[];
  readonly ignore?: readonly string[];
  readonly undo?: readonly string[];
  readonly skip?: readonly string[];
  readonly replace?: readonly string[];
}): EnvDecisions {
  let next = current;
  for (const name of patch.undo ?? []) next = applyChoice(next, name, "undo");
  for (const name of patch.use ?? []) next = applyChoice(next, name, "use");
  for (const name of patch.fake ?? []) next = applyChoice(next, name, "fake");
  for (const name of patch.ignore ?? []) next = applyChoice(next, name, "ignore");
  for (const name of patch.skip ?? []) next = applyChoice(next, name, "skip");
  if ((patch.replace ?? []).length > 0) {
    next = { ...next, replace: [...new Set([...next.replace, ...(patch.replace ?? [])])].sort() };
  }
  return next;
}

/**
 * The screen's list for one scan.
 *
 * scan: names the code reads, plus dynamic files and sign-in vendors.
 * decisions: fake, ignore, replace, and skipped sign-in.
 * secretKeys: the keys present in FACTORY_SANDBOX_ENV. Values are not passed.
 * queue: jobs already waiting. A new hold is added by the caller.
 * Returns every decided and undecided name, the unknown files, and how many
 * names still block a job. Built-in skips are left out. A name the code no
 * longer reads is not in this list; it stays in the secret and does not pause.
 */
export function buildWait(
  scan: ConfigNameScan,
  decisions: EnvDecisions,
  secretKeys: ReadonlySet<string>,
  queue: readonly QueuedJob[],
): WaitFile {
  const fake = new Set(decisions.fake);
  const ignore = new Set(decisions.ignore);
  const replace = new Set(decisions.replace);
  const names: WaitName[] = [];
  for (const [name, where] of scan.names) {
    if (isBuiltinSkip(name)) continue;
    let decision: DecisionKind = "missing";
    if (replace.has(name)) decision = "replace";
    else if (fake.has(name)) decision = "fake";
    else if (ignore.has(name)) decision = "ignore";
    else if (secretKeys.has(name)) decision = "use";
    names.push({ name, where, decision, client: isClientName(name) });
  }
  names.sort((a, b) => a.name.localeCompare(b.name));
  const skipped = new Set(decisions.skipped_sign_in);
  return {
    names,
    dynamic: scan.dynamic,
    sign_in: scan.signIn.filter((s) => !skipped.has(s.vendor)),
    queue,
    waiting: waitingCount(names),
  };
}

/**
 * How many names still block a factory job.
 *
 * names: the screen rows.
 * Returns the count of missing and replacement rows. Fake, ignore, and use
 * do not count. A sign-in the person skipped is not a row here.
 */
export function waitingCount(names: readonly WaitName[]): number {
  return names.filter((n) => n.decision === "missing" || n.decision === "replace").length;
}

/**
 * Add a job to the queue unless the same workflow and inputs are already there.
 *
 * queue: the jobs already waiting.
 * job: the workflow that just paused, with the inputs it was given.
 * Returns the next queue. The same job is not listed twice.
 */
export function enqueue(queue: readonly QueuedJob[], job: QueuedJob): QueuedJob[] {
  const key = (j: QueuedJob): string => `${j.workflow}\n${JSON.stringify(j.inputs)}`;
  if (queue.some((j) => key(j) === key(job))) return [...queue];
  return [...queue, { workflow: job.workflow, inputs: { ...job.inputs } }];
}

/**
 * Headings a person can still click, in the order they appear.
 *
 * markdown: the journey list.
 * Returns the level-two headings that are still on the finish line. A heading
 * after a line that says the rest are not on the finish line is left out.
 */
export function finishLineJourneys(markdown: string): readonly string[] {
  const out: string[] = [];
  let off = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/not on the finish line/i.test(line)) {
      off = true;
      continue;
    }
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m?.[1] === undefined || off) continue;
    if (/not on the finish line/i.test(m[1])) {
      off = true;
      continue;
    }
    out.push(m[1].trim());
  }
  return out;
}

/**
 * Whether the same failure text has been seen for this step.
 *
 * previous: the last summary recorded for the step, or null.
 * summary: the summary of the failure that just happened.
 * Returns true when both are the same non-empty text.
 */
export function sameFailure(previous: string | null, summary: string): boolean {
  const next = summary.trim();
  return next !== "" && previous !== null && previous.trim() === next;
}

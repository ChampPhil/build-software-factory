/**
 * The env commands the workflows and the screen call.
 *
 * Purpose:
 *     `bsf env scan` runs before a factory job and refuses to let a model
 *     start while a configuration name has no decision. `bsf env resume`
 *     starts the jobs that were waiting, once the list is clear. Nothing
 *     here prints a secret value. Names, files, and line numbers are the
 *     only text that leaves the process.
 *
 * Key terms:
 *     - Hold: the workflow that was about to start. It is written onto the
 *       queue and is not thrown away.
 *     - Names file: a list of keys, one per line, with no values. The local
 *       screen uses it because the secret cannot be read back.
 *     - Data ref: refs/factory/data, where the decisions and the queue live
 *       so a later job on a fresh checkout can see them.
 *
 * Exports:
 *     - envCommand: the `bsf env` entry point.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { scanConfigNames } from "./env-names.js";
import {
  DECISIONS_PATH, WAIT_PATH, applyChoice, buildWait, emptyDecisions, enqueue, mergeDecisions, parseDecisions,
  type EnvDecisions, type QueuedJob, type WaitFile,
} from "./env-state.js";
import { parseDotenv } from "./sandbox.js";
import { DataRefStore } from "../lib/dataref.js";
import { GitHub } from "../lib/github.js";

/**
 * Run one `bsf env` subcommand.
 *
 * second: scan, list, apply, resume, or skipped.
 * args: the flags. --root is the checkout. --hold is the workflow to queue.
 * --inputs is a JSON object of workflow inputs. --names-file is keys only.
 * Returns 0 when the list is clear, 1 when names are still waiting, 2 when
 * the command line is wrong.
 */
export async function envCommand(second: string | undefined, args: Record<string, string | boolean>): Promise<number> {
  const root = typeof args["root"] === "string" ? args["root"] : process.cwd();
  if (second === "scan") return scanCommand(root, args);
  if (second === "list") return listCommand(root, args);
  if (second === "apply") return applyCommand(root);
  if (second === "resume") return resumeCommand(root);
  if (second === "skipped") return skippedCommand(root);
  process.stderr.write("usage: bsf env scan|list|apply|resume|skipped\n");
  return 2;
}

/**
 * Open the data ref when this process knows which repository it is in.
 *
 * Returns the store, or null when there is no repository to write to.
 * A missing token makes later calls fail; the caller keeps the local file.
 */
function storeOrNull(): { store: DataRefStore; gh: GitHub } | null {
  const repo = process.env["GITHUB_REPOSITORY"];
  if (repo === undefined || repo === "") return null;
  const gh = new GitHub({ repo });
  return { store: new DataRefStore(gh), gh };
}

/**
 * Decisions from the checkout file and the data ref, combined.
 *
 * root: the checkout.
 * Returns the union. A name marked in either place stays marked.
 */
async function loadDecisions(root: string): Promise<EnvDecisions> {
  let local = emptyDecisions();
  const path = join(root, ".factory", "env-decisions.json");
  if (existsSync(path)) {
    try {
      local = parseDecisions(JSON.parse(readFileSync(path, "utf8")));
    } catch { /* unreadable file means no local choices */ }
  }
  const remote = storeOrNull();
  if (remote === null) return local;
  try {
    const text = await remote.store.read(DECISIONS_PATH);
    const parsed = text === null ? emptyDecisions() : parseDecisions(JSON.parse(text));
    return mergeDecisions(parsed, { fake: local.fake, ignore: local.ignore, replace: local.replace, skip: local.skipped_sign_in });
  } catch {
    return local;
  }
}

/**
 * Write decisions to the checkout and, when a repository is known, the data ref.
 *
 * root: the checkout.
 * decisions: the choices. No values.
 */
async function saveDecisions(root: string, decisions: EnvDecisions): Promise<void> {
  const dir = join(root, ".factory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "env-decisions.json"), `${JSON.stringify(decisions, null, 2)}\n`);
  const remote = storeOrNull();
  if (remote === null) return;
  await remote.store.updateJson(DECISIONS_PATH, () => ({ next: decisions, result: true }), "Remember configuration decisions");
}

/**
 * Keys in the secret, plus keys named in a file that has no values.
 *
 * args: --names-file is optional.
 * Returns the set of names. The secret text is not kept.
 */
function secretKeys(args: Record<string, string | boolean>): Set<string> {
  const keys = new Set(Object.keys(parseDotenv(process.env["FACTORY_SANDBOX_ENV"] ?? "")));
  const file = args["names-file"];
  if (typeof file === "string" && existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const name = line.trim();
      if (name !== "" && !name.startsWith("#")) keys.add(name);
    }
  }
  return keys;
}

/**
 * The current queue, from the data ref.
 *
 * Returns the jobs still waiting. A missing file is an empty queue.
 */
async function loadQueue(): Promise<QueuedJob[]> {
  const remote = storeOrNull();
  if (remote === null) return [];
  try {
    const text = await remote.store.read(WAIT_PATH);
    if (text === null) return [];
    const parsed = JSON.parse(text) as { queue?: QueuedJob[] };
    return Array.isArray(parsed.queue) ? parsed.queue : [];
  } catch {
    return [];
  }
}

/**
 * Write the wait file the dashboard reads.
 *
 * wait: the names and decisions from this scan. No values.
 * extra: a job to add to the queue, or null to leave the queue as it is.
 * The queue is read inside the write, so two jobs pausing at once both stay.
 */
async function saveWait(wait: WaitFile, extra: QueuedJob | null): Promise<void> {
  const remote = storeOrNull();
  if (remote === null) return;
  await remote.store.updateJson(WAIT_PATH, (current: WaitFile | null) => {
    const queue = extra === null ? (current?.queue ?? []) : enqueue(current?.queue ?? [], extra);
    return { next: { ...wait, queue }, result: true };
  }, "Record which settings are waiting");
}

/**
 * Scan, record the queue when a name is waiting, and say how many.
 *
 * root: the checkout.
 * args: --hold and --inputs queue this job. --names-file adds keys.
 * Returns 0 when nothing is waiting, 1 when the job must not start a model.
 * `--gate` still writes the `ready` output and always exits 0, so a workflow
 * that is holding on a setting is waiting, not failed.
 */
async function scanCommand(root: string, args: Record<string, string | boolean>): Promise<number> {
  const scan = scanConfigNames(root);
  const decisions = await loadDecisions(root);
  const hold = args["hold"];
  let extra: QueuedJob | null = null;
  if (typeof hold === "string" && hold !== "") {
    let inputs: Record<string, string> = {};
    if (typeof args["inputs"] === "string" && args["inputs"] !== "") {
      const parsed = JSON.parse(args["inputs"]) as Record<string, unknown>;
      inputs = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    }
    extra = { workflow: hold, inputs };
  }
  const wait = buildWait(scan, decisions, secretKeys(args), extra === null ? [] : [extra]);
  await saveWait(wait, wait.waiting > 0 ? extra : null);
  const gate = args["gate"] === true;
  if (wait.waiting === 0) {
    process.stdout.write("every setting has a decision\n");
    if (gate) writeReady("true");
    return 0;
  }
  process.stdout.write(`${wait.waiting} setting${wait.waiting === 1 ? " is" : "s are"} waiting\n`);
  for (const row of wait.names) {
    if (row.decision === "missing" || row.decision === "replace") {
      process.stdout.write(`${row.name} ${row.where} ${row.decision}\n`);
    }
  }
  for (const file of wait.dynamic) process.stdout.write(`unknown ${file}\n`);
  if (gate) {
    writeReady("false");
    return 0;
  }
  return 1;
}

/**
 * Write the `ready` step output, when this process is inside Actions.
 *
 * value: `true` or `false`.
 */
function writeReady(value: "true" | "false"): void {
  const file = process.env["GITHUB_OUTPUT"];
  if (file === undefined) {
    process.stdout.write(`ready=${value}\n`);
    return;
  }
  const mark = `__bsf_${Math.random().toString(36).slice(2)}`;
  appendFileSync(file, `ready<<${mark}\n${value}\n${mark}\n`);
}

/**
 * Print the screen's list as JSON. Values are not included.
 *
 * root: the checkout.
 * args: --names-file adds keys that are already chosen.
 * Returns 0.
 */
async function listCommand(root: string, args: Record<string, string | boolean>): Promise<number> {
  const scan = scanConfigNames(root);
  const decisions = await loadDecisions(root);
  const wait = buildWait(scan, decisions, secretKeys(args), await loadQueue());
  process.stdout.write(`${JSON.stringify(wait)}\n`);
  return 0;
}

/**
 * Save the screen's choices from the DECISIONS environment variable.
 *
 * The variable is JSON with use, fake, ignore, undo, skip, and replace
 * arrays of names. It has no values. Names in `use` are treated as present
 * even when the secret this job was started with does not yet list them:
 * the screen wrote those values just before this job, and the injected
 * secret can lag. Saving the choices is success; a remaining wait is
 * printed as information. The queued jobs start only when nothing is
 * waiting.
 * root: the checkout.
 * Returns 0 after the choices are saved. A parse error of DECISIONS is 2.
 */
async function applyCommand(root: string): Promise<number> {
  const raw = process.env["DECISIONS"] ?? "{}";
  const patch = JSON.parse(raw) as {
    use?: string[]; fake?: string[]; ignore?: string[]; undo?: string[]; skip?: string[]; replace?: string[];
  };
  const next = mergeDecisions(await loadDecisions(root), patch);
  await saveDecisions(root, next);
  const scan = scanConfigNames(root);
  const queue = await loadQueue();
  const keys = secretKeys({});
  for (const name of patch.use ?? []) keys.add(name);
  const wait = buildWait(scan, next, keys, queue);
  await saveWait(wait, null);
  if (wait.waiting > 0) {
    process.stdout.write(`${wait.waiting} setting${wait.waiting === 1 ? " is" : "s are"} waiting\n`);
    return 0;
  }
  process.stdout.write("every setting has a decision\n");
  if (process.env["RESUME"] !== "false") return resumeCommand(root);
  return 0;
}

/**
 * Start every queued job, now that nothing is waiting.
 *
 * root: the checkout, scanned again so a stale queue is not started early.
 * Returns 0 after the jobs are dispatched, or 1 when a name is still waiting.
 * An empty queue is success.
 */
async function resumeCommand(root: string): Promise<number> {
  const scan = scanConfigNames(root);
  const decisions = await loadDecisions(root);
  const queue = await loadQueue();
  const wait = buildWait(scan, decisions, secretKeys({}), queue);
  if (wait.waiting > 0) {
    process.stdout.write(`${wait.waiting} setting${wait.waiting === 1 ? " is" : "s are"} waiting\n`);
    return 1;
  }
  const remote = storeOrNull();
  const key = (j: QueuedJob): string => `${j.workflow}\n${JSON.stringify(j.inputs)}`;
  const taken = new Set(queue.map(key));
  if (remote !== null) {
    await remote.store.updateJson(WAIT_PATH, (current: WaitFile | null) => {
      const left = (current?.queue ?? []).filter((j) => !taken.has(key(j)));
      return { next: { ...wait, queue: left }, result: true };
    }, "Clear the settings queue");
    for (const job of queue) {
      await remote.gh.dispatchWorkflow(job.workflow, undefined, job.inputs);
      process.stdout.write(`started ${job.workflow}\n`);
    }
    return 0;
  }
  for (const job of queue) process.stdout.write(`queued ${job.workflow}\n`);
  return 0;
}

/**
 * Print the sign-in vendors the person took off the finish line.
 *
 * root: the checkout.
 * Returns 0. The JSON has no secret values.
 */
async function skippedCommand(root: string): Promise<number> {
  const decisions = await loadDecisions(root);
  process.stdout.write(`${JSON.stringify({ skipped_sign_in: decisions.skipped_sign_in })}\n`);
  return 0;
}

/**
 * One choice, used by the local screen when it already saved the value.
 *
 * root: the checkout.
 * name: the configuration name or the vendor.
 * choice: use, fake, ignore, undo, or skip.
 */
export async function decideOne(root: string, name: string, choice: "use" | "fake" | "ignore" | "undo" | "skip"): Promise<void> {
  const next = applyChoice(await loadDecisions(root), name, choice);
  await saveDecisions(root, next);
}

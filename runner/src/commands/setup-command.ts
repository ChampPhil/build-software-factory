/**
 * The setup commands that chain one step to the next.
 *
 * Purpose:
 *     Each setup step is its own workflow. These commands copy a step onto
 *     the branch, decide which workflow runs next, and stop when the same
 *     failure happens twice. They do not print secret values.
 *
 * Key terms:
 *     - Advance: after a step is saved, start the next one. The journey list
 *       and the standard rules both have to be saved before the recipe starts.
 *     - Same failure: the summary matches the previous one for that step.
 *       The second time opens one issue and does not start the step again.
 *     - Judge: read the boot log and say whether the finish line was met,
 *       whether the writer should run again, or whether the person has to
 *       answer a missing name on the screen.
 *
 * Exports:
 *     - setupCommand: the `bsf setup` entry point.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishSetupStep } from "./setup-flow.js";
import { deletedJourneyProblem, namesFromBootLog, signedInJourneyProblem, unclickedJourneys, vendorLoginWaiting } from "./boot-checks.js";
import { FAILURES_PATH, JOURNEY_HEADINGS_PATH, NEXT_PATH, finishLineJourneys, sameFailure, type SetupNext } from "./env-state.js";
import { DataRefStore } from "../lib/dataref.js";
import { GitHub } from "../lib/github.js";

/**
 * Run one `bsf setup` subcommand.
 *
 * second: publish, journeys, advance, failed, or judge.
 * args: the flags for that subcommand.
 * Returns 0 on success, 1 when the step should be tried again, 2 when setup
 * has stopped or the command line is wrong.
 */
export async function setupCommand(second: string | undefined, args: Record<string, string | boolean>): Promise<number> {
  if (second === "publish") return publishCommand(args);
  if (second === "journeys") return journeysCommand(args);
  if (second === "advance") return advanceCommand(args);
  if (second === "failed") return failedCommand(args);
  if (second === "judge") return judgeCommand(args);
  if (second === "reset") return resetCommand();
  process.stderr.write("usage: bsf setup publish|journeys|advance|failed|judge\n");
  return 2;
}

/**
 * The repository client, or null outside GitHub.
 *
 * Returns the client when GITHUB_REPOSITORY is set.
 */
function githubOrNull(): { store: DataRefStore; gh: GitHub; repo: string } | null {
  const repo = process.env["GITHUB_REPOSITORY"];
  if (repo === undefined || repo === "") return null;
  const gh = new GitHub({ repo });
  return { store: new DataRefStore(gh), gh, repo };
}

/**
 * Copy one step's files.
 *
 * args: --from is the artifact directory, --into is the setup-state directory.
 * Returns 0 when the copy is done, 1 when a password or a deleted journey
 * refused it.
 */
function publishCommand(args: Record<string, string | boolean>): number {
  const from = typeof args["from"] === "string" ? args["from"] : "";
  const into = typeof args["into"] === "string" ? args["into"] : "";
  if (from === "" || into === "") {
    process.stderr.write("usage: bsf setup publish --from DIR --into DIR\n");
    return 2;
  }
  try {
    const copied = publishSetupStep(from, into);
    process.stdout.write(copied.length === 0 ? "nothing to save\n" : `saved ${copied.join(", ")}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

/**
 * An app with sign-in needs a signed-in journey, unless the person skipped it.
 *
 * args: --file is the journey list, --root is the checkout.
 * Returns 0 when the list is acceptable, 1 when it must be written again.
 */
async function journeysCommand(args: Record<string, string | boolean>): Promise<number> {
  const file = typeof args["file"] === "string" ? args["file"] : "";
  const root = typeof args["root"] === "string" ? args["root"] : process.cwd();
  if (file === "" || !existsSync(file)) {
    process.stderr.write("usage: bsf setup journeys --file PATH [--root DIR]\n");
    return 2;
  }
  const list = readFileSync(file, "utf8");
  let skipped: string[] = [];
  const remote = githubOrNull();
  if (remote !== null) {
    try {
      const text = await remote.store.read("env/decisions.json");
      if (text !== null) {
        const parsed = JSON.parse(text) as { skipped_sign_in?: string[] };
        skipped = parsed.skipped_sign_in ?? [];
      }
      const headings = finishLineJourneys(list);
      await remote.store.updateJson(JOURNEY_HEADINGS_PATH, () => ({ next: { headings }, result: true }), "Remember the journey list");
    } catch { /* the check still runs from the file */ }
  }
  const problem = signedInJourneyProblem(list, root, skipped);
  if (problem !== null) {
    process.stderr.write(`${problem}\n`);
    return 1;
  }
  process.stdout.write("the journey list is on the finish line\n");
  return 0;
}

/**
 * Start the next setup workflow.
 *
 * args: --from is journeys, rules, or recipe. --state is the setup-state
 * directory on the branch that was just pushed.
 * Returns 0 when the next workflow was started or is waiting on the other
 * step. Returns 1 when there is nothing to start.
 */
async function advanceCommand(args: Record<string, string | boolean>): Promise<number> {
  const from = typeof args["from"] === "string" ? args["from"] : "";
  const state = typeof args["state"] === "string" ? args["state"] : ".factory/setup-state";
  const remote = githubOrNull();
  if (remote === null) {
    process.stderr.write("no repository to start the next step in\n");
    return 1;
  }
  if (from === "journeys" || from === "rules") {
    const journeys = existsSync(join(state, "context", "journeys.md"));
    const rules = existsSync(join(state, "rules.done")) || existsSync(join(state, "guardrails.patch"));
    if (!journeys || !rules) {
      process.stdout.write("waiting for the other step\n");
      return 0;
    }
    const journeysFile = join(state, "context", "journeys.md");
    const rulesFile = existsSync(join(state, "rules.done")) ? join(state, "rules.done") : join(state, "guardrails.patch");
    const token = createHash("sha256")
      .update(existsSync(journeysFile) ? readFileSync(journeysFile) : "")
      .update(existsSync(rulesFile) ? readFileSync(rulesFile) : "")
      .digest("hex");
    const start = await remote.store.updateJson<{ token?: string }, boolean>(
      "env/recipe-started.json",
      (current) => current?.token === token ? { next: current, result: false } : { next: { token }, result: true },
      "The recipe can start",
    );
    if (!start) {
      process.stdout.write("the recipe is already starting\n");
      return 0;
    }
    await remote.gh.dispatchWorkflow("factory-setup-recipe.yml", undefined, {});
    process.stdout.write("started the recipe\n");
    return 0;
  }
  if (from === "recipe") {
    if (!existsSync(join(state, "manifest.json"))) {
      process.stderr.write("the recipe was not saved\n");
      return 1;
    }
    const next = await remote.store.updateJson<SetupNext, "boot" | "pr">(
      NEXT_PATH,
      (current) => ({ next: { after_recipe: "boot" }, result: current?.after_recipe ?? "boot" }),
      "The recipe's next step",
    );
    const workflow = next === "pr" ? "factory-setup-pr.yml" : "factory-setup-boot.yml";
    await remote.gh.dispatchWorkflow(workflow, undefined, {});
    process.stdout.write(`started ${workflow}\n`);
    return 0;
  }
  process.stderr.write("usage: bsf setup advance --from journeys|rules|recipe [--state DIR]\n");
  return 2;
}

/**
 * Record a failure. The first time, start the one workflow that should run
 * again. The second time, open one issue and stop.
 *
 * args: --step is the step name, --summary is what went wrong (no secrets),
 * --retry is the workflow to start the first time.
 * Returns 1 when the retry was started, 2 when setup stopped.
 */
async function failedCommand(args: Record<string, string | boolean>): Promise<number> {
  const step = typeof args["step"] === "string" ? args["step"] : "";
  const summary = typeof args["summary"] === "string" ? args["summary"] : "";
  const retry = typeof args["retry"] === "string" ? args["retry"] : "";
  if (step === "" || summary === "") {
    process.stderr.write("usage: bsf setup failed --step NAME --summary TEXT [--retry WORKFLOW]\n");
    return 2;
  }
  const remote = githubOrNull();
  if (remote === null) {
    process.stderr.write(`${summary}\n`);
    return 1;
  }
  const again = await remote.store.updateJson<Record<string, string>, boolean>(
    FAILURES_PATH,
    (current) => {
      const prev = current ?? {};
      if (sameFailure(prev[step] ?? null, summary)) return { next: prev, result: true };
      return { next: { ...prev, [step]: summary.trim() }, result: false };
    },
    "Record a setup failure",
  );
  if (again) {
    await openStopIssue(remote.gh, remote.repo, summary);
    process.stderr.write("The same failure happened twice. Setup has stopped.\n");
    return 2;
  }
  if (retry === "factory-setup-recipe.yml") {
    await remote.store.updateJson<SetupNext, true>(NEXT_PATH, () => ({ next: { after_recipe: "boot" }, result: true }), "The next recipe is booted");
  }
  if (retry === "factory-setup-pr.yml" || args["then"] === "pr") {
    await remote.store.updateJson<SetupNext, true>(NEXT_PATH, () => ({ next: { after_recipe: "pr" }, result: true }), "The next recipe opens the pull request");
  }
  if (retry !== "") {
    await remote.gh.dispatchWorkflow(retry, undefined, {});
    process.stdout.write(`started ${retry}\n`);
  }
  return 1;
}

/**
 * Open the one issue that says setup stopped, if it is not already open.
 *
 * gh: the repository client.
 * repo: owner/name.
 * summary: what failed, with no secret values.
 */
async function openStopIssue(gh: GitHub, repo: string, summary: string): Promise<void> {
  const issues = await gh.get<{ title: string; state: string }[]>(`repos/${repo}/issues?state=open&per_page=50`);
  if (issues.some((i) => i.title === "Setup stopped")) return;
  await gh.send("POST", `repos/${repo}/issues`, {
    title: "Setup stopped",
    body: `Setup stopped. The same failure happened twice, so it did not start over.\n\n${summary}\n`,
  });
}

/**
 * Forget the chain flag so a new setup can start the recipe again.
 *
 * Returns 0. A retry of one step does not call this.
 */
async function resetCommand(): Promise<number> {
  const remote = githubOrNull();
  if (remote === null) return 0;
  await remote.store.updateJson("env/recipe-started.json", () => ({ next: { token: "" }, result: true }), "A new setup can start the recipe");
  await remote.store.updateJson(FAILURES_PATH, () => ({ next: {}, result: true }), "A new setup starts with a clear failure count");
  process.stdout.write("setup can start\n");
  return 0;
}

/**
 * Decide what the boot log means.
 *
 * args: --trial is the trial JSON, --journeys is the journey list, --html is
 * an optional saved page.
 * Returns 0 when the finish line was met, 1 when the writer should run again,
 * 2 when a missing or rejected name sends the person back to the screen.
 */
async function judgeCommand(args: Record<string, string | boolean>): Promise<number> {
  const trialPath = typeof args["trial"] === "string" ? args["trial"] : "";
  if (trialPath === "" || !existsSync(trialPath)) {
    process.stderr.write("usage: bsf setup judge --trial PATH [--journeys PATH] [--html PATH] [--root DIR]\n");
    return 2;
  }
  const trial = JSON.parse(readFileSync(trialPath, "utf8")) as {
    reached?: string; claimed?: string; summary?: string;
    steps?: { tail?: string }[];
    probes?: { dependency?: string; path?: string; ok?: boolean }[];
    return_to_screen?: string[];
    rejected_names?: string[];
  };
  const log = [trial.summary ?? "", ...(trial.steps ?? []).map((s) => s.tail ?? "")].join("\n");
  const fromLog = namesFromBootLog(log);
  const missing = [...new Set([...(trial.return_to_screen ?? []), ...fromLog.missing])];
  const rejected = [...new Set([...(trial.rejected_names ?? []), ...fromLog.rejected])];
  const note = typeof args["note"] === "string" ? args["note"] : "";
  const writeNote = (kind: string, names: readonly string[]): void => {
    if (note === "") return;
    writeFileSync(note, `${JSON.stringify({ kind, names })}\n`);
  };
  if (missing.length > 0 || rejected.length > 0) {
    writeNote("screen", [...missing, ...rejected]);
    process.stderr.write("A setting is missing or was rejected. The screen has to answer it. The writer is not asked to invent the value.\n");
    return 2;
  }
  const htmlPath = typeof args["html"] === "string" ? args["html"] : "";
  if (htmlPath !== "" && existsSync(htmlPath) && vendorLoginWaiting(readFileSync(htmlPath, "utf8"))) {
    writeNote("writer", []);
    process.stderr.write("a page is still waiting on a vendor login. The boot does not type into that page.\n");
    return 1;
  }
  const journeys = typeof args["journeys"] === "string" ? args["journeys"] : "";
  if (journeys !== "" && existsSync(journeys)) {
    const list = readFileSync(journeys, "utf8");
    let original: readonly string[] = [];
    const remote = githubOrNull();
    if (remote !== null) {
      try {
        const text = await remote.store.read(JOURNEY_HEADINGS_PATH);
        if (text !== null) original = (JSON.parse(text) as { headings?: string[] }).headings ?? [];
      } catch { /* the list on disk is the check */ }
    }
    const deleted = deletedJourneyProblem(original, list);
    if (deleted !== null) {
      writeNote("writer", []);
      process.stderr.write(`${deleted}\n`);
      return 1;
    }
    const server = trial.claimed === "renders" || (trial.reached === "renders");
    if (server) {
      const probed = (trial.probes ?? []).filter((p) => p.ok).flatMap((p) => [p.dependency ?? "", p.path ?? ""]);
      const missed = unclickedJourneys(list, probed);
      if (missed.length > 0) {
        writeNote("writer", []);
        process.stderr.write(`these journeys were not clicked: ${missed.join(", ")}\n`);
        return 1;
      }
    }
  }
  if (trial.reached !== trial.claimed) {
    writeNote("writer", []);
    process.stderr.write(`${trial.summary ?? "the boot did not meet the finish line"}\n`);
    return 1;
  }
  writeNote("ok", []);
  process.stdout.write("the boot met the finish line\n");
  return 0;
}

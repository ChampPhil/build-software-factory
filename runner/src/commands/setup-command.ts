/**
 * setup-command.ts — the `bsf setup` entry point: one subcommand per setup workflow step.
 *
 * WHY THIS EXISTS
 *
 * Each setup workflow step is a single `bsf setup ...` command. This file
 * reads the command line, builds the connection to GitHub, and hands over to
 * the function that does the work. The work itself is in `setup-steps.ts`
 * (ready, start, plan, finish, boot, status), `setup-pr.ts` (the pull
 * request) and `setup-round.ts` (the writer's own check).
 *
 * THE SUBCOMMANDS
 *
 *   bsf setup ready    can setup start at all? (credentials, a whole install)
 *   bsf setup start    check the settings and start the first steps
 *   bsf setup plan     before a writer: hold on settings, write its brief
 *   bsf setup submit   inside the writer's run: check what it wrote
 *   bsf setup finish   after a writer: check, save, start the next step
 *   bsf setup boot     boot the saved recipe and click the journeys
 *   bsf setup pr       open the pull request
 *   bsf setup status   where setup is, what it waits on, the last failure
 *
 * KEY TERMS
 *
 *   - Writer: the model run that produces a step's files.
 *   - Round: the folder the writer leaves its files in.
 *   - Brief: `amend.json`, what the writer is told before it starts.
 *   - Record: `env/setup.json` on the factory's data ref, where setup notes
 *     which step it is on and every failure with its full reason.
 *
 * EXPORTS
 *
 *   - setupCommand: the `bsf setup` entry point.
 */

import { DataRefStore } from "../lib/dataref.js";
import { GitHub } from "../lib/github.js";
import { prStep } from "./setup-pr.js";
import type { SetupStep } from "./setup-record.js";
import { submitRound } from "./setup-round.js";
import { bootStep, failStep, finishStep, planStep, readyStep, startStep, statusStep } from "./setup-steps.js";
import { githubWorld, type SetupWorld } from "./setup-world.js";

const USAGE = [
  "usage:",
  "  bsf setup ready --trusted DIR",
  "  bsf setup start [--amend TEXT]",
  "  bsf setup plan --step journeys|rules|recipe [--amend TEXT]",
  "  bsf setup submit --dir DIR",
  "  bsf setup finish --step journeys|rules|recipe --from DIR [--amend TEXT] [--writer RESULT]",
  "  bsf setup boot",
  "  bsf setup pr",
  "  bsf setup status [--repo OWNER/NAME] [--json]",
].join("\n");

/**
 * Run one `bsf setup` subcommand.
 *
 * second: the subcommand, as listed at the top of this file.
 * args: the flags for that subcommand.
 * Returns 0 on success, 1 when a step was started again, 2 when setup has
 * stopped or the command line is wrong.
 */
export async function setupCommand(second: string | undefined, args: Record<string, string | boolean>): Promise<number> {
  const text = (name: string): string => {
    const value = args[name];
    return typeof value === "string" ? value : "";
  };
  const root = text("root") === "" ? process.cwd() : text("root");

  if (second === "submit") {
    if (text("dir") === "") return usage();
    const result = submitRound(text("dir"), root);
    for (const line of result.lines) process.stdout.write(`${line}\n`);
    return result.code;
  }
  if (second === "status") return statusCommand(text("repo"), args["json"] === true);

  const known = ["ready", "start", "plan", "finish", "boot", "pr"];
  if (second === undefined || !known.includes(second)) return usage();
  const world = githubWorld(root);
  if (world === null) {
    process.stderr.write(`bsf setup ${second} runs inside a GitHub workflow. GITHUB_REPOSITORY is not set.\n`);
    return 2;
  }
  // The request arrives in the environment as well as on the command line,
  // because text a person typed must not be pasted into a shell command.
  const amend = text("amend") !== "" ? text("amend") : process.env["AMEND"] ?? "";
  const step = text("step");
  const writerStep = step === "journeys" || step === "rules" || step === "recipe" ? step : null;

  if (second === "ready") {
    if (text("trusted") === "") return usage();
    return readyStep(world, {
      trusted: text("trusted"),
      event: process.env["GITHUB_EVENT_NAME"] ?? "",
      env: process.env,
      repo: process.env["GITHUB_REPOSITORY"] ?? "",
      branch: process.env["GITHUB_REF_NAME"] ?? world.defaultBranch,
    });
  }
  if (second === "start") return guarded(world, "start", () => startStep(world, amend));
  if (second === "plan") {
    if (writerStep === null) return usage();
    return guarded(world, writerStep, () => planStep(world, writerStep, amend));
  }
  if (second === "finish") {
    if (writerStep === null || text("from") === "") return usage();
    return guarded(world, writerStep, () => finishStep(world, writerStep, text("from"), amend, text("writer")));
  }
  if (second === "boot") return guarded(world, "boot", () => bootStep(world));
  if (second === "pr") return prStep(world);
  return usage();
}

/**
 * Print how the command is used.
 *
 * Returns 2, the exit code for a wrong command line.
 */
function usage(): number {
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

/**
 * Run a step, and record anything it throws as that step's failure.
 *
 * world: the outside world.
 * name: the step, for the record.
 * step: the step to run.
 * Returns the step's exit code. A step that throws has hit something it has
 * no rule for (a refused request, a full disk). Running a writer again
 * cannot fix that, so setup stops and the issue carries the whole message.
 * When even the record cannot be written, both messages are printed and
 * the job fails.
 */
async function guarded(world: SetupWorld, name: SetupStep, step: () => Promise<number>): Promise<number> {
  try {
    return await step();
  } catch (err) {
    const message = world.git.redact((err as Error).stack ?? (err as Error).message);
    try {
      return await failStep(world, { step: name, code: "unexpected", detail: message }, name === "start" ? null : name);
    } catch (second) {
      process.stderr.write(`${message}\n`);
      process.stderr.write(`The failure could not be recorded: ${world.git.redact((second as Error).message)}\n`);
      return 1;
    }
  }
}

/**
 * `bsf setup status`: read the record and what can be seen right now.
 *
 * repo: `owner/name`, or empty to use `GITHUB_REPOSITORY`.
 * json: true to print JSON.
 * Returns 0, or 2 when no repository was named.
 */
async function statusCommand(repo: string, json: boolean): Promise<number> {
  const name = repo !== "" ? repo : process.env["GITHUB_REPOSITORY"] ?? "";
  if (name === "") {
    process.stderr.write("Say which repository: bsf setup status --repo OWNER/NAME\n");
    return 2;
  }
  const gh = new GitHub({ repo: name });
  const store = new DataRefStore(gh);
  /**
   * The names in one list GitHub keeps for the repository.
   *
   * path: `actions/secrets` or `actions/variables`.
   * Returns the names, or null when this login may not read the list.
   */
  const names = async (path: "actions/secrets" | "actions/variables"): Promise<readonly string[] | null> => {
    try {
      const got = await gh.get<{ secrets?: { name: string }[]; variables?: { name: string }[] }>(`repos/${name}/${path}?per_page=100`);
      return (got.secrets ?? got.variables ?? []).map((row) => row.name);
    } catch {
      return null;
    }
  };
  const [secrets, variables] = [await names("actions/secrets"), await names("actions/variables")];
  const missing: string[] = [];
  if (variables !== null && !variables.includes("FACTORY_APP_CLIENT_ID")) missing.push("the factory's GitHub App (the variable FACTORY_APP_CLIENT_ID)");
  if (secrets !== null && !secrets.includes("FACTORY_APP_PRIVATE_KEY")) missing.push("the GitHub App's private key (the secret FACTORY_APP_PRIVATE_KEY)");
  if (secrets !== null && !secrets.includes("ANTHROPIC_API_KEY")) missing.push("the model key (the secret ANTHROPIC_API_KEY)");
  if (secrets !== null && !secrets.includes("FACTORY_SANDBOX_ENV")) missing.push("the development environment (the secret FACTORY_SANDBOX_ENV)");

  const running: { name: string; url: string }[] = [];
  for (const status of ["in_progress", "queued"]) {
    try {
      const got = await gh.get<{ workflow_runs?: { name: string; html_url: string }[] }>(`repos/${name}/actions/runs?status=${status}&per_page=50`);
      for (const run of got.workflow_runs ?? []) {
        if (run.name.startsWith("factory-setup")) running.push({ name: `${run.name} (${status === "queued" ? "queued" : "running"})`, url: run.html_url });
      }
    } catch { /* this login may not list runs */ }
  }
  return statusStep(
    {
      readJson: async <T>(path: string) => {
        const found = await store.read(path);
        return found === null ? null : (JSON.parse(found) as T);
      },
      say: (line) => process.stdout.write(`${line}\n`),
    },
    { missing, running },
    json,
  );
}

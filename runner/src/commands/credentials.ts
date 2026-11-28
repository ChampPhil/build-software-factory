/**
 * credentials.ts — stop a job at its first step when the GitHub App or the model key is missing.
 *
 * WHY THIS EXISTS
 *
 * Every factory workflow needs the factory's GitHub App (to write to the
 * repository) and most need the model key (to run an agent). When one was
 * missing, the job ran until the first action that used it and died there
 * with a message such as "Input required and not supplied: app-id", deep in
 * a step whose name said nothing about credentials. The person had to work
 * out from that what they had not done yet.
 *
 * `bsf credentials check` is the first thing a job runs after the runner is
 * on the path. It fails at once and names what is missing in plain words.
 *
 * HOW IT KNOWS, WITHOUT SEEING A SECRET
 *
 * A workflow cannot hand this command a secret's value without risking it in
 * a log, and it does not need to. GitHub evaluates an expression such as
 * `${{ secrets.ANTHROPIC_API_KEY != '' }}` to the word `true` or `false`
 * before the step starts, so the workflow passes only those words, in the
 * environment variables below. The values themselves never reach this
 * process.
 *
 * KEY TERMS
 *
 *   - The App: the factory's GitHub App. It is "installed" when the
 *     repository variable `FACTORY_APP_CLIENT_ID` and the secret
 *     `FACTORY_APP_PRIVATE_KEY` both exist.
 *   - The model key: the secret `ANTHROPIC_API_KEY`.
 *   - Need: what a job requires, as a comma-separated list of `app` and
 *     `model`.
 *
 * EXPORTS
 *
 *   - missingCredentials: the sentences for whatever is missing.
 *   - credentialsCommand: the `bsf credentials check` entry point.
 */

import { appendFileSync } from "node:fs";

/** Each thing a job can need, the variable that says whether it is present, and the sentence for when it is not. */
const PARTS = [
  {
    need: "model",
    flag: "HAS_MODEL",
    missing: "the model key is not set (the secret `ANTHROPIC_API_KEY`)",
  },
  {
    need: "app",
    flag: "HAS_APP_ID",
    missing: "the factory's GitHub App is not installed (the variable `FACTORY_APP_CLIENT_ID` is empty)",
  },
  {
    need: "app",
    flag: "HAS_APP_KEY",
    missing: "the GitHub App's private key is not set (the secret `FACTORY_APP_PRIVATE_KEY`)",
  },
] as const;

/**
 * What is missing, as sentences.
 *
 * need: what the job requires: `app`, `model`, or both.
 * env: the environment, where `HAS_MODEL`, `HAS_APP_ID` and `HAS_APP_KEY`
 * are the word `true` when that credential exists.
 * Returns one sentence per missing credential. A flag that is not set at
 * all counts as missing, so a workflow that forgot to pass it fails here
 * and not three steps later.
 */
export function missingCredentials(
  need: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return PARTS.filter((p) => need.includes(p.need) && env[p.flag] !== "true").map((p) => p.missing);
}

/**
 * Run `bsf credentials check --need app,model`.
 *
 * second: the subcommand. Only `check` exists.
 * args: `--need` is a comma-separated list of `app` and `model`. It
 * defaults to both.
 * Returns 0 when everything needed is present, 1 when something is missing
 * (the job stops here), 2 when the command line is wrong.
 */
export function credentialsCommand(second: string | undefined, args: Readonly<Record<string, string | boolean>>): number {
  if (second !== "check") {
    process.stderr.write("usage: bsf credentials check [--need app,model]\n");
    return 2;
  }
  const need = (typeof args["need"] === "string" ? args["need"] : "app,model").split(",").map((n) => n.trim());
  const missing = missingCredentials(need, process.env);
  if (missing.length === 0) {
    process.stdout.write("the credentials this job needs are present\n");
    return 0;
  }
  const lines = [
    "### This job cannot run yet",
    "",
    ...missing.map((m) => `- ${m}`),
    "",
    "Finish those, then run this workflow again, or ask your coding agent to carry on with the software factory setup.",
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined && summary !== "") appendFileSync(summary, `${lines.join("\n")}\n`);
  return 1;
}

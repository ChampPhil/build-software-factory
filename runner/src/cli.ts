#!/usr/bin/env node
import { runSettings } from "./commands/settings-run.js";
import { dashboardLink } from "./lib/dashboard-link.js";
import { GitHub } from "./lib/github.js";
import {
  DiskLoader, RefLoader, loadPolicy, loadBaselines, loadCoverage, changedFilesSince, changedLinesSince,
  POLICY_PATH, resolveRead,
} from "./lib/config.js";
import { runStaticGate, runCoverageGate, repoHasTests, checkedFromCheckRuns, summarizeGates, GATES_CHECK, type JobResult } from "./commands/gates-run.js";
import { runPolicyCommand } from "./commands/policy-run.js";
import { planGates } from "./commands/gates.js";
import { SCHEMA_NAMES, assertValid, type SchemaName, SCHEMA_DIR } from "./lib/schema.js";
import { runIntakeCommand, recordIntakeCommand } from "./commands/intake-run.js";
import { runRollupCommand, squashMedia } from "./commands/rollup-run.js";
import { runMergeCommand } from "./commands/merge-run.js";
import { runGardenCommand } from "./commands/garden.js";
import { runConflictsCommand } from "./commands/conflicts.js";
import { runSyncCommand } from "./commands/sync-settings.js";
import { runAuditCommand, blockingFindings } from "./commands/audit.js";
import { scanAssetHosts } from "./commands/asset-hosts.js";
import { scanProse, renderProse, budgetVerdict, budgetBytes, alwaysLoaded } from "./commands/repo-prose.js";
import { planUninstall, applyUninstall, formatPlan, removeLocalFactory, removeLocalFactoryBranches, LOCAL_FACTORY_DIR } from "./commands/uninstall.js";
import { readBrainstorm, render as renderBrainstorm } from "./commands/brainstorm.js";
import { byFileOf } from "./commands/gates.js";
import { parseYaml } from "./lib/yaml.js";
import type { CandidatesFile, Policy } from "./lib/types.js";
import { runDoctor, formatReport } from "./commands/doctor.js";
import { findDashboard, serveDashboard } from "./commands/serve.js";
import { checkConsistencyOutcomes } from "./commands/consistency.js";
import { allFindings, describeOutcomes } from "./lib/applicability.js";
import {
  submitContribution,
  mergeContribution,
  type Contribution,
} from "./commands/contribute.js";
import {
  surfaceForDirectory,
  compareSurface,
  readFrozen,
  writeFrozen,
} from "./commands/schema-freeze.js";
import {
  planMigration,
  applyMigration,
  diskIo,
  schemaSupport,
  MIGRATIONS,
} from "./commands/migrate.js";
import { runReviewDue, runReviewRoute, type ScoredFailure } from "./commands/review.js";
import { planRun, afterGates } from "./commands/run-plan.js";
import { buildStepReport, writeStepReport, changedFilesFromGit, type Harness } from "./commands/step-report.js";
import { pausedPipelines, type BudgetState } from "./commands/rollup.js";
import {
  BUDGET_PATH, reserve as reserveBudget, settle as settleBudget, rollMonth, used, creditsToUsd,
  measuredUsd, detectionUsd, canStart, type BudgetDoc, type BudgetLimits, type BudgetMeasure,
} from "./commands/budget.js";
import { loadFactory, trustedRoot } from "./lib/config.js";
import { reportApiCalls } from "./lib/apicalls.js";
import { startSandbox, loadManifest, loadManifestAt, trialSandbox, freezeManifest, needsHost, serveOnHost, closedEnv, trialMet } from "./commands/sandbox.js";
import { fetchWorkItem, writeSpec, fetchArtifact, storeMedia } from "./commands/role-io.js";
import { gardenScan, gardenFile, hardenContext, reviewCollect, reviewWrite } from "./commands/role-steps.js";
import { runTestsGate, manifestDropsTests } from "./commands/tests-gate.js";
import { mineCorrections, listSessions, clusterCorrections, candidatesFrom } from "./commands/mine.js";
import { mineRepo } from "./commands/mine-repo.js";
import { mineGithub, ghAt, filesInCommit, repoSlug } from "./commands/mine-github.js";
import { assembleMine, anthropicClassifier, splitFindings } from "./commands/mine-classify.js";
import { assessCheck } from "./commands/assess-check.js";
import { runScorers, loadRubrics } from "./commands/score.js";
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { specProblems, type SpecGateInput, type SpecLike } from "./commands/spec-gate.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `bsf` — the factory's deterministic runner.
 *
 * Every factory workflow is a thin wrapper around one of these commands. The
 * agents are the only part that isn't deterministic; routing, policy, gates,
 * the queue and the rollups all live here so they behave the same every time
 * and can be tested without a model.
 */

const VERSION = "0.1.1";

const USAGE = `bsf ${VERSION} — Build Software Factory runner

  bsf policy --pr N [--report-check NAME]
      Run the factory/policy check on a pull request. Reads the changed-file
      list, reviews and labels; never checks out the PR's code. policy.yaml
      comes from the default branch.

  bsf gates plan [--commit SHA] [--actor agent|human]
      Decide which gates to run for a commit, and say why.

  bsf gates static [--base REF] [--report-check NAME]
      Gate 1. Runs the repo's own linters, compares every rule's count per
      file against the baselines on the base ref, and checks for weakening.

  bsf gates coverage [--base REF] [--pr N] [--report-check NAME]
      Gate 2's coverage half. Diff coverage of the changed files is the main
      check; total coverage must stay above the floor.

  bsf gates tests [--report-check NAME]
      Gate 2's test half. Reads the repo's own test check for this commit when
      it has one; runs the tests itself if that check does not report in time.

  bsf gates record --plan-static B --plan-verification B --plan-agent B --static R --verification R --agent R [--commit SHA]
      Report factory/gates: the verdict over every gate the plan called for.
      Record a gate's result against the head commit, so the same commit is
      never checked twice.

  bsf intake [--record-only] [--at TIME] [--event-name NAME] [--event PATH] [--plan]
      Normalize every unprocessed event into work items and dispatch runs.
      Appends the incoming event to the data ref before deciding anything, so
      a dropped run costs a delay rather than a request.

  bsf run plan WORK_ITEM [--attempt N] [--revision] | --pipeline P
      Which roles run for this attempt, and why. factory-run reads this.

  bsf run start WORK_ITEM [--attempt N] [--escalate true] [--first-step ROLE]
  bsf run after-gates WORK_ITEM --run-id R [--attempt N] [--pr N] [--build-result R] [--wait-min M] [--steps-dir DIR]
  bsf run after-gates --static S --verification V [--attempt N]
      What happens after the gates: verify, retry, escalate or clear. With
      --wait-min 0 (the default) a run whose gates have not reported parks its
      item in review and returns awaiting_gates.
  bsf run decide PR
      Finish the run parked on PR's gates: factory-gates calls this once the
      verdict is recorded. Nothing parked is a no-op.

  bsf rollup [--squash-media] [--plan]
      Rebuild index.json and ledger.json from the run files, and dispatch
      queued work when slots are free.

  bsf budget check [--pipeline P]
      Which pipelines are over their share of either monthly limit. With
      --pipeline, paused=true|false for that one (and true before setup).

  bsf budget reserve --key K --pipeline P --role R --model M --cap CREDITS
      [--detection-model M --detection-cap CREDITS]
      Before an agent step: hold the most it can cost (its credit cap plus one
      request past it, for the agent and its threat detection), or refuse and
      exit 1 if spent + held + this would pass the budget or the share.

  bsf budget measure --key K [--pipeline P] --model M --detection-artifact NAME --out PATH
      After the agent: write what it spent (the larger of its session's cost
      and its tokens at list price) for the settle step.

  bsf budget settle --key K [--measured PATH] [--detection-dir DIR]
      Replace a step's hold with its measured cost; anything unmeasured is
      charged at the ceiling.

  bsf budget status
  bsf budget verify   (budget.json and steps/ must agree to the cent)
  bsf budget minutes   (Actions minutes billed this month against the limit)
      Spent, held and left this month.

  bsf merge-queue [--apply]
      Work the queue: update the head PR from main, or merge it.

  bsf garden [--max N] [--plan]
      The nightly scan: file up to N gardening items and dispatch them.

  bsf conflicts scan [--no-dispatch]
  bsf report store --role R --dir DIR --work-item WI [--attempt N]
  bsf report publish --work-item WI --pr N
  bsf report setup --dir D --trial-dir T --tier X --out BODY [--extra FILE]
  bsf report check --pr N --problems FILE
  bsf conflicts context WORK_ITEM --out DIR
  bsf conflicts button --pr N
      Find open factory PRs that became conflicting; dispatch resolution runs.

  bsf review due [--force true]
      Whether the scheduled review should run, and why.

  bsf review route --failures PATH [--plan]
      Group scored failures into problems and file each where its fix belongs.

  bsf sync-settings [--branch NAME] [--apply]
      Apply branch protection from factory.yaml. Adds checks, never removes.

  bsf attribution
      The credit line, as Markdown, from the one place it is defined.
  bsf audit [--commit SHA]
  bsf scan-asset-hosts [--root DIR] [--why]
      The external hosts this repo's own pages load. Each needs a sandbox stub.
  bsf repo-prose [--root DIR] [--out PATH] [--json]
      The conventions this repository writes down for agents — AGENTS.md,
      CLAUDE.md, CONTRIBUTING.md, .claude/skills/ and anything policy.yaml
      names. Every role reads these: they are the owners' own statement of
      house style, and the factory's context supplements them.
  bsf prose-budget [--root DIR]
      Is any always-loaded prose file over its budget? Those files are in
      every run's context, so past the cap a practice has to replace one
      already there rather than being appended.
  bsf uninstall [--apply] [--purge-data] [--root DIR]
      Take the factory out of operation. Keeps everything it built.
      --apply also deletes the .factory/ folder on this computer, including
      files that were never committed.
  bsf brainstorm WORK_ITEM [--out PATH]
      The conversation held with the author so far, for a role to read.
  bsf brainstorm say WORK_ITEM --issue N --text TEXT [--understood TEXT]
  bsf brainstorm frame WORK_ITEM --issue N --file FRAME.json --question TEXT
      Ask the author something: one comment on the issue, one turn in the log.
  bsf brainstorm wait WORK_ITEM --issue N [--idle SECONDS] [--poll SECONDS]
      Block until the author answers, then print what they said. Exits 0 with
      "quiet" on the first line when they have said nothing for --idle.
      Conditional polling, so watching costs no rate limit while nothing
      happens.
  bsf brainstorm close WORK_ITEM --understood TEXT
      End the conversation. The log stays; it is what the spec stage reads.
      After a push to main: did anything reach main without passing the gates,
      and is every compiled role workflow current with its source?

  bsf local-hook [--repo OWNER/NAME]
      The correction hook for a local agent session. Reads the message from
      stdin as the harness gives it, and when it is a correction hands it to
      the factory, which turns it into hardening work. Prints nothing and never
      fails, because a hook's output can reach the agent.
  bsf local-hook --install [--repo OWNER/NAME] [--repo-path PATH] [--allow-public]
  bsf local-hook --uninstall [--repo-path PATH]
      Turn the hook on or off for this checkout, in .claude/settings.local.json
      (yours alone, not the team's). A public repository is refused unless
      --allow-public, because what you correct is then visible there.
  bsf local-hook --sent
      What this machine has sent, with when and to which repository. Kept in
      your own cache, never anywhere else.

  bsf schema-surface [--check] [--freeze]
      Compare the schemas against the frozen shape in schema/SURFACE.json.
      An additive change is reported and allowed; a change that would stop
      already-written data validating fails, because doc 09 asks for a major
      bump and a migration instead.

  bsf migrate [PATHS...] [--apply] [--support]
      Move stored data across a breaking schema change. Writes the new file
      next to the old one and never over it, so a half-finished migration
      leaves the data ref readable. --support prints what this runner reads
      and writes, which the dashboard uses to warn about an old runner.

  bsf step-report --role R --out PATH [--usage PATH] [--session-dir PATH]
      Write one role's step report. Reads gh-aw's own session evidence first,
      then the harness's log, then the price table — and says the cost is
      unknown rather than estimating one the budget would then pause on.

  bsf fetch-work-item ID --out PATH [--spec-only] [--with-triage] [--with-shortlist]
      Write what a role may see into a file. Untrusted text is stripped here,
      not in the prompt.

  bsf write-spec ID --from PATH [--pipeline P]
  bsf fetch-gate-failures WORK_ITEM --out PATH
  bsf write-triage WORK_ITEM --from PATH
  bsf guardrails record [--out PATH]
  bsf run status WORK_ITEM
  bsf run fail-step WORK_ITEM --step triage
  bsf run announce WORK_ITEM
      Make sure a run that produced no PR still told the author why.
  bsf run closed --pr N --merged true|false
  bsf run drop --items ID[,ID...] --why TEXT
  bsf spec check --file PATH [--pipeline P]
  bsf sandbox report --from PATH [--work-item ID]
      Store the spec role's plan and acceptance checks on the work item.

  bsf fetch-artifact NAME --out PATH [--run-id N]
      Read one of this run's artifacts, which is how role results travel.

  bsf store-media --run-dir DIR [--run-id ID]
      Put the verifier's screenshots and clips on the media ref.

  bsf garden-scan --out PATH
      The two measurable kinds of drift, for the gardener.

  bsf garden-file --from PATH [--max N] [--plan]
      Turn the gardener's picks into work items, re-checking the ledger.

  bsf harden-context ID --out PATH
      The existing rules, candidates and open work the hardener must check.

  bsf review-collect --out PATH
      The runs to grade since the last review, for the scorer.

  bsf review-write --scores PATH [--plan]
      Group the scorer's failures into problems and file each one.

  bsf mine-corrections --list [--repo-path PATH]
      List the sessions that would be read — date, harness, opening line — and
      read none of them. Phase 1 shows this to the user first, because these
      are their private conversations.

  bsf mine-corrections [--exclude ID,ID] [--out PATH] [--source NAME]
                       [--merge-into PATH] [--classes PATH]
      Read the sessions the user did not exclude and find the moments they
      corrected an agent. Each one is a rule they already wanted. Writes
      guardrail candidates; reports and continues if memex is not installed.
      With --merge-into, the existing list is kept and only genuinely new
      problems are added — what the skill's update mode needs, since one the
      user already rejected must not be offered again.
      A fix subject, an applied review comment, and a bug issue closed by a
      commit are evidence. They become candidates only after a label says
      they are a rule and quotes their text. --classes is that label file.
      Exit 2 means findings are still unlabelled and setup is not finished.

  bsf assess check [--root DIR]
      Refuse a thin survey. assessment.md must cover the build, the test
      check, the patterns, a count where two patterns compete, coverage, and
      the miner's own summary sentence. The miner must have run, and every
      finding must be labelled.
  bsf assess fundamentals [--root DIR]
      Refuse a fundamentals.md that copies the README or AGENTS.md.

  bsf recompile-prepare
      Apply the frozen sandbox's research hosts to the spec role's network, ready for gh aw compile.
  bsf practice add TEXT
      Declare a practice every agent follows from now on. Opens a PR adding it to
      practices.md, and a rule where one can enforce it. Same as commenting
      /practice TEXT on any issue or PR.
  bsf sandbox ui-paths [--file PATH]   (record which files are the UI)
  bsf enforcement detect [--file PATH] (record whether this repo can require checks)
  bsf sandbox secrets [--file PATH]  (refuse a recipe that pastes a password)
  bsf env scan [--root DIR] [--hold WORKFLOW] [--inputs JSON] [--names-file PATH]
  bsf env list [--root DIR] [--names-file PATH]
  bsf env apply [--root DIR]
  bsf env resume [--root DIR]
  bsf env skipped [--root DIR]
  bsf journeys look
  bsf guardrails require-zero [--file PATH]
  bsf setup publish --from DIR --into DIR
  bsf setup journeys --file PATH [--root DIR]
  bsf setup advance --from journeys|rules|recipe [--state DIR]
  bsf setup failed --step NAME --summary TEXT [--retry WORKFLOW] [--then pr]
  bsf setup judge --trial PATH [--journeys PATH]
  bsf setup reset
  bsf sandbox dry-run   (start the sandbox and serve the app, as the checker will)
  bsf sandbox start
      Bring up the frozen sandbox: its services, its closed environment, its install.
  bsf sandbox check [--file PATH]
      Validate a sandbox manifest.
  bsf sandbox trial --candidate PATH --out PATH
      Run a candidate manifest: the tier it actually reaches, its sign-in, and each dependency's probe.
  bsf sandbox freeze --rounds CANDIDATE:TRIAL[,...] --out PATH
      Write the manifest from the best measured round, at the tier it reached, with what it proved.
  bsf sandbox land --pr N --main PATH --candidate PATH   (AMEND in the environment)
      Merge a sandbox amendment when it is safe to, and verify again the changes it was for.
  bsf sandbox release   (AMEND in the environment)
      An amendment that never reached a trial: its reports wait again, the attempt not counted.
  bsf dashboard-link --repo owner/name
      Print the link that opens the shared dashboard on that repository, with
      the repository already filled in at sign-in. Exits non-zero, saying why,
      when the dashboard has not been published yet.
  bsf settings [--set id=value[,id=value]] [--root PATH]
      Show the settings a person may change, or change some (budget, shares,
      auto-merge, cleanup PRs and time). The setup skill uses this instead of
      editing any file by hand.
  bsf models
      Emit each role's model and the gardening budget from factory.yaml as step outputs.
  bsf consistency [--root PATH] [--json]
      Compare the artifacts that are supposed to agree: environment variables
      the code reads against the example file, commands the README tells
      people to run against the manifest's scripts, declared dependencies
      against the lockfile. Each file is fine on its own, which is why no
      linter catches these.

  bsf dashboard [--port N] [--dir PATH]
      Serve the dashboard from this machine, on the loopback interface only.
      It is a static export that talks to GitHub from your browser, so there
      is nothing else to run and no server sees your token.

  bsf context merge-intent --existing PATH --incoming PATH --out PATH
  bsf doctor [--root PATH] [--repo OWNER/REPO] [--json] [--quiet] [--fix-modes]
      What is wrong with an installed factory: missing definition, role or
      context files, a guardrail file that no longer validates, a missing
      workflow, a lock file too stale for gh-aw to run, and — with --repo — a
      missing secret or variable and whether the data ref exists. Changes
      nothing: the skill's repair mode diagnoses before it touches anything.

  bsf contribute-corrections [--repo-path PATH] [--exclude ID,ID] [--out PATH]
      For a teammate: mine the corrections on *your* machine and write them to
      a file. Submits nothing. The quotes come from your own agent sessions, so
      you read the file, delete anything you would rather not share, and then:

  bsf contribute-corrections --submit [--from PATH] [--repo OWNER/REPO]
      Open a PR adding what is left in that file to the factory's candidate
      list. Merges rather than replaces, folds a problem already on the list
      into its existing candidate, and leaves a candidate someone has already
      accepted or rejected alone.

  bsf score --runs PATH --out PATH [--repeat N]
      Grade runs against their pipeline's rubric and the shared one, on
      promptfoo's LLM-rubric graders. Reports a criterion whose repeats
      disagree instead of routing it.

  bsf validate SCHEMA FILE
      Validate a file against one of the shared schemas.

  bsf schemas
      List the schemas this runner reads and writes.

  bsf version

Environment:
  GITHUB_REPOSITORY   owner/name (set by Actions)
  GH_TOKEN            the job's installation token
  FACTORY_APP_LOGINS  comma-separated App logins whose approvals never count
`;

type Args = Readonly<Record<string, string | boolean>>;

function parse(argv: readonly string[]): { readonly command: string[]; readonly args: Args } {
  const command: string[] = [];
  const args: Record<string, string | boolean> = {};
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) break;
    command.push(a);
  }
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return { command, args };
}

function requireRepo(): string {
  const repo = process.env["GITHUB_REPOSITORY"];
  if (repo === undefined || repo === "") {
    die("GITHUB_REPOSITORY is not set. Outside Actions, set it to owner/name.");
  }
  return repo;
}

function appLogins(): readonly string[] {
  const raw = process.env["FACTORY_APP_LOGINS"] ?? "";
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

function die(message: string): never {
  process.stderr.write(`bsf: ${message}\n`);
  process.exit(2);
}

/** Set an Actions step output, when running in Actions. */
function setOutput(name: string, value: string): void {
  const file = process.env["GITHUB_OUTPUT"];
  if (file === undefined) {
    process.stdout.write(`${name}=${value}\n`);
    return;
  }
  // Multiline-safe form, so a value with newlines does not break the file.
  const delim = `__bsf_${Math.random().toString(36).slice(2)}`;
  appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  const { command, args } = parse(argv);
  const [first, second] = command;

  // Workflows call this right after putting the vendored runner on PATH, so a
  // missing or broken bundle fails at that step with a clear line, not three
  // steps later inside whatever command needed it.
  if (args["version"] === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (first === undefined || args["help"] === true || first === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (first) {
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return 0;

    case "schemas": {
      for (const n of SCHEMA_NAMES) process.stdout.write(`${n}/1\n`);
      return 0;
    }

    case "validate": {
      const [, name, file] = command;
      if (name === undefined || file === undefined) die("usage: bsf validate SCHEMA FILE");
      if (!(SCHEMA_NAMES as readonly string[]).includes(name)) {
        die(`unknown schema ${name}. Run \`bsf schemas\` for the list.`);
      }
      const text = readFileSync(file, "utf8");
      const doc: unknown = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
      try {
        assertValid(name as SchemaName, doc);
        process.stdout.write(`${file} is a valid ${name}\n`);
        return 0;
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        return 1;
      }
    }

    case "intake":
      return intakeCommand(args);

    case "run":
      return runCommand(second, args, command[2]);

    case "rollup":
      return rollupCommand(args);

    case "budget":
      if (second === "reserve") return budgetReserveCommand(args);
      if (second === "settle") return budgetSettleCommand(args);
      if (second === "measure") return budgetMeasureCommand(args);
      if (second === "status") return budgetStatusCommand();
      if (second === "verify") return budgetVerifyCommand();
      if (second === "minutes") return budgetMinutesCommand();
      if (second !== "check") die("usage: bsf budget check|reserve|measure|settle|status|verify|minutes");
      return budgetCommand(args);

    case "merge-queue":
      return mergeCommand(args);

    case "garden":
      return gardenCommand(args);

    case "conflicts":
      if (second !== "scan" && second !== "context" && second !== "button") {
        die("usage: bsf conflicts scan | context WORK_ITEM --out DIR | button --pr N");
      }
      return conflictsCommand(args, second, command[2]);

    case "review":
      return reviewCommand(second, args);

    case "sync-settings":
      return syncCommand(args);

    case "enforcement": {
      // `bsf enforcement detect [--file PATH]`: write what this repo can enforce
      // into factory.yaml, so the dashboard knows before the first rollup.
      if (second !== "detect") die("usage: bsf enforcement detect [--file PATH]");
      const file = typeof args["file"] === "string" ? args["file"] : ".factory/definition/factory.yaml";
      if (!existsSync(file)) die(`${file} does not exist`);
      const gh = new GitHub({ repo: requireRepo() });
      const { detectEnforcement, withBranchProtection } = await import("./lib/enforcement.js");
      const value = await detectEnforcement(gh, await gh.defaultBranch());
      writeFileSync(file, withBranchProtection(readFileSync(file, "utf8"), value));
      process.stdout.write(`enforcement: branch_protection ${value}${value === "off" ? " (this plan cannot require checks; the factory audits instead)" : ""}\n`);
      return 0;
    }

    case "attribution":
      // One place for the credit line, so every surface that shows it — the
      // dashboard, the setup PR, the bootstrap PR — says the same thing, and a
      // product added to PRODUCTS reaches all of them.
      process.stdout.write(`${(await import("./lib/brand.js")).attributionMarkdown()}\n`);
      return 0;
    case "audit":
      return auditCommand(args);
    case "scan-asset-hosts":
      return scanAssetHostsCommand(args);
    case "repo-prose":
      return repoProseCommand(args);
    case "prose-budget":
      return proseBudgetCommand(args);
    case "uninstall":
      return uninstallCommand(args);
    case "brainstorm":
      return brainstormCommand(second, command.slice(2), args);

    case "consistency":
      return consistencyCommand(args);
    case "models":
      return modelsCommand();
    case "settings":
      return settingsCommand(args);
    case "dashboard-link":
      return dashboardLinkCommand(args);
    case "sandbox":
      return sandboxCommandCli(second, args);
    case "env":
      return (await import("./commands/env-command.js")).envCommand(second, args);
    case "setup":
      return (await import("./commands/setup-command.js")).setupCommand(second, args);
    case "practice":
      return practiceCommand(second, command.slice(2));
    case "recompile-prepare":
      return recompilePrepareCommand();

    case "dashboard":
      return dashboardCommand(args);

    case "doctor":
      return doctorCommand(args);
    case "context": {
      // `bsf context merge-intent --existing PATH --incoming PATH --out PATH`:
      // the person's "Product intent (from you)" block survives the setup
      // workflow rewriting the rest of fundamentals.md.
      if (second !== "merge-intent") die("usage: bsf context merge-intent --existing PATH --incoming PATH --out PATH");
      const incoming = args["incoming"];
      const out = args["out"];
      if (typeof incoming !== "string" || typeof out !== "string") die("usage: bsf context merge-intent --existing PATH --incoming PATH --out PATH");
      const existing = typeof args["existing"] === "string" && existsSync(args["existing"]) ? readFileSync(args["existing"], "utf8") : null;
      const { mergeProductIntent } = await import("./lib/product-intent.js");
      writeFileSync(out, mergeProductIntent(existing, readFileSync(incoming, "utf8")));
      return 0;
    }

    case "contribute-corrections":
      return contributeCorrectionsCommand(args);

    case "schema-surface":
      return schemaSurfaceCommand(args);

    case "local-hook":
      return localHookCommand(args);

    case "migrate":
      return migrateCommand(command.slice(1), args);

    case "step-report":
      return stepReportCommand(args);

    case "mine-corrections":
      return mineCommand(args);

    case "assess":
      if (second !== "check" && second !== "fundamentals") {
        die("usage: bsf assess check [--root DIR] | bsf assess fundamentals [--root DIR]");
      }
      return assessCommand(args, second === "fundamentals");

    case "score":
      return scoreCommand(args);

    case "fetch-work-item":
      return fetchWorkItemCommand(command[1], args);

    case "write-spec":
      return writeSpecCommand(command[1], args);

    case "spec":
      if (second !== "check") die("usage: bsf spec check --file PATH [--pipeline P]");
      return specCheckCommand(args);

    case "journeys":
      return journeysCommand(second);
    case "guardrails": {
      // `bsf guardrails record [--out PATH]`: baseline what the repo's own
      // checkers report today, per rule and per file, for setup's PR.
      // `bsf guardrails require-zero [--file PATH]`: setup is not finished
      // while any recorded count is above zero.
      if (second === "require-zero") return guardrailsRequireZero(typeof args["file"] === "string" ? args["file"] : ".factory/guardrails/baselines.json");
      if (second !== "record") die("usage: bsf guardrails record [--out PATH] | bsf guardrails require-zero [--file PATH]");
      const { runStaticTools, baselinesFrom, measuredCounts } = await import("./commands/gates-run.js");
      const out = typeof args["out"] === "string" ? args["out"] : ".factory/guardrails/baselines.json";
      // Setup records this from its own candidate sandbox, in the checkout:
      // the checkers it declared are part of what it is baselining.
      const candidate = loadManifestAt(join(process.cwd(), ".factory/sandbox/manifest.json"));
      const checks = candidate.kind === "ok" ? candidate.manifest.static_checks ?? [] : [];
      const env = closedEnv(process.cwd());
      const { results, unavailable } = await runStaticTools(process.cwd(), env === null ? { checks } : { checks, env });
      const existing = existsSync(out)
        ? (JSON.parse(readFileSync(out, "utf8")) as import("./lib/types.js").Baselines)
        : ({ schema: "baselines/1", rules: {} } as import("./lib/types.js").Baselines);
      const next = baselinesFrom(existing, measuredCounts(results), nowIso());
      const { assertValid } = await import("./lib/schema.js");
      assertValid("baselines", next);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(next, null, 2)}\n`);
      const total = Object.values(next.rules).reduce((a, r) => a + r.count, 0);
      process.stdout.write(
        `baselined ${Object.keys(next.rules).length} rule(s), ${total} existing violation(s), from ${results.map((r) => r.tool).join(", ") || "no checker"}\n`,
      );
      for (const u of unavailable) process.stdout.write(`  ${u.tool} could not run: ${u.detail.split("\n")[0] ?? ""}\n`);
      setOutput("violations", String(total));
      return 0;
    }

    case "write-triage":
      return writeTriageCommand(command[1], args);

    case "fetch-gate-failures":
      return fetchGateFailuresCommand(command[1], args);

    case "fetch-artifact":
      return fetchArtifactCommand(command[1], args);

    case "store-media":
      return storeMediaCommand(args);

    case "report":
      return reportCommand(second, args);

    case "garden-scan":
      return gardenScanCommand(args);

    case "garden-file":
      return gardenFileCommand(args);

    case "harden-context":
      return hardenContextCommand(command[1], args);

    case "review-collect":
      return reviewCollectCommand(args);

    case "review-write":
      return reviewWriteCommand(args);

    case "policy": {
      const prRaw = args["pr"];
      if (typeof prRaw !== "string") die("usage: bsf policy --pr N");
      const pr = Number(prRaw);
      if (!Number.isInteger(pr) || pr < 1) die(`--pr must be a positive integer, got ${prRaw}`);

      const checkName = typeof args["report-check"] === "string" ? args["report-check"] : "factory/policy";
      const gh = new GitHub({ repo: requireRepo() });
      const result = await runPolicyCommand({
        gh,
        loader: new DiskLoader(),
        pr,
        checkName,
        appLogins: appLogins(),
        report: args["report-check"] !== undefined,
      });

      if (result.conclusion === "success") {
        process.stdout.write("policy: pass\n");
        for (const n of result.notes) process.stdout.write(`  note: ${n}\n`);
        return 0;
      }
      const { awaitingApproval } = await import("./commands/policy-run.js");
      if (awaitingApproval(result)) {
        // Waiting is not failing: the job stays green and factory/policy
        // stays yellow until a trusted person approves.
        process.stdout.write("policy: awaiting a trusted approval\n");
        for (const f of result.failures) process.stdout.write(`  ${f.kind}: ${f.message}\n`);
        return 0;
      }
      process.stdout.write("policy: fail\n");
      for (const f of result.failures) {
        process.stdout.write(`  ${f.kind}: ${f.message}\n`);
      }
      for (const n of result.notes) process.stdout.write(`  note: ${n}\n`);
      return 1;
    }

    case "gates": {
      if (second === "static") return await gatesStatic(args);
      if (second === "coverage") return await gatesCoverage(args);
      if (second === "record") return gatesRecord(args);
      if (second === "tests") return await gatesTests(args);
      if (second !== "plan") die("usage: bsf gates plan|static|coverage|tests|record");
      const ev = gateEvent();
      const commit = typeof args["commit"] === "string" ? args["commit"] : ev.sha;
      // A label is a reason to judge only when it is the one that asks for
      // verification. Others — the factory's own factory:cleared among them —
      // change nothing about the change, and re-judging on them recorded a
      // second, different verdict on a commit already judged; the App's label
      // events also cannot check the PR out for the verifier.
      const verifyLabelName = typeof args["verify-label"] === "string" ? args["verify-label"] : "factory:verify";
      const judge = ev.action !== "labeled" || ev.label === verifyLabelName;
      setOutput("judge", String(judge));
      if (!judge) {
        process.stdout.write(`the ${ev.label} label changes nothing about this change; not judging it again\n`);
        return 0;
      }
      if (commit === "" || commit === "HEAD") die("no commit: pass --commit SHA or run inside Actions");
      // The factory's own change is a factory/ branch its App opened. Anyone
      // can name a branch factory/, so the author has to be a bot as well.
      const isFactoryChange = ev.headRef.startsWith("factory/") && (ev.pr === 0 || ev.authorIsBot);
      const actor =
        args["actor"] === "human" ? "human" : args["actor"] === "agent" ? "agent" : isFactoryChange ? "agent" : "human";
      const labels = typeof args["labels"] === "string" ? args["labels"].split(",") : ev.labels;
      const policy = await loadPolicy(new DiskLoader()).catch(() => null);
      const verifyLabel =
        typeof args["verify-label"] === "string" ? args["verify-label"] : "factory:verify";

      // A gate that already passed on this commit — its check runs say so —
      // re-runs nothing. Read from GitHub, which keeps them; a file in the
      // checkout would be gone when the job ended.
      let checked: readonly ("static" | "verification")[] = [];
      try {
        checked = checkedFromCheckRuns(await new GitHub({ repo: requireRepo() }).checkRunsFor(commit));
      } catch {
        /* unreadable: run everything rather than skip on a guess */
      }
      const plan = planGates({
        commit,
        actor,
        labels,
        alreadyChecked: { [commit]: checked },
        isUpdateFromMain: args["update-from-main"] === true,
        mainTouchesFeatureFolders: args["touches-feature-folders"] === true,
        verifyLabel,
      });

      setOutput("static", String(plan.static));
      setOutput("tests", String(plan.tests));
      setOutput("coverage", String(plan.coverage));
      setOutput("commit", commit);
      setOutput("pr_number", String(ev.pr));
      {
        const loadedM = loadManifest(process.cwd());
        setOutput("host_access", String(loadedM.kind === "ok" && needsHost(loadedM.manifest)));
      }
      // The verifier checks a factory change against its work item's spec.
      // The run links its PR to the item as soon as the build opens it; wait
      // a little for that link rather than verify against nothing.
      let workItem = "";
      // A factory PR that touches only .factory/ — setup, a sandbox amendment,
      // a definition change — has no work item and no spec: there is nothing
      // for the verifier to check it against, and policy already requires a
      // person to approve it. It is not agent-verified, and says why.
      let definitionOnly = false;
      if (plan.agentVerification && actor === "agent" && ev.pr > 0) {
        const files = await new GitHub({ repo: requireRepo() }).pullFiles(ev.pr).catch(() => []);
        definitionOnly = files.length > 0 && files.every((f) => f.filename.startsWith(".factory/"));
        if (definitionOnly) {
          process.stdout.write("  this PR changes only .factory/: not agent-verified (no spec to check it against); a person approves it under policy\n");
        }
      }
      if (plan.agentVerification && actor === "agent" && ev.pr > 0 && !definitionOnly) {
        const { FactoryStore } = await import("./lib/store.js");
        const store = new FactoryStore(new GitHub({ repo: requireRepo() }));
        for (let i = 0; i < 20 && workItem === ""; i++) {
          const ledger = await store.ledger(nowIso()).catch(() => null);
          workItem = ledger?.open.find((o) => o.pr === ev.pr)?.work_item ?? "";
          if (workItem === "") await new Promise((r) => setTimeout(r, 15_000));
        }
        if (workItem === "") process.stdout.write(`  no work item is linked to PR #${ev.pr}, so there is no spec to verify against\n`);
      }
      setOutput("work_item", workItem);
      // A factory change with no item to verify against does not pass by
      // skipping verification: the verifier runs and fails for want of a
      // spec. A human PR asking for it with the label gets it when it is
      // linked to an item, and is told otherwise.
      setOutput("agent_verification", String(plan.agentVerification && !definitionOnly && (actor === "agent" || workItem !== "")));
      for (const r of plan.reasons) process.stdout.write(`  ${r}\n`);
      void policy;
      return 0;
    }

    default:
      die(`unknown command: ${[first, second].filter(Boolean).join(" ")}\n\n${USAGE}`);
  }
}

/* ------------------------------------------------------------- gate commands */

function baseRef(args: Args): string {
  if (typeof args["base"] === "string") return args["base"];
  const envBase = process.env["GITHUB_BASE_REF"];
  if (envBase !== undefined && envBase !== "") return `origin/${envBase}`;
  return "origin/HEAD";
}

interface GateEvent {
  /** The commit a verdict belongs to: a PR's head, not the merge commit Actions checks out. */
  readonly sha: string;
  readonly action?: string;
  readonly label?: string;
  readonly pr: number;
  readonly headRef: string;
  readonly authorIsBot: boolean;
  readonly labels: readonly string[];
}

/** What the event that started this job says about the change being judged. */
function gateEvent(): GateEvent {
  let p: {
    pull_request?: { number?: number; head?: { sha?: string; ref?: string }; user?: { type?: string; login?: string }; labels?: { name?: string }[] };
    merge_group?: { head_sha?: string; head_ref?: string };
    action?: string;
    label?: { name?: string };
  } = {};
  const path = process.env["GITHUB_EVENT_PATH"];
  if (path !== undefined && existsSync(path)) {
    try {
      p = JSON.parse(readFileSync(path, "utf8")) as typeof p;
    } catch {
      /* no payload: fall back to the environment */
    }
  }
  const pr = p.pull_request;
  if (pr?.head?.sha !== undefined) {
    return {
      sha: pr.head.sha,
      ...(p.action === undefined ? {} : { action: p.action }),
      ...(p.label?.name === undefined ? {} : { label: p.label.name }),
      pr: pr.number ?? 0,
      headRef: pr.head.ref ?? "",
      authorIsBot: pr.user?.type === "Bot" || /\[bot\]$/.test(pr.user?.login ?? ""),
      labels: (pr.labels ?? []).map((l) => l.name ?? "").filter((n) => n !== ""),
    };
  }
  const sha = p.merge_group?.head_sha ?? process.env["GITHUB_SHA"] ?? "HEAD";
  const ref = (process.env["GITHUB_REF"] ?? "").replace(/^refs\/heads\//, "");
  return { sha, pr: 0, headRef: p.merge_group?.head_ref ?? ref, authorIsBot: false, labels: [] };
}

function headSha(): string {
  return gateEvent().sha;
}

async function maybeReportCheck(
  args: Args,
  conclusion: "success" | "failure" | "neutral",
  title: string,
  summary: string,
  fallbackName: string,
): Promise<void> {
  const name = typeof args["report-check"] === "string" ? args["report-check"] : null;
  if (name === null) return;
  const repo = process.env["GITHUB_REPOSITORY"];
  if (repo === undefined || repo === "") {
    process.stderr.write("bsf: --report-check needs GITHUB_REPOSITORY\n");
    return;
  }
  const gh = new GitHub({ repo });
  await gh.reportCheck({ name: name === "" ? fallbackName : name, headSha: headSha(), conclusion, title, summary });
}

async function gatesStatic(args: Args): Promise<number> {
  const root = process.cwd();
  const base = baseRef(args);
  const disk = new DiskLoader(root);
  const beforeLoader = new RefLoader(base);

  const policy = await loadPolicy(disk);
  const result = await runStaticGate({
    root,
    policy,
    baselineBefore: await loadBaselines(beforeLoader),
    baselineAfter: await loadBaselines(disk),
    coverageBefore: await loadCoverage(beforeLoader),
    coverageAfter: await loadCoverage(disk),
    changedFiles: changedFilesSince(base),
    declared: await declaredChecks(),
  });

  process.stdout.write(`${result.summary}\n`);
  await maybeReportCheck(
    args,
    result.conclusion,
    result.conclusion === "success" ? "No new violations" : result.conclusion === "neutral" ? "Nothing checked" : "Static rules failed",
    result.summary,
    "factory/gate-static",
  );
  setOutput("conclusion", result.conclusion);
  return result.conclusion === "failure" ? 1 : 0;
}

async function gatesCoverage(args: Args): Promise<number> {
  const root = process.cwd();
  const base = baseRef(args);
  const loaded = loadManifest(root);
  const report = loaded.kind === "ok" ? loaded.manifest.coverage_report : undefined;
  // The PR's pipeline, from the ledger: gardening and hardening are held to
  // the coverage floor but not to diff coverage (fix 20).
  let pipeline: string | undefined;
  const prNumber = Number(args["pr"]);
  if (prNumber > 0 && process.env["GITHUB_REPOSITORY"] !== undefined && process.env["GITHUB_REPOSITORY"] !== "") {
    try {
      const { FactoryStore } = await import("./lib/store.js");
      const store = new FactoryStore(new GitHub({ repo: process.env["GITHUB_REPOSITORY"] }));
      const led = await store.ledger(new Date().toISOString());
      pipeline = led.open.find((o: { pr?: number | null }) => o.pr === prNumber)?.pipeline;
    } catch {
      pipeline = undefined;
    }
  }
  const testCmd = sandboxCommand("test", root);
  const result = await runCoverageGate({
    root,
    ...(pipeline === undefined ? {} : { pipeline }),
    current: await loadCoverage(new DiskLoader(root)),
    changedFiles: changedFilesSince(base),
    changedLines: changedLinesSince(base),
    ...(report === undefined ? {} : { report }),
    repoHasTests: repoHasTests(root, testCmd.kind === "command" ? testCmd.command : null),
  });

  process.stdout.write(`${result.summary}\n`);
  await maybeReportCheck(
    args,
    result.conclusion,
    result.conclusion === "success" ? "Coverage held" : result.conclusion === "neutral" ? "No coverage report" : "Coverage failed",
    result.summary,
    "factory/gate-coverage",
  );
  setOutput("diff_pct", String(result.diff_pct ?? ""));
  setOutput("total_pct", String(result.total_pct ?? ""));
  return result.conclusion === "failure" ? 1 : 0;
}

/**
 * `bsf gates record` — report the one check branch protection requires.
 *
 * Protection required `factory/gates` while the gates reported only
 * `factory/gate-static`, `-tests` and `-coverage`, so with protection applied
 * every PR would have waited forever on a check nothing reported. This always
 * reports it, as the verdict over every gate the plan called for.
 */
async function gatesRecord(args: Args): Promise<number> {
  const result = (k: string): JobResult => {
    const v = args[k];
    return v === "success" || v === "failure" || v === "cancelled" || v === "skipped" ? v : "";
  };
  const planned = (k: string): boolean => args[k] === "true";
  const verdict = summarizeGates({
    planned: { static: planned("plan-static"), verification: planned("plan-verification"), agent: planned("plan-agent") },
    results: { static: result("static"), verification: result("verification"), agent: result("agent") },
  });
  const commit = typeof args["commit"] === "string" ? args["commit"] : headSha();
  process.stdout.write(`${GATES_CHECK}: ${verdict.conclusion}\n${verdict.lines.map((l) => `  ${l}`).join("\n")}\n`);
  await new GitHub({ repo: requireRepo() }).reportCheck({
    name: GATES_CHECK,
    headSha: commit,
    conclusion: verdict.conclusion,
    title: verdict.conclusion === "success" ? "Every planned gate passed" : "A planned gate did not pass",
    summary: verdict.lines.join("\n"),
  });
  if (verdict.conclusion === "success") await clearAfterGates(commit);
  return verdict.conclusion === "success" ? 0 : 1;
}

/**
 * A held or escalated factory change whose gates just passed (a sandbox repair
 * brought its branch up to date and it was verified again) is cleared here,
 * because no run is waiting to do it. Never fails the gates: a change that
 * cannot be cleared stays as it was and the next verdict tries again.
 */
async function clearAfterGates(commit: string): Promise<void> {
  try {
    const gh = new GitHub({ repo: requireRepo() });
    const prs = await gh.get<{ number: number; state: string; head: { sha: string } }[]>(
      `repos/${gh.repo}/commits/${commit}/pulls?per_page=20`,
    );
    const pr = (Array.isArray(prs) ? prs : []).find((p) => p.state === "open" && p.head.sha === commit);
    if (pr === undefined) return;
    const { clearHeldChange } = await import("./commands/run-lifecycle.js");
    const said = await clearHeldChange({ gh, pr: pr.number, now: () => new Date().toISOString() });
    process.stdout.write(`clear: ${said}\n`);
  } catch (e) {
    process.stdout.write(`clear: skipped (${e instanceof Error ? e.message : String(e)})\n`);
  }
}

/* ------------------------------------------------------------- new commands */

/**
 * factory.yaml, read from the checkout.
 *
 * Every path here must exist in schema/factory.json, which forbids unknown
 * keys. This interface was once written by hand and drifted: thirteen of the
 * paths it read could never be set by a user, so each silently fell back to a
 * hardcoded default — the concurrency limit, the merge-queue mode, the review
 * cadence and the budget's hard stop among them. A test now resolves every
 * `cfg.` path read in this file against the schema.
 */
interface FactoryConfig {
  harness?: string;
  models?: Record<string, string>;
  budget?: {
    monthly_usd?: number;
    monthly_actions_minutes?: number | null;
    shares?: Record<string, number>;
    product_work_hard_stop_pct?: number;
  };
  data?: { media_retention_months?: number };
  limits?: { retry_cap?: number; step_time_budget_sec?: number; concurrency?: { max_runs?: number } };
  review?: { every_days?: number; run_early_at_runs?: number; skip_below_runs?: number };
  pipelines?: Record<string, { auto_merge?: boolean; max_prs_per_run?: number }>;
  enforcement?: { merge_queue?: "auto" | "native" | "fallback" };
  triggers?: Record<string, boolean>;
  sandbox?: { agent_runtime?: string };
  existing_ci?: { test_check?: string | null };
}

/** Days of history the rollup summarizes. Not configurable; the schema has no field for it. */
const ROLLUP_WINDOW_DAYS = 30;

/** The required checks sync-settings adds. These are the factory's own check names. */
const FACTORY_REQUIRED_CHECKS = ["factory/policy", GATES_CHECK];

/**
 * The runner's own version: the VERSION file the bundle ships beside itself,
 * or the package version with "source" when running unbundled.
 */
function runnerVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "VERSION"), "utf8").trim();
  } catch {
    return `${VERSION} source`;
  }
}

/**
 * A command the sandbox episode verified, from the frozen manifest.
 *
 * Three answers, kept distinct because they mean different things to a gate:
 * the manifest is missing (setup never finished, so the factory does not know
 * how to run anything here), the manifest records no such command (this repo
 * has none, e.g. no tests), or the command itself.
 */
type SandboxCommand =
  | { readonly kind: "no_manifest" }
  | { readonly kind: "invalid"; readonly errors: readonly string[] }
  | { readonly kind: "none" }
  | { readonly kind: "command"; readonly command: string };

/**
 * The checkers declared in this checkout's sandbox manifest (the pull request
 * head), with the closed environment the sandbox start wrote, so they run
 * like the tests do. Secret values still come only from FACTORY_SANDBOX_ENV.
 */
async function declaredChecks(): Promise<{ checks: readonly import("./commands/sandbox.js").StaticCheck[]; env?: Record<string, string> }> {
  const loaded = loadManifest(process.cwd());
  const checks = loaded.kind === "ok" ? loaded.manifest.static_checks ?? [] : [];
  if (checks.length === 0) return { checks };
  const { closedEnv } = await import("./commands/sandbox.js");
  const env = closedEnv(process.env["GITHUB_WORKSPACE"] ?? process.cwd());
  return env === null ? { checks } : { checks, env };
}

function sandboxCommand(name: "test" | "build" | "coverage", root = process.cwd()): SandboxCommand {
  const loaded = loadManifest(root);
  if (loaded.kind === "missing") return { kind: "no_manifest" };
  if (loaded.kind === "invalid") return { kind: "invalid", errors: loaded.errors };
  const c = loaded.manifest.commands[name];
  return c === null || c === undefined || c.trim() === "" ? { kind: "none" } : { kind: "command", command: c };
}

/** Just the command, for callers that treat "none" and "unknown" alike. */
function sandboxCommandText(name: "test" | "build" | "coverage"): string | null {
  const c = sandboxCommand(name);
  return c.kind === "command" ? c.command : null;
}

async function factoryConfig(): Promise<FactoryConfig> {
  const doc = await loadFactory(new DiskLoader(process.cwd()));
  return doc ?? {};
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The dashboard's health line, from what can be read. The rollup used to
 * write fixed values — including an enforcement the schema does not allow,
 * which failed every rollup — and a guess is worse than a blank.
 */
async function measuredHealth(gh: GitHub, cfg: FactoryConfig): Promise<{
  gardening_schedule_active?: boolean;
  last_review?: string;
  sandbox_profile?: string;
  enforcement?: "branch_protection" | "audit";
}> {
  const out: { gardening_schedule_active?: boolean; last_review?: string; sandbox_profile?: string; enforcement?: "branch_protection" | "audit" } = {};
  out.sandbox_profile = cfg.sandbox?.agent_runtime === "docker-sudo-iptables" ? "docker-sudo-iptables" : "docker";
  try {
    const { FactoryStore } = await import("./lib/store.js");
    const reviews = (await new FactoryStore(gh).data.list("reviews/"))
      .map((p) => /^reviews\/(\d{4})-(\d{2})-(\d{2})\.json$/.exec(p))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => `rev_${m[1]}${m[2]}${m[3]}`)
      .sort();
    const last = reviews.at(-1);
    if (last !== undefined) out.last_review = last;
  } catch {
    /* unreadable: leave it out */
  }
  try {
    // The branch endpoint carries the protection summary with only contents
    // access, which the rollup's token has; the protection endpoint needs admin.
    const b = await gh.get<{ protected?: boolean; protection?: { required_status_checks?: { contexts?: string[] } } }>(
      `repos/${gh.repo}/branches/${await gh.defaultBranch()}`,
    );
    const contexts = b.protection?.required_status_checks?.contexts ?? [];
    out.enforcement = b.protected === true && contexts.includes(GATES_CHECK) ? "branch_protection" : "audit";
  } catch {
    /* unreadable: leave it out */
  }
  try {
    const garden = readFileSync(join(process.env["GITHUB_WORKSPACE"] ?? process.cwd(), ".github/workflows/factory-garden.yml"), "utf8");
    out.gardening_schedule_active = /^\s*schedule:/m.test(garden) && cfg.pipelines?.["gardening"]?.max_prs_per_run !== 0;
  } catch {
    /* no workflow in this checkout: leave it out */
  }
  return out;
}

/** How many runs are in flight, from the live refs' files, after ending the ones that are not. */
async function runningRuns(gh: GitHub): Promise<number> {
  const { reapStaleRuns } = await import("./commands/run-lifecycle.js");
  try {
    const r = await reapStaleRuns(gh, nowIso());
    for (const x of r.reaped) {
      process.stdout.write(`ended ${x.run}, which stopped without finishing${x.requeued ? `; ${x.work_item} is queued again` : ""}\n`);
    }
  } catch (e) {
    process.stdout.write(`could not check for runs that stopped: ${(e as Error).message}\n`);
  }
  const { FactoryStore } = await import("./lib/store.js");
  const store = new FactoryStore(gh);
  try {
    const live = await store.data.list("live/");
    return live.filter((p) => p.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function budgetLimits(cfg: FactoryConfig): BudgetLimits {
  const shares = cfg.budget?.shares ?? {};
  return {
    monthlyUsd: cfg.budget?.monthly_usd ?? 0,
    shares: {
      product_work: shares["product_work"] ?? 60,
      gardening: shares["gardening"] ?? 25,
      review_and_benchmarks: shares["review_and_benchmarks"] ?? 15,
    },
    productHardStopPct: cfg.budget?.product_work_hard_stop_pct ?? 110,
  };
}

/**
 * What dispatch and the rollup see of the budget: per share, what is spent
 * plus what running steps hold, from the one budget record the reserve and
 * settle steps keep (budget.json, schema budget/2).
 */
async function budgetState(cfg: FactoryConfig, gh: GitHub): Promise<BudgetState> {
  const { FactoryStore } = await import("./lib/store.js");
  const store = new FactoryStore(gh);
  const raw = await store.data.readJson<BudgetDoc | { schema?: string }>(BUDGET_PATH);
  const doc = raw !== null && (raw as { schema?: string }).schema === "budget/2" ? rollMonth(raw as BudgetDoc, nowIso()) : null;
  const limits = budgetLimits(cfg);
  const spentUsd: Record<string, number> = {};
  if (doc !== null) {
    for (const share of ["product_work", "gardening", "review_and_benchmarks"] as const) spentUsd[share] = used(doc, share).share;
    spentUsd["setup"] = used(doc, null).total - Object.values(spentUsd).reduce((a, b) => a + b, 0);
  }
  // A pipeline is paused when its largest step no longer fits: its queued
  // work then waits rather than starting runs the budget would refuse.
  const models = (cfg.models ?? {});
  const paused = (["product_work", "gardening", "hardening", "conflict", "definition"] as const).filter(
    (p) => !canStart(doc, limits, p, models, nowIso()).ok,
  );
  return {
    limitUsd: limits.monthlyUsd,
    limitMinutes: cfg.budget?.monthly_actions_minutes ?? null,
    shares: limits.shares,
    spentUsd,
    spentMinutes: {},
    productHardStopPct: limits.productHardStopPct,
    paused,
  };
}

/**
 * The chief of staff, when it can run: it needs the factory's own API key, and
 * it is skipped while product work is over its budget, so a stopped factory
 * does not spend on routing what it cannot start.
 */
async function chiefOfStaff(cfg: FactoryConfig, gh: GitHub): Promise<{ router?: import("./commands/routing-run.js").Router }> {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key === undefined || key === "") return {};
  if (pausedPipelines(await budgetState(cfg, gh)).includes("product_work")) return {};
  const { anthropicComplete } = await import("./commands/chief-of-staff.js");
  const { FactoryStore } = await import("./lib/store.js");
  const store = new FactoryStore(gh);
  const model = (cfg.models)?.["chief_of_staff"] ?? "claude-haiku-5-5";
  const cap = (text: string | null, n: number): string => (text === null ? "" : text.slice(0, n));
  return {
    router: {
      complete: anthropicComplete(key, model),
      model,
      context: async () => {
        const ref = await gh.defaultBranch();
        const [featureMap, history] = await Promise.all([
          gh.fileAtRef(".factory/definition/context/feature-map.md", ref).catch(() => null),
          gh.fileAtRef(".factory/definition/context/history.md", ref).catch(() => null),
        ]);
        const h = history ?? "";
        return { featureMap: cap(featureMap, 6000), history: h.length > 3000 ? h.slice(-3000) : h };
      },
      charge: async (usd, chargeKey) => {
        await store.data.updateJson<BudgetDoc, null>(
          BUDGET_PATH,
          (current) => {
            const base = current !== null && current.schema === "budget/2" ? current : null;
            const r = settleBudget(base, { key: chargeKey, agentUsd: usd, detectionUsd: 0, pipeline: "product_work" }, nowIso());
            return { next: r.doc, result: null };
          },
          `budget: routing ${chargeKey}`,
        );
      },
    },
  };
}

/**
 * Which failed workflow intake will accept, or nothing when the default branch cannot be read.
 *
 * The workflow name is `existing_ci.test_check` when that is set, otherwise `ci`.
 * Failing closed (no watch) means a workflow_run is not turned into a request.
 *
 * @param gh - the repository client
 * @param cfg - the factory config from the trusted definition
 */
async function ciWatch(
  gh: GitHub,
  cfg: FactoryConfig,
): Promise<{ ci: { workflow: string; defaultBranch: string } } | Record<string, never>> {
  try {
    const { ciWorkflowName } = await import("./commands/intake-run.js");
    return { ci: { workflow: ciWorkflowName(cfg.existing_ci?.test_check), defaultBranch: await gh.defaultBranch() } };
  } catch {
    return {};
  }
}

async function intakeCommand(args: Args): Promise<number> {
  const cfg = await factoryConfig();
  const gh = new GitHub({ repo: requireRepo() });
  const eventName =
    typeof args["event-name"] === "string" ? args["event-name"] : process.env["GITHUB_EVENT_NAME"] ?? "";
  const eventPath =
    typeof args["event"] === "string" ? args["event"] : process.env["GITHUB_EVENT_PATH"] ?? "";
  if (eventName === "" || eventPath === "") {
    die("no event to read: pass --event-name and --event, or run inside Actions");
  }

  const triggers = cfg.triggers ?? {};
  // The record job fixes the event's time and hands it to the process job
  // with --at, so both name the event the same id and it is one event, not
  // two (fix 4).
  const at = typeof args["at"] === "string" && !Number.isNaN(Date.parse(args["at"])) ? args["at"] : nowIso();
  const intakeOpts = {
    gh,
    eventName,
    eventPath,
    now: at,
    policy: await loadPolicy(new DiskLoader(process.cwd())),
    triggers: {
      issues: triggers["issues"] !== false,
      comments: triggers["comments"] !== false,
      ci_failure_on_main: triggers["ci_failure_on_main"] !== false,
      dashboard_dispatch: triggers["dashboard_dispatch"] !== false,
    },
    maxRuns: cfg.limits?.concurrency?.max_runs ?? 5,
    runningRuns: await runningRuns(gh),
    pausedPipelines: pausedPipelines(await budgetState(cfg, gh)),
    setupFinished: await gh.setupFinished(),
    ...(args["plan"] === true ? { plan: true } : {}),
    ...(await chiefOfStaff(cfg, gh)),
    ...(await ciWatch(gh, cfg)),
  };

  if (args["record-only"] === true) {
    const recorded = await recordIntakeCommand(intakeOpts);
    setOutput("at", at);
    process.stdout.write(`recorded event ${recorded.event ?? "(none: not a request)"}\n`);
    await reportApiCalls(gh, nowIso(), (t) => process.stdout.write(t));
    return 0;
  }
  const report = await runIntakeCommand(intakeOpts);
  for (const d of report.result.decisions) {
    process.stdout.write(`${d.event.kind}: ${d.outcome} — ${d.reason}\n`);
  }
  process.stdout.write(
    `${report.result.processed} event(s) processed; dispatched ${report.dispatched.length}: ${report.decision.reason}\n`,
  );
  setOutput("dispatched", report.dispatched.join(","));
  await reportApiCalls(gh, nowIso(), (t) => process.stdout.write(t));
  return 0;
}

async function runCommand(second: string | undefined, args: Args, third?: string): Promise<number> {
  if (second === "plan") {
    // `bsf run plan WORK_ITEM --attempt N`, which is how factory-run calls it:
    // the pipeline comes from the work item, because the item is what knows
    // whether it is product work, gardening or hardening. `--pipeline` alone
    // still works for planning without one, as the tests and the dashboard do.
    //
    // This and the workflow were written separately and never run together:
    // the workflow passed a work item and read four outputs the command did
    // not set, and the command required a flag the workflow did not pass, so
    // factory-run's first step would have died on a usage error.
    const workItemId = third;
    let pipeline = typeof args["pipeline"] === "string" ? args["pipeline"] : undefined;
    let hasSpec = true;
    // Fix 7: what the item already knows decides which steps a run repeats.
    let skipTriage = false;
    let brainstormOpen = false;
    if (typeof workItemId === "string") {
      const { FactoryStore, workItemPath } = await import("./lib/store.js");
      const store = new FactoryStore(new GitHub({ repo: requireRepo() }));
      const item = await store.get<{ pipeline: string; spec?: unknown; triage_reason?: unknown }>(workItemPath(workItemId), "work-item");
      if (item === null && pipeline === undefined) die(`${workItemId} is not on the data ref`);
      if (item !== null) {
        if (pipeline === undefined) {
          pipeline = item.pipeline;
          hasSpec = item.spec !== null && item.spec !== undefined;
        }
        // Triage already ran and a spec exists: a reply or an approval does
        // not need the item read again (about 3 billable minutes each time).
        const spec = item.spec;
        skipTriage =
          typeof item.triage_reason === "string" &&
          spec !== null && typeof spec === "object" && Object.keys(spec).length > 0;
        // A conversation is still open on this item: the reply goes to it.
        const { brainstormPath } = await import("./commands/brainstorm.js");
        const b = await store.data.readJson<{ closed_at?: string }>(brainstormPath(workItemId)).catch(() => null);
        brainstormOpen = b !== null && b.closed_at === undefined;
      }
    }
    // A conflict rebuild: the same change, rebuilt on the current main by the
    // builder and verified. The intent and spec are the item's already.
    if (args["reason"] === "conflict") pipeline = "conflict";
    if (pipeline === undefined) die("usage: bsf run plan WORK_ITEM [--attempt N] | --pipeline P");
    const attempt = typeof args["attempt"] === "string" ? Number(args["attempt"]) : 1;
    const cfg: FactoryConfig = await factoryConfig().catch((): FactoryConfig => ({}));
    const plan = planRun({
      pipeline: pipeline as Parameters<typeof planRun>[0]["pipeline"],
      attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
      maxAttempts: cfg.limits?.retry_cap ?? 3,
      ...(args["revision"] === true ? { revision: true } : {}),
    });

    // A retry repeats only the build, because the spec is already on the
    // item. When it is not — the spec step itself is what failed — the retry
    // has to start where the last attempt stopped, or the builder runs with
    // no plan at all, which is what happened on attempts 2 and 3 on ts-webapp.
    let roles = plan.roles;
    if (!hasSpec && plan.attempt > 1 && !plan.escalate) {
      const first = planRun({ pipeline: pipeline as Parameters<typeof planRun>[0]["pipeline"], attempt: 1, maxAttempts: cfg.limits?.retry_cap ?? 3 });
      if (first.roles.includes("spec")) roles = first.roles;
    }

    // gh-aw's protected-file policy for this pipeline's safe outputs.
    let protectedFilesPolicy = "request-review";
    try {
      const policy = await loadPolicy(new DiskLoader(process.cwd()));
      protectedFilesPolicy = policy.protected_files?.policy ?? protectedFilesPolicy;
    } catch {
      /* no policy in this checkout: keep the safe default */
    }

    // The budget: a run whose largest step does not fit what is left waits
    // in the queue instead of starting and being refused halfway. Dispatch
    // applies the same rule, so a waiting item is not dispatched again until
    // the budget allows it.
    let budgetWait = false;
    if (!plan.escalate && roles.length > 0 && typeof workItemId === "string") {
      const { FactoryStore } = await import("./lib/store.js");
      const raw = await new FactoryStore(new GitHub({ repo: requireRepo() })).data.readJson<BudgetDoc>(BUDGET_PATH).catch(() => null);
      const doc = raw !== null && raw.schema === "budget/2" ? raw : null;
      const check = canStart(doc, budgetLimits(cfg), pipeline, (cfg.models ?? {}), nowIso(), roles);
      if (!check.ok) {
        budgetWait = true;
        process.stdout.write(`waiting for budget: ${check.reason}\n`);
        summary(`### Waiting for budget\n\nThis run did not start: ${check.reason}. The item stays queued and starts when the budget allows (next month, or when the monthly budget is raised on the dashboard's Factory page).\n`);
      }
    }
    setOutput("budget_wait", String(budgetWait));

    process.stdout.write(`${plan.reason}\nroles: ${roles.join(" -> ") || "(none)"}\n`);
    setOutput("pipeline", pipeline);
    setOutput("roles", roles.join(","));
    const runsTriage = roles.includes("triage") && !skipTriage && !brainstormOpen;
    setOutput("needs_triage", String(runsTriage));
    setOutput("skip_triage", String(skipTriage || brainstormOpen));
    setOutput("brainstorm_open", String(brainstormOpen));
    setOutput("needs_hardener", String(roles.includes("hardener")));
    setOutput("needs_spec", String(roles.includes("spec")));
    setOutput("protected_files_policy", protectedFilesPolicy);
    setOutput("proceed", String(!plan.escalate && !budgetWait));
    setOutput("escalate", String(plan.escalate));
    setOutput("attempt", String(plan.attempt));
    {
      const loadedM = loadManifest(process.cwd());
      setOutput("host_access", String(loadedM.kind === "ok" && needsHost(loadedM.manifest)));
    }
    setOutput("first_step", roles[0] === "verifier" ? "verifier" : (roles[0] ?? "builder"));
    // Escalation is an outcome, not a crash: the jobs downstream read
    // `proceed`, and failing this job would bury the reason under red.
    return 0;
  }

  if (second === "drop") {
    // `bsf run drop --items ID[,ID...] --why TEXT`: an owner takes work back.
    const items = typeof args["items"] === "string" ? args["items"].split(/[\s,]+/).filter((x) => x !== "") : [];
    const why = typeof args["why"] === "string" && args["why"].trim() !== "" ? args["why"].trim() : "no reason given";
    if (items.length === 0) die("usage: bsf run drop --items ID[,ID...] --why TEXT");
    const { dropItems } = await import("./commands/run-lifecycle.js");
    const r = await dropItems({ gh: new GitHub({ repo: requireRepo() }), ids: items, why, now: nowIso() });
    process.stdout.write(
      `dropped ${r.dropped.length}: ${r.dropped.join(", ") || "none"}\n` +
        r.skipped.map((s) => `skipped ${s.work_item}: ${s.why}\n`).join("") +
        (r.cancelledRuns.length > 0 ? `cancelled run(s) ${r.cancelledRuns.join(", ")}\n` : "") +
        (r.closedPrs.length > 0 ? `closed PR(s) ${r.closedPrs.map((n) => `#${n}`).join(", ")}\n` : ""),
    );
    return 0;
  }

  if (second === "closed") {
    // `bsf run closed --pr N --merged true|false`: a factory PR closed, so
    // its work item is done. Then anything that waited on it may go.
    const pr = Number(args["pr"]);
    if (!Number.isInteger(pr) || pr <= 0) die("usage: bsf run closed --pr N --merged true|false");
    const merged = args["merged"] === "true" || args["merged"] === true;
    const gh = new GitHub({ repo: requireRepo() });
    const { prClosed } = await import("./commands/run-lifecycle.js");
    const now = nowIso();
    const r = await prClosed({ gh, pr, merged, now });
    process.stdout.write(
      r.workItem === null
        ? `PR #${pr} is not a factory work item's; nothing to record\n`
        : `PR #${pr} ${merged ? "merged" : "closed"}: ${r.workItem} is ${r.status}` +
            (r.runsUpdated.length > 0 ? `; run(s) ${r.runsUpdated.join(", ")} updated` : "") + "\n",
    );
    const { FactoryStore } = await import("./lib/store.js");
    const { sweepReports } = await import("./commands/sandbox-reports.js");
    const store = new FactoryStore(gh);
    const sweep = await sweepReports({ gh, store, ledger: await store.ledger(now), now, fits: async () => amendmentFits(gh, await factoryConfig()) });
    process.stdout.write(`${sweep.why}\n`);
    return 0;
  }

  if (second === "fail-step") {
    // `bsf run fail-step ITEM --step triage`: a role's job failed. Carry on if
    // its agent in fact finished; otherwise queue the item again.
    if (third === undefined || typeof args["step"] !== "string") die("usage: bsf run fail-step WORK_ITEM --step triage");
    const { failStep } = await import("./commands/run-lifecycle.js");
    const gh = new GitHub({ repo: requireRepo() });
    const r = await failStep({ gh, workItem: third, step: args["step"], runId: process.env["GITHUB_RUN_ID"] ?? "", now: new Date().toISOString() });
    process.stdout.write(`${r.action}: ${r.reason}\n`);
    setOutput("recovered", String(r.recovered));
    return 0;
  }

  if (second === "status") {
    // `bsf run status WORK_ITEM`: proceed=true while the item is still the run's.
    if (third === undefined) die("usage: bsf run status WORK_ITEM");
    const { itemStatus, advanceLiveForItem } = await import("./commands/run-lifecycle.js");
    const gh = new GitHub({ repo: requireRepo() });
    await advanceLiveForItem(gh, third).catch(() => undefined);
    const status = await itemStatus(gh, third);
    process.stdout.write(`${third} is ${status}\n`);
    setOutput("status", status);
    setOutput("proceed", String(status === "running"));

    // A request triage could not pin down is not a dead end any more: the run
    // goes on to a conversation. Two things have to be true — triage asked for
    // information, and nobody is already talking to them, because a second
    // conversation would ask the same question twice.
    const { readBrainstorm, heldLive } = await import("./commands/brainstorm.js");
    const convo = await readBrainstorm(gh, third).catch(() => null);
    const live = heldLive(convo, new Date());
    const wants = status === "needs_info" && !live;
    setOutput("wants_conversation", String(wants));
    // Set when a conversation has already run and settled, which is what lets
    // the spec step proceed from an item triage had marked needs_info.
    setOutput("understood", String(convo?.closed_at !== undefined && convo.understood !== null));
    if (live) process.stdout.write(`a conversation is already open on ${third}; not starting another\n`);
    return 0;
  }

  if (second === "announce") {
    // `bsf run announce WORK_ITEM`: the safety net that makes sure a run which
    // ended without a PR still said something to whoever asked for it.
    if (third === undefined) die("usage: bsf run announce WORK_ITEM");
    const { announceTerminalState } = await import("./commands/run-lifecycle.js");
    process.stdout.write(`${await announceTerminalState(new GitHub({ repo: requireRepo() }), third)}\n`);
    return 0;
  }

  if (second === "start") {
    // `bsf run start WORK_ITEM --attempt N [--escalate true] [--first-step ROLE]`
    if (third === undefined) die("usage: bsf run start WORK_ITEM [--attempt N] [--escalate true]");
    const { startRun } = await import("./commands/run-lifecycle.js");
    const attempt = typeof args["attempt"] === "string" ? Number(args["attempt"]) : 1;
    const r = await startRun({
      gh: new GitHub({ repo: requireRepo() }),
      workItem: third,
      attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
      escalate: args["escalate"] === "true" || args["escalate"] === true,
      firstStep: typeof args["first-step"] === "string" ? args["first-step"] : "builder",
      now: nowIso(),
      ...(typeof args["reason"] === "string" && args["reason"] !== "" ? { reason: args["reason"] } : {}),
      ...(Number(args["pr"]) > 0 ? { pr: Number(args["pr"]) } : {}),
      ...(Number(process.env["GITHUB_RUN_ID"]) > 0 ? { actionsRun: Number(process.env["GITHUB_RUN_ID"]) } : {}),
    });
    process.stdout.write(r.runId === "" ? `${r.reason}\n` : `${third} is ${r.status}; run ${r.runId}\n`);
    setOutput("run_id", r.runId);
    return 0;
  }

  if (second === "decide") {
    // `bsf run decide PR`: the gates for PR have finished (factory-gates calls
    // this), so finish the run that handed off to them: clear, retry or
    // escalate. Nothing parked for the PR means nothing to do (fix 6).
    const prNumber = Number(third);
    if (!Number.isInteger(prNumber) || prNumber <= 0) die("usage: bsf run decide PR_NUMBER");
    const { finishRun } = await import("./commands/run-lifecycle.js");
    const { FactoryStore } = await import("./lib/store.js");
    type Handoff = import("./commands/run-lifecycle.js").Handoff;
    const gh = new GitHub({ repo: requireRepo() });
    const store = new FactoryStore(gh);
    await store.data.pin();
    const parked = (await store.data.list("handoff/")).filter((p: string) => p.endsWith(".json"));
    let handoff: Handoff | null = null;
    for (const path of parked) {
      const h = await store.data.readJson<Handoff>(path);
      if (h !== null && h.pr === prNumber) handoff = h;
    }
    if (handoff === null) {
      process.stdout.write(`nothing is waiting on the gates for PR #${prNumber}\n`);
      setOutput("next", "none");
      return 0;
    }
    store.data.unpin();
    const cfg: FactoryConfig = await factoryConfig().catch((): FactoryConfig => ({}));
    const r = await finishRun({
      gh,
      workItem: handoff.work_item,
      runId: handoff.run,
      attempt: handoff.attempt,
      maxAttempts: cfg.limits?.retry_cap ?? 3,
      pr: handoff.pr,
      buildResult: handoff.build_result,
      now: nowIso,
      // One look: the gates have just reported, or this was called too early.
      waitMs: 0,
      pollMs: 60_000,
    });
    process.stdout.write(`${r.next}: ${r.reason}${r.pr === null ? "" : ` (PR #${r.pr})`}\n`);
    setOutput("next", r.next);
    await reportApiCalls(gh, nowIso(), (t) => process.stdout.write(t));
    return 0;
  }

  if (second === "after-gates" && third !== undefined && args["static"] === undefined) {
    // `bsf run after-gates WORK_ITEM --run-id R --attempt N [--pr N] [--build-result R] [--wait-min M]`
    const { finishRun } = await import("./commands/run-lifecycle.js");
    const runIdArg = args["run-id"];
    if (typeof runIdArg !== "string" || runIdArg === "") die("usage: bsf run after-gates WORK_ITEM --run-id R ...");
    const cfg: FactoryConfig = await factoryConfig().catch((): FactoryConfig => ({}));
    const attempt = typeof args["attempt"] === "string" ? Number(args["attempt"]) : 1;
    const pr = typeof args["pr"] === "string" ? Number(args["pr"]) : 0;
    // 0 hands the run to the gates' own workflow instead of waiting here (fix 6).
    const waitMin = typeof args["wait-min"] === "string" ? Number(args["wait-min"]) : 0;
    // The roles' StepReports, downloaded from this run's artifacts.
    const steps: import("./commands/run-lifecycle.js").StepReportDoc[] = [];
    const stepsDir = typeof args["steps-dir"] === "string" ? args["steps-dir"] : undefined;
    if (stepsDir !== undefined && existsSync(stepsDir)) {
      const walk = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".json") ? [join(d, e.name)] : []));
      for (const f of walk(stepsDir)) {
        try {
          steps.push(JSON.parse(readFileSync(f, "utf8")) as import("./commands/run-lifecycle.js").StepReportDoc);
        } catch {
          process.stdout.write(`  ${f} is not a StepReport; left out\n`);
        }
      }
    }
    const r = await finishRun({
      gh: new GitHub({ repo: requireRepo() }),
      workItem: third,
      steps,
      runId: runIdArg,
      attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
      maxAttempts: cfg.limits?.retry_cap ?? 3,
      pr: Number.isInteger(pr) && pr > 0 ? pr : null,
      buildResult: typeof args["build-result"] === "string" ? args["build-result"] : "",
      now: nowIso,
      waitMs: waitMin * 60_000,
      // Each poll is two API calls on an App installation every repo shares.
      pollMs: 60_000,
    });
    process.stdout.write(`${r.next}: ${r.reason}${r.pr === null ? "" : ` (PR #${r.pr})`}\n`);
    setOutput("next", r.next);
    setOutput("attempt", String(r.attempt));
    return 0;
  }

  if (second === "after-gates") {
    const s = args["static"];
    const v = args["verification"];
    if (typeof s !== "string" || typeof v !== "string") {
      die("usage: bsf run after-gates --static passed|failed|skipped --verification passed|failed|skipped|not_run");
    }
    const attempt = typeof args["attempt"] === "string" ? Number(args["attempt"]) : 1;
    const decision = afterGates({
      staticGate: s as "passed" | "failed" | "skipped",
      verificationGate: v as "passed" | "failed" | "skipped" | "not_run",
      attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
      ...(typeof args["summary"] === "string" ? { failureSummary: args["summary"] } : {}),
    });
    process.stdout.write(`${decision.next}: ${decision.reason}\n`);
    setOutput("next", decision.next);
    setOutput("attempt", String("attempt" in decision ? decision.attempt : attempt));
    return 0;
  }

  die("usage: bsf run plan|start|decide|after-gates");
}

async function rollupCommand(args: Args): Promise<number> {
  const cfg = await factoryConfig();
  const gh = new GitHub({ repo: requireRepo() });
  const now = nowIso();
  if (args["plan"] !== true) await sweepStaleHolds(gh);
  const { loadBaselines: lb, loadCoverage: lc } = await import("./lib/config.js");
  const loader = new DiskLoader(process.cwd());
  const baselines = await lb(loader);
  const coverage = await lc(loader);

  const ruleCount = Object.keys(baselines.rules ?? {}).length;
  // Each entry is a BaselineRule, not a per-file map: its own keys are
  // `count`, `by_file` and so on. Summing those directly added `count` to the
  // per-file numbers and concatenated the `by_file` object into the total.
  const baselined = Object.values(baselines.rules ?? {}).reduce(
    (total, entry) => total + Object.values(byFileOf(entry)).reduce((x, y) => x + y, 0),
    0,
  );

  const report = await runRollupCommand({
    gh,
    now,
    windowDays: ROLLUP_WINDOW_DAYS,
    maxRuns: cfg.limits?.concurrency?.max_runs ?? 5,
    runnerPin: runnerVersion(),
    harness: cfg.harness ?? "claude-code",
    budget: await budgetState(cfg, gh),
    setupFinished: await gh.setupFinished(),
    guardrails: {
      rules: ruleCount,
      baselined,
      coverage_floor_pct: coverage.floor_pct,
      candidates_pending: 0,
    },
    health: await measuredHealth(gh, cfg),
    amendmentFits: () => amendmentFits(gh, cfg),
    ...(args["plan"] === true ? { plan: true } : {}),
  });

  process.stdout.write(
    `${report.metrics.runs} run(s) in the last ${report.metrics.window_days} days; ` +
      `${report.metrics.merged} merged; $${report.metrics.spend_usd.toFixed(2)} spent\n` +
      `${report.dispatchReason}\n` +
      (report.amendment === undefined ? "" : `${report.amendment}\n`),
  );
  if (report.paused.length > 0) {
    process.stdout.write(`paused: ${report.paused.join(", ")}\n`);
  }
  await reportApiCalls(gh, now, (t) => process.stdout.write(t));

  if (args["squash-media"] === true) {
    const months = cfg.data?.media_retention_months ?? 12;
    const r = await squashMedia(gh, now, months);
    process.stdout.write(`media: kept ${r.kept}, dropped ${r.dropped}\n`);
  }
  return 0;
}

/** Append to the job's summary page, when there is one. */
function summary(markdown: string): void {
  const path = process.env["GITHUB_STEP_SUMMARY"];
  if (path === undefined || path === "") return;
  try {
    appendFileSync(path, markdown);
  } catch {
    /* a summary is a courtesy; the log line above already says it */
  }
}

/** No step runs longer than this (the longest role timeout is 75 minutes); older holds are swept. */
const STALE_HOLD_SEC = 4 * 3600;

/**
 * `bsf budget reserve --key K --pipeline P --role R --model M --cap N
 * [--detection-model M --detection-cap N]`: hold this step's ceiling, or
 * refuse. Run before the agent starts; a refusal exits 1, so the agent does
 * not run, and says why on the job's summary.
 */
async function budgetReserveCommand(args: Args): Promise<number> {
  const str = (k: string): string | undefined => (typeof args[k] === "string" ? (args[k]) : undefined);
  const key = str("key");
  const pipeline = str("pipeline") ?? "product_work";
  const role = str("role");
  const model = str("model");
  const cap = Number(str("cap"));
  if (key === undefined || role === undefined || model === undefined || !Number.isFinite(cap)) {
    die("usage: bsf budget reserve --key K --pipeline P --role R --model M --cap CREDITS [--detection-model M --detection-cap CREDITS]");
  }
  const cfg = await factoryConfig();
  // The budget rests on gh-aw's credit cap, which stops Claude Code and was
  // shown not to stop Cursor. On any other harness no ceiling is real.
  if ((cfg.harness ?? "claude-code") !== "claude-code") {
    process.stdout.write(`refused: the factory is set to harness ${String(cfg.harness)}; only Claude Code's spend can be capped\n`);
    setOutput("allowed", "false");
    summary(`### Not started\n\nThe factory is set to the \`${String(cfg.harness)}\` harness. It runs only on Claude Code, the one harness whose spend its budget can stop. Ask Claude Code to update your factory to switch back.\n`);
    return 1;
  }
  const gh = new GitHub({ repo: requireRepo() });
  const { FactoryStore } = await import("./lib/store.js");
  const store = new FactoryStore(gh);
  const limits = budgetLimits(cfg);
  const now = nowIso();
  const outcome = await store.data.updateJson<BudgetDoc, ReturnType<typeof reserveBudget>>(
    BUDGET_PATH,
    (current) => {
      const base = current !== null && current.schema === "budget/2" ? current : null;
      const r = reserveBudget(base, {
        key, pipeline, role, model, capCredits: cap,
        detectionModel: str("detection-model") ?? "claude-haiku-5-5",
        detectionCapCredits: Number(str("detection-cap") ?? "0"),
      }, limits, now);
      return { next: r.ok && r.doc !== base ? r.doc : null, result: r };
    },
    `budget: reserve ${key}`,
  );
  process.stdout.write(`${outcome.ok ? "reserved" : "refused"}: ${outcome.reason}\n`);
  setOutput("allowed", String(outcome.ok));
  if (!outcome.ok) {
    summary(`### Not started: over budget\n\n${outcome.reason}.\n\nThe factory stops before a step could pass the monthly budget. ` +
      `It starts again next month, or when the monthly budget is raised on the dashboard's Factory page.\n`);
    return 1;
  }
  return 0;
}

/**
 * `bsf budget measure --key K --model M --detection-artifact NAME --out PATH`:
 * in the role's agent job, after the agent, write what it spent for the
 * caller's settle job to read.
 */
async function budgetMeasureCommand(args: Args): Promise<number> {
  const str = (k: string): string | undefined => (typeof args[k] === "string" ? (args[k]) : undefined);
  const out = str("out");
  const key = str("key");
  const model = str("model");
  if (out === undefined || key === undefined || model === undefined) {
    die("usage: bsf budget measure --key K --model M --detection-artifact NAME --out PATH");
  }
  const { readSessionUsage } = await import("./lib/session.js");
  const usage = readSessionUsage(sessionDirs(args));
  const measure: BudgetMeasure = {
    schema: "budget-measure/1",
    key,
    model,
    ...(str("pipeline") === undefined ? {} : { pipeline: str("pipeline")! }),
    agent_usd: measuredUsd(model, usage),
    detection_artifact: str("detection-artifact") ?? "",
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(measure, null, 2)}\n`);
  process.stdout.write(`${key}: agent ${measure.agent_usd === null ? "not measured (the ceiling will be charged)" : `$${measure.agent_usd.toFixed(4)}`}\n`);
  return 0;
}

/**
 * `bsf budget settle --key K [--measured PATH] [--detection-dir DIR]
 * [--detection-model M] [--agent-aic N] [--detection-aic N] [--pipeline P]`:
 * replace a step's hold with what it measured. A missing number is charged
 * at the ceiling, never as zero.
 */
async function budgetSettleCommand(args: Args): Promise<number> {
  const str = (k: string): string | undefined => (typeof args[k] === "string" ? (args[k]) : undefined);
  const key = str("key");
  if (key === undefined) die("usage: bsf budget settle --key K [--measured PATH] [--detection-dir DIR] [--not-run]");
  const release = args["not-run"] === true;
  let agentUsd = creditsToUsd(str("agent-aic"));
  let pipeline = str("pipeline");
  const measuredPath = str("measured");
  if (measuredPath !== undefined && existsSync(measuredPath)) {
    try {
      const m = JSON.parse(readFileSync(measuredPath, "utf8")) as BudgetMeasure;
      if (m.key === key && typeof m.agent_usd === "number") agentUsd = m.agent_usd;
      if (m.key === key && pipeline === undefined && typeof m.pipeline === "string") pipeline = m.pipeline;
    } catch {
      /* an unreadable measure is a missing one: the ceiling is charged */
    }
  }
  let detUsd = creditsToUsd(str("detection-aic"));
  const detDir = str("detection-dir");
  if (detUsd === null && detDir !== undefined) detUsd = detectionUsd(detDir, str("detection-model") ?? "claude-haiku-5-5", (l) => process.stdout.write(`${l}\n`));
  const gh = new GitHub({ repo: requireRepo() });
  const { FactoryStore } = await import("./lib/store.js");
  const store = new FactoryStore(gh);
  const now = nowIso();
  let heldSince: string | null = null;
  const r = await store.data.updateJson<BudgetDoc, ReturnType<typeof settleBudget>>(
    BUDGET_PATH,
    (current) => {
      const base = current !== null && current.schema === "budget/2" ? current : null;
      heldSince = base?.inflight.find((f) => f.key === key)?.started_at ?? null;
      const out = settleBudget(base, { key, agentUsd, detectionUsd: detUsd, ...(pipeline === undefined ? {} : { pipeline }), ...(release ? { release: true } : {}) }, now);
      return { next: out.doc === base || (base !== null && base.settled.includes(key)) ? null : out.doc, result: out };
    },
    `budget: settle ${key}`,
  );
  process.stdout.write(`${key}: ${r.reason}\n`);
  // The same command that charged the budget records the step, so the two
  // cannot disagree about what a run cost (fix 23).
  const parsed = (await import("./commands/run-lifecycle.js")).parseBudgetKey(key);
  if (parsed !== null && r.chargedUsd > 0) {
    const started = heldSince === null ? Date.parse(now) : Date.parse(heldSince);
    const billed = await billedMinutes(gh, parsed.run);
    const record: import("./commands/run-lifecycle.js").StepRecord = {
      role: parsed.role,
      run_id: parsed.run,
      attempt: parsed.attempt,
      at: now,
      cost_usd: r.chargedUsd,
      duration_sec: Math.max(0, Math.round((Date.parse(now) - started) / 1000)),
      ...(billed === null ? {} : { billed_minutes: billed }),
    };
    await store.put([{ path: `steps/${parsed.run}/${parsed.role}-${parsed.attempt}.json`, content: `${JSON.stringify(record, null, 2)}\n` }], `steps: ${key}`);
    const { advanceLiveFromSteps } = await import("./commands/run-lifecycle.js");
    await advanceLiveFromSteps(gh, parsed.run).catch(() => undefined);
  }
  return 0;
}

/**
 * `bsf budget verify`: budget.json and steps/ must agree to the cent. When
 * they do not, say so, file a factory_health item once, and exit 1.
 */
async function budgetVerifyCommand(): Promise<number> {
  const gh = new GitHub({ repo: requireRepo() });
  const { FactoryStore, LEDGER, json, workItemPath } = await import("./lib/store.js");
  const store = new FactoryStore(gh);
  const raw = await store.data.readJson<BudgetDoc>(BUDGET_PATH);
  const doc = raw !== null && raw.schema === "budget/2" ? raw : null;
  const names = (await store.data.list("steps/")).filter((n) => n.endsWith(".json"));
  const steps: { at: string; cost_usd: number }[] = [];
  for (const n of names) {
    const d = await store.data.readJson<{ at?: string; cost_usd?: number }>(n).catch(() => null);
    if (d !== null && typeof d.cost_usd === "number" && typeof d.at === "string") steps.push({ at: d.at, cost_usd: d.cost_usd });
  }
  const { verifySpend } = await import("./commands/budget.js");
  const v = verifySpend(doc, steps);
  process.stdout.write(`budget.json $${v.budget_usd.toFixed(4)}, steps/ $${v.steps_usd.toFixed(4)}: ${v.ok ? "they agree" : `they differ by $${v.difference_usd.toFixed(4)}`}\n`);
  if (v.ok) return 0;
  const { fingerprint } = await import("./commands/intake.js");
  const { workItemId } = await import("./lib/ids.js");
  const now = nowIso();
  const ledger = await store.ledger(now);
  const fp = fingerprint({ title: "factory_health", body: "spend_mismatch" });
  if (!ledger.open.some((o: { fingerprint?: string; status: string }) => o.fingerprint === fp && o.status === "queued")) {
    const id = workItemId(Date.parse(now));
    const item = {
      schema: "work-item/1" as const, id, created_at: now,
      source: { kind: "review_routed", ref: null, actor: "factory", via: null },
      trigger_class: "self" as const, pipeline: "factory_health" as const,
      title: "The factory's two records of spend disagree",
      body: `budget.json says $${v.budget_usd.toFixed(4)} and steps/ says $${v.steps_usd.toFixed(4)}. They are written by the same command, so a write was lost.`,
      priority: "high" as const, fingerprint: fp, status: "queued" as const, runs: [], pr: null, parent: null, related: [], spec: null,
    };
    await store.put(
      [
        { path: workItemPath(id), content: json(item) },
        { path: LEDGER, content: json({ ...ledger, updated_at: now, open: [...ledger.open, { work_item: id, pipeline: "factory_health", status: "queued", fingerprint: fp, priority: "high", created_at: now, fixes: ["spend_mismatch"] }] }) },
      ],
      "budget verify: spend records disagree",
    );
  }
  return 1;
}

/**
 * `bsf budget minutes`: Actions minutes billed this month, from the steps'
 * billed_minutes, against the plan's limit. A null limit (public repos,
 * where standard runners are free) is never exceeded.
 */
async function budgetMinutesCommand(): Promise<number> {
  const cfg = await factoryConfig();
  const gh = new GitHub({ repo: requireRepo() });
  const { FactoryStore } = await import("./lib/store.js");
  const store = new FactoryStore(gh);
  const month = nowIso().slice(0, 7);
  let used = 0;
  for (const n of (await store.data.list("steps/")).filter((x) => x.endsWith(".json"))) {
    const d = await store.data.readJson<{ at?: string; billed_minutes?: number }>(n).catch(() => null);
    if (d !== null && typeof d.at === "string" && d.at.startsWith(month) && typeof d.billed_minutes === "number") used += d.billed_minutes;
  }
  const limit = cfg.budget?.monthly_actions_minutes ?? null;
  setOutput("minutes_used", String(used));
  if (limit === null) {
    process.stdout.write(`${used} Actions minutes billed this month; no limit applies here\n`);
    return 0;
  }
  process.stdout.write(`${used} of ${limit} Actions minutes billed this month${used > limit ? ": over the limit" : ""}\n`);
  return used > limit ? 1 : 0;
}

/** Minutes GitHub billed for a run, from its timing; null when unreadable. */
async function billedMinutes(gh: GitHub, runId: string): Promise<number | null> {
  try {
    const t = await gh.get<{ run_duration_ms?: number; billable?: Record<string, { total_ms?: number }> }>(`repos/${gh.repo}/actions/runs/${runId}/timing`);
    const ms = Object.values(t.billable ?? {}).reduce((a, b) => a + (b.total_ms ?? 0), 0);
    return ms > 0 ? Math.ceil(ms / 60_000) : null;
  } catch {
    return null;
  }
}

/** `bsf budget status`: spent, held and left, for a person reading a log. */
async function budgetStatusCommand(): Promise<number> {
  const cfg = await factoryConfig();
  const gh = new GitHub({ repo: requireRepo() });
  const { FactoryStore } = await import("./lib/store.js");
  const raw = await new FactoryStore(gh).data.readJson<BudgetDoc>(BUDGET_PATH);
  const doc = raw !== null && raw.schema === "budget/2" ? rollMonth(raw, nowIso()) : null;
  const limit = budgetLimits(cfg).monthlyUsd;
  if (doc === null) {
    process.stdout.write(`nothing spent this month; budget $${limit.toFixed(2)}\n`);
    return 0;
  }
  const spent = Object.values(doc.spent_usd).reduce((a, b) => a + b, 0);
  const held = Math.max(0, Math.round((used(doc, null).total - spent) * 10_000) / 10_000);
  process.stdout.write(
    `${doc.month}: spent $${spent.toFixed(4)}, held by running steps $${held.toFixed(4)}, ` +
      `left $${(limit - spent - held).toFixed(4)} of $${limit.toFixed(2)}\n`,
  );
  for (const [p, v] of Object.entries(doc.spent_usd)) process.stdout.write(`  ${p}: $${v.toFixed(4)}\n`);
  for (const f of doc.inflight) process.stdout.write(`  running ${f.key} (${f.role}): holds $${(f.agent_ceiling_usd + f.detection_ceiling_usd).toFixed(2)}\n`);
  return 0;
}

/** Whether the budget has room for a sandbox amendment's largest step: one setup round. */
async function amendmentFits(gh: GitHub, cfg: Awaited<ReturnType<typeof factoryConfig>>): Promise<{ ok: boolean; reason: string }> {
  const { FactoryStore } = await import("./lib/store.js");
  const raw = await new FactoryStore(gh).data.readJson<BudgetDoc>(BUDGET_PATH).catch(() => null);
  const doc = raw !== null && raw.schema === "budget/2" ? raw : null;
  return canStart(doc, budgetLimits(cfg), "setup", cfg.models ?? {}, nowIso(), ["setup"]);
}

/**
 * Settle holds whose step has ended but never settled: from the step's own
 * measure, in its run's artifacts, and at the ceiling only when there is
 * none. Run by the rollup and before a repair is started.
 */
async function sweepStaleHolds(gh: GitHub): Promise<void> {
  const { FactoryStore } = await import("./lib/store.js");
  const { staleHolds, githubSweepDeps } = await import("./commands/budget-sweep.js");
  const store = new FactoryStore(gh);
  const now = nowIso();
  const raw = await store.data.readJson<BudgetDoc>(BUDGET_PATH);
  if (raw === null || raw.schema !== "budget/2" || raw.inflight.length === 0) return;
  const log = (l: string): void => void process.stdout.write(`${l}\n`);
  const verdicts = await staleHolds(raw, now, STALE_HOLD_SEC, githubSweepDeps(gh, log));
  if (verdicts.length === 0) return;
  await store.data.updateJson<BudgetDoc, null>(
    BUDGET_PATH,
    (current) => {
      if (current === null || current.schema !== "budget/2") return { next: null, result: null };
      let doc = current;
      for (const v of verdicts) {
        if (!doc.inflight.some((f) => f.key === v.key)) continue;
        doc = settleBudget(doc, { key: v.key, agentUsd: v.agentUsd, detectionUsd: v.detectionUsd, ...(v.pipeline === undefined ? {} : { pipeline: v.pipeline }) }, now).doc;
      }
      return { next: doc === current ? null : doc, result: null };
    },
    `budget: settle ${verdicts.length} hold(s) whose step ended`,
  );
  for (const v of verdicts) log(`budget: settled ${v.key}: ${v.why}`);
}

async function budgetCommand(args: Args): Promise<number> {
  const cfg = await factoryConfig();
  const gh = new GitHub({ repo: requireRepo() });
  const state = await budgetState(cfg, gh);
  const paused = pausedPipelines(state);
  if (paused.length === 0) {
    process.stdout.write("every pipeline is within its share\n");
  } else {
    process.stdout.write(`paused: ${paused.join(", ")}\n`);
  }
  // With --pipeline, `paused` is a yes/no for that one pipeline, which is
  // what a workflow's `if:` can test. It is also yes before setup merges,
  // when there is no sandbox for the work to run in.
  const pipeline = args["pipeline"];
  if (typeof pipeline === "string") {
    const setupDone = await gh.setupFinished();
    if (!setupDone) process.stdout.write("setup has not finished: nothing runs until its PR merges\n");
    setOutput("paused", String(!setupDone || (paused as readonly string[]).includes(pipeline)));
    return 0;
  }
  setOutput("paused", paused.join(","));
  return 0;
}

async function mergeCommand(args: Args): Promise<number> {
  const cfg = await factoryConfig();
  const gh = new GitHub({ repo: requireRepo() });
  const autoMerge: Record<string, boolean> = {};
  for (const [name, p] of Object.entries(cfg.pipelines ?? {})) {
    autoMerge[name] = p.auto_merge === true;
  }
  const report = await runMergeCommand({
    gh,
    now: nowIso(),
    policy: await loadPolicy(new DiskLoader(process.cwd())),
    // "auto" falls back until native-queue detection exists; say "native" to use it.
    nativeQueue: cfg.enforcement?.merge_queue === "native",
    autoMerge,
    appLogins: appLogins(),
    ...(args["apply"] === true ? { apply: true } : {}),
  });
  process.stdout.write(`${report.considered} factory PR(s); next: ${report.action.kind} #${report.action.pr} — ${report.action.reason}\n`);
  for (const b of report.blocked) process.stdout.write(`  #${b.pr} blocked: ${b.reason}\n`);
  if (report.applied !== null) process.stdout.write(`${report.applied}\n`);
  setOutput("action", report.action.kind);
  return 0;
}

async function gardenCommand(args: Args): Promise<number> {
  const cfg = await factoryConfig();
  const gh = new GitHub({ repo: requireRepo() });
  const max = typeof args["max"] === "string" ? Number(args["max"]) : cfg.pipelines?.["gardening"]?.max_prs_per_run ?? 5;
  const state = await budgetState(cfg, gh);
  if (pausedPipelines(state).includes("gardening")) {
    process.stdout.write("gardening is over its budget share; nothing filed tonight\n");
    return 0;
  }
  // Before setup merges there is no sandbox to build in, and nothing
  // gardening files could run; it would only queue up.
  if (!(await gh.setupFinished())) {
    process.stdout.write("setup has not finished; nothing filed tonight\n");
    return 0;
  }
  const running = await runningRuns(gh);
  const report = await runGardenCommand({
    gh,
    now: nowIso(),
    root: process.cwd(),
    baselines: await loadBaselines(new DiskLoader(process.cwd())),
    maxPrs: Number.isInteger(max) && max > 0 ? max : 5,
    freeSlots: Math.max(0, (cfg.limits?.concurrency?.max_runs ?? 5) - running),
    ...(args["plan"] === true ? { plan: true } : {}),
  });
  process.stdout.write(
    `found ${report.scan.items.length} drift item(s); filed ${report.filed.length}; dispatched ${report.dispatched.length}\n`,
  );
  for (const s of report.scan.skipped) process.stdout.write(`  skipped ${s.problem_class}: ${s.reason}\n`);
  return 0;
}

async function conflictsCommand(args: Args, second?: string, third?: string): Promise<number> {
  const gh = new GitHub({ repo: requireRepo() });
  if (second === "context") {
    // `bsf conflicts context WORK_ITEM --out DIR`: what a rebuild works from.
    if (third === undefined || typeof args["out"] !== "string") die("usage: bsf conflicts context WORK_ITEM --out DIR");
    const { FactoryStore, workItemPath } = await import("./lib/store.js");
    const item = await new FactoryStore(gh).get<{ pr?: number | null }>(workItemPath(third), "work-item");
    if (item === null || typeof item.pr !== "number") die(`${third} has no PR to rebuild`);
    const { rebuildContext } = await import("./commands/conflicts.js");
    const ctx = await rebuildContext(gh, item.pr);
    mkdirSync(args["out"], { recursive: true });
    writeFileSync(join(args["out"], "change.diff"), ctx.change);
    writeFileSync(join(args["out"], "main-since.diff"), ctx.mainSince);
    writeFileSync(join(args["out"], "files.txt"), `${ctx.files.join("\n")}\n`);
    process.stdout.write(`PR #${item.pr}: ${ctx.files.length} file(s); main changed ${ctx.mainSince === "" ? "none" : "some"} of them since\n`);
    return 0;
  }
  if (second === "button") {
    // `bsf conflicts button --pr N`: the "Rebuild on main" check button.
    const pr = Number(args["pr"]);
    if (!Number.isInteger(pr) || pr <= 0) die("usage: bsf conflicts button --pr N");
    const { rebuildFromButton } = await import("./commands/conflicts.js");
    process.stdout.write(`${await rebuildFromButton(gh, pr, nowIso())}\n`);
    return 0;
  }
  const checksToken = process.env["CHECKS_TOKEN"];
  const report = await runConflictsCommand({
    gh,
    now: nowIso(),
    ...(args["no-dispatch"] === true ? { dispatch: false } : {}),
    ...(checksToken === undefined || checksToken === "" ? {} : { checks: new GitHub({ repo: requireRepo(), token: checksToken }) }),
  });
  process.stdout.write(
    `${report.conflicting.length} conflicting, ${report.clean.length} clean, ${report.unknown.length} undetermined\n`,
  );
  if (report.dispatched.length > 0) {
    process.stdout.write(`  rebuilding: ${report.dispatched.join(", ")}\n`);
  }
  if (report.queued.length > 0) {
    // One rebuild at a time: the rest start when this one lands, or at the
    // next scheduled scan if it never does.
    process.stdout.write(`  queued behind it: ${report.queued.join(", ")}\n`);
  }
  if (report.unknown.length > 0) {
    // Not reported as clean: GitHub had not finished computing mergeability.
    process.stdout.write(`  still unknown after retries: ${report.unknown.map((p) => `#${p}`).join(", ")}\n`);
  }
  return 0;
}

async function reviewCommand(second: string | undefined, args: Args): Promise<number> {
  const cfg = await factoryConfig();
  const gh = new GitHub({ repo: requireRepo() });

  if (second === "due") {
    // A manual dispatch with force=true always reviews. The workflow passed
    // this flag from the start and nothing read it.
    if (args["force"] === true || args["force"] === "true") {
      process.stdout.write("due: forced by the dispatcher\n");
      setOutput("due", "true");
      setOutput("reason", "forced");
      return 0;
    }
    const r = await runReviewDue({
      gh,
      now: nowIso(),
      ...(cfg.review?.every_days === undefined ? {} : { everyDays: cfg.review.every_days }),
      ...(cfg.review?.run_early_at_runs === undefined ? {} : { earlyAtRuns: cfg.review.run_early_at_runs }),
      ...(cfg.review?.skip_below_runs === undefined ? {} : { minRuns: cfg.review.skip_below_runs }),
    });
    process.stdout.write(`${r.due ? "due" : "not due"}: ${r.reason}\n`);
    setOutput("due", String(r.due));
    setOutput("reason", r.reason);
    setOutput("runs_since", String(r.runsSinceLastReview));
    return 0;
  }

  if (second === "route") {
    const file = args["failures"];
    if (typeof file !== "string") die("usage: bsf review route --failures PATH");
    const failures = JSON.parse(readFileSync(file, "utf8")) as ScoredFailure[];
    const r = await runReviewRoute({
      gh,
      now: nowIso(),
      failures,
      ...(args["plan"] === true ? { plan: true } : {}),
    });
    for (const p of r.problems) {
      process.stdout.write(`${p.tag} (${p.occurrences}x) -> hardening: ${p.why}\n`);
    }
    for (const u of r.unrouted) process.stdout.write(`${u.tag} in ${u.run}: not routed, ${u.reason}\n`);
    process.stdout.write(`filed ${r.filed.length}, dispatched ${r.dispatched.length}\n`);
    return 0;
  }

  die("usage: bsf review due|route");
}

async function syncCommand(args: Args): Promise<number> {
  const gh = new GitHub({ repo: requireRepo() });
  const branch = typeof args["branch"] === "string" ? args["branch"] : (await gh.defaultBranch());
  const report = await runSyncCommand({
    gh,
    branch,
    requiredChecks: FACTORY_REQUIRED_CHECKS,
    requireReview: false,
    ...(args["apply"] === true ? { apply: true } : {}),
  });
  process.stdout.write(
    `${branch}: ${report.existed ? "protection exists" : "no protection yet"}; ` +
      `adding ${report.added.length} check(s), keeping ${report.kept.length}\n`,
  );
  for (const d of report.declinedToLoosen) process.stdout.write(`  left alone: ${d}\n`);
  if (!report.applied) process.stdout.write("nothing applied (pass --apply)\n");
  return 0;
}

/**
 * The policy, when there is one, keeping "there isn't one" apart from
 * "there is one and it is wrong".
 *
 * `repo-prose` runs during setup too, before `.factory/` exists, so a missing
 * policy is an ordinary answer. An *invalid* one is not, and swallowing it
 * would be the worst outcome here: a repo whose policy has a typo would
 * silently lose every prose path it declared and never hear why.
 */
async function policyOrNull(root: string): Promise<{ policy: Policy | null; invalid: string | null }> {
  if (!existsSync(resolveRead(root, POLICY_PATH))) return { policy: null, invalid: null };
  try {
    return { policy: await loadPolicy(new DiskLoader(root)), invalid: null };
  } catch (err) {
    return { policy: null, invalid: (err as Error).message };
  }
}

/**
 * `bsf repo-prose` — the repo's own conventions, for a role to read.
 *
 * Resolved on every run rather than recorded once at setup. An index written
 * at setup is a second thing to keep current and is wrong the moment someone
 * adds a `CONVENTIONS.md`; these names are cheap to check and always right.
 */
async function repoProseCommand(args: Args): Promise<number> {
  const root = typeof args["root"] === "string" ? args["root"] : process.cwd();
  const { policy, invalid } = await policyOrNull(root);
  if (invalid !== null) {
    // Loud, but not fatal. A role should still read AGENTS.md when the thing
    // that is broken is a path list it does not depend on.
    process.stderr.write(`${POLICY_PATH} is invalid, so any prose it declares is not being read:\n${invalid}\n`);
  }
  const scan = scanProse(root, policy);
  const text = args["json"] === true ? JSON.stringify(scan, null, 2) : renderProse(scan);
  const out = args["out"];
  if (typeof out === "string") {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${text}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
  for (const r of scan.refused) {
    process.stderr.write(`refused ${r}: .factory/, .github/workflows/ and .git/ are never prose\n`);
  }
  return 0;
}

/**
 * `bsf prose-budget` — a gate on the size of always-loaded prose.
 *
 * `AGENTS.md` and its kind are read on every build and every gardening run, so
 * a line added there is paid for on every run for as long as the repo exists.
 * Hardening may write a practice into them, and the cheapest thing an agent can
 * do is append one more line; fifty corrections later the file it keeps growing
 * is the thing degrading all of its own work. Past the cap, a new practice has
 * to replace one already there.
 */
async function proseBudgetCommand(args: Args): Promise<number> {
  const root = typeof args["root"] === "string" ? args["root"] : process.cwd();
  const { policy, invalid } = await policyOrNull(root);
  if (invalid !== null) {
    // A gate reads policy.yaml to know the budget. An unreadable policy is a
    // failure, not a pass at the default.
    process.stderr.write(`${POLICY_PATH} is invalid, so the prose budget cannot be read:\n${invalid}\n`);
    return 1;
  }
  const scan = scanProse(root, policy);
  const budget = budgetBytes(policy);
  const verdict = budgetVerdict(scan, budget);

  for (const d of alwaysLoaded(scan)) {
    process.stdout.write(`${d.bytes > budget ? "OVER" : "ok  "} ${d.path}\t${d.bytes}/${budget} bytes\n`);
  }
  if (verdict.ok) {
    process.stdout.write(`every always-loaded prose file is within ${budget} bytes\n`);
    return 0;
  }
  for (const o of verdict.over) {
    process.stderr.write(
      `OVER BUDGET  ${o.path} is ${o.bytes} bytes, over the ${o.budget}-byte cap. ` +
        `It is read on every run, so consolidate it — merge overlapping lines, drop what no longer holds, ` +
        `or move a grown section into a file read on demand — rather than adding to it.\n`,
    );
  }
  setOutput("prose_over_budget", String(verdict.over.length));
  return 1;
}

/**
 * `bsf scan-asset-hosts` — the hosts the repo's front end loads at runtime.
 *
 * Each is a sandbox dependency with `"stand_in": "stub"`. They do not go in
 * `egress`: the sandbox is hermetic so that a CDN being down cannot change
 * what the factory concludes. Miss one and the page renders blank, and every
 * screenshot the factory attaches is a picture of nothing.
 */
function scanAssetHostsCommand(args: Args): number {
  const root = typeof args["root"] === "string" ? args["root"] : process.cwd();
  const scan = scanAssetHosts(root);
  if (args["why"] === true || args["why"] === "true") {
    for (const h of scan.hosts) process.stdout.write(`${h}\t${scan.where[h] ?? ""}\n`);
  } else {
    for (const h of scan.hosts) process.stdout.write(`${h}\n`);
  }
  process.stderr.write(`${scan.hosts.length} host(s) across ${scan.filesRead} file(s)\n`);
  return 0;
}

/**
 * `bsf uninstall` — stop the factory running, keep everything it made.
 *
 * Prints the plan by default and changes nothing. `--apply` removes the files
 * from the checkout, deletes the whole `.factory/` folder on this computer
 * (tracked files and anything git never stored), and does the API work. The
 * caller commits the tracked deletions on a branch and opens a pull request,
 * because the workflows sit under protected paths and taking them out is a
 * change a person should see. After that pull request merges, this checkout
 * can get the folder back by switching to the old commit; pull, and delete
 * the folder again if it is there.
 */
/**
 * `bsf brainstorm WORK_ITEM` — the conversation so far, as prose.
 *
 * Triage reads it at the top of every run so a second turn builds on the
 * first instead of starting again; spec reads it because what the person said
 * when asked directly beats anything inferred from the issue text.
 */
async function brainstormCommand(second: string | undefined, rest: readonly string[], args: Args): Promise<number> {
  // `bsf brainstorm say|wait|close WORK_ITEM ...` holds the conversation;
  // `bsf brainstorm WORK_ITEM` reads it. The verbs are checked first, so a
  // work item is never mistaken for one.
  if (second === "say" || second === "wait" || second === "close" || second === "frame") {
    return brainstormTurnCommand(second, rest[0], args);
  }
  const id = second;
  if (id === undefined) die("usage: bsf brainstorm WORK_ITEM [--out PATH] | bsf brainstorm say|wait|close WORK_ITEM ...");
  const text = renderBrainstorm(await readBrainstorm(new GitHub({ repo: requireRepo() }), id));
  const out = args["out"];
  if (typeof out === "string") {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${text}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
  return 0;
}

/**
 * The commands a held conversation runs between questions.
 *
 * The agent asks with `say`, blocks on `wait`, and ends with `close`. Keeping
 * the loop in the agent's own session is the point: the conversation is its
 * context, so a fourth question knows what the first three settled without
 * anything being re-read or re-primed.
 */
async function brainstormTurnCommand(sub: "say" | "wait" | "close" | "frame", workItem: string | undefined, args: Args): Promise<number> {
  if (workItem === undefined || workItem === "") die(`usage: bsf brainstorm ${sub} WORK_ITEM ...`);
  const gh = new GitHub({ repo: requireRepo() });
  const bs = await import("./commands/brainstorm.js");

  if (sub === "close") {
    const understood = typeof args["understood"] === "string" ? args["understood"] : "";
    if (understood === "") die("usage: bsf brainstorm close WORK_ITEM --understood TEXT");
    await bs.closeBrainstorm(gh, workItem, understood, nowIso());
    process.stdout.write("the conversation is closed; the spec stage reads the log from here\n");
    return 0;
  }

  const issue = Number(args["issue"]);
  if (!Number.isInteger(issue) || issue <= 0) die(`usage: bsf brainstorm ${sub} WORK_ITEM --issue N ...`);

  if (sub === "say") {
    const text = typeof args["text"] === "string" ? args["text"].trim() : "";
    if (text === "") die("usage: bsf brainstorm say WORK_ITEM --issue N --text TEXT");
    const r = await bs.say(gh, {
      workItem,
      issue,
      text,
      now: nowIso(),
      ...(typeof args["understood"] === "string" ? { understood: args["understood"] } : {}),
    });
    process.stdout.write(`asked on #${issue} (comment ${r.commentId})\n`);
    return 0;
  }

  if (sub === "frame") {
    // Structure in a file rather than a dozen flags: the frame is nested, and
    // a shell quoting a term's meaning into an argument is how one of them
    // ends up truncated at an apostrophe.
    const file = typeof args["file"] === "string" ? args["file"] : "";
    const question = typeof args["question"] === "string" ? args["question"].trim() : "";
    if (file === "" || question === "") {
      die("usage: bsf brainstorm frame WORK_ITEM --issue N --file FRAME.json --question TEXT");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      die(`cannot read the frame at ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const frame = bs.parseFrame(raw);
    const r = await bs.sayFrame(gh, {
      workItem,
      issue,
      frame,
      question,
      now: nowIso(),
      ...(Array.isArray(args["open"]) ? { open: (args["open"] as string[]) } : {}),
    });
    process.stdout.write(`framed and asked on #${issue} (comment ${r.commentId})\n`);
    return 0;
  }

  // The author of the request is always trusted to answer it; anyone else has
  // to be someone the repo trusts. A conversation that decides what gets built
  // is not open to passers-by.
  const policy = (await policyOrNull(process.cwd())).policy;
  const { isTrustedActor } = await import("./commands/policy.js");
  const author = typeof args["author"] === "string" ? args["author"] : "";
  const trusted = (c: {
    readonly body?: string | undefined;
    readonly user?: { readonly login?: string | undefined } | undefined;
    readonly author_association?: string | undefined;
  }): boolean => {
    if (bs.wroteByFactory(c)) return false;
    const login = c.user?.login ?? "";
    if (login !== "" && login === author) return true;
    if (policy === null) return false;
    return isTrustedActor(policy, login, (c.author_association ?? "NONE") as Parameters<typeof isTrustedActor>[2]);
  };

  const idleMs = (Number(args["idle"]) > 0 ? Number(args["idle"]) : 300) * 1000;
  const pollMs = (Number(args["poll"]) > 0 ? Number(args["poll"]) : 3) * 1000;
  const holder = process.env["GITHUB_RUN_ID"] ?? "local";
  const outcome = await bs.waitForAnswer(gh, {
    issue,
    idleMs,
    pollMs,
    trusted,
    after: (await bs.readBrainstorm(gh, workItem))?.last_comment_id ?? 0,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onAnswer: async (c) => {
      await bs.mark(gh, workItem, { holder, lastCommentId: c.id, now: nowIso() });
      await bs.appendTurn(gh, workItem, {
        at: c.created_at ?? nowIso(),
        who: "person",
        text: (c.body ?? "").trim(),
        comment: c.id,
      });
    },
    onHeartbeat: async () => {
      await bs.mark(gh, workItem, { holder, now: nowIso() });
    },
    // "Build it" ends the conversation with what the factory understood, and
    // says nothing back: the run goes straight on to spec (fix 7).
    onGoAhead: async () => {
      const current = await bs.readBrainstorm(gh, workItem);
      const lastFactory = [...(current?.turns ?? [])].reverse().find((t) => t.who === "factory")?.text ?? "";
      await bs.closeBrainstorm(gh, workItem, current?.understood ?? lastFactory, nowIso());
    },
  });

  if (outcome.kind === "answer") {
    process.stdout.write(`answer from ${outcome.from}:\n${outcome.text}\n`);
    return 0;
  }
  if (outcome.kind === "closed") {
    process.stdout.write("closed\nThe conversation was closed while you were waiting.\n");
    return 0;
  }
  // Exits 0: nobody saying anything is an ordinary way for a conversation to
  // pause, not a failure, and a non-zero here would fail the whole run.
  process.stdout.write(
    `quiet\nNothing said for ${Math.round(outcome.waitedMs / 1000)}s. Stop here; their next comment starts a new conversation.\n`,
  );
  return 0;
}

async function uninstallCommand(args: Args): Promise<number> {
  const root = typeof args["root"] === "string" ? args["root"] : process.cwd();
  const gh = new GitHub({ repo: requireRepo() });
  const branch = typeof args["branch"] === "string" ? args["branch"] : await gh.defaultBranch();

  const { execFileSync } = await import("node:child_process");
  const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((l: string) => l !== "");
  // Read the hook before anything is deleted. A broken settings file is left
  // alone: uninstall still has the rest of the factory to remove.
  const lh = await import("./commands/local-hook.js");
  const hookFile = lh.settingsPath(root);
  let hookNext: Record<string, unknown> | null = null;
  try {
    hookNext = lh.withoutHook(lh.readSettings(hookFile));
  } catch {
    hookNext = null;
  }
  const plan = await planUninstall({
    gh,
    branch,
    root,
    files: tracked,
    localHook: hookNext !== null,
    ...(args["purge-data"] === true ? { purgeData: true } : {}),
  });

  const apply = args["apply"] === true;
  if (apply) {
    // Workflows, issue forms and the Dependabot file live outside the folder.
    // The folder itself is removed as a directory so untracked files go with
    // the tracked ones.
    for (const f of plan.files) {
      if (f === LOCAL_FACTORY_DIR || f.startsWith(`${LOCAL_FACTORY_DIR}/`)) continue;
      rmSync(join(root, f), { force: true, recursive: true });
    }
    if (plan.dependabot.action === "delete") {
      rmSync(join(root, ".github/dependabot.yml"), { force: true });
    } else if (plan.dependabot.action === "edit") {
      writeFileSync(join(root, ".github/dependabot.yml"), plan.dependabot.text);
    }
    const removed = removeLocalFactory(root);
    if (removed !== null) process.stdout.write(`removed ${LOCAL_FACTORY_DIR}/ on this computer\n`);
    if (hookNext !== null) {
      writeFileSync(hookFile, `${JSON.stringify(hookNext, null, 2)}\n`);
      process.stdout.write(`removed the correction hook from ${hookFile}\n`);
    }
    const branches = removeLocalFactoryBranches(root);
    for (const name of branches.deletedLocal) process.stdout.write(`removed local branch ${name}\n`);
    for (const name of branches.deletedTracking) process.stdout.write(`removed local bookmark ${name}\n`);
    const done = await applyUninstall(gh, branch, plan);
    for (const d of done) process.stdout.write(`${d}\n`);
  }
  process.stdout.write(`${formatPlan(plan, apply)}\n`);
  if (!apply) {
    process.stdout.write("\nNothing was changed. Run again with --apply to do it.\n");
  } else {
    process.stdout.write(
      "\nThe .factory/ folder is deleted on this computer, including files that were never committed. " +
        "The tracked deletions are not committed yet. Commit them on a branch and open a pull request: " +
        "they are under protected paths, so removing them is a change someone should see. After that " +
        "pull request merges, pull the default branch here. If .factory/ came back with the old commit, delete it again. " +
        "If you are still on a factory/ branch, switch to the default branch and delete that branch with git branch -D.\n",
    );
  }
  return 0;
}

async function auditCommand(args: Args): Promise<number> {
  const gh = new GitHub({ repo: requireRepo() });
  const commit = typeof args["commit"] === "string" ? args["commit"] : headSha();
  const report = await runAuditCommand({
    gh,
    commit,
    root: process.cwd(),
    configuredAppLogins: appLogins(),
  });
  for (const c of report.checked) process.stdout.write(`checked: ${c}\n`);
  const blocking = blockingFindings(report.findings);
  // Everything is reported; only a finding that means something really got
  // past the gates fails the run. A check that has not concluded, and a
  // lookup GitHub had not caught up with, are both normal.
  for (const f of report.findings) {
    const out = blocking.includes(f) ? process.stderr : process.stdout;
    out.write(`${f.kind}: ${f.detail}\n`);
  }
  setOutput("findings", String(blocking.length));
  if (blocking.length === 0) {
    process.stdout.write(`${commit.slice(0, 8)} passed every gate it should have\n`);
    return 0;
  }
  return 1;
}

/**
 * `bsf models` — each role's model, from factory.yaml, as step outputs.
 *
 * The callers pass these into the role workflows as inputs. This replaced a
 * set of repository variables that the roles read and nothing ever set, so
 * every role would have started with an empty model. factory.yaml is the one
 * place a model is chosen; there is no second copy to keep in step.
 */
/**
 * `bsf practice add TEXT` — the CLI form of a `/practice` comment. Dispatching
 * factory-intake needs write access, so it is trusted by construction.
 */
async function recompilePrepareCommand(): Promise<number> {
  const { parseHosts, addAllowedHosts } = await import("./commands/recompile.js");
  const root = process.cwd();
  const domainsFile = join(root, ".factory/sandbox/research-domains.txt");
  const spec = join(root, ".github/workflows/factory-role-spec.md");
  if (!existsSync(domainsFile) || !existsSync(spec)) {
    process.stdout.write("nothing to apply: no research hosts, or no spec role\n");
    setOutput("changed", "false");
    return 0;
  }
  const { hosts, rejected } = parseHosts(readFileSync(domainsFile, "utf8"));
  for (const r of rejected) process.stderr.write(`ignored, not a hostname: ${r}\n`);
  const { text, added } = addAllowedHosts(readFileSync(spec, "utf8"), hosts);
  if (added.length > 0) writeFileSync(spec, text);
  process.stdout.write(added.length > 0 ? `spec may now research: ${added.join(", ")}\n` : "every research host is already allowed\n");
  setOutput("changed", String(added.length > 0));
  return 0;
}

async function practiceCommand(second: string | undefined, rest: readonly string[]): Promise<number> {
  const text = rest.join(" ").trim();
  if (second !== "add" || text === "") die('usage: bsf practice add "use longer, descriptive identifier names"');
  const gh = new GitHub({ repo: requireRepo() });
  await gh.dispatchWorkflow("factory-intake.yml", undefined, { title: `/practice ${text}` });
  process.stdout.write(
    `declared: ${text}\nThe factory will open a pull request adding it to practices.md, and a rule where one can enforce it.\n`,
  );
  return 0;
}

/**
 * `bsf journeys look`: one uncovered page, or a line that says the list
 * already reaches every page that was found.
 *
 * A missing journey file is not a gap. Setup writes that file. The look
 * only notices a page that appeared after the list existed.
 *
 * second: the subcommand. Only `look` is accepted.
 */
async function journeysCommand(second: string | undefined): Promise<number> {
  if (second !== "look") die("usage: bsf journeys look");
  const { lookForGap, pagesSinceJourneyList, readJourneysFile } = await import("./commands/journeys.js");
  const gap = lookForGap(readJourneysFile(process.cwd()), pagesSinceJourneyList(process.cwd()));
  if (gap === null) {
    process.stdout.write("no new journey\n");
    setOutput("gap", "");
    return 0;
  }
  process.stdout.write(`gap: ${gap}\n`);
  setOutput("gap", gap);
  return 0;
}

/**
 * `bsf guardrails require-zero`: fail while any recorded count is above zero.
 *
 * file: the baselines file the clean step wrote. A missing file is a
 * failure, because an uncounted tree is not a clean one.
 */
function guardrailsRequireZero(file: string): number {
  if (!existsSync(file)) {
    process.stdout.write(`guardrail counts were not recorded at ${file}\n`);
    return 1;
  }
  const doc = JSON.parse(readFileSync(file, "utf8")) as { rules?: Record<string, { count?: number }> };
  const total = Object.values(doc.rules ?? {}).reduce((sum, rule) => sum + (typeof rule.count === "number" ? rule.count : 0), 0);
  if (total > 0) {
    process.stdout.write(`${total} violation(s) remain. Setup is not finished until the count is zero.\n`);
    return 1;
  }
  process.stdout.write("guardrail counts are zero\n");
  return 0;
}

/**
 * `bsf sandbox scratch --note TEXT` records an addition for this run only.
 * `--clear` deletes that record and prints the proof line. The recipe is
 * not opened.
 *
 * args: `--note` the sentence, or `--clear` to finish the run.
 */
async function scratchCommand(args: Args): Promise<number> {
  const { clearScratch, noteScratch } = await import("./commands/scratch.js");
  if (args["clear"] === true) {
    const cleared = clearScratch(process.cwd());
    process.stdout.write(`${cleared.proof}\n`);
    return 0;
  }
  const note = typeof args["note"] === "string" ? args["note"] : "";
  if (note === "") die('usage: bsf sandbox scratch --note "what this run added" | bsf sandbox scratch --clear');
  noteScratch(process.cwd(), note, nowIso());
  process.stdout.write("noted for this run only\n");
  return 0;
}

async function sandboxCommandCli(second: string | undefined, args: Args): Promise<number> {
  if (second === "scratch") return scratchCommand(args);
  if (second === "start") {
    // --if-present: the gates run on every PR, including those opened before
    // setup has frozen a sandbox. There the tests gate decides (the repo's
    // own test check, or a failure saying setup has not finished); starting
    // nothing is not itself an error.
    if (args["if-present"] === true && loadManifest(process.cwd()).kind === "missing") {
      process.stdout.write("no sandbox yet: setup has not frozen one in this checkout\n");
      setOutput("tier", "none");
      return 0;
    }
    const r = await startSandbox({
      root: process.cwd(),
      workspace: process.env["GITHUB_WORKSPACE"] ?? process.cwd(),
      ...(process.env["FACTORY_SANDBOX_ENV"] === undefined ? {} : { secretBlob: process.env["FACTORY_SANDBOX_ENV"] }),
    });
    process.stdout.write(
      `sandbox up: tier ${r.tier}; services ${r.services.join(", ") || "none"}; ` +
        `${r.envNames.length} variable(s) in ${r.envFile}\n`,
    );
    setOutput("tier", r.tier);
    // --serve: a role that looks at the app. Where the sandbox needs the
    // runner, the app runs here, with its services and stubs, and the role's
    // host-access variant reaches it; the agent finds the address in
    // app.json. Elsewhere the agent runs the app itself, as before.
    const loaded = loadManifest(process.cwd());
    const host = loaded.kind === "ok" && needsHost(loaded.manifest);
    setOutput("host_access", String(host));
    if (args["serve"] === true && loaded.kind === "ok" && host) {
      const workspace = process.env["GITHUB_WORKSPACE"] ?? process.cwd();
      const served = await serveOnHost({
        manifest: loaded.manifest,
        workspace,
        env: closedEnv(workspace) ?? {},
        infoFile: "/tmp/gh-aw/agent/bsf/app.json",
        log: (l) => process.stdout.write(`${l}\n`),
      });
      setOutput("app_url", served.url ?? "");
      // An app the manifest says to run that never answered is a failure of
      // this step, not a quiet note for the agent to trip over: the role
      // cannot verify anything without it (fix 1).
      if (served.appExpected && served.url === null) {
        process.stdout.write(`${served.failure ?? "the app did not start"}; the last lines of its log are in app.json\n`);
        return 1;
      }
    }
    return 0;
  }
  if (second === "ui-paths") {
    // `bsf sandbox ui-paths [--file PATH]`: record which files are the UI, so
    // the PR report needs a video only for changes to them.
    const file = typeof args["file"] === "string" ? args["file"] : ".factory/sandbox/manifest.json";
    if (!existsSync(file)) die(`${file} does not exist`);
    const { detectUiPaths } = await import("./lib/ui-paths.js");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const found = detectUiPaths(process.cwd());
    writeFileSync(file, `${JSON.stringify({ ...manifest, ui_paths: found }, null, 2)}\n`);
    process.stdout.write(`ui paths: ${found.length === 0 ? "none found" : found.join(", ")}\n`);
    return 0;
  }
  if (second === "secrets") {
    // `bsf sandbox secrets [--file PATH]`: refuse a recipe that pastes a
    // password into a value field. The file is not rewritten. A path stays
    // a path. The push does not run when this fails.
    const file = typeof args["file"] === "string" ? args["file"] : ".factory/sandbox/manifest.json";
    if (!existsSync(file)) die(`${file} does not exist`);
    const { pastedSecrets } = await import("./lib/placeholders.js");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { env?: unknown };
    const problems = pastedSecrets(Array.isArray(parsed.env) ? parsed.env : []);
    if (problems.length > 0) {
      for (const line of problems) process.stderr.write(`${line}\n`);
      return 1;
    }
    process.stdout.write("the recipe names secrets; it does not paste them\n");
    return 0;
  }
  if (second === "dry-run") {
    // `bsf sandbox dry-run`: do exactly what the checker does before its
    // agent starts (start the sandbox, serve the app on the host) and say
    // whether the app answered. Setup runs it so it cannot finish with a
    // sandbox the checker could not use.
    const loaded = loadManifest(process.cwd());
    if (loaded.kind !== "ok") {
      process.stdout.write("dry run: no usable sandbox manifest\n");
      return 1;
    }
    const workspace = process.env["GITHUB_WORKSPACE"] ?? process.cwd();
    await startSandbox({
      root: process.cwd(),
      workspace,
      ...(process.env["FACTORY_SANDBOX_ENV"] === undefined ? {} : { secretBlob: process.env["FACTORY_SANDBOX_ENV"] }),
    });
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const served = await serveOnHost({
      manifest: loaded.manifest,
      workspace,
      env: closedEnv(workspace) ?? {},
      infoFile: join(mkdtempSync(join(tmpdir(), "bsf-dry-")), "app.json"),
      log: (l) => process.stdout.write(`${l}\n`),
    });
    const { stopServing } = await import("./commands/sandbox.js");
    stopServing();
    if (served.appExpected && served.url === null) {
      process.stdout.write(`dry run failed: ${served.failure ?? "the app did not start"}\n`);
      return 1;
    }
    process.stdout.write(`dry run passed: ${served.url ?? "no app to serve"}\n`);
    return 0;
  }
  if (second === "report") {
    // `bsf sandbox report --from PATH [--work-item ID]`: a role found the
    // sandbox could not exercise what its change needs. This is the one way
    // the sandbox changes after setup: it starts factory-setup in amend mode,
    // once per need, and the amendment arrives as a PR a person reviews.
    const from = args["from"];
    if (typeof from !== "string") die("usage: bsf sandbox report --from PATH [--work-item ID]");
    if (!existsSync(from)) {
      process.stdout.write("no sandbox report: the sandbox was enough for this step\n");
      return 0;
    }
    const { inadequacyProblems } = await import("./commands/sandbox.js");
    let report: unknown;
    try {
      report = JSON.parse(readFileSync(from, "utf8"));
    } catch (e) {
      die(`${from}: ${(e as Error).message}`);
    }
    const problems = inadequacyProblems(report);
    if (problems.length > 0) die(`the sandbox report was rejected:\n  - ${problems.join("\n  - ")}`);
    type InadequacyReport = import("./commands/sandbox.js").InadequacyReport;
    const r = report as InadequacyReport;
    const gh = new GitHub({ repo: requireRepo() });
    const { FactoryStore } = await import("./lib/store.js");
    const { recordReport, sweepReports } = await import("./commands/sandbox-reports.js");
    const store = new FactoryStore(gh);
    const now = nowIso();
    const workItem = typeof args["work-item"] === "string" ? args["work-item"] : undefined;
    await recordReport(store, r, workItem, now);
    const sweep = await sweepReports({ gh, store, ledger: await store.ledger(now), now, fits: async () => amendmentFits(gh, await factoryConfig()) });
    process.stdout.write(`${sweep.why}\n`);
    return 0;
  }
  if (second === "check") {
    const file = typeof args["file"] === "string" ? args["file"] : undefined;
    const loaded = file === undefined ? loadManifest(process.cwd()) : loadManifestAt(file);
    if (loaded.kind === "ok") {
      process.stdout.write(`valid sandbox manifest, tier ${loaded.manifest.tier}\n`);
      return 0;
    }
    process.stderr.write(loaded.kind === "missing" ? "no sandbox manifest\n" : `invalid:\n  ${loaded.errors.join("\n  ")}\n`);
    return 1;
  }
  if (second === "trial") {
    const candidate = args["candidate"];
    const out = args["out"];
    if (typeof candidate !== "string" || typeof out !== "string") die("usage: bsf sandbox trial --candidate PATH --out PATH");
    let fakeKeys: readonly string[] | null = null;
    const repo = process.env["GITHUB_REPOSITORY"];
    if (repo !== undefined && repo !== "") {
      try {
        const { DataRefStore } = await import("./lib/dataref.js");
        const { GitHub } = await import("./lib/github.js");
        const { parseDecisions, DECISIONS_PATH } = await import("./commands/env-state.js");
        const text = await new DataRefStore(new GitHub({ repo })).read(DECISIONS_PATH);
        if (text !== null) fakeKeys = parseDecisions(JSON.parse(text)).fake;
      } catch { /* no decisions yet: the stand-in check stays off */ }
    }
    const r = await trialSandbox({
      manifestPath: candidate,
      workspace: process.env["GITHUB_WORKSPACE"] ?? process.cwd(),
      out,
      ...(process.env["FACTORY_SANDBOX_ENV"] === undefined ? {} : { secretBlob: process.env["FACTORY_SANDBOX_ENV"] }),
      fakeKeys,
    });
    setOutput("reached", r.reached);
    setOutput("claimed", r.claimed);
    // Met: the tier claimed, and every dependency proven. Short of either,
    // the next round reads what failed and tries again.
    setOutput("met", String(trialMet(r)));
    // A trial that ran is a success even when it fell short: its report is
    // the output, and the next design round reads it.
    return 0;
  }
  if (second === "freeze") {
    const out = args["out"];
    // One comma-separated flag: the parser keeps only the last value of a
    // repeated one, which would have dropped every round but the last.
    const raw = args["rounds"];
    const rounds = (typeof raw === "string" ? raw.split(",") : [])
      .map((r) => r.trim().split(":"))
      .filter((p) => p.length === 2)
      .map(([candidate, trial]) => ({ candidate: candidate ?? "", trial: trial ?? "" }));
    if (typeof out !== "string" || rounds.length === 0) die("usage: bsf sandbox freeze --rounds CANDIDATE:TRIAL[,CANDIDATE:TRIAL...] --out PATH");
    const { manifest, chosen } = freezeManifest(rounds, nowIso());
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`froze round ${chosen + 1} at tier ${String(manifest["tier"])} into ${out}\n`);
    setOutput("tier", String(manifest["tier"]));
    // 1-based, as the round artifacts are named.
    setOutput("chosen", String(chosen + 1));
    return 0;
  }
  if (second === "land") {
    // `bsf sandbox land --pr N --main PATH --candidate PATH`, with the
    // amendment request in AMEND: merge the amendment when it is safe to,
    // and verify again the changes that were stuck on the old sandbox.
    const pr = Number(args["pr"]);
    const mainPath = args["main"];
    const candidatePath = args["candidate"];
    if (!Number.isInteger(pr) || pr <= 0 || typeof candidatePath !== "string") {
      die("usage: bsf sandbox land --pr N --main PATH --candidate PATH");
    }
    const amendRaw = process.env["AMEND"] ?? "";
    if (amendRaw.trim() === "") {
      process.stdout.write("first setup: a person reviews it\n");
      return 0;
    }
    const candidate = loadManifestAt(candidatePath);
    if (candidate.kind !== "ok") die(`the amended manifest is not valid: ${candidate.kind}`);
    const main = typeof mainPath === "string" ? loadManifestAt(mainPath) : ({ kind: "missing" } as const);
    const policy = await loadPolicy(new DiskLoader(trustedRoot() ?? process.cwd())).catch(() => null);
    let amend: import("./commands/sandbox-land.js").AmendRequest;
    try {
      amend = JSON.parse(amendRaw) as import("./commands/sandbox-land.js").AmendRequest;
    } catch (e) {
      die(`AMEND is not JSON: ${(e as Error).message}`);
    }
    const gh = new GitHub({ repo: requireRepo() });
    const { FactoryStore } = await import("./lib/store.js");
    const { landAmendment } = await import("./commands/sandbox-land.js");
    const store = new FactoryStore(gh);
    const now = nowIso();
    const r = await landAmendment({
      gh,
      store,
      ledger: await store.ledger(now),
      pr,
      input: {
        mode: policy?.sandbox_repairs ?? "automatic",
        main: main.kind === "ok" ? main.manifest : null,
        candidate: candidate.manifest,
      },
      amend: { reports: Array.isArray(amend.reports) ? amend.reports : [] },
      verifyLabel: typeof args["verify-label"] === "string" ? args["verify-label"] : "factory:verify",
      now,
      log: (l) => process.stdout.write(`${l}\n`),
    });
    setOutput("merged", String(r.merged));
    return 0;
  }
  if (second === "release") {
    // `bsf sandbox release`, with AMEND: the amendment ended before any
    // trial, so its reports wait again and the attempt does not count.
    const amendRaw = process.env["AMEND"] ?? "";
    if (amendRaw.trim() === "") return 0;
    let keys: string[] = [];
    try {
      keys = ((JSON.parse(amendRaw) as { reports?: { key?: unknown }[] }).reports ?? [])
        .map((r) => r.key)
        .filter((k): k is string => typeof k === "string");
    } catch (e) {
      die(`AMEND is not JSON: ${(e as Error).message}`);
    }
    const gh = new GitHub({ repo: requireRepo() });
    const { FactoryStore } = await import("./lib/store.js");
    const { releaseReports } = await import("./commands/sandbox-reports.js");
    const n = await releaseReports(new FactoryStore(gh), keys);
    process.stdout.write(`${n} report(s) wait again: the amendment never reached a trial\n`);
    return 0;
  }
  die("usage: bsf sandbox start | check | trial | freeze | land | release");
}

async function modelsCommand(): Promise<number> {
  const cfg = await factoryConfig();
  const models = cfg.models ?? {};
  const roles = ["triage", "spec", "builder", "verifier", "gardener", "hardener", "scorer"];
  const missing = roles.filter((r) => typeof models[r] !== "string" || models[r] === "");
  if (missing.length > 0) {
    process.stderr.write(`bsf: the factory's settings have no model for: ${missing.join(", ")}\n`);
    return 1;
  }
  for (const r of roles) setOutput(`model_${r}`, models[r] ?? "");
  setOutput("garden_max_prs", String(cfg.pipelines?.["gardening"]?.max_prs_per_run ?? 5));
  for (const r of roles) process.stdout.write(`${r}: ${models[r] ?? ""}\n`);
  return 0;
}

async function consistencyCommand(args: Args): Promise<number> {
  const root = typeof args["root"] === "string" ? args["root"] : process.cwd();

  // Every tracked text file, rather than a list of extensions: a list left a
  // C++ or Swift repo invisible. git knows what is generated and vendored.
  const files = textFiles(root, await trackedFiles(root));
  const outcomes = checkConsistencyOutcomes({ root, files });
  const findings = allFindings(outcomes);

  if (args["json"] === true) {
    process.stdout.write(`${JSON.stringify({ files: files.length, outcomes, findings }, null, 2)}\n`);
  } else {
    process.stdout.write(`${describeOutcomes(outcomes)}\n\n`);
    for (const f of findings) {
      process.stdout.write(`${f.check}\n  ${f.detail}\n  between ${f.between[0]} and ${f.between[1]}\n`);
    }
    const applied = outcomes.filter((o) => o.state !== "not_applicable").length;
    process.stdout.write(
      `${findings.length} inconsistency(ies) across ${files.length} file(s); ${applied} of ${outcomes.length} checks applied here\n`,
    );
  }

  setOutput("inconsistencies", String(findings.length));
  setOutput("checks_applied", String(outcomes.filter((o) => o.state !== "not_applicable").length));
  // Reported, not failed: every one of these needs a person to say which of
  // the two artifacts is the one that is wrong.
  return 0;
}

/**
 * Tracked files that are text and not huge. Content-sniffed rather than
 * matched by extension, so every language counts.
 */
function textFiles(root: string, tracked: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of tracked) {
    try {
      const full = join(root, f);
      const size = statSync(full).size;
      if (size === 0 || size > 1_000_000) continue;
      const head = readFileSync(full).subarray(0, 8000);
      if (head.includes(0)) continue; // binary
      out.push(f);
    } catch {
      /* deleted or unreadable: skip */
    }
  }
  return out;
}

async function trackedFiles(root: string): Promise<readonly string[]> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return String(stdout).split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}

async function dashboardCommand(args: Args): Promise<number> {
  const dir =
    typeof args["dir"] === "string" ? args["dir"] : findDashboard(dirname(fileURLToPath(import.meta.url)));
  if (dir === null) {
    die(
      "the built dashboard was not found. In a checkout, run `npm -w @bsf/dashboard run build` first, " +
        "or pass --dir PATH to the directory holding its index.html.",
    );
  }

  const port = typeof args["port"] === "string" ? Number(args["port"]) : 7777;
  if (!Number.isInteger(port) || port < 0 || port > 65535) die(`${String(args["port"])} is not a port`);

  const server = await serveDashboard({ root: dir, port }).catch((err: unknown) => {
    // The common one by far, and the message node gives for it says nothing
    // about what to do.
    if (/EADDRINUSE/.test(String(err))) {
      die(`port ${port} is already in use; pass --port with another one`);
    }
    throw err;
  });

  process.stdout.write(`${server.url}\n`);
  process.stdout.write("Serving the dashboard on this machine only. Ctrl-C to stop.\n");

  // Held open until the process is stopped; there is nothing else to do.
  await new Promise<void>((resolve) => {
    const stop = () => {
      void server.close().then(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function dashboardLinkCommand(args: Args): Promise<number> {
  const repo = typeof args["repo"] === "string" ? args["repo"] : "";
  const result = dashboardLink(repo);
  if (!result.ok) {
    process.stderr.write(`bsf: ${result.reason ?? "no link"}\n`);
    return 1;
  }
  process.stdout.write(`${result.url}\n`);
  return 0;
}

async function settingsCommand(args: Args): Promise<number> {
  const root = typeof args["root"] === "string" ? args["root"] : process.cwd();
  const result = runSettings({ root, ...(typeof args["set"] === "string" ? { set: args["set"] } : {}) });
  process.stdout.write(`${result.lines.join("\n")}\n`);
  if (!result.ok) return 1;
  if (result.changed.length > 0) {
    process.stdout.write("Open it as a pull request with the factory:settings label so the factory's check can pass it.\n");
  }
  return 0;
}

async function doctorCommand(args: Args): Promise<number> {
  const root = typeof args["root"] === "string" ? args["root"] : process.cwd();
  const repo = typeof args["repo"] === "string" ? args["repo"] : undefined;

  const report = await runDoctor({
    root,
    fixModes: args["fix-modes"] === true,
    ...(repo === undefined ? {} : { gh: new GitHub({ repo }) }),
  });

  const broken = report.findings.filter((f) => f.severity === "broken").length;
  // `--quiet` is for a workflow that only wants the verdict: the exit code
  // gates whether a run worth minutes of agent time should start at all.
  if (args["quiet"] === true) {
    setOutput("broken", String(broken));
    setOutput("installed", String(report.installed));
    return broken > 0 ? 1 : 0;
  }

  if (args["json"] === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }

  setOutput("broken", String(broken));
  setOutput("installed", String(report.installed));
  // A factory that is simply not installed is not a failure to report: the
  // skill calls this to find out which mode it is in.
  return broken > 0 ? 1 : 0;
}

async function localHookCommand(args: Args): Promise<number> {
  const lh = await import("./commands/local-hook.js");
  const repoPath = typeof args["repo-path"] === "string" ? args["repo-path"] : process.cwd();
  const repo = typeof args["repo"] === "string" ? args["repo"] : process.env["GITHUB_REPOSITORY"];

  if (args["install"] === true || args["uninstall"] === true) {
    const file = lh.settingsPath(repoPath);
    const current = lh.readSettings(file);
    if (args["uninstall"] === true) {
      const next = lh.withoutHook(current);
      if (next === null) {
        process.stdout.write("the correction hook is not installed here\n");
        return 0;
      }
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      process.stdout.write(`removed the correction hook from ${file}\n`);
      return 0;
    }
    if (repo === undefined || repo === "") die("usage: bsf local-hook --install --repo OWNER/NAME");
    const info = await new GitHub({ repo }).get<{ private?: boolean }>(`repos/${repo}`);
    if (info.private !== true && args["allow-public"] !== true) {
      die(
        `${repo} is public. What you correct an agent on would be written into work items and Actions runs anyone can read. ` +
          `Run again with --allow-public if that is fine, or use a private repo.`,
      );
    }
    const next = lh.withHook(current, lh.hookCommand(repo));
    if (next === null) {
      process.stdout.write("the correction hook is already installed here\n");
      return 0;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    process.stdout.write(
      `installed the correction hook in ${file}\n` +
        `From now on a message to your agent that corrects it is sent to ${repo} as a hardening request, redacted and cut short. ` +
        `Remove it any time with: bsf local-hook --uninstall\n`,
    );
    return 0;
  }

  // What this machine has sent. The hook reads what someone types at an agent
  // and turns it into a work item in a repository, so this is how they answer
  // "what left my machine" without going and reading that repository.
  if (args["sent"] === true) {
    process.stdout.write(`${lh.renderSent(lh.readSent())}\n`);
    return 0;
  }

  // Hook mode. Nothing here may print or fail: the harness can feed a hook's
  // output to the agent, and a broken hook must never break a session.
  try {
    if (repo === undefined || repo === "") return 0;
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const input = lh.parseHookInput(Buffer.concat(chunks).toString("utf8"));
    const capture = lh.captureLocal(input, process.env["USER"] ?? "local", nowIso());
    if (!capture.send || capture.key === undefined || capture.title === undefined || capture.body === undefined) return 0;
    if (lh.alreadySent(capture.key)) return 0;
    await new GitHub({ repo }).dispatchWorkflow("factory-intake.yml", undefined, {
      kind: "correction",
      title: capture.title,
      body: capture.body,
    });
    lh.markSent(capture.key, undefined, { at: nowIso(), title: capture.title, repo });
  } catch {
    // Silent by design.
  }
  return 0;
}

async function contributeCorrectionsCommand(args: Args): Promise<number> {
  const file =
    typeof args["from"] === "string"
      ? args["from"]
      : typeof args["out"] === "string"
        ? args["out"]
        : "factory-contribution.json";

  if (args["submit"] === true) {
    if (!existsSync(file)) {
      die(`${file} does not exist. Run \`bsf contribute-corrections\` first, read it, then --submit.`);
    }
    const contribution = JSON.parse(readFileSync(file, "utf8")) as Contribution;
    if (contribution.schema !== "contribution/1") {
      die(`${file} is not a contribution file`);
    }
    if (contribution.candidates.length === 0) {
      process.stdout.write("that file has no candidates left in it; nothing submitted\n");
      return 0;
    }

    const repo = typeof args["repo"] === "string" ? args["repo"] : contribution.repo;
    const gh = new GitHub({ repo });
    const res = await submitContribution({
      gh,
      contribution,
      candidatesPath: ".factory/guardrails/candidates.json",
      repoPath: typeof args["repo-path"] === "string" ? args["repo-path"] : process.cwd(),
    });
    if ("nothing" in res) {
      process.stdout.write(`${res.nothing}\n`);
      return 0;
    }
    process.stdout.write(
      `${res.merge.added.length} new, ${res.merge.folded.length} folded into existing, ` +
        `${res.merge.skipped.length} already decided\n` +
        `PR #${res.pull}  ${res.url}\n`,
    );
    setOutput("pull", String(res.pull));
    return 0;
  }

  // Mining half: identical to what setup does, writing a file for the person
  // to read instead of the factory's candidate list.
  const repoPath = typeof args["repo-path"] === "string" ? args["repo-path"] : process.cwd();
  const exclude =
    typeof args["exclude"] === "string"
      ? args["exclude"].split(",").map((x) => x.trim()).filter((x) => x !== "")
      : undefined;

  const report = await mineCorrections({
    repoPath,
    ...(exclude === undefined ? {} : { excludeSessions: exclude }),
  });
  process.stdout.write(`${report.note}\n`);

  if (report.corrections.length === 0) {
    // Deliberately not mining the repository's own history here: setup
    // already did that, and it is the same for everyone. Only what is on this
    // machine is new.
    process.stdout.write("nothing found in the sessions on this machine\n");
    return 0;
  }

  const candidates = candidatesFrom(clusterCorrections(report.corrections), nowIso());
  const doc: Contribution = {
    schema: "contribution/1",
    repo: typeof args["repo"] === "string" ? args["repo"] : repoPath,
    mined_at: nowIso(),
    candidates,
  };
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);

  process.stdout.write(`\n${candidates.length} candidate(s), written to ${file}:\n\n`);
  for (const c of candidates) {
    process.stdout.write(`  ${String(c.occurrences).padStart(3)}x  ${c.problem_class.replace(/\s+/g, " ")}\n`);
  }
  process.stdout.write(
    `\nThat text is from your own sessions and would be visible to everyone with\n` +
      `access to the repo. Open ${file}, delete any candidate you would rather not\n` +
      `share, then run:\n\n  bsf contribute-corrections --submit --from ${file}\n`,
  );
  setOutput("mined", String(candidates.length));
  return 0;
}

function schemaSurfaceCommand(args: Args): number {
  const frozenPath = join(SCHEMA_DIR, "SURFACE.json");
  const live = surfaceForDirectory(SCHEMA_DIR);

  if (args["freeze"] === true) {
    const at = new Date().toISOString().slice(0, 10);
    writeFrozen(frozenPath, live, at);
    const files = Object.keys(live).length;
    process.stdout.write(`froze ${files} schema files at ${at}\n`);
    return 0;
  }

  if (!existsSync(frozenPath)) {
    die(`${frozenPath} does not exist; run bsf schema-surface --freeze once to record the frozen shape`);
  }
  const drift = compareSurface(readFrozen(frozenPath).surface, live);
  const breaking = drift.filter((d) => d.kind === "breaking");
  const widening = drift.filter((d) => d.kind === "widening");
  const additive = drift.filter((d) => d.kind === "additive");

  for (const d of additive) process.stdout.write(`additive  ${d.file}${d.pointer} ${d.what}\n`);
  for (const d of widening) {
    process.stdout.write(`widening  ${d.file}${d.pointer} ${d.what} (a reader on the frozen major rejects it)\n`);
  }
  for (const d of breaking) process.stderr.write(`BREAKING  ${d.file}${d.pointer} ${d.what}\n`);

  if (breaking.length > 0) {
    process.stderr.write(
      `\n${breaking.length} breaking change(s). Either undo them, or bump the major and ship a ` +
        `migration in bsf migrate, then re-freeze.\n`,
    );
    setOutput("breaking", String(breaking.length));
    return 1;
  }
  if (drift.length === 0) process.stdout.write("the schemas match the frozen shape exactly\n");
  return 0;
}

function migrateCommand(paths: readonly string[], args: Args): number {
  if (args["support"] === true) {
    for (const s of schemaSupport()) {
      process.stdout.write(`${s.schema}: writes ${s.writes}, reads ${s.reads.join(", ")}\n`);
    }
    return 0;
  }

  if (paths.length === 0) {
    die("usage: bsf migrate PATHS... [--apply]   (or --support)");
  }

  const files = paths.map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const plan = planMigration(files);

  for (const p of plan.current) process.stdout.write(`current: ${p}\n`);
  for (const u of plan.unknown) process.stderr.write(`skipped ${u.path}: ${u.why}\n`);

  if (plan.items.length === 0) {
    // Worth saying plainly: at schema 1.0 there is nothing to migrate, and
    // that is a fact about the schemas, not a command that did nothing.
    const why = MIGRATIONS.length === 0 ? " (this runner ships no migrations)" : "";
    process.stdout.write(`nothing to migrate${why}\n`);
    return plan.unknown.length > 0 ? 1 : 0;
  }

  for (const item of plan.items) {
    process.stdout.write(`${item.path} ${item.schema}/${item.from} -> ${item.to}: ${item.summary}\n`);
    process.stdout.write(`  would write ${item.writesTo}\n`);
  }
  if (args["apply"] !== true) {
    process.stdout.write("nothing written (pass --apply)\n");
    return 0;
  }

  const result = applyMigration(plan, diskIo);
  for (const m of result.migrated) process.stdout.write(`wrote ${m.to}\n`);
  for (const f of result.failed) process.stderr.write(`failed ${f.path}: ${f.why}\n`);
  return result.failed.length > 0 ? 1 : 0;
}

function stepReportCommand(args: Args): number {
  const role = args["role"];
  const out = args["out"];
  if (typeof role !== "string" || typeof out !== "string") {
    die("usage: bsf step-report --role R --out PATH [--usage PATH]");
  }
  const exit = typeof args["exit"] === "string" ? args["exit"] : "ok";
  const report = buildStepReport({
    harness: (typeof args["harness"] === "string" ? args["harness"] : "claude-code") as Harness,
    role,
    model: typeof args["model"] === "string" ? args["model"] : process.env["FACTORY_MODEL"] ?? "unknown",
    exit: exit as "ok" | "failed" | "timeout" | "cancelled",
    durationSec: typeof args["duration"] === "string" ? Number(args["duration"]) : 0,
    filesChanged: changedFilesFromGit(process.cwd()),
    transcript: typeof args["transcript"] === "string" ? args["transcript"] : "",
    ...(typeof args["usage"] === "string" ? { usagePath: args["usage"] } : {}),
    // gh-aw writes its session evidence under RUNNER_TEMP in the agent job.
    sessionDirs: sessionDirs(args),
  });
  writeStepReport(out, report);
  process.stdout.write(
    `${role}: ${report.exit}, ${report.tokens.in}+${report.tokens.out} tokens, ` +
      `$${report.cost_usd.toFixed(4)} (${report.cost_source})\n`,
  );
  return 0;
}

/** Where gh-aw's agent-session.jsonl and token-usage.jsonl may be. */
function sessionDirs(args: Args): readonly string[] {
  if (typeof args["session-dir"] === "string") return [args["session-dir"]];
  const temp = process.env["RUNNER_TEMP"];
  const dirs = ["/tmp/gh-aw"];
  if (temp !== undefined && temp !== "") dirs.unshift(`${temp}/gh-aw`, `${temp}/gh-aw/agent`);
  return dirs;
}

/* ----------------------------------------------------- role steps and gate 2 */

function requireOut(args: Args, usage: string): string {
  const out = args["out"];
  if (typeof out !== "string") die(usage);
  return out;
}

async function fetchWorkItemCommand(id: string | undefined, args: Args): Promise<number> {
  if (id === undefined) die("usage: bsf fetch-work-item ID --out PATH [--spec-only] [--with-triage]");
  const out = requireOut(args, "usage: bsf fetch-work-item ID --out PATH");
  const r = await fetchWorkItem({
    gh: new GitHub({ repo: requireRepo() }),
    id,
    out,
    ...(args["spec-only"] === true ? { specOnly: true } : {}),
    ...(args["with-triage"] === true ? { withTriage: true } : {}),
    ...(args["with-shortlist"] === true ? { withShortlist: true } : {}),
  });
  process.stdout.write(
    `${r.id} -> ${r.wrote}${r.specOnly ? " (spec only)" : ""}` +
      `${r.strippedBody && !r.specOnly ? "; the author is not trusted, so their text was withheld" : ""}` +
      `${r.includedTriage ? "; with triage's notes" : ""}\n`,
  );
  return 0;
}

/** What the spec gate checks against: the default branch's policy, and the checkout the spec was researched in. */
async function specGate(args: Args): Promise<Omit<SpecGateInput, "spec">> {
  const policy = await loadPolicy(new DiskLoader(process.cwd())).catch(() => null);
  const pipeline = typeof args["pipeline"] === "string" ? args["pipeline"] : "product_work";
  return {
    root: process.env["GITHUB_WORKSPACE"] ?? process.cwd(),
    protectedPaths: policy?.paths.protected ?? [".github/workflows/**"],
    pipelineExclusions: policy?.protected_files?.exclude[pipeline] ?? [],
    pipeline,
  };
}

async function writeSpecCommand(id: string | undefined, args: Args): Promise<number> {
  const from = args["from"];
  if (id === undefined || typeof from !== "string") die("usage: bsf write-spec ID --from PATH");
  const r = await writeSpec(new GitHub({ repo: requireRepo() }), id, from, nowIso(), await specGate(args));
  process.stdout.write(
    `spec stored on ${r.id}` +
      `${r.declaredTestEdits.length > 0 ? `; declares ${r.declaredTestEdits.length} test edit(s)` : ""}\n`,
  );
  setOutput("declared_test_edits", r.declaredTestEdits.join(","));
  return 0;
}

/** The same gate write-spec applies, run by the spec agent on its own draft so it can fix what fails. */
async function specCheckCommand(args: Args): Promise<number> {
  const file = args["file"];
  if (typeof file !== "string") die("usage: bsf spec check --file PATH [--pipeline P]");
  let spec: SpecLike;
  try {
    spec = JSON.parse(readFileSync(file, "utf8")) as SpecLike;
  } catch (e) {
    process.stderr.write(`${file} is not JSON: ${(e as Error).message}\n`);
    return 1;
  }
  // The shape first: write-spec stores the spec on the work item, whose
  // schema allows exactly the documented fields. An agent that passed the
  // gate but added a field lost the run at the store step.
  const { validate } = await import("./lib/schema.js");
  const stub = {
    schema: "work-item/1",
    id: "wi_00000000000000000000000000",
    created_at: "2000-01-01T00:00:00Z",
    source: { kind: "dashboard", actor: "check" },
    trigger_class: "request",
    pipeline: "product_work",
    title: "check",
    body: "",
    priority: "normal",
    fingerprint: `sha256:${"0".repeat(64)}`,
    status: "running",
    runs: [],
    pr: null,
    parent: null,
    related: [],
    spec,
  };
  const shape = validate("work-item", stub);
  const shapeProblems = shape.ok ? [] : shape.errors.filter((e) => e.path.startsWith("/spec") && !/must be null|must match exactly one schema/.test(e.message)).map((e) => `${e.path}: ${e.message}`);
  const problems = [...shapeProblems, ...specProblems({ ...(await specGate(args)), spec })];
  if (problems.length === 0) {
    process.stdout.write("the spec passes the gate\n");
    return 0;
  }
  process.stderr.write(`the spec would be rejected:\n  - ${problems.join("\n  - ")}\n`);
  return 1;
}

async function writeTriageCommand(id: string | undefined, args: Args): Promise<number> {
  const from = args["from"];
  if (id === undefined || typeof from !== "string") die("usage: bsf write-triage WORK_ITEM --from PATH");
  const { writeTriage, triageProblems } = await import("./commands/run-lifecycle.js");
  let result: unknown;
  try {
    result = JSON.parse(readFileSync(from, "utf8"));
  } catch (e) {
    die(`${from}: ${(e as Error).message}`);
  }
  const problems = triageProblems(result);
  if (problems.length > 0) die(`the triage result was rejected:\n  - ${problems.join("\n  - ")}`);
  const status = await writeTriage(new GitHub({ repo: requireRepo() }), id, result as never, nowIso());
  process.stdout.write(`${id} is ${status}\n`);
  return 0;
}

/** The previous attempt's gate failures, which after-gates stored on the data ref. Writes nothing when there are none. */
async function fetchGateFailuresCommand(id: string | undefined, args: Args): Promise<number> {
  if (id === undefined) die("usage: bsf fetch-gate-failures WORK_ITEM --out PATH");
  const out = requireOut(args, "usage: bsf fetch-gate-failures WORK_ITEM --out PATH");
  const { FactoryStore } = await import("./lib/store.js");
  const { gateFailuresPath } = await import("./commands/run-lifecycle.js");
  const text = await new FactoryStore(new GitHub({ repo: requireRepo() })).data.read(gateFailuresPath(id));
  if (text === null) {
    process.stdout.write(`no gate failures recorded for ${id}\n`);
    return 0;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  process.stdout.write(`${id}'s gate failures -> ${out}\n`);
  return 0;
}

async function fetchArtifactCommand(name: string | undefined, args: Args): Promise<number> {
  if (name === undefined) die("usage: bsf fetch-artifact NAME --out PATH [--run-id N]");
  const out = requireOut(args, "usage: bsf fetch-artifact NAME --out PATH");
  const runId = typeof args["run-id"] === "string" ? args["run-id"] : process.env["GITHUB_RUN_ID"];
  const r = await fetchArtifact(new GitHub({ repo: requireRepo() }), name, out, runId);
  process.stdout.write(r.found ? `${r.name} -> ${r.wrote}\n` : `${r.name} is not in this run; wrote an empty result\n`);
  return 0;
}

async function reportCommand(second: string | undefined, args: Args): Promise<number> {
  const gh = new GitHub({ repo: requireRepo() });
  const workItem = typeof args["work-item"] === "string" ? args["work-item"] : "";
  if (second === "store") {
    // `bsf report store --role R --dir DIR --work-item WI [--attempt N]`
    const role = typeof args["role"] === "string" ? args["role"] : "";
    const dir = typeof args["dir"] === "string" ? args["dir"] : "";
    if (role === "" || dir === "" || workItem === "") die("usage: bsf report store --role R --dir DIR --work-item WI [--attempt N]");
    const attempt = Number(args["attempt"] ?? 1);
    const { storeReport } = await import("./commands/pr-report.js");
    const r = await storeReport({ gh, dir, role, workItem, attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1, now: nowIso() });
    if (r === null) {
      process.stdout.write(`the ${role} wrote no report\n`);
      return 0;
    }
    process.stdout.write(`stored the ${role}'s report: ${r.report.blocks.length} block(s)\n`);
    for (const p of r.problems) process.stdout.write(`  problem: ${p}\n`);
    return 0;
  }
  if (second === "publish") {
    // `bsf report publish --work-item WI --pr N`
    const pr = Number(args["pr"]);
    if (workItem === "" || !Number.isInteger(pr) || pr <= 0) die("usage: bsf report publish --work-item WI --pr N");
    const { publishReport } = await import("./commands/pr-report.js");
    const r = await publishReport({ gh, workItem, pr, now: nowIso() });
    process.stdout.write(r.problems.length === 0 ? `PR #${pr} shows its proof\n` : `PR #${pr} is missing: ${r.problems.join("; ")}\n`);
    for (const d of r.degraded) process.stdout.write(`  note: ${d}\n`);
    return 0;
  }
  if (second === "setup") {
    // `bsf report setup --dir D --trial-dir T --tier X --out BODY [--extra FILE]`, where FILE is
    // { "focus": [{ "title", "detail" }], "links": [{ "label", "url" }] } from the workflow.
    const dir = typeof args["dir"] === "string" ? args["dir"] : "";
    const trialDir = typeof args["trial-dir"] === "string" ? args["trial-dir"] : "";
    const out = typeof args["out"] === "string" ? args["out"] : "";
    if (dir === "" || out === "") die("usage: bsf report setup --dir D --trial-dir T --tier X --out BODY [--extra FILE]");
    const extra = (typeof args["extra"] === "string" && existsSync(args["extra"])
      ? JSON.parse(readFileSync(args["extra"], "utf8"))
      : {}) as { focus?: { title: string; detail: string }[]; links?: { label: string; url: string }[] };
    const { renderSetupReport } = await import("./commands/pr-report.js");
    const r = await renderSetupReport({
      gh, dir, trialDir, runId: process.env["GITHUB_RUN_ID"] ?? "local",
      tier: typeof args["tier"] === "string" ? args["tier"] : "unknown",
      extraFocus: (extra.focus ?? []).filter((f) => f.title !== "" && f.detail !== ""),
      links: extra.links ?? [],
      now: nowIso(),
    });
    writeFileSync(out, r.body);
    writeFileSync(`${out}.problems.json`, JSON.stringify(r.problems));
    writeFileSync(`${out}.degraded.json`, JSON.stringify(r.degraded));
    if (r.continued !== null) writeFileSync(`${out}.continued.md`, r.continued);
    process.stdout.write(r.problems.length === 0 ? "rendered the setup PR\n" : `rendered the setup PR; missing: ${r.problems.join("; ")}\n`);
    return 0;
  }
  if (second === "check") {
    // `bsf report check --pr N --problems FILE [--degraded FILE]`
    const pr = Number(args["pr"]);
    const file = typeof args["problems"] === "string" ? args["problems"] : "";
    if (!Number.isInteger(pr) || pr <= 0 || file === "") die("usage: bsf report check --pr N --problems FILE [--degraded FILE]");
    const notesFile = typeof args["degraded"] === "string" ? args["degraded"] : "";
    const notes = notesFile !== "" && existsSync(notesFile) ? (JSON.parse(readFileSync(notesFile, "utf8")) as string[]) : [];
    const { reportCheck } = await import("./commands/pr-report.js");
    await reportCheck(gh, pr, JSON.parse(readFileSync(file, "utf8")) as string[], notes);
    return 0;
  }
  die("usage: bsf report store ... | publish ... | setup ... | check ...");
}

async function storeMediaCommand(args: Args): Promise<number> {
  const dir = args["run-dir"];
  if (typeof dir !== "string") die("usage: bsf store-media --run-dir DIR [--run-id ID]");
  const runId =
    typeof args["run-id"] === "string" ? args["run-id"] : process.env["GITHUB_RUN_ID"] ?? "unknown";
  const r = await storeMedia(new GitHub({ repo: requireRepo() }), dir, runId, nowIso());
  process.stdout.write(
    r.files.length === 0
      ? "no media to store\n"
      : `stored ${r.files.length} file(s), ${Math.round(r.bytes / 1024)} KB\n`,
  );
  for (const s of r.skipped) process.stdout.write(`  skipped ${s.file}: ${s.why}\n`);
  return 0;
}

/** Put the standing goals for a lane into a role's input file, so the role weighs them without another command. */
async function addStandingGoals(path: string, lane: "gardening" | "hardening"): Promise<void> {
  try {
    const { FactoryStore } = await import("./lib/store.js");
    const { activeGoals, goalLines, readGoals } = await import("./commands/standing-goals.js");
    const lines = goalLines(activeGoals(await readGoals(new FactoryStore(new GitHub({ repo: requireRepo() }))), nowIso(), lane));
    if (lines.length === 0) return;
    const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...doc, standing_goals: lines }, null, 2)}\n`);
  } catch {
    // Goals steer attention; a role runs fine without them.
  }
}

async function gardenScanCommand(args: Args): Promise<number> {
  const out = requireOut(args, "usage: bsf garden-scan --out PATH");
  const r = await gardenScan({
    gh: new GitHub({ repo: requireRepo() }),
    now: nowIso(),
    root: process.cwd(),
    baselines: await loadBaselines(new DiskLoader(process.cwd())),
    out,
  });
  await addStandingGoals(r.wrote, "gardening");
  process.stdout.write(`${r.measured.length} measured drift item(s) -> ${r.wrote}\n`);
  if (r.alreadyFixing.length > 0) {
    process.stdout.write(`  ${r.alreadyFixing.length} class(es) left out: an open PR already fixes them\n`);
  }
  return 0;
}

async function gardenFileCommand(args: Args): Promise<number> {
  const from = args["from"];
  if (typeof from !== "string") die("usage: bsf garden-file --from PATH [--max N] [--plan]");
  const cfg = await factoryConfig();
  const gh = new GitHub({ repo: requireRepo() });
  const max = typeof args["max"] === "string" ? Number(args["max"]) : cfg.pipelines?.["gardening"]?.max_prs_per_run ?? 5;
  const running = await runningRuns(gh);
  const r = await gardenFile({
    gh,
    now: nowIso(),
    root: process.cwd(),
    from,
    maxPrs: Number.isInteger(max) && max > 0 ? max : 5,
    freeSlots: Math.max(0, (cfg.limits?.concurrency?.max_runs ?? 5) - running),
    ...(args["plan"] === true ? { plan: true } : {}),
  });
  process.stdout.write(`filed ${r.filed.length}, dispatched ${r.dispatched.length}, handed to hardening ${r.handedOff.length}\n`);
  for (const x of r.rejected) process.stdout.write(`  rejected ${x.problem_class}: ${x.why}\n`);
  return 0;
}

async function hardenContextCommand(id: string | undefined, args: Args): Promise<number> {
  if (id === undefined) die("usage: bsf harden-context ID --out PATH");
  const out = requireOut(args, "usage: bsf harden-context ID --out PATH");
  const r = await hardenContext({
    gh: new GitHub({ repo: requireRepo() }),
    now: nowIso(),
    id,
    out,
    baselines: await loadBaselines(new DiskLoader(process.cwd())),
    candidatesPath: ".factory/guardrails/candidates.json",
    policy: (await policyOrNull(process.cwd())).policy,
  });
  await addStandingGoals(r.wrote, "hardening");
  process.stdout.write(`${r.openRules} existing rule(s), ${r.candidates} candidate(s) -> ${r.wrote}\n`);
  return 0;
}

async function reviewCollectCommand(args: Args): Promise<number> {
  const out = requireOut(args, "usage: bsf review-collect --out PATH");
  const root = trustedRoot() ?? process.cwd();
  const r = await reviewCollect({ gh: new GitHub({ repo: requireRepo() }), now: nowIso(), out, rubricsDir: join(root, ".factory/definition/rubrics") });
  process.stdout.write(`${r.runs} run(s) to grade${r.since === null ? "" : ` since ${r.since}`} -> ${r.wrote}\n`);
  return 0;
}

async function reviewWriteCommand(args: Args): Promise<number> {
  const scores = args["scores"];
  if (typeof scores !== "string") die("usage: bsf review-write --scores PATH [--plan]");
  const r = await reviewWrite({
    gh: new GitHub({ repo: requireRepo() }),
    now: nowIso(),
    scores,
    ...(args["plan"] === true ? { plan: true } : {}),
  });
  process.stdout.write(
    `${r.scored} scored, ${r.problems} problem(s), filed ${r.filed.length}, dispatched ${r.dispatched.length}\n`,
  );
  return 0;
}

async function gatesTests(args: Args): Promise<number> {
  const cfg = await factoryConfig();
  const gh = new GitHub({ repo: requireRepo() });
  const test = sandboxCommand("test");
  const existingCheck = cfg.existing_ci?.test_check ?? null;

  // Not knowing how to test a repo is not the same as the repo having no
  // tests. Reported neutral, it read as "nothing to run" on a repo with a
  // perfectly good `npm test`, and the aggregate gate would have passed a
  // change no test had seen.
  if (test.kind === "invalid") {
    const summary = `The sandbox manifest in this checkout is invalid, so the tests cannot be run:\n${test.errors.join("\n")}`;
    process.stdout.write(`${summary}\n`);
    await maybeReportCheck(args, "failure", "Sandbox manifest invalid", summary, "factory/gate-tests");
    setOutput("tests_source", "invalid_manifest");
    return 1;
  }
  if (test.kind === "no_manifest" && existingCheck === null) {
    // Before the manifest is on the default branch, failing here blocks the
    // pull request that lets setup write the manifest. After that, a missing
    // manifest is a real failure: a change would merge with no tests run.
    const { missingManifestTests } = await import("./commands/tests-gate.js");
    const setupDone = await gh.setupFinished().catch(() => false);
    const verdict = missingManifestTests(setupDone);
    process.stdout.write(`${verdict.summary}\n`);
    await maybeReportCheck(args, verdict.conclusion, verdict.title, verdict.summary, "factory/gate-tests");
    setOutput("tests_source", verdict.source);
    return verdict.exitCode;
  }

  let env: Record<string, string> | undefined;
  if (test.kind === "command") {
    const { closedEnv } = await import("./commands/sandbox.js");
    const closed = closedEnv(process.env["GITHUB_WORKSPACE"] ?? process.cwd());
    if (closed === null && existingCheck === null) {
      const summary =
        "The sandbox was not started before the tests gate, so the tests would run without their dependencies " +
        "or their environment. The gate workflow runs `bsf sandbox start` first; a workflow that does not was edited.";
      process.stdout.write(`${summary}\n`);
      await maybeReportCheck(args, "failure", "Sandbox not started", summary, "factory/gate-tests");
      setOutput("tests_source", "no_sandbox");
      return 1;
    }
    if (closed !== null) env = closed;
  }
  // A command that deselects tests can still exit 0, and the coverage command
  // replaces the test command when it is set. Either one is a failed sandbox,
  // including when an existing CI check would have been read as a pass.
  const dropped = manifestDropsTests(
    {
      test: test.kind === "command" ? test.command : null,
      coverage: sandboxCommandText("coverage"),
    },
    env,
  );
  if (dropped !== null) {
    process.stdout.write(`${dropped}\n`);
    await maybeReportCheck(args, "failure", "Tests were deselected", dropped, "factory/gate-tests");
    setOutput("tests_source", "deselected");
    return 1;
  }
  const result = await runTestsGate({
    gh,
    commit: headSha(),
    existingCheck,
    // The build first, where the manifest has one: a test command is written
    // to follow it (dotnet test --no-build, a compiled test binary), and the
    // sandbox start runs only the install.
    command:
      test.kind === "command"
        ? (() => {
            // The coverage command is the tests run so they also write the
            // report the coverage gate reads: one run, not two.
            const run = sandboxCommandText("coverage") ?? test.command;
            const build = sandboxCommandText("build");
            return build === null ? run : `${build} && ${run}`;
          })()
        : null,
    root: process.cwd(),
    ...(env === undefined ? {} : { env }),
  });
  process.stdout.write(`${result.summary}\n`);
  await maybeReportCheck(
    args,
    result.conclusion,
    result.conclusion === "success" ? "Tests passed" : result.conclusion === "neutral" ? "No tests" : "Tests failed",
    `${result.summary}\n\n${result.detail ?? ""}`,
    "factory/gate-tests",
  );
  setOutput("tests_source", result.source);
  return result.conclusion === "failure" ? 1 : 0;
}

async function mineCommand(args: Args): Promise<number> {
  const repoPath = typeof args["repo-path"] === "string" ? args["repo-path"] : process.cwd();
  const sources =
    typeof args["source"] === "string" ? args["source"].split(",").map((s) => s.trim()) : undefined;

  if (args["list"] === true) {
    const listing = await listSessions({ repoPath, ...(sources === undefined ? {} : { sources }) });
    process.stdout.write(`${listing.note}\n`);
    for (const s of listing.sessions) {
      process.stdout.write(
        `  ${(s.at ?? "unknown date").slice(0, 10)}  ${s.source.padEnd(10)} ${s.session}\n` +
          `${s.opening === "" ? "" : `      ${s.opening}\n`}`,
      );
    }
    // An empty result said nothing at all, which reads as a command that
    // failed rather than a repo with no past agent sessions to read.
    if (listing.sessions.length === 0) {
      process.stdout.write("No past agent sessions found for this repository, so there is nothing to mine.\n");
    }
    setOutput("sessions", String(listing.sessions.length));
    return 0;
  }

  const exclude =
    typeof args["exclude"] === "string"
      ? args["exclude"].split(",").map((s) => s.trim()).filter((s) => s !== "")
      : undefined;

  const report = await mineCorrections({
    repoPath,
    ...(sources === undefined ? {} : { sources }),
    ...(exclude === undefined ? {} : { excludeSessions: exclude }),
  });

  process.stdout.write(`${report.note}\n`);

  // The repository's own history needs no consent and no memex, so it is
  // mined either way — and on a repo no agent has touched, it is the only
  // mining that finds anything.
  const fromRepo = await mineRepo(repoPath);
  process.stdout.write(
    `the repository itself: ${fromRepo.reverts.length} revert(s), ${fromRepo.fixes.length} quick fix(es), ` +
      `${fromRepo.prose.length} written rule(s)\n`,
  );

  const remote = await gitRemote(repoPath);
  const slug = process.env["GITHUB_REPOSITORY"] ?? (remote === "" ? null : repoSlug(remote));
  const fromGithubReal = await mineGithub({
    repo: slug,
    gh: ghAt(repoPath),
    filesInCommit: (sha) => filesInCommit(repoPath, sha),
  });
  process.stdout.write(`${fromGithubReal.note}\n`);

  const split = splitFindings({ session: report.corrections, repo: fromRepo, github: fromGithubReal });
  const mergeInto = typeof args["merge-into"] === "string" ? args["merge-into"] : undefined;
  const out =
    typeof args["out"] === "string"
      ? args["out"]
      : (mergeInto ?? ".factory/guardrails/candidates.json");
  const key = process.env["ANTHROPIC_API_KEY"];
  const classes = typeof args["classes"] === "string" ? args["classes"] : undefined;
  const done = await assembleMine({
    session: report,
    clear: split.clear,
    pending: split.pending,
    counts: {
      session_searches: report.searched,
      reverts: fromRepo.reverts.length,
      fixes: fromRepo.fixes.length,
      reviews: fromGithubReal.reviews === null ? null : fromGithubReal.reviews.length,
      bugs: fromGithubReal.bugs === null ? null : fromGithubReal.bugs.length,
      prose: fromRepo.prose.length,
    },
    notes: [report.note, fromGithubReal.note],
    ...(classes === undefined ? {} : { classesPath: classes }),
    ...(key && classes === undefined ? { complete: anthropicClassifier(key, "claude-haiku-5-5") } : {}),
    out,
    reportPath: join(repoPath, ".factory/guardrails/mining-report.json"),
    ...(mergeInto === undefined ? {} : { mergeInto }),
    now: nowIso(),
  });
  for (const line of done.lines) process.stdout.write(`${line}\n`);
  setOutput("mined", done.code === 0 ? "done" : "pending");
  return done.code;
}

async function gitRemote(root: string): Promise<string> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("git", ["remote", "get-url", "origin"], { cwd: root });
    return String(stdout).trim();
  } catch {
    return "";
  }
}

/**
 * Run the survey check or only the fundamentals copy check.
 *
 * args: CLI flags. `--root` is the checkout.
 * fundamentalsOnly: true for `bsf assess fundamentals`.
 * Returns 0 when nothing is wrong, 1 when the survey or the copy check failed.
 */
function assessCommand(args: Args, fundamentalsOnly: boolean): number {
  const root = typeof args["root"] === "string" ? args["root"] : process.cwd();
  const problems = assessCheck(root, fundamentalsOnly);
  if (problems.length === 0) {
    process.stdout.write(fundamentalsOnly ? "fundamentals.md does not copy the house docs\n" : "the survey is complete\n");
    return 0;
  }
  for (const p of problems) process.stderr.write(`${p}\n`);
  return 1;
}


async function scoreCommand(args: Args): Promise<number> {
  const runsPath = args["runs"];
  const out = args["out"];
  if (typeof runsPath !== "string" || typeof out !== "string") {
    die("usage: bsf score --runs PATH --out PATH [--repeat N]");
  }
  const runs = JSON.parse(readFileSync(runsPath, "utf8")) as Parameters<typeof runScorers>[0]["runs"];
  const rubrics = loadRubrics(".factory/definition/rubrics");
  if (rubrics.length === 0) die("the factory has no rubrics installed");

  const grader = process.env["FACTORY_GRADER_PROVIDER"] ?? "anthropic:messages:claude-haiku-5-5";
  const repeat = typeof args["repeat"] === "string" ? Number(args["repeat"]) : 2;
  const report = await runScorers({
    rubrics,
    runs,
    graderProvider: grader,
    workDir: ".factory/work/scorers",
    repeat: Number.isInteger(repeat) && repeat > 0 ? repeat : 2,
  });

  for (const e of report.errors) process.stderr.write(`grading error: ${e}\n`);
  for (const u of report.unreliable) {
    process.stdout.write(`  not routed, the repeats disagreed: ${u}\n`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ failures: report.failures }, null, 2)}\n`);
  process.stdout.write(
    `${report.rows.length} grade(s), ${report.failures.length} failure(s) -> ${out}\n`,
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`bsf: ${(err as Error).message ?? String(err)}\n`);
    process.exit(2);
  });

#!/usr/bin/env node
import { GitHub } from "./lib/github.js";
import {
  DiskLoader, RefLoader, loadPolicy, loadBaselines, loadCoverage, changedFilesSince, changedLinesSince,
} from "./lib/config.js";
import { runStaticGate, runCoverageGate, checkedFromCheckRuns, summarizeGates, GATES_CHECK, type JobResult } from "./commands/gates-run.js";
import { runPolicyCommand } from "./commands/policy-run.js";
import { planGates } from "./commands/gates.js";
import { SCHEMA_NAMES, assertValid, type SchemaName, SCHEMA_DIR } from "./lib/schema.js";
import { runIntakeCommand } from "./commands/intake-run.js";
import { runRollupCommand, squashMedia } from "./commands/rollup-run.js";
import { runMergeCommand } from "./commands/merge-run.js";
import { runGardenCommand } from "./commands/garden.js";
import { runConflictsCommand } from "./commands/conflicts.js";
import { runSyncCommand } from "./commands/sync-settings.js";
import { runAuditCommand } from "./commands/audit.js";
import { byFileOf } from "./commands/gates.js";
import { parseYaml } from "./lib/yaml.js";
import { benchmarkResultId } from "./lib/ids.js";
import { benchmarkResultPath, FactoryStore, json } from "./lib/store.js";
import type { CandidatesFile } from "./lib/types.js";
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
import { loadFactory } from "./lib/config.js";
import { startSandbox, loadManifest, loadManifestAt, trialSandbox, freezeManifest, needsHost, serveOnHost, closedEnv } from "./commands/sandbox.js";
import { fetchWorkItem, writeSpec, fetchArtifact, storeMedia } from "./commands/role-io.js";
import { gardenScan, gardenFile, hardenContext, reviewCollect, reviewWrite } from "./commands/role-steps.js";
import { runTestsGate } from "./commands/tests-gate.js";
import { mineCorrections, listSessions, clusterCorrections, candidatesFrom } from "./commands/mine.js";
import { mineRepo } from "./commands/mine-repo.js";
import { runScorers, loadRubrics } from "./commands/score.js";
import {
  buildTasks, buildBenchmarkConfig, runBenchmark, readBenchmark, admit, sideSummary,
  type BenchmarkTask,
} from "./commands/benchmark.js";
import { runBenchmarkTask, type BenchmarkTaskInput } from "./commands/benchmark-run.js";
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
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

const VERSION = "0.1.0";

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

  bsf gates coverage [--base REF] [--report-check NAME]
      Gate 2's coverage half. Diff coverage of the changed files is the main
      check; total coverage must stay above the floor.

  bsf gates tests [--report-check NAME]
      Gate 2's test half. Reads the repo's own test check for this commit when
      it has one; runs the tests itself if that check does not report in time.

  bsf gates record --plan-static B --plan-verification B --plan-agent B --static R --verification R --agent R [--commit SHA]
      Report factory/gates: the verdict over every gate the plan called for.
      Record a gate's result against the head commit, so the same commit is
      never checked twice.

  bsf intake [--event-name NAME] [--event PATH] [--plan]
      Normalize every unprocessed event into work items and dispatch runs.
      Appends the incoming event to the data ref before deciding anything, so
      a dropped run costs a delay rather than a request.

  bsf run plan WORK_ITEM [--attempt N] [--revision] | --pipeline P
      Which roles run for this attempt, and why. factory-run reads this.

  bsf run start WORK_ITEM [--attempt N] [--escalate true] [--first-step ROLE]
  bsf run after-gates WORK_ITEM --run-id R [--attempt N] [--pr N] [--build-result R] [--wait-min M] [--steps-dir DIR]
  bsf run after-gates --static S --verification V [--attempt N]
      What happens after the gates: verify, retry, escalate or clear.

  bsf rollup [--squash-media] [--plan]
      Rebuild index.json and ledger.json from the run files, and dispatch
      queued work when slots are free.

  bsf budget check
      Which pipelines are over their share of either monthly limit.

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

  bsf audit [--commit SHA]
      After a push to main: did anything reach main without passing the gates,
      and is every compiled role workflow current with its source?

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
                       [--merge-into PATH]
      Read the sessions the user did not exclude and find the moments they
      corrected an agent. Each one is a rule they already wanted. Writes
      guardrail candidates; reports and continues if memex is not installed.
      With --merge-into, the existing list is kept and only genuinely new
      problems are added — what the skill's update mode needs, since one the
      user already rejected must not be offered again.

  bsf recompile-prepare
      Apply the frozen sandbox's research hosts to the spec role's network, ready for gh aw compile.
  bsf practice add TEXT
      Declare a practice every agent follows from now on. Opens a PR adding it to
      practices.md, and a rule where one can enforce it. Same as commenting
      /practice TEXT on any issue or PR.
  bsf sandbox start
      Bring up the frozen sandbox: its services, its closed environment, its install.
  bsf sandbox check [--file PATH]
      Validate a sandbox manifest.
  bsf sandbox trial --candidate PATH --out PATH
      Run a candidate manifest and record the tier it actually reaches.
  bsf sandbox freeze --rounds CANDIDATE:TRIAL[,...] --out PATH
      Write the manifest from the best measured round, at the tier it reached.
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

  bsf doctor [--root PATH] [--repo OWNER/REPO] [--json]
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

  bsf benchmark run --before PATH --after PATH [--tasks DIR] [--repeats N]
                    [--pr N] [--repo OWNER/REPO] [--result-out PATH]
      Run the frozen tasks against two definitions and say whether the change
      is admissible. Writes the comparison — each side's score, spread and
      cost — so the Improvement page can plot cost against quality; with
      --repo it also stores it in the factory's data ref.

  bsf benchmark build --runs PATH [--out DIR]
      Turn merged runs into frozen benchmark tasks, including the ones a human
      had to correct — those are what a definition change must show it fixes.

  bsf benchmark run --tasks DIR --before PATH --after PATH [--repeats N]
      Run both definitions over the same tasks and say whether the change is
      admissible. A must-pass check that regressed is a veto.

  bsf benchmark-run --task JSON --definition PATH [--json]
      One task, one definition, in this checkout. Called by the promptfoo
      provider; reports unavailable rather than a pass when it cannot run.

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
      if (second !== "check") die("usage: bsf budget check");
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

    case "audit":
      return auditCommand(args);

    case "consistency":
      return consistencyCommand(args);
    case "models":
      return modelsCommand();
    case "sandbox":
      return sandboxCommandCli(second, args);
    case "practice":
      return practiceCommand(second, command.slice(2));
    case "recompile-prepare":
      return recompilePrepareCommand();

    case "dashboard":
      return dashboardCommand(args);

    case "doctor":
      return doctorCommand(args);

    case "contribute-corrections":
      return contributeCorrectionsCommand(args);

    case "schema-surface":
      return schemaSurfaceCommand(args);

    case "migrate":
      return migrateCommand(command.slice(1), args);

    case "step-report":
      return stepReportCommand(args);

    case "mine-corrections":
      return mineCommand(args);

    case "score":
      return scoreCommand(args);

    case "benchmark":
      return benchmarkCommand(second, args);

    case "benchmark-run":
      return benchmarkRunCommand(args);

    case "fetch-work-item":
      return fetchWorkItemCommand(command[1], args);

    case "write-spec":
      return writeSpecCommand(command[1], args);

    case "spec":
      if (second !== "check") die("usage: bsf spec check --file PATH [--pipeline P]");
      return specCheckCommand(args);

    case "guardrails": {
      // `bsf guardrails record [--out PATH]`: baseline what the repo's own
      // checkers report today, per rule and per file, for setup's PR.
      if (second !== "record") die("usage: bsf guardrails record [--out PATH]");
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
  const result = await runCoverageGate({
    root,
    current: await loadCoverage(new DiskLoader(root)),
    changedFiles: changedFilesSince(base),
    changedLines: changedLinesSince(base),
    ...(report === undefined ? {} : { report }),
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
  return verdict.conclusion === "success" ? 0 : 1;
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
 * The checkers declared in the default branch's sandbox, with the closed
 * environment the sandbox start wrote, so they run like the tests do.
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

async function budgetState(cfg: FactoryConfig, gh: GitHub): Promise<BudgetState> {
  const { FactoryStore, BUDGET } = await import("./lib/store.js");
  const store = new FactoryStore(gh);
  const spent = await store.data.readJson<{
    spentUsd?: Record<string, number>;
    spentMinutes?: Record<string, number>;
  }>(BUDGET);
  const shares = cfg.budget?.shares ?? {};
  return {
    limitUsd: cfg.budget?.monthly_usd ?? 0,
    limitMinutes: cfg.budget?.monthly_actions_minutes ?? null,
    shares: {
      product_work: shares["product_work"] ?? 60,
      gardening: shares["gardening"] ?? 25,
      review_and_benchmarks: shares["review_and_benchmarks"] ?? 15,
    },
    spentUsd: spent?.spentUsd ?? {},
    spentMinutes: spent?.spentMinutes ?? {},
    productHardStopPct: cfg.budget?.product_work_hard_stop_pct ?? 110,
  };
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
  const report = await runIntakeCommand({
    gh,
    eventName,
    eventPath,
    now: nowIso(),
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
  });

  for (const d of report.result.decisions) {
    process.stdout.write(`${d.event.kind}: ${d.outcome} — ${d.reason}\n`);
  }
  process.stdout.write(
    `${report.result.processed} event(s) processed; dispatched ${report.dispatched.length}: ${report.decision.reason}\n`,
  );
  setOutput("dispatched", report.dispatched.join(","));
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
    if (pipeline === undefined && typeof workItemId === "string") {
      const { FactoryStore, workItemPath } = await import("./lib/store.js");
      const store = new FactoryStore(new GitHub({ repo: requireRepo() }));
      const item = await store.get<{ pipeline: string; spec?: unknown }>(workItemPath(workItemId), "work-item");
      if (item === null) die(`${workItemId} is not on the data ref`);
      pipeline = item.pipeline;
      hasSpec = item.spec !== null && item.spec !== undefined;
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

    process.stdout.write(`${plan.reason}\nroles: ${roles.join(" -> ") || "(none)"}\n`);
    setOutput("pipeline", pipeline);
    setOutput("roles", roles.join(","));
    setOutput("needs_triage", String(roles.includes("triage")));
    setOutput("needs_hardener", String(roles.includes("hardener")));
    setOutput("needs_spec", String(roles.includes("spec")));
    setOutput("protected_files_policy", protectedFilesPolicy);
    setOutput("proceed", String(!plan.escalate));
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
    const sweep = await sweepReports({ gh, store, ledger: await store.ledger(now), now });
    process.stdout.write(`${sweep.why}\n`);
    return 0;
  }

  if (second === "status") {
    // `bsf run status WORK_ITEM`: proceed=true while the item is still the run's.
    if (third === undefined) die("usage: bsf run status WORK_ITEM");
    const { itemStatus } = await import("./commands/run-lifecycle.js");
    const status = await itemStatus(new GitHub({ repo: requireRepo() }), third);
    process.stdout.write(`${third} is ${status}\n`);
    setOutput("status", status);
    setOutput("proceed", String(status === "running"));
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

  if (second === "after-gates" && third !== undefined && args["static"] === undefined) {
    // `bsf run after-gates WORK_ITEM --run-id R --attempt N [--pr N] [--build-result R] [--wait-min M]`
    const { finishRun } = await import("./commands/run-lifecycle.js");
    const runIdArg = args["run-id"];
    if (typeof runIdArg !== "string" || runIdArg === "") die("usage: bsf run after-gates WORK_ITEM --run-id R ...");
    const cfg: FactoryConfig = await factoryConfig().catch((): FactoryConfig => ({}));
    const attempt = typeof args["attempt"] === "string" ? Number(args["attempt"]) : 1;
    const pr = typeof args["pr"] === "string" ? Number(args["pr"]) : 0;
    const waitMin = typeof args["wait-min"] === "string" ? Number(args["wait-min"]) : 90;
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

  die("usage: bsf run plan|start|after-gates");
}

async function rollupCommand(args: Args): Promise<number> {
  const cfg = await factoryConfig();
  const gh = new GitHub({ repo: requireRepo() });
  const now = nowIso();
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

  if (args["squash-media"] === true) {
    const months = cfg.data?.media_retention_months ?? 12;
    const r = await squashMedia(gh, now, months);
    process.stdout.write(`media: kept ${r.kept}, dropped ${r.dropped}\n`);
  }
  return 0;
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
      process.stdout.write(`${p.tag} (${p.occurrences}x) -> ${p.destination}: ${p.why}\n`);
    }
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
  if (report.findings.length === 0) {
    process.stdout.write(`${commit.slice(0, 8)} passed every gate it should have\n`);
    return 0;
  }
  for (const f of report.findings) process.stderr.write(`${f.kind}: ${f.detail}\n`);
  setOutput("findings", String(report.findings.length));
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

async function sandboxCommandCli(second: string | undefined, args: Args): Promise<number> {
  if (second === "start") {
    // --if-present: the gates run on every PR, including those opened before
    // setup has frozen a sandbox. There the tests gate decides (the repo's
    // own test check, or a failure saying setup has not finished); starting
    // nothing is not itself an error.
    if (args["if-present"] === true && loadManifest(process.cwd()).kind === "missing") {
      process.stdout.write("no sandbox yet: setup has not frozen one on the default branch\n");
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
    }
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
    const sweep = await sweepReports({ gh, store, ledger: await store.ledger(now), now });
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
    const r = await trialSandbox({
      manifestPath: candidate,
      workspace: process.env["GITHUB_WORKSPACE"] ?? process.cwd(),
      out,
      ...(process.env["FACTORY_SANDBOX_ENV"] === undefined ? {} : { secretBlob: process.env["FACTORY_SANDBOX_ENV"] }),
    });
    setOutput("reached", r.reached);
    setOutput("claimed", r.claimed);
    setOutput("met", String(r.reached === r.claimed));
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
  die("usage: bsf sandbox start | check | trial | freeze");
}

async function modelsCommand(): Promise<number> {
  const cfg = await factoryConfig();
  const models = cfg.models ?? {};
  const roles = ["triage", "spec", "builder", "verifier", "gardener", "hardener", "scorer"];
  const missing = roles.filter((r) => typeof models[r] !== "string" || models[r] === "");
  if (missing.length > 0) {
    process.stderr.write(`bsf: factory.yaml has no model for: ${missing.join(", ")}\n`);
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

async function doctorCommand(args: Args): Promise<number> {
  const root = typeof args["root"] === "string" ? args["root"] : process.cwd();
  const repo = typeof args["repo"] === "string" ? args["repo"] : undefined;

  const report = await runDoctor({
    root,
    ...(repo === undefined ? {} : { gh: new GitHub({ repo }) }),
  });

  if (args["json"] === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }

  const broken = report.findings.filter((f) => f.severity === "broken").length;
  setOutput("broken", String(broken));
  setOutput("installed", String(report.installed));
  // A factory that is simply not installed is not a failure to report: the
  // skill calls this to find out which mode it is in.
  return broken > 0 ? 1 : 0;
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
    if (r.continued !== null) writeFileSync(`${out}.continued.md`, r.continued);
    process.stdout.write(r.problems.length === 0 ? "rendered the setup PR\n" : `rendered the setup PR; missing: ${r.problems.join("; ")}\n`);
    return 0;
  }
  if (second === "check") {
    // `bsf report check --pr N --problems FILE`
    const pr = Number(args["pr"]);
    const file = typeof args["problems"] === "string" ? args["problems"] : "";
    if (!Number.isInteger(pr) || pr <= 0 || file === "") die("usage: bsf report check --pr N --problems FILE");
    const { reportCheck } = await import("./commands/pr-report.js");
    await reportCheck(gh, pr, JSON.parse(readFileSync(file, "utf8")) as string[]);
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

async function gardenScanCommand(args: Args): Promise<number> {
  const out = requireOut(args, "usage: bsf garden-scan --out PATH");
  const r = await gardenScan({
    gh: new GitHub({ repo: requireRepo() }),
    now: nowIso(),
    root: process.cwd(),
    baselines: await loadBaselines(new DiskLoader(process.cwd())),
    out,
  });
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
  });
  process.stdout.write(`${r.openRules} existing rule(s), ${r.candidates} candidate(s) -> ${r.wrote}\n`);
  return 0;
}

async function reviewCollectCommand(args: Args): Promise<number> {
  const out = requireOut(args, "usage: bsf review-collect --out PATH");
  const r = await reviewCollect({ gh: new GitHub({ repo: requireRepo() }), now: nowIso(), out });
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
    const summary = `The sandbox manifest on the default branch is invalid, so the tests cannot be run:\n${test.errors.join("\n")}`;
    process.stdout.write(`${summary}\n`);
    await maybeReportCheck(args, "failure", "Sandbox manifest invalid", summary, "factory/gate-tests");
    setOutput("tests_source", "invalid_manifest");
    return 1;
  }
  if (test.kind === "no_manifest" && existingCheck === null) {
    // The setup PR is the one that brings the first manifest: the default
    // branch has none to run its tests with, and setup's own trial already
    // ran them on the runner with exactly this manifest. Not judged here.
    const { MANIFEST_PATH } = await import("./commands/sandbox.js");
    if (existsSync(join(process.env["GITHUB_WORKSPACE"] ?? process.cwd(), MANIFEST_PATH))) {
      const why =
        "This change brings the first sandbox manifest, so the default branch has none to run the tests with. " +
        "Setup's trial ran them on a runner with exactly this manifest; its measured tier is in the PR.";
      process.stdout.write(`${why}\n`);
      await maybeReportCheck(args, "neutral", "Not judged: this PR brings the sandbox", why, "factory/gate-tests");
      setOutput("tests_source", "setup_trial");
      return 0;
    }
    const summary =
      "The factory does not know how to run this repo's tests: there is no .factory/sandbox/manifest.json, " +
      "which setup writes once it has run them. Finish setup, or set existing_ci.test_check in factory.yaml.";
    process.stdout.write(`${summary}\n`);
    await maybeReportCheck(args, "failure", "Tests could not run", summary, "factory/gate-tests");
    setOutput("tests_source", "unknown");
    return 1;
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

  const all = [...report.corrections, ...fromRepo.asCorrections];
  if (all.length === 0) {
    setOutput("mined", "0");
    // Not a failure: setup continues with the rule packs alone.
    return 0;
  }

  const clusters = clusterCorrections(all);
  const mined = candidatesFrom(clusters, nowIso());

  const mergeInto = typeof args["merge-into"] === "string" ? args["merge-into"] : undefined;
  let doc: CandidatesFile = { schema: "candidates/1", candidates: mined };
  let added = mined.length;

  if (mergeInto !== undefined) {
    // Update mode. The existing list holds decisions — accepted, rejected,
    // installed — and re-mining must not undo any of them, or re-offer
    // something the user has already turned down.
    const existing: CandidatesFile = existsSync(mergeInto)
      ? (JSON.parse(readFileSync(mergeInto, "utf8")) as CandidatesFile)
      : { schema: "candidates/1", candidates: [] };
    const merge = mergeContribution(existing, mined, null);
    doc = merge.merged;
    added = merge.added.length;
    process.stdout.write(
      `${merge.added.length} new, ${merge.folded.length} already pending (counts raised), ` +
        `${merge.skipped.length} already decided and not re-offered\n`,
    );
    for (const c of merge.added.slice(0, 10)) {
      process.stdout.write(`  ${c.occurrences}x  ${c.problem_class.slice(0, 90)}\n`);
    }
  } else {
    for (const c of clusters.slice(0, 10)) {
      process.stdout.write(`  ${c.occurrences}x  ${c.theme.slice(0, 90)}\n`);
    }
  }

  assertValid("candidates", doc);

  const out =
    typeof args["out"] === "string"
      ? args["out"]
      : (mergeInto ?? ".factory/guardrails/candidates.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`${doc.candidates.length} candidate(s) in ${out}\n`);
  setOutput("mined", String(added));
  return 0;
}


async function scoreCommand(args: Args): Promise<number> {
  const runsPath = args["runs"];
  const out = args["out"];
  if (typeof runsPath !== "string" || typeof out !== "string") {
    die("usage: bsf score --runs PATH --out PATH [--repeat N]");
  }
  const runs = JSON.parse(readFileSync(runsPath, "utf8")) as Parameters<typeof runScorers>[0]["runs"];
  const rubrics = loadRubrics(".factory/definition/rubrics");
  if (rubrics.length === 0) die("no rubrics in .factory/definition/rubrics");

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

async function benchmarkCommand(second: string | undefined, args: Args): Promise<number> {
  if (second === "build") {
    const runsPath = args["runs"];
    if (typeof runsPath !== "string") die("usage: bsf benchmark build --runs PATH [--out DIR]");
    const dir = typeof args["out"] === "string" ? args["out"] : ".factory/benchmarks";
    const runs = JSON.parse(readFileSync(runsPath, "utf8")) as Parameters<typeof buildTasks>[0]["runs"];
    const existing = readTasks(dir);
    const { tasks, skipped } = buildTasks({ runs, now: nowIso(), existing });

    mkdirSync(dir, { recursive: true });
    for (const t of tasks) {
      assertValid("benchmark-task", t);
      writeFileSync(join(dir, `${t.id}.json`), `${JSON.stringify(t, null, 2)}\n`);
    }
    const byOrigin = new Map<string, number>();
    for (const t of [...existing, ...tasks]) byOrigin.set(t.origin, (byOrigin.get(t.origin) ?? 0) + 1);
    process.stdout.write(
      `${tasks.length} new task(s), ${existing.length + tasks.length} in all: ` +
        `${[...byOrigin].map(([o, n]) => `${n} ${o}`).join(", ")}\n`,
    );
    for (const s of skipped) process.stdout.write(`  skipped ${s.run}: ${s.why}\n`);
    return 0;
  }

  if (second === "run") {
    const dir = typeof args["tasks"] === "string" ? args["tasks"] : ".factory/benchmarks";
    const before = args["before"];
    const after = args["after"];
    if (typeof before !== "string" || typeof after !== "string") {
      die("usage: bsf benchmark run --before PATH --after PATH [--tasks DIR] [--repeats N]");
    }
    const tasks = readTasks(dir);
    if (tasks.length === 0) die(`no benchmark tasks in ${dir}`);

    const repeats = typeof args["repeats"] === "string" ? Number(args["repeats"]) : 3;
    const config = buildBenchmarkConfig({
      tasks,
      provider: `file://${join(process.cwd(), "provider/pipeline.cjs")}`,
      definitions: [
        { label: "before", path: before },
        { label: "after", path: after },
      ],
      graderProvider: process.env["FACTORY_GRADER_PROVIDER"] ?? "anthropic:messages:claude-haiku-5-5",
      repeats: Number.isInteger(repeats) && repeats > 0 ? repeats : 3,
    });

    const result = await runBenchmark({ config, workDir: ".factory/work/benchmark" });
    if (!result.ran) {
      process.stderr.write(`${result.note}\n`);
      return 1;
    }
    const sides = readBenchmark(JSON.parse(readFileSync(result.outputPath, "utf8")), tasks);
    const beforeRuns = sides.get("before") ?? [];
    const afterRuns = sides.get("after") ?? [];
    const verdict = admit(beforeRuns, afterRuns, repeats);

    process.stdout.write(`${verdict.admit ? "admissible" : "not admissible"}\n`);
    for (const r of verdict.reasons) process.stdout.write(`  ${r}\n`);

    // Persisted so the Improvement page can plot cost against quality without
    // re-running anything. Each side is one configuration tried.
    const doc = {
      schema: "benchmark-result/1" as const,
      id: benchmarkResultId(),
      at: nowIso(),
      repeats,
      task_count: tasks.length,
      sides: [
        sideSummary("before", beforeRuns, repeats, {
          ...(modelsOf(before) === null ? {} : { models: modelsOf(before) as Record<string, string> }),
          current: true,
        }),
        sideSummary("after", afterRuns, repeats, {
          ...(modelsOf(after) === null ? {} : { models: modelsOf(after) as Record<string, string> }),
        }),
      ],
      admitted: verdict.admit,
      reasons: [...verdict.reasons],
      regressed: [...verdict.regressed],
      ...(typeof args["pr"] === "string" && Number.isInteger(Number(args["pr"]))
        ? { pr: Number(args["pr"]) }
        : {}),
    };
    assertValid("benchmark-result", doc);

    const resultOut =
      typeof args["result-out"] === "string"
        ? args["result-out"]
        : join(".factory/work/benchmark", `${doc.id}.json`);
    mkdirSync(dirname(resultOut), { recursive: true });
    writeFileSync(resultOut, `${JSON.stringify(doc, null, 2)}\n`);
    process.stdout.write(`result -> ${resultOut}\n`);

    if (typeof args["repo"] === "string") {
      // On a real run the comparison happens in CI, so the result has to
      // reach the data ref for the dashboard to ever see it.
      const store = new FactoryStore(new GitHub({ repo: args["repo"] }));
      await store.put(
        [{ path: benchmarkResultPath(doc.id), content: json(doc) }],
        `benchmark: ${doc.admitted ? "admissible" : "not admissible"} over ${tasks.length} task(s)`,
      );
      process.stdout.write(`stored at ${benchmarkResultPath(doc.id)}\n`);
    }

    setOutput("admit", String(verdict.admit));
    setOutput("benchmark_result", doc.id);
    return verdict.admit ? 0 : 1;
  }

  die("usage: bsf benchmark build|run");
}

/**
 * The model per role a definition file names, for labelling a point on the
 * cost-vs-quality chart. Null when the file cannot be read: a point with no
 * models is still a point, and guessing them would mislabel the chart.
 */
function modelsOf(definitionPath: string): Readonly<Record<string, string>> | null {
  try {
    const doc = parseYaml(readFileSync(definitionPath, "utf8")) as { models?: unknown };
    const models = doc.models;
    if (typeof models !== "object" || models === null) return null;
    const out: Record<string, string> = {};
    for (const [role, model] of Object.entries(models)) {
      if (typeof model === "string") out[role] = model;
    }
    return Object.keys(out).length === 0 ? null : out;
  } catch {
    return null;
  }
}

async function benchmarkRunCommand(args: Args): Promise<number> {
  const taskJson = args["task"];
  const definition = args["definition"];
  if (typeof taskJson !== "string" || typeof definition !== "string") {
    die("usage: bsf benchmark-run --task JSON --definition PATH");
  }
  const report = await runBenchmarkTask({
    task: JSON.parse(taskJson) as BenchmarkTaskInput,
    definitionPath: definition,
    worktree: process.cwd(),
    testCommand: sandboxCommandText("test"),
  });
  // One line of JSON on stdout: the provider reads the last JSON object, so
  // progress may be printed to stderr without confusing it.
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return 0;
}

function readTasks(dir: string): readonly BenchmarkTask[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as BenchmarkTask)
    .filter((t) => t.schema === "benchmark-task/1");
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`bsf: ${(err as Error).message ?? String(err)}\n`);
    process.exit(2);
  });

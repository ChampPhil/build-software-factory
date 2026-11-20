#!/usr/bin/env node
import { GitHub } from "./lib/github.js";
import {
  DiskLoader, RefLoader, loadPolicy, loadBaselines, loadCoverage, changedFilesSince,
} from "./lib/config.js";
import { runStaticGate, runCoverageGate, recordGateResult, alreadyChecked } from "./commands/gates-run.js";
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
import { checkConsistency } from "./commands/consistency.js";
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
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
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

  bsf gates record --gate static|verification --result pass|fail|skipped
      Record a gate's result against the head commit, so the same commit is
      never checked twice.

  bsf intake [--event-name NAME] [--event PATH] [--plan]
      Normalize every unprocessed event into work items and dispatch runs.
      Appends the incoming event to the data ref before deciding anything, so
      a dropped run costs a delay rather than a request.

  bsf run plan --pipeline P [--attempt N] [--revision]
      Which roles run for this attempt, and why. factory-run reads this.

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
      Find open factory PRs that became conflicting; dispatch resolution runs.

  bsf review due
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

  bsf fetch-work-item ID --out PATH [--spec-only] [--with-triage]
      Write what a role may see into a file. Untrusted text is stripped here,
      not in the prompt.

  bsf write-spec ID --from PATH
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
  if (args["version"] === true || first === "version") {
    process.stdout.write(`bsf ${VERSION}\n`);
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
      return runCommand(second, args);

    case "rollup":
      return rollupCommand(args);

    case "budget":
      if (second !== "check") die("usage: bsf budget check");
      return budgetCommand();

    case "merge-queue":
      return mergeCommand(args);

    case "garden":
      return gardenCommand(args);

    case "conflicts":
      if (second !== "scan") die("usage: bsf conflicts scan");
      return conflictsCommand(args);

    case "review":
      return reviewCommand(second, args);

    case "sync-settings":
      return syncCommand(args);

    case "audit":
      return auditCommand(args);

    case "consistency":
      return consistencyCommand(args);

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

    case "fetch-artifact":
      return fetchArtifactCommand(command[1], args);

    case "store-media":
      return storeMediaCommand(args);

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
      const commit = typeof args["commit"] === "string" ? args["commit"] : process.env["GITHUB_SHA"] ?? "";
      if (commit === "") die("no commit: pass --commit SHA or run inside Actions");
      const actor = args["actor"] === "human" ? "human" : "agent";
      const labels = typeof args["labels"] === "string" ? args["labels"].split(",") : [];
      const policy = await loadPolicy(new DiskLoader()).catch(() => null);
      const verifyLabel =
        typeof args["verify-label"] === "string" ? args["verify-label"] : "factory:verify";

      // Results are keyed by commit on disk, so a commit already checked
      // re-runs nothing. Without reading them here, every push would re-run
      // both gates and the once-per-commit rule would only exist in tests.
      const checked = alreadyChecked(process.cwd(), commit);
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
      setOutput("agent_verification", String(plan.agentVerification));
      setOutput("commit", commit);
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

function headSha(): string {
  return process.env["GITHUB_SHA"] ?? process.env["GITHUB_HEAD_SHA"] ?? "HEAD";
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
  });

  process.stdout.write(`${result.summary}\n`);
  await maybeReportCheck(
    args,
    result.conclusion,
    result.conclusion === "success" ? "No new violations" : "Static rules failed",
    result.summary,
    "factory/gate-static",
  );
  setOutput("conclusion", result.conclusion);
  return result.conclusion === "failure" ? 1 : 0;
}

async function gatesCoverage(args: Args): Promise<number> {
  const root = process.cwd();
  const base = baseRef(args);
  const result = await runCoverageGate({
    root,
    current: await loadCoverage(new DiskLoader(root)),
    changedFiles: changedFilesSince(base),
  });

  process.stdout.write(`${result.summary}\n`);
  await maybeReportCheck(
    args,
    result.conclusion,
    result.conclusion === "success" ? "Coverage held" : "Coverage failed",
    result.summary,
    "factory/gate-coverage",
  );
  setOutput("diff_pct", String(result.diff_pct ?? ""));
  setOutput("total_pct", String(result.total_pct ?? ""));
  return result.conclusion === "failure" ? 1 : 0;
}

function gatesRecord(args: Args): number {
  const gate = args["gate"];
  const resultArg = args["result"];
  if (gate !== "static" && gate !== "verification") {
    die("usage: bsf gates record --gate static|verification --result pass|fail|skipped");
  }
  if (resultArg !== "pass" && resultArg !== "fail" && resultArg !== "skipped") {
    die("--result must be pass, fail or skipped");
  }
  const attempt = typeof args["attempt"] === "string" ? Number(args["attempt"]) : 1;
  recordGateResult(process.cwd(), {
    commit: headSha(),
    gate,
    attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
    result: resultArg,
    recorded_at: new Date().toISOString(),
  });
  process.stdout.write(`recorded ${gate}=${resultArg} for ${headSha()}\n`);
  return 0;
}

/* ------------------------------------------------------------- new commands */

/** factory.yaml, read from the checkout, with the defaults the commands need. */
interface FactoryConfig {
  concurrency?: { max_runs?: number };
  budget?: {
    monthly_usd?: number;
    monthly_actions_minutes?: number | null;
    shares?: Record<string, number>;
    product_hard_stop_pct?: number;
  };
  data?: { window_days?: number; media_retention_months?: number };
  gardening?: { max_prs_per_night?: number };
  review?: { every_days?: number; early_at_runs?: number; min_runs?: number };
  pipelines?: Record<string, { auto_merge?: boolean }>;
  merge?: { native_queue?: boolean; method?: "merge" | "squash" | "rebase" };
  triggers?: Record<string, boolean>;
  runner?: { pin?: string };
  harness?: string;
  sandbox?: { agent_runtime?: string };
  checks?: { required?: string[] };
  branch?: string;
  existing_ci?: { test_check?: string | null };
  tests?: { command?: string | null };
}

async function factoryConfig(): Promise<FactoryConfig> {
  const doc = await loadFactory(new DiskLoader(process.cwd()));
  return doc ?? {};
}

function nowIso(): string {
  return new Date().toISOString();
}

/** How many runs are in flight, from the live refs' files. */
async function runningRuns(gh: GitHub): Promise<number> {
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
    productHardStopPct: cfg.budget?.product_hard_stop_pct ?? 110,
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
    maxRuns: cfg.concurrency?.max_runs ?? 5,
    runningRuns: await runningRuns(gh),
    pausedPipelines: pausedPipelines(await budgetState(cfg, gh)),
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

async function runCommand(second: string | undefined, args: Args): Promise<number> {
  if (second === "plan") {
    const pipeline = args["pipeline"];
    if (typeof pipeline !== "string") die("usage: bsf run plan --pipeline P [--attempt N]");
    const attempt = typeof args["attempt"] === "string" ? Number(args["attempt"]) : 1;
    const plan = planRun({
      pipeline: pipeline as Parameters<typeof planRun>[0]["pipeline"],
      attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
      ...(args["revision"] === true ? { revision: true } : {}),
    });
    process.stdout.write(`${plan.reason}\nroles: ${plan.roles.join(" -> ") || "(none)"}\n`);
    setOutput("roles", plan.roles.join(","));
    setOutput("escalate", String(plan.escalate));
    setOutput("attempt", String(plan.attempt));
    return plan.escalate ? 1 : 0;
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

  die("usage: bsf run plan|after-gates");
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
    windowDays: cfg.data?.window_days ?? 30,
    maxRuns: cfg.concurrency?.max_runs ?? 5,
    runnerPin: cfg.runner?.pin ?? "unpinned",
    harness: cfg.harness ?? "claude-code",
    budget: await budgetState(cfg, gh),
    guardrails: {
      rules: ruleCount,
      baselined,
      coverage_floor_pct: coverage.floor_pct,
      candidates_pending: 0,
    },
    health: {
      gardening_schedule_active: true,
      last_review: null,
      lock_files_current: true,
      sandbox_profile: cfg.sandbox?.agent_runtime ?? "docker",
      enforcement: "deterministic",
    },
    ...(args["plan"] === true ? { plan: true } : {}),
  });

  process.stdout.write(
    `${report.metrics.runs} run(s) in the last ${report.metrics.window_days} days; ` +
      `${report.metrics.merged} merged; $${report.metrics.spend_usd.toFixed(2)} spent\n` +
      `${report.dispatchReason}\n`,
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

async function budgetCommand(): Promise<number> {
  const cfg = await factoryConfig();
  const gh = new GitHub({ repo: requireRepo() });
  const state = await budgetState(cfg, gh);
  const paused = pausedPipelines(state);
  if (paused.length === 0) {
    process.stdout.write("every pipeline is within its share\n");
  } else {
    process.stdout.write(`paused: ${paused.join(", ")}\n`);
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
    nativeQueue: cfg.merge?.native_queue === true,
    autoMerge,
    appLogins: appLogins(),
    ...(cfg.merge?.method === undefined ? {} : { mergeMethod: cfg.merge.method }),
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
  const max = typeof args["max"] === "string" ? Number(args["max"]) : cfg.gardening?.max_prs_per_night ?? 5;
  const state = await budgetState(cfg, gh);
  if (pausedPipelines(state).includes("gardening")) {
    process.stdout.write("gardening is over its budget share; nothing filed tonight\n");
    return 0;
  }
  const running = await runningRuns(gh);
  const report = await runGardenCommand({
    gh,
    now: nowIso(),
    root: process.cwd(),
    baselines: await loadBaselines(new DiskLoader(process.cwd())),
    maxPrs: Number.isInteger(max) && max > 0 ? max : 5,
    freeSlots: Math.max(0, (cfg.concurrency?.max_runs ?? 5) - running),
    ...(args["plan"] === true ? { plan: true } : {}),
  });
  process.stdout.write(
    `found ${report.scan.items.length} drift item(s); filed ${report.filed.length}; dispatched ${report.dispatched.length}\n`,
  );
  for (const s of report.scan.skipped) process.stdout.write(`  skipped ${s.problem_class}: ${s.reason}\n`);
  return 0;
}

async function conflictsCommand(args: Args): Promise<number> {
  const gh = new GitHub({ repo: requireRepo() });
  const report = await runConflictsCommand({
    gh,
    now: nowIso(),
    ...(args["no-dispatch"] === true ? { dispatch: false } : {}),
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
    const r = await runReviewDue({
      gh,
      now: nowIso(),
      ...(cfg.review?.every_days === undefined ? {} : { everyDays: cfg.review.every_days }),
      ...(cfg.review?.early_at_runs === undefined ? {} : { earlyAtRuns: cfg.review.early_at_runs }),
      ...(cfg.review?.min_runs === undefined ? {} : { minRuns: cfg.review.min_runs }),
    });
    process.stdout.write(`${r.due ? "due" : "not due"}: ${r.reason}\n`);
    setOutput("due", String(r.due));
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
  const cfg = await factoryConfig();
  const gh = new GitHub({ repo: requireRepo() });
  const branch = typeof args["branch"] === "string" ? args["branch"] : cfg.branch ?? (await gh.defaultBranch());
  const report = await runSyncCommand({
    gh,
    branch,
    requiredChecks: cfg.checks?.required ?? ["factory/policy", "factory/gates"],
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

async function consistencyCommand(args: Args): Promise<number> {
  const root = typeof args["root"] === "string" ? args["root"] : process.cwd();

  // The files git knows about, so node_modules and build output are out
  // without a list of directories to ignore going stale.
  const tracked = await trackedFiles(root);
  const files = tracked.filter((f) =>
    /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|rs|cs|java|ya?ml)$/.test(f),
  );

  const findings = checkConsistency({ root, files });

  if (args["json"] === true) {
    process.stdout.write(`${JSON.stringify({ files: files.length, findings }, null, 2)}\n`);
  } else if (findings.length === 0) {
    process.stdout.write(`nothing inconsistent across ${files.length} file(s)\n`);
  } else {
    for (const f of findings) {
      process.stdout.write(`${f.check}\n  ${f.detail}\n  between ${f.between[0]} and ${f.between[1]}\n`);
    }
    process.stdout.write(`\n${findings.length} inconsistency(ies)\n`);
  }

  setOutput("inconsistencies", String(findings.length));
  // Reported, not failed: every one of these needs a person to say which of
  // the two artifacts is the one that is wrong.
  return 0;
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
  });
  process.stdout.write(
    `${r.id} -> ${r.wrote}${r.specOnly ? " (spec only)" : ""}` +
      `${r.strippedBody && !r.specOnly ? "; the author is not trusted, so their text was withheld" : ""}` +
      `${r.includedTriage ? "; with triage's notes" : ""}\n`,
  );
  return 0;
}

async function writeSpecCommand(id: string | undefined, args: Args): Promise<number> {
  const from = args["from"];
  if (id === undefined || typeof from !== "string") die("usage: bsf write-spec ID --from PATH");
  const r = await writeSpec(new GitHub({ repo: requireRepo() }), id, from, nowIso());
  process.stdout.write(
    `spec stored on ${r.id}` +
      `${r.declaredTestEdits.length > 0 ? `; declares ${r.declaredTestEdits.length} test edit(s)` : ""}\n`,
  );
  setOutput("declared_test_edits", r.declaredTestEdits.join(","));
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
  const max = typeof args["max"] === "string" ? Number(args["max"]) : cfg.gardening?.max_prs_per_night ?? 5;
  const running = await runningRuns(gh);
  const r = await gardenFile({
    gh,
    now: nowIso(),
    root: process.cwd(),
    from,
    maxPrs: Number.isInteger(max) && max > 0 ? max : 5,
    freeSlots: Math.max(0, (cfg.concurrency?.max_runs ?? 5) - running),
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
  const result = await runTestsGate({
    gh,
    commit: headSha(),
    existingCheck: cfg.existing_ci?.test_check ?? null,
    command: cfg.tests?.command ?? null,
    root: process.cwd(),
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

  const grader = process.env["FACTORY_GRADER_PROVIDER"] ?? "anthropic:messages:claude-opus-5";
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
      graderProvider: process.env["FACTORY_GRADER_PROVIDER"] ?? "anthropic:messages:claude-opus-5",
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
  // Annotated rather than cast: the catch branch has to widen to the config
  // type, and `eslint --fix` removes a cast in this position as redundant.
  const cfg: FactoryConfig = await factoryConfig().catch(() => ({}));
  const report = await runBenchmarkTask({
    task: JSON.parse(taskJson) as BenchmarkTaskInput,
    definitionPath: definition,
    worktree: process.cwd(),
    testCommand: cfg.tests?.command ?? null,
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

#!/usr/bin/env node
import { createRequire } from "node:module";
import { GitHub } from "./lib/github.js";
import {
  DiskLoader, RefLoader, loadPolicy, loadBaselines, loadCoverage, changedFilesSince,
} from "./lib/config.js";
import { runStaticGate, runCoverageGate, recordGateResult, alreadyChecked } from "./commands/gates-run.js";
import { runPolicyCommand } from "./commands/policy-run.js";
import { planGates } from "./commands/gates.js";
import { SCHEMA_NAMES, assertValid, type SchemaName } from "./lib/schema.js";
import { runIntakeCommand } from "./commands/intake-run.js";
import { runRollupCommand, squashMedia } from "./commands/rollup-run.js";
import { runMergeCommand } from "./commands/merge-run.js";
import { runGardenCommand } from "./commands/garden.js";
import { runConflictsCommand } from "./commands/conflicts.js";
import { runSyncCommand } from "./commands/sync-settings.js";
import { runAuditCommand } from "./commands/audit.js";
import { runReviewDue, runReviewRoute, type ScoredFailure } from "./commands/review.js";
import { planRun, afterGates } from "./commands/run-plan.js";
import { buildStepReport, writeStepReport, changedFilesFromGit, type Harness } from "./commands/step-report.js";
import { pausedPipelines, type BudgetState } from "./commands/rollup.js";
import { loadFactory } from "./lib/config.js";
import { readFileSync, appendFileSync } from "node:fs";

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

  bsf step-report --role R --out PATH [--usage PATH] [--exit ok|failed]
      Write one role's step report. Says the cost is unknown rather than
      estimating one the budget would then pause on.

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
      const doc: unknown = file.endsWith(".json") ? JSON.parse(text) : parseYamlLazy(text);
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

    case "step-report":
      return stepReportCommand(args);

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
      if (second !== "plan") die("usage: bsf gates plan|static|coverage|record");
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
}

async function factoryConfig(): Promise<FactoryConfig> {
  const doc = await loadFactory(new DiskLoader(process.cwd()));
  return (doc ?? {}) as FactoryConfig;
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
  const baselined = Object.values(baselines.rules ?? {}).reduce(
    (a, perFile) => a + Object.values(perFile).reduce((x, y) => x + y, 0),
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
  const report = await runAuditCommand({ gh, commit, root: process.cwd() });
  for (const c of report.checked) process.stdout.write(`checked: ${c}\n`);
  if (report.findings.length === 0) {
    process.stdout.write(`${commit.slice(0, 8)} passed every gate it should have\n`);
    return 0;
  }
  for (const f of report.findings) process.stderr.write(`${f.kind}: ${f.detail}\n`);
  setOutput("findings", String(report.findings.length));
  return 1;
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
  });
  writeStepReport(out, report);
  process.stdout.write(
    `${role}: ${report.exit}, ${report.tokens.in}+${report.tokens.out} tokens, ` +
      `$${report.cost_usd.toFixed(4)} (${report.cost_source})\n`,
  );
  return 0;
}

function parseYamlLazy(text: string): unknown {
  // This file is ESM, so there is no bare `require`. The yaml package is
  // CommonJS, and it is only needed for the yaml paths, so it is required
  // through createRequire rather than imported at the top.
  const require_ = createRequire(import.meta.url);
  const { parse } = require_("yaml") as typeof import("yaml");
  return parse(text);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`bsf: ${(err as Error).message ?? String(err)}\n`);
    process.exit(2);
  });

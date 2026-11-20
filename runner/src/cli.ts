#!/usr/bin/env node
import { GitHub } from "./lib/github.js";
import {
  DiskLoader, RefLoader, loadPolicy, loadBaselines, loadCoverage, changedFilesSince,
} from "./lib/config.js";
import { runStaticGate, runCoverageGate, recordGateResult, alreadyChecked } from "./commands/gates-run.js";
import { runPolicyCommand } from "./commands/policy-run.js";
import { planGates } from "./commands/gates.js";
import { SCHEMA_NAMES, assertValid, type SchemaName } from "./lib/schema.js";
import { readFileSync } from "node:fs";

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
  const { appendFileSync } = require("node:fs") as typeof import("node:fs");
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

function parseYamlLazy(text: string): unknown {
  const { parse } = require("yaml") as typeof import("yaml");
  return parse(text);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`bsf: ${(err as Error).message ?? String(err)}\n`);
    process.exit(2);
  });

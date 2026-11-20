import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runTestsGate } from "./tests-gate.js";
import { planRun } from "./run-plan.js";
import type { Pipeline } from "../lib/types.js";

const exec = promisify(execFile);

/**
 * `bsf benchmark-run` — run one pipeline on one frozen task, in a worktree.
 *
 * Called by the promptfoo provider, once per task per side of a comparison.
 * It is the only place the factory runs a pipeline outside GitHub Actions, and
 * it exists because a benchmark has to run the same roles with a different
 * definition — which Actions cannot do without merging that definition first.
 *
 * Its contract with the provider is one line of JSON on stdout. Everything
 * else it prints is progress, because a benchmark that prints nothing for
 * twenty minutes is one nobody will wait for.
 */

export interface BenchmarkTaskInput {
  readonly id: string;
  readonly pipeline: string;
  readonly base_commit: string;
  readonly request: { readonly title: string; readonly body?: string | null };
  readonly must_pass: readonly string[];
}

export interface BenchmarkReport {
  readonly summary: string;
  readonly must_pass_ok: boolean;
  readonly must_pass: readonly { readonly check: string; readonly passed: boolean | null }[];
  readonly changed: readonly string[];
  readonly cost_usd?: number;
  readonly tokens?: { readonly total: number; readonly in: number; readonly out: number };
  /** Why the run could not happen, when it could not. */
  readonly unavailable?: string;
}

export interface BenchmarkRunOptions {
  readonly task: BenchmarkTaskInput;
  readonly definitionPath: string;
  readonly worktree: string;
  /** The harness command, e.g. `claude`. */
  readonly harnessCommand?: string;
  readonly harnessArgs?: readonly string[];
  readonly testCommand?: string | null;
  readonly timeoutMs?: number;
  readonly runHarness?: (prompt: string, cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export async function runBenchmarkTask(opts: BenchmarkRunOptions): Promise<BenchmarkReport> {
  const definition = readDefinition(opts.definitionPath);
  if (definition === null) {
    return unavailable(`the definition at ${opts.definitionPath} could not be read`, opts.task);
  }

  const plan = planRun({ pipeline: opts.task.pipeline as Pipeline, attempt: 1 });
  if (plan.roles.length === 0) {
    return unavailable(`no role sequence for the ${opts.task.pipeline} pipeline`, opts.task);
  }

  const harness = opts.runHarness ?? defaultHarness(opts);
  if (harness === null) {
    // The one thing this must never do is report a pass it did not observe.
    // A benchmark side that silently scores zero-cost successes would make
    // every definition change look harmless.
    return unavailable(
      "no harness is available here: set FACTORY_HARNESS_COMMAND, or run the benchmark where " +
        "the agent CLI is installed. Reporting unavailable rather than a pass.",
      opts.task,
    );
  }

  const prompt = buildPrompt(opts.task, definition, plan.roles);
  process.stderr.write(`running ${plan.roles.join(" -> ")} on ${opts.task.id}\n`);

  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await harness(prompt, opts.worktree);
  } catch (err) {
    return unavailable(`the harness failed to start: ${String(err).slice(0, 300)}`, opts.task);
  }

  const changed = await changedFiles(opts.worktree);

  // must_pass is checked, not asked about: the tests gate runs the repo's own
  // tests, and anything it cannot decide stays null rather than becoming true.
  const tests = await runTestsGate({
    gh: { repo: "benchmark/local" } as never,
    commit: opts.task.base_commit,
    existingCheck: null,
    command: opts.testCommand ?? null,
    root: opts.worktree,
  });

  const checks = opts.task.must_pass.map((check) => ({
    check,
    // A check the tests cover is decided by them; one phrased as a behaviour
    // nobody can run here is unknown, and unknown is not passed.
    passed: tests.source === "ran_tests" ? tests.conclusion === "success" : null,
  }));

  const decided = checks.filter((c) => c.passed !== null);
  const allPassed = decided.length > 0 && decided.every((c) => c.passed === true);

  return {
    summary:
      `${plan.roles.join(" -> ")} with ${definition.label}: exit ${result.code}, ` +
      `${changed.length} file(s) changed, tests ${tests.conclusion} (${tests.source}).\n` +
      `${result.stdout.slice(-2000)}`,
    must_pass_ok: allPassed && result.code === 0,
    must_pass: checks,
    changed,
  };
}

function unavailable(why: string, task: BenchmarkTaskInput): BenchmarkReport {
  return {
    summary: `could not run ${task.id}: ${why}`,
    must_pass_ok: false,
    must_pass: task.must_pass.map((check) => ({ check, passed: null })),
    changed: [],
    unavailable: why,
  };
}

interface Definition {
  readonly label: string;
  readonly context: string;
}

/** The definition under test: its context files, as text. */
function readDefinition(path: string): Definition | null {
  if (!existsSync(path)) return null;
  const parts: string[] = [];
  for (const name of ["fundamentals.md", "feature-map.md", "runbook.md", "history.md"]) {
    const full = join(path, "context", name);
    if (existsSync(full)) parts.push(`## ${name}\n\n${readFileSync(full, "utf8")}`);
  }
  if (parts.length === 0) {
    // A directory with no context is still a definition — the point of a
    // benchmark may be to test removing a context file.
    return { label: path, context: "(this definition supplies no context)" };
  }
  return { label: path, context: parts.join("\n\n") };
}

function buildPrompt(
  task: BenchmarkTaskInput,
  definition: Definition,
  roles: readonly string[],
): string {
  return [
    `You are running the ${task.pipeline} pipeline's ${roles.join(", then ")} roles on one task.`,
    "",
    "## The request",
    task.request.title,
    task.request.body ?? "",
    "",
    "## What this has to achieve",
    task.must_pass.map((c) => `- ${c}`).join("\n"),
    "",
    "## The context this definition supplies",
    definition.context,
    "",
    "Work in this checkout. Change the code and its tests. Do not commit.",
  ].join("\n");
}

function defaultHarness(
  opts: BenchmarkRunOptions,
): ((prompt: string, cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>) | null {
  const command = opts.harnessCommand ?? process.env["FACTORY_HARNESS_COMMAND"];
  if (command === undefined || command === "") return null;

  const args = opts.harnessArgs ?? (process.env["FACTORY_HARNESS_ARGS"] ?? "").split(" ").filter((a) => a !== "");
  const timeout = opts.timeoutMs ?? 20 * 60 * 1000;

  return async (prompt: string, cwd: string) => {
    try {
      const { stdout, stderr } = await exec(command, args, {
        cwd,
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        // The prompt goes on stdin, so nothing in it is shell-interpreted.
        input: prompt,
      } as never);
      return { code: 0, stdout: String(stdout), stderr: String(stderr) };
    } catch (err) {
      const e = err as { code?: unknown; stdout?: string; stderr?: string };
      return {
        code: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
  };
}

async function changedFiles(cwd: string): Promise<readonly string[]> {
  try {
    const { stdout } = await exec("git", ["status", "--porcelain=v1"], { cwd });
    return String(stdout)
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter((l) => l !== "")
      .map((l) => (l.includes(" -> ") ? l.split(" -> ")[1]! : l));
  } catch {
    return [];
  }
}

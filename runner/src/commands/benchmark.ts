import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { benchmarkTaskId } from "../lib/ids.js";
import { admitDefinitionChange, type BenchmarkComparison, type AdmissionResult } from "./review.js";
import { promptfooEnv, resolvePromptfoo } from "./score.js";

/**
 * Benchmarks: frozen tasks built from the factory's own merged work, and the
 * before-and-after comparison that gates a definition change (doc 06).
 *
 * The set builds up on its own from every merged run, and deliberately
 * includes the failures: runs a human corrected or finished, with the
 * human-fixed merge as the known-good result. A benchmark made only of
 * successes cannot show that a change fixes anything.
 */

export type TaskOrigin = "succeeded" | "corrected" | "escalated" | "representative";

export interface BenchmarkTask {
  readonly schema: "benchmark-task/1";
  readonly id: string;
  readonly source_run: string;
  readonly origin: TaskOrigin;
  readonly pipeline: string;
  /** The commit the task starts from: the merge's first parent. */
  readonly base_commit: string;
  readonly created_at?: string;
  readonly request: { readonly title: string; readonly body?: string | null };
  readonly reference: { readonly merged_commit: string; readonly tests?: readonly string[] };
  readonly grading: { readonly must_pass: readonly string[]; readonly rubric: string };
  readonly tags?: readonly string[];
}

export interface MergedRun {
  readonly run: string;
  readonly pipeline: string;
  readonly work_item: string;
  readonly title: string;
  readonly body?: string | null;
  readonly merged_commit: string;
  readonly base_commit: string;
  readonly escalated: boolean;
  readonly human_corrections: readonly string[];
  /** Tests the merge added or changed; the task's must-pass set. */
  readonly tests: readonly string[];
  readonly acceptance_checks: readonly string[];
  readonly representative?: boolean;
}

/**
 * Which runs become tasks, and what each one's origin says about it.
 *
 * The origin is not a label for the record: it is what makes the set useful.
 * A definition change has to show it improves the `corrected` and `escalated`
 * tasks — the factory's own failures — without regressing the rest, and that
 * comparison is impossible if the set cannot tell them apart.
 */
export function originOf(run: MergedRun): TaskOrigin {
  if (run.representative === true) return "representative";
  if (run.escalated) return "escalated";
  if (run.human_corrections.length > 0) return "corrected";
  return "succeeded";
}

export interface BuildTasksOptions {
  readonly runs: readonly MergedRun[];
  readonly now: string;
  readonly existing?: readonly BenchmarkTask[];
}

export function buildTasks(opts: BuildTasksOptions): {
  tasks: readonly BenchmarkTask[];
  skipped: readonly { readonly run: string; readonly why: string }[];
} {
  const already = new Set((opts.existing ?? []).map((t) => t.source_run));
  const tasks: BenchmarkTask[] = [];
  const skipped: { run: string; why: string }[] = [];

  for (const [i, run] of opts.runs.entries()) {
    if (already.has(run.run)) {
      skipped.push({ run: run.run, why: "already a benchmark task" });
      continue;
    }
    // Without a base commit there is nothing to start the task from, and
    // without acceptance checks there is nothing to grade it against.
    if (!/^[0-9a-f]{40}$/.test(run.base_commit) || !/^[0-9a-f]{40}$/.test(run.merged_commit)) {
      skipped.push({ run: run.run, why: "no base or merged commit recorded" });
      continue;
    }
    const mustPass = [...run.tests, ...run.acceptance_checks].filter((s) => s.trim() !== "");
    if (mustPass.length === 0) {
      skipped.push({
        run: run.run,
        why: "nothing to grade against: the merge added no test and the spec listed no acceptance check",
      });
      continue;
    }

    const origin = originOf(run);
    tasks.push({
      schema: "benchmark-task/1",
      id: benchmarkTaskId((Date.parse(opts.now) || Date.now()) + i),
      source_run: run.run,
      origin,
      pipeline: run.pipeline,
      base_commit: run.base_commit,
      created_at: opts.now,
      request: { title: run.title, ...(run.body === undefined ? {} : { body: run.body }) },
      reference: { merged_commit: run.merged_commit, ...(run.tests.length === 0 ? {} : { tests: [...run.tests] }) },
      grading: {
        must_pass: mustPass,
        rubric: rubricFor(run, origin),
      },
      tags: [origin, run.pipeline],
    });
  }
  return { tasks, skipped };
}

/** What a run of this task has to achieve, in words a grader can judge. */
function rubricFor(run: MergedRun, origin: TaskOrigin): string {
  const base =
    `Did the run satisfy the request, with changes of a shape this codebase would accept, ` +
    `and with evidence that the acceptance checks pass?`;
  if (origin === "corrected" || origin === "escalated") {
    return (
      `${base}\n\nThis task is one the factory previously got wrong: ` +
      `${run.human_corrections.join("; ") || "it was escalated to a human"}. ` +
      `Judge in particular whether that specific problem is absent this time. ` +
      `A run that is good in general but repeats that problem has not passed.`
    );
  }
  return base;
}

/* ------------------------------------------------------------- the comparison */

export interface BenchmarkRunResult {
  readonly task: string;
  readonly origin: TaskOrigin;
  /** 1-5, as the scorers use. */
  readonly score: number;
  readonly cost_usd: number;
  readonly passed_must_pass: boolean;
}

/**
 * Turn before-and-after results into the comparison the admission rule reads.
 *
 * The split is the whole point: the failure tasks are the ones the change is
 * meant to fix, and everything else is what it must not break. Measuring one
 * average over both hides exactly the trade a bad change makes.
 */
export function compare(
  before: readonly BenchmarkRunResult[],
  after: readonly BenchmarkRunResult[],
  repeats: number,
): BenchmarkComparison {
  const isFailureTask = (r: BenchmarkRunResult): boolean =>
    r.origin === "corrected" || r.origin === "escalated";

  const sum = (xs: readonly BenchmarkRunResult[]): number =>
    xs.reduce((a, r) => a + r.cost_usd, 0);

  const tasks = new Set([...before, ...after].map((r) => r.task));

  return {
    failureTaskScores: {
      before: before.filter(isFailureTask).map((r) => r.score),
      after: after.filter(isFailureTask).map((r) => r.score),
    },
    otherTaskScores: {
      before: before.filter((r) => !isFailureTask(r)).map((r) => r.score),
      after: after.filter((r) => !isFailureTask(r)).map((r) => r.score),
    },
    costBefore: sum(before),
    costAfter: sum(after),
    taskCount: tasks.size,
    repeats,
  };
}

/**
 * A must-pass check that regressed is a veto, whatever the scores say.
 *
 * The rubric score is a judgement; a must-pass check is a fact. A change that
 * raises every score while breaking a check the reference merge passed has
 * broken something real.
 */
export function regressedChecks(
  before: readonly BenchmarkRunResult[],
  after: readonly BenchmarkRunResult[],
): readonly string[] {
  const afterByTask = new Map(after.map((r) => [r.task, r]));
  return before
    .filter((b) => b.passed_must_pass && afterByTask.get(b.task)?.passed_must_pass === false)
    .map((b) => b.task);
}

export interface AdmissionReport extends AdmissionResult {
  readonly comparison: BenchmarkComparison;
  readonly regressed: readonly string[];
}

export function admit(
  before: readonly BenchmarkRunResult[],
  after: readonly BenchmarkRunResult[],
  repeats: number,
): AdmissionReport {
  const comparison = compare(before, after, repeats);
  const regressed = regressedChecks(before, after);
  const base = admitDefinitionChange(comparison);
  if (regressed.length === 0) return { ...base, comparison, regressed };
  return {
    admit: false,
    reasons: [
      ...base.reasons,
      `${regressed.length} task(s) stopped passing a check the reference merge passed: ${regressed.join(", ")}`,
    ],
    comparison,
    regressed,
  };
}

/* --------------------------------------------------------- the promptfoo config */

export interface BenchmarkConfigOptions {
  readonly tasks: readonly BenchmarkTask[];
  readonly provider: string;
  /** The definition under test: `before` is the current one. */
  readonly definitions: readonly { readonly label: string; readonly path: string }[];
  readonly graderProvider: string;
  readonly repeats: number;
}

/**
 * Both definitions as two providers over the same tests, which is how
 * promptfoo runs a side-by-side comparison — and why the tasks have to be
 * frozen: the two sides are only comparable if they start from the same
 * commit and the same request.
 */
export function buildBenchmarkConfig(opts: BenchmarkConfigOptions): unknown {
  return {
    description: "factory benchmarks",
    providers: opts.definitions.map((d) => ({
      id: opts.provider,
      label: d.label,
      // Also in config: promptfoo's `label` does not reliably reach a
      // file:// provider's constructor, and the label is the only thing that
      // tells the two sides of the comparison apart.
      config: { definition: d.path, label: d.label },
    })),
    prompts: ["{{task}}"],
    defaultTest: { options: { provider: opts.graderProvider } },
    evaluateOptions: { repeat: opts.repeats },
    tests: opts.tasks.map((t) => ({
      description: `${t.id} (${t.origin}/${t.pipeline})`,
      vars: {
        task: JSON.stringify({
          id: t.id,
          pipeline: t.pipeline,
          base_commit: t.base_commit,
          request: t.request,
          must_pass: t.grading.must_pass,
        }),
        origin: t.origin,
      },
      assert: [
        { type: "llm-rubric", value: `${t.grading.rubric}\n\nAnswer on a 1-5 scale.`, metric: "task_quality" },
        // Deterministic and so not a judgement: the provider reports which
        // must-pass checks it saw pass.
        { type: "javascript", value: "JSON.parse(output).must_pass_ok === true", metric: "must_pass" },
      ],
    })),
  };
}

export async function runBenchmark(opts: {
  readonly config: unknown;
  readonly workDir: string;
  readonly promptfoo?: (args: readonly string[], cwd: string) => Promise<void>;
}): Promise<{ outputPath: string; ran: boolean; note: string }> {
  mkdirSync(opts.workDir, { recursive: true });
  const configPath = join(opts.workDir, "benchmark.yaml");
  const outPath = join(opts.workDir, "benchmark.json");
  writeFileSync(configPath, JSON.stringify(opts.config, null, 2));

  const run =
    opts.promptfoo ??
    (async (args: readonly string[], cwd: string): Promise<void> => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      const [bin, prefix] = resolvePromptfoo();
      try {
        await exec(bin, [...prefix, ...args], {
          cwd,
          maxBuffer: 256 * 1024 * 1024,
          env: promptfooEnv(cwd),
        });
      } catch (err) {
        // As with the scorers: a failing assertion is a result, not an error.
        if (typeof (err as { code?: unknown }).code === "number") return;
        throw err;
      }
    });

  await run(["eval", "-c", configPath, "-o", outPath, "--no-cache"], opts.workDir);

  if (!existsSync(outPath)) {
    return { outputPath: outPath, ran: false, note: "promptfoo produced no benchmark output" };
  }
  return { outputPath: outPath, ran: true, note: "benchmark complete" };
}

/** Read promptfoo's benchmark output into per-side results. */
export function readBenchmark(
  output: unknown,
  tasks: readonly BenchmarkTask[],
): ReadonlyMap<string, readonly BenchmarkRunResult[]> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const doc = output as {
    results?: {
      results?: readonly {
        provider?: { label?: string; id?: string };
        vars?: Record<string, unknown>;
        namedScores?: Record<string, number>;
        response?: { tokenUsage?: { total?: number }; cost?: number };
        gradingResult?: {
          componentResults?: readonly {
            score?: number;
            pass?: boolean;
            assertion?: { metric?: string };
          }[];
        };
      }[];
    };
  };

  const sides = new Map<string, BenchmarkRunResult[]>();
  for (const r of doc.results?.results ?? []) {
    const side = r.provider?.label ?? r.provider?.id ?? "unknown";
    const taskJson = r.vars?.["task"];
    let taskId = "";
    if (typeof taskJson === "string") {
      try {
        taskId = (JSON.parse(taskJson) as { id?: string }).id ?? "";
      } catch {
        /* fall through */
      }
    }
    const task = byId.get(taskId);
    if (task === undefined) continue;

    const components = r.gradingResult?.componentResults ?? [];
    const quality = components.find((c) => c.assertion?.metric === "task_quality")?.score;
    const mustPass = components.find((c) => c.assertion?.metric === "must_pass")?.pass;

    const list = sides.get(side) ?? [];
    list.push({
      task: task.id,
      origin: task.origin,
      score: Math.min(5, Math.max(1, Math.round((quality ?? 0) * 5))),
      cost_usd: typeof r.response?.cost === "number" ? r.response.cost : 0,
      passed_must_pass: mustPass === true,
    });
    sides.set(side, list);
  }
  return sides;
}

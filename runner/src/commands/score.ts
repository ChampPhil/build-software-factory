import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import type { ScoredFailure } from "./review.js";

const exec = promisify(execFile);

/**
 * The scorers, run on promptfoo's LLM-rubric graders (doc 06).
 *
 * promptfoo does the parts that are hard to do well: calling a grading model,
 * repeating runs, caching, and reporting a score per named metric. What is
 * here is the translation either way — rubrics into a promptfoo config, and
 * promptfoo's results back into the failures the review routes on.
 *
 * The scores are 1–5 in the rubrics and 0–1 in promptfoo, so the mapping is
 * explicit in both directions rather than left to whoever reads the output.
 */

export interface Rubric {
  readonly schema: string;
  readonly pipeline?: string;
  readonly shared?: boolean;
  readonly criteria: readonly { readonly id: string; readonly question: string }[];
  readonly scale: string;
  readonly failure_tags: readonly string[];
}

/** 1–5 as promptfoo's 0–1, and back. A 1 is 0.2, not 0. */
export const toFraction = (score: number): number => Math.min(1, Math.max(0, score / 5));
export const toScale = (fraction: number): number =>
  Math.min(5, Math.max(1, Math.round(fraction * 5)));

/** A run's evidence, as the grader sees it. */
export interface RunEvidence {
  readonly run: string;
  readonly pipeline: string;
  readonly work_item: string;
  readonly outcome: string;
  readonly escalated: boolean;
  /** What the work item asked for. */
  readonly request: string;
  /** The spec's plan and acceptance checks. */
  readonly spec: string;
  /** The diff's shape: files and line counts, not the diff itself. */
  readonly changed: readonly string[];
  /** What the verifier reported, including its artifacts. */
  readonly verification: string;
  /** Whether a human changed anything after the fact. */
  readonly human_corrections: readonly string[];
}

export interface ScoreConfigOptions {
  readonly rubrics: readonly Rubric[];
  readonly runs: readonly RunEvidence[];
  readonly graderProvider: string;
  /** Repeats per test; the review's own noise check (doc 06). */
  readonly repeat?: number;
}

/**
 * Build the promptfoo config.
 *
 * One test per run, with one assertion per rubric criterion, each carrying the
 * criterion's id as its `metric` — which is what makes promptfoo report a
 * score per criterion in `namedScores` rather than one verdict per run.
 *
 * The provider is `echo`: the thing being graded already exists, so there is
 * nothing to generate. promptfoo's job here is only to grade.
 */
export function buildScoreConfig(opts: ScoreConfigOptions): unknown {
  const shared = opts.rubrics.filter((r) => r.shared === true);
  const byPipeline = new Map(
    opts.rubrics.filter((r) => r.pipeline !== undefined).map((r) => [r.pipeline as string, r]),
  );

  const tests = opts.runs.map((run) => {
    const rubrics = [...shared, ...(byPipeline.get(run.pipeline) === undefined ? [] : [byPipeline.get(run.pipeline)!])];
    return {
      description: `${run.run} (${run.pipeline})`,
      vars: {
        evidence: evidenceText(run),
        run: run.run,
        pipeline: run.pipeline,
      },
      assert: rubrics.flatMap((rubric) =>
        rubric.criteria.map((c) => ({
          type: "llm-rubric",
          // The question, plus how to answer it on this scale. Without the
          // scale the grader returns its own idea of a score and the 1-5 in
          // the rubrics means nothing.
          value:
            `${c.question}\n\n` +
            `Answer on a 1-5 scale, where 1 is a clear failure and 5 is exemplary. ` +
            `Judge only what the evidence shows; absent evidence is not a pass.`,
          metric: c.id,
        })),
      ),
    };
  });

  return {
    description: "factory scorers",
    // Echo: the work is done, so there is nothing to generate — only grade.
    providers: [{ id: "echo" }],
    prompts: ["{{evidence}}"],
    defaultTest: { options: { provider: opts.graderProvider } },
    tests,
    ...(opts.repeat === undefined ? {} : { evaluateOptions: { repeat: opts.repeat } }),
  };
}

/** The evidence, as text, in a fixed order so grades are comparable. */
export function evidenceText(run: RunEvidence): string {
  const lines = [
    `Pipeline: ${run.pipeline}`,
    `Outcome: ${run.outcome}${run.escalated ? " (escalated to a human)" : ""}`,
    "",
    "## What was asked",
    run.request.trim() === "" ? "(nothing recorded)" : run.request,
    "",
    "## The spec it worked from",
    run.spec.trim() === "" ? "(no spec: this pipeline has none)" : run.spec,
    "",
    "## What changed",
    run.changed.length === 0 ? "(no files changed)" : run.changed.map((f) => `- ${f}`).join("\n"),
    "",
    "## What verification reported",
    run.verification.trim() === "" ? "(verification did not report)" : run.verification,
  ];
  if (run.human_corrections.length > 0) {
    lines.push(
      "",
      "## What a human changed afterwards",
      // The strongest evidence there is: whatever a human had to fix is
      // exactly what the run got wrong.
      ...run.human_corrections.map((c) => `- ${c}`),
    );
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------ reading back */

interface PromptfooResult {
  readonly results?: {
    readonly results?: readonly {
      readonly description?: string;
      readonly vars?: Record<string, unknown>;
      readonly namedScores?: Record<string, number>;
      readonly gradingResult?: {
        readonly componentResults?: readonly {
          readonly pass?: boolean;
          readonly score?: number;
          readonly reason?: string;
          readonly assertion?: { readonly metric?: string };
        }[];
      };
      readonly error?: string;
    }[];
  };
}

export interface ScoreRow {
  readonly run: string;
  readonly criterion: string;
  readonly score: number;
  readonly reason: string;
}

/**
 * Read promptfoo's output into one row per run per criterion.
 *
 * Repeats are averaged, because the review's question is whether a run was
 * good, not what one grading pass happened to say. The spread is kept so a
 * criterion the grader cannot decide consistently is visible rather than
 * averaged into a confident-looking number.
 */
export function readScores(output: unknown): {
  rows: readonly ScoreRow[];
  spread: ReadonlyMap<string, number>;
  errors: readonly string[];
} {
  const doc = output as PromptfooResult;
  const samples = new Map<string, { scores: number[]; reasons: string[] }>();
  const errors: string[] = [];

  for (const r of doc.results?.results ?? []) {
    const components = r.gradingResult?.componentResults ?? [];

    // `error` is set on any row whose assertions failed, carrying the first
    // failure's reason — and the row still holds every component score. So a
    // row is only a real error when it graded nothing at all. Skipping on
    // `error` alone would discard exactly the low scores a scorer exists to
    // find, and the review would conclude that nothing ever goes wrong.
    if (components.length === 0) {
      if (r.error !== undefined && r.error !== "") errors.push(r.error);
      continue;
    }

    const run = typeof r.vars?.["run"] === "string" ? (r.vars["run"]) : (r.description ?? "unknown");
    for (const comp of components) {
      const metric = comp.assertion?.metric;
      if (metric === undefined) continue;
      const key = `${run}\u0000${metric}`;
      const entry = samples.get(key) ?? { scores: [], reasons: [] };
      entry.scores.push(typeof comp.score === "number" ? comp.score : 0);
      if (comp.reason !== undefined && comp.reason !== "") entry.reasons.push(comp.reason);
      samples.set(key, entry);
    }
  }

  const rows: ScoreRow[] = [];
  const spread = new Map<string, number>();
  for (const [key, entry] of samples) {
    const [run, criterion] = key.split("\u0000") as [string, string];
    const mean = entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length;
    rows.push({
      run,
      criterion,
      score: toScale(mean),
      reason: entry.reasons[0] ?? "",
    });
    if (entry.scores.length > 1) {
      spread.set(key, Math.max(...entry.scores) - Math.min(...entry.scores));
    }
  }
  return { rows, spread, errors };
}

/**
 * The rows that are failures: a 1 or a 2, an escalation, or a human
 * correction (doc 06). A 3 is mediocre, not a problem to file.
 */
export function failuresFrom(
  rows: readonly ScoreRow[],
  runs: readonly RunEvidence[],
  rubrics: readonly Rubric[],
): readonly ScoredFailure[] {
  const byRun = new Map(runs.map((r) => [r.run, r]));
  const tagFor = (criterion: string): string => {
    for (const r of rubrics) {
      if (r.criteria.some((c) => c.id === criterion)) {
        // The criterion's own id is the tag the review routes on, when the
        // rubric lists it; otherwise the criterion id itself.
        return r.failure_tags.includes(criterion) ? criterion : criterion;
      }
    }
    return criterion;
  };

  const out: ScoredFailure[] = [];
  for (const row of rows) {
    if (row.score > 2) continue;
    const run = byRun.get(row.run);
    out.push({
      run: row.run,
      role: "",
      area: areaOf(run),
      tag: tagFor(row.criterion),
      score: row.score,
      kind: "low_score",
      ...(row.reason === "" ? {} : { detail: row.reason }),
    });
  }

  // Escalations and human corrections are failures whatever the scores said.
  for (const run of runs) {
    if (run.escalated) {
      out.push({ run: run.run, role: "", area: areaOf(run), tag: "escalation", kind: "escalation" });
    }
    for (const c of run.human_corrections) {
      out.push({
        run: run.run, role: "", area: areaOf(run), tag: "human_correction",
        kind: "human_correction", detail: c,
      });
    }
  }
  return out;
}

/** The feature folder most of a run's changes sat in, for grouping. */
function areaOf(run: RunEvidence | undefined): string {
  if (run === undefined || run.changed.length === 0) return "";
  const counts = new Map<string, number>();
  for (const f of run.changed) {
    const dir = f.split("/").slice(0, 2).join("/");
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}


/**
 * How to invoke promptfoo here.
 *
 * In CI it is a dev dependency, so `node_modules/.bin/promptfoo` is the usual
 * answer and a bare `promptfoo` is not on PATH at all. A globally installed
 * one is next, and `npx` last because it may try to fetch. Resolved rather
 * than assumed, because the failure mode of assuming is an empty result that
 * looks like "nothing scored badly".
 */
export function resolvePromptfoo(from = process.cwd()): [string, readonly string[]] {
  const local = [
    join(from, "node_modules/.bin/promptfoo"),
    join(from, "../node_modules/.bin/promptfoo"),
    join(from, "../../node_modules/.bin/promptfoo"),
  ].find((p) => existsSync(p));
  if (local !== undefined) return [local, []];

  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (dir !== "" && existsSync(join(dir, "promptfoo"))) return [join(dir, "promptfoo"), []];
  }
  return ["npx", ["--yes", "promptfoo"]];
}


/**
 * promptfoo's environment for a scorer run.
 *
 * Its config directory is put inside the run's own work directory for two
 * reasons. A CI runner should not accumulate state in a shared `~/.promptfoo`
 * between jobs, and a review's grades should not depend on what some earlier
 * eval left in a database — a scorer run wants to be hermetic.
 *
 * It also happens to be what promptfoo asks for when it detects a test
 * runner: it refuses to open its default database and names
 * PROMPTFOO_CONFIG_DIR as the way out, so the same setting makes this
 * testable and makes production clean.
 */
export function promptfooEnv(workDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PROMPTFOO_CONFIG_DIR: join(workDir, ".promptfoo"),
    // Nothing here should phone home about a user's repository.
    PROMPTFOO_DISABLE_TELEMETRY: "1",
    PROMPTFOO_DISABLE_UPDATE: "1",
  };
}

/* ----------------------------------------------------------------- running */

export interface RunScorersOptions extends ScoreConfigOptions {
  readonly workDir: string;
  readonly promptfoo?: (args: readonly string[], cwd: string) => Promise<void>;
}

export interface ScorersReport {
  readonly rows: readonly ScoreRow[];
  readonly failures: readonly ScoredFailure[];
  readonly unreliable: readonly string[];
  readonly errors: readonly string[];
  readonly configPath: string;
}

/** A criterion whose repeats disagree by this much is not a usable grade. */
export const UNRELIABLE_SPREAD = 0.4;

export async function runScorers(opts: RunScorersOptions): Promise<ScorersReport> {
  mkdirSync(opts.workDir, { recursive: true });
  const configPath = join(opts.workDir, "scorers.yaml");
  const outPath = join(opts.workDir, "scores.json");

  const config = buildScoreConfig(opts);
  writeFileSync(configPath, toYaml(config));
  let lastOutput = "";

  const run =
    opts.promptfoo ??
    (async (args: readonly string[], cwd: string): Promise<void> => {
      const [bin, prefix] = resolvePromptfoo();
      try {
        await exec(bin, [...prefix, ...args], {
          cwd,
          maxBuffer: 256 * 1024 * 1024,
          env: promptfooEnv(cwd),
        });
      } catch (err) {
        // promptfoo exits non-zero when assertions fail, and for a scorer that
        // is the normal case: a run graded 1 is the finding, not an error. The
        // output file is the result either way, so a non-zero exit is ignored
        // here and a missing file is what counts as failure.
        const e = err as { code?: unknown; stderr?: string; stdout?: string };
        if (typeof e.code === "number") {
          // Keep what it said, so a config error is diagnosable rather than
          // arriving as "promptfoo wrote no output".
          lastOutput = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
          return;
        }
        throw err;
      }
    });

  await run(
    [
      "eval",
      "-c",
      configPath,
      "-o",
      outPath,
      // Caching would return a previous run's grade for the same evidence,
      // which is right for repeats and wrong for a review that is meant to
      // re-grade; the review runs rarely enough that the cost is small.
      "--no-cache",
      ...(opts.repeat === undefined ? [] : ["--repeat", String(opts.repeat)]),
    ],
    opts.workDir,
  );

  if (!existsSync(outPath)) {
    return {
      rows: [],
      failures: [],
      unreliable: [],
      errors: [`promptfoo wrote no output${lastOutput === "" ? "" : `: ${lastOutput.slice(-1200)}`}`],
      configPath,
    };
  }
  const { rows, spread, errors } = readScores(JSON.parse(readFileSync(outPath, "utf8")));

  // A criterion the grader cannot decide consistently is reported rather than
  // routed: filing a problem on a coin flip wastes a hardening run.
  const unreliable = [...spread.entries()]
    .filter(([, s]) => s >= UNRELIABLE_SPREAD)
    .map(([key]) => key.replace("\u0000", " / "));
  const reliable = rows.filter(
    (r) => !unreliable.includes(`${r.run} / ${r.criterion}`),
  );

  return {
    rows,
    failures: failuresFrom(reliable, opts.runs, opts.rubrics),
    unreliable,
    errors,
    configPath,
  };
}

/** Load the rubrics from the definition. */
export function loadRubrics(dir: string): readonly Rubric[] {
  if (!existsSync(dir)) return [];
  const require_ = createRequire(import.meta.url);
  const { parse } = require_("yaml") as typeof import("yaml");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => parse(readFileSync(join(dir, f), "utf8")) as Rubric)
    .filter((r) => Array.isArray(r.criteria));
}

function toYaml(doc: unknown): string {
  const require_ = createRequire(import.meta.url);
  const { stringify } = require_("yaml") as typeof import("yaml");
  return stringify(doc);
}

export { dirname };

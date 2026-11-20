/**
 * The factory's promptfoo provider: runs one pipeline on one frozen task.
 *
 * promptfoo handles repeats, side-by-side configurations and grading. What it
 * cannot do is run a factory pipeline, so this is the seam: each test's `task`
 * var names a base commit and a request, and each provider instance names a
 * definition to run it with. Two providers over the same tests is the
 * before-and-after comparison.
 *
 * Deliberately a .cjs file with no dependencies: promptfoo loads it with
 * `require`, and a provider that needed a build step would be one more thing
 * to go stale between the runner and the definition under test.
 */

const { execFile } = require("node:child_process");
const { mkdtempSync, existsSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const run = (bin, args, opts) =>
  new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 1 << 26, ...opts }, (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });

class FactoryPipelineProvider {
  constructor(options) {
    const config = (options && options.config) || {};
    this.definitionPath = config.definition;
    this.repoPath = config.repo || process.env.FACTORY_BENCHMARK_REPO || process.cwd();
    this.runner = config.runner || process.env.FACTORY_RUNNER || "bsf";
    this.timeoutMs = Number(config.timeoutMs || process.env.FACTORY_BENCHMARK_TIMEOUT_MS || 20 * 60 * 1000);
    // promptfoo's own `label` does not reliably reach a file:// provider's
    // constructor, and the two sides of a comparison are only distinguishable
    // by it — without this both sides report under one name and the
    // before-and-after collapses into a single column. So the label is also
    // carried in config, where it always arrives.
    this.label = config.label || (options && options.label) || "factory";
    this.keepWorktree = config.keepWorktree === true;
  }

  id() {
    return `factory-pipeline:${this.label}`;
  }

  /**
   * promptfoo passes the rendered prompt, which is the task JSON.
   *
   * The result is JSON rather than prose because two different assertions read
   * it: the rubric grader reads the summary, and a deterministic check reads
   * `must_pass_ok`. A provider that returned prose would make the second one a
   * judgement too.
   */
  async callApi(prompt) {
    let task;
    try {
      task = JSON.parse(prompt);
    } catch {
      return { error: "the task var is not JSON; the benchmark config passes a JSON task" };
    }
    if (!task.base_commit || !task.request) {
      return { error: "the task needs a base_commit and a request" };
    }
    if (!this.definitionPath) {
      return { error: "no definition configured: each provider must name the definition it runs with" };
    }

    // A worktree, so two sides of a comparison can run from the same
    // repository without touching each other's checkout or the user's.
    const worktree = mkdtempSync(join(tmpdir(), "bsf-bench-"));
    const added = await run("git", ["worktree", "add", "--detach", worktree, task.base_commit], {
      cwd: this.repoPath,
    });
    if (added.code !== 0) {
      return { error: `could not check out ${String(task.base_commit).slice(0, 8)}: ${added.stderr.slice(-400)}` };
    }

    try {
      const started = Date.now();
      const result = await run(
        this.runner,
        [
          "benchmark-run",
          "--task",
          JSON.stringify(task),
          "--definition",
          this.definitionPath,
          "--json",
        ],
        { cwd: worktree, timeout: this.timeoutMs, env: { ...process.env, FACTORY_BENCHMARK: "1" } },
      );

      const elapsed = Date.now() - started;
      const report = parseReport(result.stdout);

      if (report === null) {
        return {
          // Never a zero-cost success: a run whose report cannot be read has
          // an unknown outcome, and the comparison must not read that as a
          // pass. Same rule as the step report's unknown cost.
          error:
            `the pipeline produced no readable report (exit ${result.code}). ` +
            `${result.stderr.slice(-400)}`,
        };
      }

      return {
        output: JSON.stringify({
          summary: report.summary || "",
          must_pass_ok: report.must_pass_ok === true,
          must_pass: report.must_pass || [],
          changed: report.changed || [],
          elapsed_ms: elapsed,
          exit: result.code,
        }),
        tokenUsage: report.tokens
          ? { total: report.tokens.total || 0, prompt: report.tokens.in || 0, completion: report.tokens.out || 0 }
          : undefined,
        cost: typeof report.cost_usd === "number" ? report.cost_usd : undefined,
      };
    } finally {
      if (!this.keepWorktree) {
        await run("git", ["worktree", "remove", "--force", worktree], { cwd: this.repoPath });
        try {
          if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
        } catch {
          /* the worktree remove already handled it */
        }
      }
    }
  }
}

/**
 * The report is the last JSON object on stdout.
 *
 * Taking the last one rather than the whole of stdout means progress output
 * before it does not have to be suppressed, which matters because that output
 * is what someone watching a benchmark run has to go on.
 */
function parseReport(stdout) {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* not the report; keep looking backwards */
    }
  }
  return null;
}

module.exports = FactoryPipelineProvider;
module.exports.parseReport = parseReport;

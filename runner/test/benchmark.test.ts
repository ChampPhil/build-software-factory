import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTasks, originOf, compare, regressedChecks, admit, buildBenchmarkConfig, readBenchmark,
  type MergedRun, type BenchmarkRunResult, type BenchmarkTask,
} from "../src/commands/benchmark.js";
import { runBenchmarkTask } from "../src/commands/benchmark-run.js";
import { assertValid } from "../src/lib/schema.js";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

const merged = (over: Partial<MergedRun> = {}): MergedRun => ({
  run: "run_01KAFC0S0041MD83K2M2YZG6RK",
  pipeline: "product_work",
  work_item: "wi_01KAFC0S0041MD83K2M2YZG6RK",
  title: "Export invoices as CSV",
  body: "the accountant needs it",
  merged_commit: SHA2,
  base_commit: SHA,
  escalated: false,
  human_corrections: [],
  tests: ["lib/invoices.test.ts"],
  acceptance_checks: ["downloads a CSV with one row per invoice"],
  ...over,
});

describe("originOf", () => {
  it("tells a clean run from one a human had to fix", () => {
    // The split is what makes the set useful: a definition change has to show
    // it improves the factory's own failures without regressing the rest.
    expect(originOf(merged())).toBe("succeeded");
    expect(originOf(merged({ human_corrections: ["fixed the rounding"] }))).toBe("corrected");
    expect(originOf(merged({ escalated: true }))).toBe("escalated");
    expect(originOf(merged({ representative: true }))).toBe("representative");
  });

  it("prefers the explicit mark over what the run did", () => {
    expect(originOf(merged({ representative: true, escalated: true }))).toBe("representative");
  });
});

describe("buildTasks", () => {
  it("produces tasks that validate against the schema", () => {
    const { tasks } = buildTasks({ runs: [merged()], now: "2026-11-20T00:00:00Z" });
    expect(tasks).toHaveLength(1);
    assertValid("benchmark-task", tasks[0]);
  });

  it("mints ids in the shape the schema pins", () => {
    const { tasks } = buildTasks({ runs: [merged()], now: "2026-11-20T00:00:00Z" });
    expect(tasks[0]?.id).toMatch(/^bt_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("gives distinct ids within one batch", () => {
    const { tasks } = buildTasks({
      runs: [merged(), merged({ run: "run_01KAFC0S0041MD83K2M2YZG6RM" })],
      now: "2026-11-20T00:00:00Z",
    });
    expect(new Set(tasks.map((t) => t.id)).size).toBe(2);
  });

  it("skips a run that is already a task", () => {
    const { tasks } = buildTasks({ runs: [merged()], now: "t" });
    const { tasks: again, skipped } = buildTasks({
      runs: [merged()], now: "t", existing: tasks,
    });
    expect(again).toHaveLength(0);
    expect(skipped[0]?.why).toContain("already");
  });

  it("skips a run with nothing to grade against", () => {
    // No test and no acceptance check means a task that cannot be judged, and
    // a task that cannot be judged scores whatever the grader feels like.
    const { tasks, skipped } = buildTasks({
      runs: [merged({ tests: [], acceptance_checks: [] })], now: "t",
    });
    expect(tasks).toHaveLength(0);
    expect(skipped[0]?.why).toContain("nothing to grade against");
  });

  it("skips a run with no base commit, since there is nothing to start from", () => {
    const { tasks } = buildTasks({ runs: [merged({ base_commit: "not-a-sha" })], now: "t" });
    expect(tasks).toHaveLength(0);
  });

  it("tells a corrected task's grader what went wrong last time", () => {
    const { tasks } = buildTasks({
      runs: [merged({ human_corrections: ["the total included tax"] })], now: "t",
    });
    expect(tasks[0]?.grading.rubric).toContain("the total included tax");
    expect(tasks[0]?.grading.rubric).toContain("has not passed");
  });

  it("does not add that to a clean task's rubric", () => {
    const { tasks } = buildTasks({ runs: [merged()], now: "t" });
    expect(tasks[0]?.grading.rubric).not.toContain("previously got wrong");
  });
});

describe("compare and admit", () => {
  const result = (over: Partial<BenchmarkRunResult> = {}): BenchmarkRunResult => ({
    task: "bt_01AAAAAAAAAAAAAAAAAAAAAAAA", origin: "corrected", score: 3,
    cost_usd: 0.1, passed_must_pass: true, ...over,
  });

  it("splits the failure tasks from everything else", () => {
    const c = compare(
      [result({ score: 2 }), result({ task: "bt_2", origin: "succeeded", score: 4 })],
      [result({ score: 4 }), result({ task: "bt_2", origin: "succeeded", score: 4 })],
      3,
    );
    expect(c.failureTaskScores.before).toEqual([2]);
    expect(c.failureTaskScores.after).toEqual([4]);
    expect(c.otherTaskScores.before).toEqual([4]);
  });

  it("counts escalated tasks as failure tasks too", () => {
    const c = compare([result({ origin: "escalated", score: 1 })], [result({ origin: "escalated", score: 3 })], 3);
    expect(c.failureTaskScores.before).toEqual([1]);
  });

  it("vetoes a change that broke a check the reference merge passed", () => {
    // The rubric score is a judgement; a must-pass check is a fact.
    const before = [result({ passed_must_pass: true, score: 2 })];
    const after = [result({ passed_must_pass: false, score: 5 })];
    const r = admit(before, after, 3);
    expect(r.admit).toBe(false);
    expect(r.reasons.join(" ")).toContain("stopped passing a check");
    expect(regressedChecks(before, after)).toHaveLength(1);
  });

  it("does not veto a check that was already failing", () => {
    const before = [result({ passed_must_pass: false })];
    const after = [result({ passed_must_pass: false })];
    expect(regressedChecks(before, after)).toHaveLength(0);
  });

  it("still refuses a one-task comparison, however good it looks", () => {
    // The guard that matters most: a 2 becoming a 4 on one task is noise.
    const r = admit([result({ score: 2 })], [result({ score: 4 })], 1);
    expect(r.admit).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/at least 10|at least 3/);
  });
});

describe("buildBenchmarkConfig", () => {
  const task: BenchmarkTask = {
    schema: "benchmark-task/1", id: "bt_01AAAAAAAAAAAAAAAAAAAAAAAA", source_run: "run_01A",
    origin: "corrected", pipeline: "product_work", base_commit: SHA,
    request: { title: "fix the total" }, reference: { merged_commit: SHA2 },
    grading: { must_pass: ["excludes tax"], rubric: "Is it fixed?" },
  };

  it("runs both definitions over the same tests, which is the comparison", () => {
    const c = buildBenchmarkConfig({
      tasks: [task], provider: "file://p.cjs",
      definitions: [{ label: "before", path: "/a" }, { label: "after", path: "/b" }],
      graderProvider: "file://g.cjs", repeats: 3,
    }) as { providers: { label: string; config: { label: string } }[]; evaluateOptions: { repeat: number } };
    expect(c.providers.map((p) => p.label)).toEqual(["before", "after"]);
    expect(c.evaluateOptions.repeat).toBe(3);
  });

  it("carries the label inside config as well as beside it", () => {
    // promptfoo's own `label` does not reliably reach a file:// provider's
    // constructor, and without it both sides report under one name — the
    // comparison collapses into a single column.
    const c = buildBenchmarkConfig({
      tasks: [task], provider: "file://p.cjs",
      definitions: [{ label: "before", path: "/a" }],
      graderProvider: "file://g.cjs", repeats: 1,
    }) as { providers: { config: { label: string } }[] };
    expect(c.providers[0]?.config.label).toBe("before");
  });

  it("grades a task two ways: a rubric and a deterministic check", () => {
    const c = buildBenchmarkConfig({
      tasks: [task], provider: "file://p.cjs",
      definitions: [{ label: "before", path: "/a" }],
      graderProvider: "file://g.cjs", repeats: 1,
    }) as { tests: { assert: { type: string; metric: string }[] }[] };
    const types = c.tests[0]!.assert.map((a) => `${a.type}:${a.metric}`);
    expect(types).toContain("llm-rubric:task_quality");
    expect(types).toContain("javascript:must_pass");
  });
});

describe("readBenchmark", () => {
  const task: BenchmarkTask = {
    schema: "benchmark-task/1", id: "bt_01AAAAAAAAAAAAAAAAAAAAAAAA", source_run: "run_01A",
    origin: "corrected", pipeline: "product_work", base_commit: SHA,
    request: { title: "x" }, reference: { merged_commit: SHA2 },
    grading: { must_pass: ["y"], rubric: "z" },
  };

  it("separates the two sides by their label", () => {
    const sides = readBenchmark(
      {
        results: {
          results: [
            {
              provider: { label: "before" },
              vars: { task: JSON.stringify({ id: task.id }) },
              gradingResult: {
                componentResults: [
                  { score: 0.4, assertion: { metric: "task_quality" } },
                  { pass: false, assertion: { metric: "must_pass" } },
                ],
              },
            },
            {
              provider: { label: "after" },
              vars: { task: JSON.stringify({ id: task.id }) },
              gradingResult: {
                componentResults: [
                  { score: 0.8, assertion: { metric: "task_quality" } },
                  { pass: true, assertion: { metric: "must_pass" } },
                ],
              },
            },
          ],
        },
      },
      [task],
    );
    expect(sides.get("before")?.[0]?.score).toBe(2);
    expect(sides.get("after")?.[0]?.score).toBe(4);
    expect(sides.get("after")?.[0]?.passed_must_pass).toBe(true);
  });

  it("ignores a result for a task it was not given", () => {
    const sides = readBenchmark(
      { results: { results: [{ provider: { label: "before" }, vars: { task: '{"id":"bt_other"}' } }] } },
      [task],
    );
    expect(sides.size).toBe(0);
  });
});

describe("runBenchmarkTask", () => {
  const task = {
    id: "bt_01AAAAAAAAAAAAAAAAAAAAAAAA", pipeline: "product_work", base_commit: SHA,
    request: { title: "fix the total" }, must_pass: ["the total excludes tax"],
  };

  it("reports unavailable rather than a pass when no harness is there", async () => {
    // A benchmark side that silently scored zero-cost successes would make
    // every definition change look harmless.
    const def = mkdtempSync(join(tmpdir(), "def-"));
    const r = await runBenchmarkTask({ task, definitionPath: def, worktree: def });
    expect(r.must_pass_ok).toBe(false);
    expect(r.unavailable).toContain("no harness");
    expect(r.must_pass[0]?.passed).toBeNull();
  });

  it("reports unavailable when the definition cannot be read", async () => {
    const r = await runBenchmarkTask({
      task, definitionPath: "/nonexistent/def", worktree: "/tmp",
      runHarness: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(r.unavailable).toContain("could not be read");
  });

  it("does not mark a check passed that nothing here could decide", async () => {
    const def = mkdtempSync(join(tmpdir(), "def-"));
    mkdirSync(join(def, "context"), { recursive: true });
    writeFileSync(join(def, "context/fundamentals.md"), "this codebase prefers small files");
    const r = await runBenchmarkTask({
      task, definitionPath: def, worktree: def, testCommand: null,
      runHarness: async () => ({ code: 0, stdout: "done", stderr: "" }),
    });
    // No test command, so the gate is neutral and the check is unknown.
    expect(r.must_pass[0]?.passed).toBeNull();
    expect(r.must_pass_ok).toBe(false);
  });

  it("passes only when the tests actually ran and passed", async () => {
    const def = mkdtempSync(join(tmpdir(), "def-"));
    mkdirSync(join(def, "context"), { recursive: true });
    writeFileSync(join(def, "context/fundamentals.md"), "x");
    const r = await runBenchmarkTask({
      task, definitionPath: def, worktree: def, testCommand: "node --version",
      runHarness: async () => ({ code: 0, stdout: "done", stderr: "" }),
    });
    expect(r.must_pass[0]?.passed).toBe(true);
    expect(r.must_pass_ok).toBe(true);
  });

  it("does not pass when the harness itself failed, whatever the tests say", async () => {
    const def = mkdtempSync(join(tmpdir(), "def-"));
    mkdirSync(join(def, "context"), { recursive: true });
    writeFileSync(join(def, "context/fundamentals.md"), "x");
    const r = await runBenchmarkTask({
      task, definitionPath: def, worktree: def, testCommand: "node --version",
      runHarness: async () => ({ code: 2, stdout: "", stderr: "crashed" }),
    });
    expect(r.must_pass_ok).toBe(false);
  });

  it("accepts a definition that supplies no context, which is a thing worth benchmarking", async () => {
    const def = mkdtempSync(join(tmpdir(), "def-"));
    const r = await runBenchmarkTask({
      task, definitionPath: def, worktree: def,
      runHarness: async () => ({ code: 0, stdout: "done", stderr: "" }),
    });
    expect(r.unavailable).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildScoreConfig, evidenceText, readScores, failuresFrom, runScorers, loadRubrics,
  toFraction, toScale, UNRELIABLE_SPREAD, type Rubric, type RunEvidence,
} from "../src/commands/score.js";

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "templates")) && existsSync(join(dir, "schema"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}

const RUBRIC_DIR = join(repoRoot(), "templates/definition/rubrics");

const run = (over: Partial<RunEvidence> = {}): RunEvidence => ({
  run: "run_01AAA", pipeline: "product_work", work_item: "wi_1", outcome: "merged",
  escalated: false, request: "Add a CSV export", spec: "plan: add a route",
  changed: ["lib/invoices.ts"], verification: "clicked export, a CSV downloaded",
  human_corrections: [], ...over,
});

describe("the 1-5 scale", () => {
  it("maps a 1 to a fifth, not to zero", () => {
    // A 1 is the worst grade on the scale, not the absence of a grade.
    expect(toFraction(1)).toBeCloseTo(0.2);
    expect(toScale(0.2)).toBe(1);
  });

  it("round-trips every point on the scale", () => {
    for (const n of [1, 2, 3, 4, 5]) expect(toScale(toFraction(n))).toBe(n);
  });

  it("never returns a score off the scale", () => {
    expect(toScale(0)).toBe(1);
    expect(toScale(1)).toBe(5);
    expect(toScale(99)).toBe(5);
  });
});

describe("loadRubrics", () => {
  it("loads the shipped rubrics", () => {
    const rubrics = loadRubrics(RUBRIC_DIR);
    expect(rubrics.length).toBe(4);
    expect(rubrics.filter((r) => r.shared === true)).toHaveLength(1);
    expect(rubrics.reduce((a, r) => a + r.criteria.length, 0)).toBeGreaterThan(15);
  });

  it("returns nothing for a directory that is not there", () => {
    expect(loadRubrics("/nonexistent")).toHaveLength(0);
  });
});

describe("buildScoreConfig", () => {
  const rubrics = loadRubrics(RUBRIC_DIR);

  it("gives a run the shared rubric plus its own pipeline's", () => {
    const config = buildScoreConfig({ rubrics, runs: [run()], graderProvider: "file://g.js" }) as {
      tests: { assert: { metric: string }[] }[];
    };
    const metrics = config.tests[0]!.assert.map((a) => a.metric);
    expect(metrics).toContain("meaningful_tests");     // shared
    expect(metrics).toContain("verification_was_real"); // product_work
    expect(metrics).not.toContain("behaviour_unchanged"); // gardening's
  });

  it("carries each criterion's id as the metric, which is what reports a score per criterion", () => {
    const config = buildScoreConfig({ rubrics, runs: [run()], graderProvider: "file://g.js" }) as {
      tests: { assert: { metric: string; type: string }[] }[];
    };
    for (const a of config.tests[0]!.assert) {
      expect(a.type).toBe("llm-rubric");
      expect(a.metric).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("tells the grader the scale, so the 1-5 in the rubrics means something", () => {
    const config = buildScoreConfig({ rubrics, runs: [run()], graderProvider: "file://g.js" }) as {
      tests: { assert: { value: string }[] }[];
    };
    expect(config.tests[0]!.assert[0]!.value).toContain("1-5");
    expect(config.tests[0]!.assert[0]!.value).toContain("absent evidence is not a pass");
  });

  it("generates nothing: the work exists, so promptfoo only grades", () => {
    const config = buildScoreConfig({ rubrics, runs: [run()], graderProvider: "file://g.js" }) as {
      providers: { id: string }[];
    };
    expect(config.providers[0]!.id).toBe("echo");
  });
});

describe("evidenceText", () => {
  it("says so plainly when something is missing, rather than leaving a blank", () => {
    const text = evidenceText(run({ verification: "", changed: [], spec: "" }));
    expect(text).toContain("verification did not report");
    expect(text).toContain("no files changed");
    expect(text).toContain("no spec");
  });

  it("includes what a human changed afterwards, which is the strongest evidence", () => {
    const text = evidenceText(run({ human_corrections: ["a human fixed the rounding"] }));
    expect(text).toContain("What a human changed afterwards");
    expect(text).toContain("fixed the rounding");
  });

  it("leaves that section out entirely when nobody corrected anything", () => {
    expect(evidenceText(run())).not.toContain("What a human changed");
  });
});

describe("readScores", () => {
  const row = (over: Record<string, unknown>): unknown => ({
    vars: { run: "run_01AAA" },
    gradingResult: {
      componentResults: [
        { pass: true, score: 0.8, reason: "fine", assertion: { metric: "meaningful_tests" } },
      ],
    },
    ...over,
  });

  it("keeps the scores of a row promptfoo marked as an error", () => {
    // This is the bug this test exists for. promptfoo sets `error` on any row
    // whose assertions failed, carrying the first failure's reason — and the
    // row still holds every component score. Skipping on `error` discarded
    // exactly the low scores a scorer exists to find, so the review would
    // have concluded that nothing ever goes wrong.
    const out = readScores({
      results: {
        results: [
          row({
            error: "the evidence shows no real verification",
            gradingResult: {
              componentResults: [
                { pass: false, score: 0.2, reason: "no verification", assertion: { metric: "meaningful_tests" } },
              ],
            },
          }),
        ],
      },
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.score).toBe(1);
    expect(out.errors).toHaveLength(0);
  });

  it("counts a row that graded nothing at all as a real error", () => {
    const out = readScores({
      results: { results: [{ error: "provider refused", gradingResult: { componentResults: [] } }] },
    });
    expect(out.rows).toHaveLength(0);
    expect(out.errors).toEqual(["provider refused"]);
  });

  it("averages repeats, because one grading pass is not the question", () => {
    const out = readScores({
      results: {
        results: [
          row({ gradingResult: { componentResults: [{ score: 0.2, assertion: { metric: "m" } }] } }),
          row({ gradingResult: { componentResults: [{ score: 1.0, assertion: { metric: "m" } }] } }),
        ],
      },
    });
    expect(out.rows[0]?.score).toBe(toScale(0.6));
  });

  it("keeps the spread, so a criterion the grader cannot decide is visible", () => {
    const out = readScores({
      results: {
        results: [
          row({ gradingResult: { componentResults: [{ score: 0.2, assertion: { metric: "m" } }] } }),
          row({ gradingResult: { componentResults: [{ score: 1.0, assertion: { metric: "m" } }] } }),
        ],
      },
    });
    expect([...out.spread.values()][0]).toBeCloseTo(0.8);
  });

  it("ignores a component with no metric, which belongs to no criterion", () => {
    const out = readScores({
      results: { results: [row({ gradingResult: { componentResults: [{ score: 0.5 }] } })] },
    });
    expect(out.rows).toHaveLength(0);
  });
});

describe("failuresFrom", () => {
  const rubrics = loadRubrics(RUBRIC_DIR);

  it("files a 1 and a 2 and leaves a 3 alone", () => {
    // A 3 is mediocre, not a problem worth a hardening run.
    const rows = [
      { run: "run_01AAA", criterion: "meaningful_tests", score: 1, reason: "weak" },
      { run: "run_01AAA", criterion: "minimal_change", score: 2, reason: "large" },
      { run: "run_01AAA", criterion: "honest_reporting", score: 3, reason: "ok" },
      { run: "run_01AAA", criterion: "followed_intent", score: 5, reason: "good" },
    ];
    const f = failuresFrom(rows, [run()], rubrics);
    expect(f.filter((x) => x.kind === "low_score").map((x) => x.tag).sort()).toEqual([
      "meaningful_tests", "minimal_change",
    ]);
  });

  it("files an escalation whatever the scores said", () => {
    const f = failuresFrom([], [run({ escalated: true })], rubrics);
    expect(f.some((x) => x.kind === "escalation")).toBe(true);
  });

  it("files every human correction", () => {
    const f = failuresFrom([], [run({ human_corrections: ["fixed rounding", "fixed the title"] })], rubrics);
    expect(f.filter((x) => x.kind === "human_correction")).toHaveLength(2);
  });

  it("attributes a failure to the area most of the run's changes sat in", () => {
    const f = failuresFrom(
      [{ run: "run_01AAA", criterion: "meaningful_tests", score: 1, reason: "" }],
      [run({ changed: ["app/checkout/page.tsx", "app/checkout/total.ts", "lib/util.ts"] })],
      rubrics,
    );
    expect(f[0]?.area).toBe("app/checkout");
  });
});

describe("runScorers, through promptfoo itself", () => {
  const stubGrader = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "grader-"));
    const p = join(dir, "grader.js");
    writeFileSync(
      p,
      `class StubGrader {
         id() { return "stub"; }
         async callApi(prompt) {
           const weak = /did not report|no files changed/.test(prompt);
           return { output: JSON.stringify({ pass: !weak, score: weak ? 0.2 : 0.8, reason: weak ? "no verification" : "fine" }) };
         }
       }
       module.exports = StubGrader;`,
    );
    return `file://${p}`;
  };

  it("grades real runs through real promptfoo and reports the low scores", async () => {
    // No model key here, so the grading model is stubbed — but promptfoo
    // itself, its config parsing, its llm-rubric assertions and its output
    // format are the real thing.
    const rubrics = loadRubrics(RUBRIC_DIR);
    const workDir = mkdtempSync(join(tmpdir(), "scorers-"));
    const report = await runScorers({
      rubrics,
      runs: [run(), run({ run: "run_01BBB", verification: "did not report", changed: [], escalated: true })],
      graderProvider: stubGrader(),
      workDir,
      repeat: 2,
    });

    expect(report.errors).toHaveLength(0);
    expect(report.rows.length).toBeGreaterThan(15);
    expect(report.rows.some((r) => r.score <= 2)).toBe(true);
    expect(report.failures.some((f) => f.kind === "low_score")).toBe(true);
    expect(report.failures.some((f) => f.kind === "escalation")).toBe(true);
    expect(existsSync(report.configPath)).toBe(true);
  }, 120_000);

  it("does not treat promptfoo's non-zero exit as a failure", async () => {
    // promptfoo exits non-zero whenever an assertion fails, which for a
    // scorer is the normal case.
    const rubrics = loadRubrics(RUBRIC_DIR);
    const workDir = mkdtempSync(join(tmpdir(), "scorers-"));
    const report = await runScorers({
      rubrics,
      runs: [run({ verification: "did not report", changed: [] })],
      graderProvider: stubGrader(),
      workDir,
    });
    expect(report.rows.length).toBeGreaterThan(0);
  }, 120_000);

  it("reports a criterion whose repeats disagree instead of routing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flaky-"));
    const p = join(dir, "grader.js");
    writeFileSync(
      p,
      `let n = 0;
       class Flaky {
         id() { return "flaky"; }
         async callApi() {
           n++;
           return { output: JSON.stringify({ pass: n % 2 === 0, score: n % 2 === 0 ? 1 : 0.2, reason: "coin flip" }) };
         }
       }
       module.exports = Flaky;`,
    );
    const rubrics: Rubric[] = [
      { schema: "rubric/1", shared: true, scale: "1-5", failure_tags: ["x"],
        criteria: [{ id: "coin_flip", question: "Is it good?" }] },
    ];
    const workDir = mkdtempSync(join(tmpdir(), "scorers-"));
    const report = await runScorers({
      rubrics, runs: [run()], graderProvider: `file://${p}`, workDir, repeat: 4,
    });
    // Filing a problem on a coin flip wastes a hardening run.
    expect(report.unreliable.length).toBeGreaterThan(0);
    expect(report.failures.filter((f) => f.kind === "low_score")).toHaveLength(0);
    expect(UNRELIABLE_SPREAD).toBeGreaterThan(0);
  }, 120_000);
});


import { describe, it, expect } from "vitest";
import { configPoints, verdictOf, scorerCards } from "../lib/metrics";
import type { BenchmarkResultFile, ReviewFile } from "../lib/types";

function result(over: Partial<BenchmarkResultFile> = {}): BenchmarkResultFile {
  return {
    schema: "benchmark-result/1",
    id: "bench_01JD000000000000000000000A",
    at: "2026-11-20T10:00:00Z",
    repeats: 3,
    task_count: 12,
    sides: [
      {
        label: "before",
        models: { builder: "claude-opus-5" },
        score_mean: 3.5,
        score_spread: 0.2,
        cost_usd: 12,
        cost_per_task: 1,
        must_pass_rate: 0.9,
        current: true,
      },
      {
        label: "after",
        models: { builder: "claude-sonnet-5-5" },
        score_mean: 4.2,
        score_spread: 0.2,
        cost_usd: 6,
        cost_per_task: 0.5,
        must_pass_rate: 0.9,
      },
    ],
    admitted: true,
    reasons: ["the failing tasks improved"],
    regressed: [],
    ...over,
  };
}

describe("configPoints", () => {
  it("makes one point per configuration tried", () => {
    const points = configPoints([result()]);
    expect(points).toHaveLength(2);
    expect(points.find((p) => p.current)?.score).toBe(3.5);
  });

  it("counts the same models tried twice as one point, keeping the newest", () => {
    // Two comparisons that share a side are one configuration measured twice;
    // plotting both would suggest more options than the factory has.
    const points = configPoints([
      result({ id: "bench_01JD000000000000000000000A", at: "2026-10-01T00:00:00Z" }),
      result({
        id: "bench_01JD000000000000000000000B",
        at: "2026-11-20T00:00:00Z",
        sides: [
          {
            label: "before",
            models: { builder: "claude-opus-5" },
            score_mean: 3.9,
            score_spread: 0.2,
            cost_usd: 12,
            cost_per_task: 1,
            must_pass_rate: 0.9,
            current: true,
          },
        ],
      }),
    ]);
    expect(points).toHaveLength(2);
    expect(points.find((p) => p.models["builder"] === "claude-opus-5")?.score).toBe(3.9);
  });

  it("marks the frontier: nothing else is as good for no more money", () => {
    const points = configPoints([
      result({
        sides: [
          { label: "a", models: { builder: "x" }, score_mean: 4, score_spread: 0, cost_usd: 1, cost_per_task: 1, must_pass_rate: 1 },
          { label: "b", models: { builder: "y" }, score_mean: 3, score_spread: 0, cost_usd: 2, cost_per_task: 2, must_pass_rate: 1 },
          { label: "c", models: { builder: "z" }, score_mean: 5, score_spread: 0, cost_usd: 3, cost_per_task: 3, must_pass_rate: 1 },
        ],
      }),
    ]);
    const on = points.filter((p) => p.onFrontier).map((p) => p.label).sort();
    // b is beaten by a: worse score, higher cost.
    expect(on).toEqual(["a", "c"]);
  });

  it("falls back to the label when a side recorded no models", () => {
    const points = configPoints([
      result({
        sides: [
          { label: "before", score_mean: 3, score_spread: 0, cost_usd: 1, cost_per_task: 1, must_pass_rate: 1 },
          { label: "after", score_mean: 4, score_spread: 0, cost_usd: 1, cost_per_task: 1, must_pass_rate: 1 },
        ],
      }),
    ]);
    expect(points.map((p) => p.label).sort()).toEqual(["after", "before"]);
  });

  it("is empty with no comparisons, rather than inventing a point", () => {
    expect(configPoints([])).toEqual([]);
  });
});

describe("verdictOf", () => {
  it("calls a gain larger than the spread adopted", () => {
    expect(verdictOf(result()).verdict).toBe("adopted");
  });

  it("calls a difference inside the spread no clear winner", () => {
    // The whole reason this page exists: 0.15 better with the number moving
    // 0.4 between repeats has shown nothing.
    const v = verdictOf(
      result({
        sides: [
          { label: "before", score_mean: 3.5, score_spread: 0.4, cost_usd: 1, cost_per_task: 1, must_pass_rate: 1, current: true },
          { label: "after", score_mean: 3.65, score_spread: 0.3, cost_usd: 1, cost_per_task: 1, must_pass_rate: 1 },
        ],
      }),
    );
    expect(v.verdict).toBe("no_clear_winner");
    expect(v.why).toContain("inside the run-to-run spread");
  });

  it("uses the larger of the two spreads as the noise floor", () => {
    const v = verdictOf(
      result({
        sides: [
          { label: "before", score_mean: 3, score_spread: 0.05, cost_usd: 1, cost_per_task: 1, must_pass_rate: 1, current: true },
          { label: "after", score_mean: 3.5, score_spread: 0.8, cost_usd: 1, cost_per_task: 1, must_pass_rate: 1 },
        ],
      }),
    );
    expect(v.verdict).toBe("no_clear_winner");
  });

  it("treats a regression as a veto whatever the scores say", () => {
    const v = verdictOf(result({ regressed: ["bt_01JD000000000000000000000A"] }));
    expect(v.verdict).toBe("rejected");
    expect(v.why).toContain("stopped passing");
  });

  it("calls it rejected when the gain is real but the rule said no", () => {
    const v = verdictOf(result({ admitted: false, reasons: ["cost rose by more than 20%"] }));
    expect(v.verdict).toBe("rejected");
    expect(v.why).toBe("cost rose by more than 20%");
  });

  it("decides nothing from a single side", () => {
    const v = verdictOf(
      result({
        sides: [
          { label: "only", score_mean: 4, score_spread: 0.1, cost_usd: 1, cost_per_task: 1, must_pass_rate: 1, current: true },
        ],
      }),
    );
    expect(v.verdict).toBe("no_clear_winner");
    expect(v.why).toContain("only one configuration");
  });
});

describe("scorerCards", () => {
  const review = (scores: ReviewFile["scores"]): ReviewFile => ({
    schema: "review/1",
    id: "rev_20261120",
    window: { from: "2026-11-17T00:00:00Z", to: "2026-11-20T00:00:00Z", runs: 4 },
    scores,
    problems: [],
  });

  it("draws the pass line where the review routes, at 2", () => {
    // The scorers answer 1-5 and anything at or below 2 is routed, so a 2 is
    // not a pass however it reads as a score.
    const cards = scorerCards(
      review([
        { run: "run_a", criterion: "follows the spec", score: 2 },
        { run: "run_b", criterion: "follows the spec", score: 3 },
      ]),
    );
    expect(cards[0]).toEqual({ criterion: "follows the spec", passRate: 0.5, runs: 2 });
  });

  it("puts the worst criterion first, which is the one to look at", () => {
    const cards = scorerCards(
      review([
        { run: "a", criterion: "good", score: 5 },
        { run: "b", criterion: "bad", score: 1 },
        { run: "c", criterion: "bad", score: 2 },
      ]),
    );
    expect(cards.map((c) => c.criterion)).toEqual(["bad", "good"]);
  });

  it("is empty for a review that scored nothing", () => {
    expect(scorerCards(review([]))).toEqual([]);
  });
});

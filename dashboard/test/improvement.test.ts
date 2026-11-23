import { describe, it, expect } from "vitest";
import { scorerCards } from "../lib/metrics";
import type { ReviewFile } from "../lib/types";

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

describe("the review record the Improvement page reads", () => {
  it("may carry failures that were not routed, found in hardening runs", () => {
    const r: ReviewFile = {
      schema: "review/1",
      id: "rev_20261120",
      window: { from: "2026-11-17T00:00:00Z", to: "2026-11-20T00:00:00Z", runs: 2 },
      scores: [],
      problems: [],
      unrouted: [{ run: "run_h", tag: "fixed_the_instance", reason: "found in a hardening run" }],
    };
    expect(r.unrouted?.[0]?.tag).toBe("fixed_the_instance");
    // Every problem is hardening: the type admits no other route.
    const route: ReviewFile["problems"][number]["route"] = "hardening";
    expect(route).toBe("hardening");
  });
});

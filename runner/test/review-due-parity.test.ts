import { describe, expect, it } from "vitest";
import { reviewDue } from "../src/commands/review.js";
import { reviewDueNow, reviewInputFrom } from "../../dashboard/lib/review-due.js";

const NOW = "2026-11-25T12:00:00Z";
const day = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

describe("the dashboard's due check says what the runner's says", () => {
  const cases = [
    { lastReviewAt: null, runsSinceLastReview: 0, firstRunAt: null },
    { lastReviewAt: null, runsSinceLastReview: 3, firstRunAt: day(1) },
    { lastReviewAt: null, runsSinceLastReview: 3, firstRunAt: day(4) },
    { lastReviewAt: null, runsSinceLastReview: 60, firstRunAt: day(1) },
    { lastReviewAt: day(1), runsSinceLastReview: 2, firstRunAt: day(9) },
    { lastReviewAt: day(1), runsSinceLastReview: 9, firstRunAt: day(9) },
    { lastReviewAt: day(4), runsSinceLastReview: 9, firstRunAt: day(9) },
    { lastReviewAt: day(4), runsSinceLastReview: 2, firstRunAt: day(9) },
    { lastReviewAt: "not a date", runsSinceLastReview: 9, firstRunAt: day(9) },
  ];
  it.each(cases)("%j", (c) => {
    expect(reviewDueNow({ now: NOW, ...c })).toEqual(reviewDue({ now: NOW, ...c }));
  });
  it("counts runs after the last review, leaving out practices", () => {
    const run = (pipeline: string, endedDaysAgo: number) => ({ pipeline, started_at: day(endedDaysAgo + 0.1), ended_at: day(endedDaysAgo) });
    const input = reviewInputFrom([run("product_work", 0.5), run("definition", 0.5), run("gardening", 5)], day(2), NOW);
    expect(input.runsSinceLastReview).toBe(1);
  });
});

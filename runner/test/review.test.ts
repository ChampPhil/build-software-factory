import { describe, it, expect } from "vitest";
import { reviewDue, groupAndRoute, isReviewable, type ScoredFailure } from "../src/commands/review.js";

const DAY = 86_400_000;
const at = (iso: string, plusDays: number): string => new Date(Date.parse(iso) + plusDays * DAY).toISOString();

describe("reviewDue: later reviews", () => {
  const base = { now: "2026-11-19T00:00:00Z", lastReviewAt: "2026-11-10T00:00:00Z" };

  it("skips under 5 runs, however long it has been", () => {
    const r = reviewDue({ ...base, runsSinceLastReview: 4 });
    expect(r.due).toBe(false);
    expect(r.reason).toContain("mean anything");
  });

  it("runs at 5 runs once the interval has passed", () => {
    expect(reviewDue({ ...base, runsSinceLastReview: 5 }).due).toBe(true);
  });

  it("does not run inside the interval at an ordinary run count", () => {
    expect(reviewDue({ now: "2026-11-11T00:00:00Z", lastReviewAt: "2026-11-10T00:00:00Z", runsSinceLastReview: 12 }).due).toBe(false);
  });

  it("runs early when 50 runs pile up", () => {
    const r = reviewDue({ now: "2026-11-11T00:00:00Z", lastReviewAt: "2026-11-10T00:00:00Z", runsSinceLastReview: 60 });
    expect(r.due).toBe(true);
    expect(r.reason).toContain("early");
  });

  it("respects a configured minimum", () => {
    expect(reviewDue({ ...base, runsSinceLastReview: 7, minRuns: 8 }).due).toBe(false);
  });
});

describe("reviewDue: the first review", () => {
  const first = "2026-11-10T00:00:00Z";

  it("is not due with no runs at all", () => {
    expect(reviewDue({ now: at(first, 5), lastReviewAt: null, runsSinceLastReview: 0, firstRunAt: null }).due).toBe(false);
  });

  it("is not due before day 3, even with a run", () => {
    const r = reviewDue({ now: at(first, 2), lastReviewAt: null, runsSinceLastReview: 1, firstRunAt: first });
    expect(r.due).toBe(false);
    expect(r.reason).toContain("waits for day 3");
  });

  it("is due at day 3 with just 1 run: it is never skipped for having too few", () => {
    const r = reviewDue({ now: at(first, 3), lastReviewAt: null, runsSinceLastReview: 1, firstRunAt: first });
    expect(r.due).toBe(true);
    expect(r.reason).toContain("first review");
  });

  it("is due at day 3 with 4 runs, which would skip a later review", () => {
    expect(reviewDue({ now: at(first, 3), lastReviewAt: null, runsSinceLastReview: 4, firstRunAt: first }).due).toBe(true);
  });

  it("runs early at 50 runs, before day 3", () => {
    const r = reviewDue({ now: at(first, 1), lastReviewAt: null, runsSinceLastReview: 50, firstRunAt: first });
    expect(r.due).toBe(true);
    expect(r.reason).toContain("early");
  });

  it("is due when the first run's date is unreadable, rather than never", () => {
    expect(reviewDue({ now: at(first, 0), lastReviewAt: null, runsSinceLastReview: 2, firstRunAt: "garbage" }).due).toBe(true);
  });
});

describe("isReviewable", () => {
  it("does not grade /practice runs, which are a person's own change", () => {
    expect(isReviewable("definition")).toBe(false);
    for (const p of ["product_work", "gardening", "hardening", "conflict"]) expect(isReviewable(p)).toBe(true);
  });
});

describe("groupAndRoute", () => {
  const f = (over: Partial<ScoredFailure>): ScoredFailure => ({
    run: "run-1", role: "builder", area: "checkout", tag: "weak_tests", kind: "low_score", ...over,
  });

  it("groups by tag and area", () => {
    const { problems } = groupAndRoute([
      f({ run: "a" }),
      f({ run: "b" }),
      f({ run: "c", area: "search" }),
      f({ run: "d", area: "search" }),
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]?.occurrences).toBe(2);
  });

  it("explains every problem as something a check can catch, whatever its tag", () => {
    for (const tag of ["weak_tests", "pattern_drift", "context_gap", "wrong_model_fit", "something_new"]) {
      const p = groupAndRoute([f({ tag, run: "a" }), f({ tag, run: "b" })]).problems[0];
      expect(p?.why).toContain("a check can catch");
      expect(p).not.toHaveProperty("destination");
    }
  });

  it("keeps one problem id per tag-and-area, stable across calls", () => {
    const a = groupAndRoute([f({})]).problems[0]?.id;
    const b = groupAndRoute([f({ run: "other" })]).problems[0]?.id;
    expect(a).toBe(b);
  });

  it("sets aside a failure found in a hardening run, so hardening cannot feed itself", () => {
    const pipelineOf = (run: string): string => (run === "h" ? "hardening" : "product_work");
    const { problems, unrouted } = groupAndRoute([f({ run: "h", detail: "weak check" })], { pipelineOf });
    expect(problems).toEqual([]);
    expect(unrouted).toHaveLength(1);
    expect(unrouted[0]).toMatchObject({ run: "h", tag: "weak_tests", detail: "weak check" });
    expect(unrouted[0]?.reason).toContain("hardening run");
  });

  it("still routes the same failure from a product-work run", () => {
    const pipelineOf = (): string => "product_work";
    const { problems, unrouted } = groupAndRoute([f({ run: "p" }), f({ run: "p2" })], { pipelineOf });
    expect(problems).toHaveLength(1);
    expect(unrouted).toEqual([]);
  });

  it("splits a mixed batch: the hardening run is set aside, the rest group normally", () => {
    const pipelineOf = (run: string): string => (run === "h" ? "hardening" : "gardening");
    const { problems, unrouted } = groupAndRoute(
      [f({ run: "h" }), f({ run: "g1" }), f({ run: "g2" })],
      { pipelineOf },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.occurrences).toBe(2);
    expect(problems[0]?.runs).toEqual(["g1", "g2"]);
    expect(unrouted.map((u) => u.run)).toEqual(["h"]);
  });

  it("routes a failure with no run id (a gardener hand-off) even when a lookup exists", () => {
    // The lookup can say nothing about a failure with no run, so it is not set
    // aside as hardening's own work. It still needs a second sighting, like
    // every other problem.
    const { problems, unrouted } = groupAndRoute([f({ run: "" }), f({ run: "" })], {
      pipelineOf: () => "hardening",
    });
    expect(problems).toHaveLength(1);
    expect(unrouted).toEqual([]);
  });
});

/**
 * Every problem the review found used to become a guardrail, and a problem can
 * be one scored failure in one run. So one bad afternoon — a flaky dependency,
 * an odd issue, a model having a bad time — could install a rule that every
 * future change is judged against for years. Nobody is asked: this is the
 * autonomous path.
 */
describe("a problem seen once is watched, not hardened", async () => {
  const { groupAndRoute, seenOnceIds, SEEN_ONCE_REASON } = await import("../src/commands/review.js");
  const g = (over: Partial<ScoredFailure>): ScoredFailure => ({
    run: "run-1", role: "builder", area: "checkout", tag: "weak_tests", kind: "low_score", ...over,
  });

  it("files nothing for a single sighting", () => {
    const { problems, unrouted } = groupAndRoute([g({ run: "a" })]);
    expect(problems).toEqual([]);
    expect(unrouted).toHaveLength(1);
    expect(unrouted[0]?.reason).toBe(SEEN_ONCE_REASON);
  });

  it("records it against a stable id, so the next review can match it", () => {
    const once = groupAndRoute([g({ run: "a" })]).unrouted[0];
    const twice = groupAndRoute([g({ run: "b" })]).unrouted[0];
    expect(once?.problem).toBeDefined();
    expect(once?.problem).toBe(twice?.problem);
  });

  it("routes it on the second sighting in one window", () => {
    const { problems, unrouted } = groupAndRoute([g({ run: "a" }), g({ run: "b" })]);
    expect(problems).toHaveLength(1);
    expect(unrouted).toEqual([]);
  });

  it("routes it when an earlier review saw it once", () => {
    const first = groupAndRoute([g({ run: "a" })]);
    const seenBefore = seenOnceIds([{ unrouted: first.unrouted }]);
    const second = groupAndRoute([g({ run: "b" })], { seenBefore });
    expect(second.problems).toHaveLength(1);
    expect(second.problems[0]?.id).toBe(first.unrouted[0]?.problem);
  });

  it("does not let a different problem's id unlock this one", () => {
    const other = groupAndRoute([g({ run: "a", tag: "pattern_drift" })]);
    const seenBefore = seenOnceIds([{ unrouted: other.unrouted }]);
    expect(groupAndRoute([g({ run: "b" })], { seenBefore }).problems).toEqual([]);
  });

  it("ignores a set-aside hardening failure when reading what was seen once", () => {
    // Those are recorded for a person, not as a sighting waiting to recur, and
    // they carry no problem id.
    const aside = groupAndRoute([g({ run: "h" })], { pipelineOf: () => "hardening" });
    expect(seenOnceIds([{ unrouted: aside.unrouted }]).size).toBe(0);
  });

  it("keeps the area on the record, so a person can tell two sightings apart", () => {
    const { unrouted } = groupAndRoute([g({ run: "a", area: "checkout" })]);
    expect(unrouted[0]?.detail).toBe("in checkout");
  });

  it("copes with a review record that has no unrouted list", () => {
    expect(seenOnceIds([{}, { unrouted: [] }]).size).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import { reviewDue, groupAndRoute, admitDefinitionChange, type ScoredFailure } from "../src/commands/review.js";

describe("reviewDue", () => {
  const base = { now: "2026-11-19T00:00:00Z", lastReviewAt: "2026-11-10T00:00:00Z" };

  it("skips under the minimum run count, however long it has been", () => {
    const r = reviewDue({ ...base, runsSinceLastReview: 4 });
    expect(r.due).toBe(false);
    expect(r.reason).toContain("mean anything");
  });

  it("runs after the interval", () => {
    expect(reviewDue({ ...base, runsSinceLastReview: 12 }).due).toBe(true);
  });

  it("does not run inside the interval at an ordinary run count", () => {
    expect(reviewDue({ now: "2026-11-11T00:00:00Z", lastReviewAt: "2026-11-10T00:00:00Z", runsSinceLastReview: 12 }).due).toBe(false);
  });

  it("runs early when runs pile up", () => {
    const r = reviewDue({ now: "2026-11-11T00:00:00Z", lastReviewAt: "2026-11-10T00:00:00Z", runsSinceLastReview: 60 });
    expect(r.due).toBe(true);
    expect(r.reason).toContain("early");
  });

  it("the minimum beats the early trigger's own threshold ordering", () => {
    // 60 runs is over the early trigger but the minimum is checked first;
    // with 60 runs the minimum is satisfied, so this is a sanity check that
    // the two thresholds cannot both fire in opposite directions.
    expect(reviewDue({ ...base, runsSinceLastReview: 60, minRuns: 100 }).due).toBe(false);
  });

  it("runs the first review once there is enough to grade", () => {
    expect(reviewDue({ now: base.now, lastReviewAt: null, runsSinceLastReview: 10 }).due).toBe(true);
  });
});

describe("groupAndRoute", () => {
  const f = (over: Partial<ScoredFailure>): ScoredFailure => ({
    run: "run-1", role: "builder", area: "checkout", tag: "weak_tests", kind: "low_score", ...over,
  });

  it("groups by tag and area", () => {
    const problems = groupAndRoute([f({ run: "a" }), f({ run: "b" }), f({ run: "c", area: "search" })]);
    expect(problems).toHaveLength(2);
    expect(problems[0]?.occurrences).toBe(2);
  });

  it("routes what a check can catch to hardening", () => {
    expect(groupAndRoute([f({ tag: "weak_tests" })])[0]?.destination).toBe("hardening");
    expect(groupAndRoute([f({ tag: "pattern_drift" })])[0]?.destination).toBe("hardening");
  });

  it("sends what the agent did not know to hardening in v1.0, because changing the factory's own prompts waits for v1.1", () => {
    expect(groupAndRoute([f({ tag: "context_gap" })])[0]?.destination).toBe("hardening");
    expect(groupAndRoute([f({ tag: "wrong_model_fit" })])[0]?.destination).toBe("hardening");
    expect(groupAndRoute([f({ tag: "context_gap" })])[0]?.why).toContain("v1.1");
  });

  it("still has the definition route, switched on explicitly, for v1.1", () => {
    const on = { definitionRoute: true };
    expect(groupAndRoute([f({ tag: "context_gap" })], on)[0]?.destination).toBe("definition");
    expect(groupAndRoute([f({ tag: "wrong_model_fit" })], on)[0]?.destination).toBe("definition");
  });

  it("defaults an unknown tag to hardening, the cheaper mistake", () => {
    // A wrong hardening route costs one rejected PR; a wrong definition route
    // costs a benchmark cycle.
    expect(groupAndRoute([f({ tag: "something_new" })])[0]?.destination).toBe("hardening");
  });

  it("keeps one problem id per tag-and-area, stable across calls", () => {
    const a = groupAndRoute([f({})])[0]?.id;
    const b = groupAndRoute([f({ run: "other" })])[0]?.id;
    expect(a).toBe(b);
  });
});

describe("admitDefinitionChange", () => {
  const ok = {
    failureTaskScores: { before: [2, 2, 2], after: [4, 4, 4] },
    otherTaskScores: { before: [4, 4, 4], after: [4, 4, 4] },
    costBefore: 1, costAfter: 1.1, taskCount: 12, repeats: 3,
  };

  it("admits a change that clears every bar", () => {
    expect(admitDefinitionChange(ok).admit).toBe(true);
  });

  it("refuses a gain inside the run-to-run spread", () => {
    const r = admitDefinitionChange({
      ...ok,
      failureTaskScores: { before: [1, 3, 5], after: [2, 4, 5] },
    });
    expect(r.admit).toBe(false);
    expect(r.reasons.join(" ")).toContain("spread");
  });

  it("refuses when the failure tasks did not improve", () => {
    expect(admitDefinitionChange({ ...ok, failureTaskScores: { before: [4, 4, 4], after: [4, 4, 4] } }).admit).toBe(false);
  });

  it("refuses when anything else regressed", () => {
    expect(admitDefinitionChange({ ...ok, otherTaskScores: { before: [4, 4, 4], after: [3, 3, 3] } }).admit).toBe(false);
  });

  it("refuses too few tasks or too few repeats", () => {
    expect(admitDefinitionChange({ ...ok, taskCount: 5 }).admit).toBe(false);
    expect(admitDefinitionChange({ ...ok, repeats: 1 }).admit).toBe(false);
  });

  it("refuses a cost rise over 20 per cent", () => {
    const r = admitDefinitionChange({ ...ok, costAfter: 1.5 });
    expect(r.admit).toBe(false);
    expect(r.reasons.join(" ")).toContain("20%");
  });
});

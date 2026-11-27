import { describe, expect, it } from "vitest";
import { headlineSpend, medianRequestToPr, minutesFromSteps, oneTimeSetupUsd, outcomeLabel, shareFraction, sharesFromBudget, spendAsideFromSetup, spendFromBudget, spendFromSteps } from "../lib/spend";

const step = (at: string, cost: number, minutes?: number) => ({ role: "x", run_id: "r", at, cost_usd: cost, billed_minutes: minutes });

describe("spend from step records", () => {
  it("sums the month and ignores other months", () => {
    expect(spendFromSteps([step("2026-11-02T00:00:00Z", 1.25), step("2026-11-20T00:00:00Z", 0.5), step("2026-10-30T00:00:00Z", 9)], "2026-11")).toBe(1.75);
  });
  it("sums billed minutes", () => {
    expect(minutesFromSteps([step("2026-11-02T00:00:00Z", 1, 3), step("2026-11-03T00:00:00Z", 1)], "2026-11")).toBe(3);
  });
  it("divides a share by its slice of the budget", () => {
    expect(shareFraction(5, 35, 50)).toBeCloseTo(5 / 17.5);
    expect(shareFraction(5, 0, 50)).toBe(0);
  });
});

describe("request to PR and outcome", () => {
  const run = (s: string, e: string, pr: number | null) => ({ started_at: s, ended_at: e, pr });
  it("takes the median over runs that opened a PR only", () => {
    expect(medianRequestToPr([run("2026-11-01T00:00:00Z", "2026-11-01T00:10:00Z", 4), run("2026-11-01T00:00:00Z", "2026-11-01T00:30:00Z", 5), run("2026-11-01T00:00:00Z", "2026-11-01T05:00:00Z", null)])).toBe(1200);
    expect(medianRequestToPr([])).toBeNull();
  });
  it("calls a run with a PR Opened PR, never Failed", () => {
    expect(outcomeLabel({ outcome: "failed", pr: 9 }, "Failed")).toBe("Opened PR #9");
    expect(outcomeLabel({ outcome: "failed", pr: null }, "Failed")).toBe("Failed");
  });
});

import { spentByShare } from "../lib/spend";
describe("spend by share", () => {
  it("charges each step to the share of its run's pipeline", () => {
    const steps = [
      { role: "b", run_id: "r1", at: "2026-11-02T00:00:00Z", cost_usd: 2 },
      { role: "g", run_id: "r2", at: "2026-11-03T00:00:00Z", cost_usd: 1.5 },
      { role: "h", run_id: "r3", at: "2026-11-03T00:00:00Z", cost_usd: 0.5 },
      { role: "x", run_id: "unknown", at: "2026-11-03T00:00:00Z", cost_usd: 9 },
      { role: "old", run_id: "r1", at: "2026-10-03T00:00:00Z", cost_usd: 9 },
    ];
    const out = spentByShare(steps, { r1: "product_work", r2: "gardening", r3: "hardening" }, "2026-11");
    expect(out).toEqual({ product_work: 2, gardening: 2, review_and_benchmarks: 0 });
  });
});

describe("budget.json", () => {
  it("sums every finite amount, including setup, and rounds to cents", () => {
    expect(spendFromBudget({ setup: 0.126, product_work: 1.2, gardening: 0.3, review_and_benchmarks: 0.4, lost: Number.POSITIVE_INFINITY, bad: "nope" })).toBe(2.03);
  });

  it("is null when the file has no finite charges, so the page can fall back", () => {
    expect(spendFromBudget(null)).toBeNull();
    expect(spendFromBudget({})).toBeNull();
    expect(spendFromBudget({ setup: Number.NaN })).toBeNull();
  });

  it("names the one-time setup charge and leaves a later sandbox update out of it", () => {
    expect(oneTimeSetupUsd({ setup: 12.4, sandbox_upkeep: 1.5, product_work: 3 })).toBe(12.4);
    expect(spendAsideFromSetup(16.9, 12.4)).toBe(4.5);
    expect(oneTimeSetupUsd({ sandbox_upkeep: 1.5 })).toBe(0);
    expect(oneTimeSetupUsd(null)).toBe(0);
  });

  it("fills the three share bars from those keys and leaves setup out of them", () => {
    expect(sharesFromBudget({ setup: 0.5, product_work: 1.234, gardening: 0.2 })).toEqual({
      product_work: 1.23,
      gardening: 0.2,
      review_and_benchmarks: 0,
    });
    expect(sharesFromBudget({ setup: 1 })).toBeUndefined();
  });

  it("does not turn real budget charges into zero when recent runs are empty", () => {
    expect(headlineSpend({ budgetSpent: 4.5, stepSpent: 0, recentRunIds: [], indexSpent: 0 })).toEqual({ amount: 4.5, source: "budget" });
  });

  it("uses step records only when budget.json has no amounts and the index named runs", () => {
    expect(headlineSpend({ budgetSpent: null, stepSpent: 2.5, recentRunIds: ["run-1"], indexSpent: 0 })).toEqual({ amount: 2.5, source: "steps" });
    expect(headlineSpend({ budgetSpent: null, stepSpent: 0, recentRunIds: [], indexSpent: 1.25 })).toEqual({ amount: 1.25, source: "index" });
  });
});

describe("outcome label rule used by the badge", () => {
  it("is Opened PR #N for any run with a PR whose outcome is failed or draft_pr", () => {
    expect(outcomeLabel({ outcome: "draft_pr", pr: 12 }, "Opened a PR")).toBe("Opened PR #12");
  });
});

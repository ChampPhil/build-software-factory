import { describe, expect, it } from "vitest";
import { medianRequestToPr, minutesFromSteps, outcomeLabel, shareFraction, spendFromSteps } from "../lib/spend";

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

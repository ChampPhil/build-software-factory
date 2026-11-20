import { describe, it, expect } from "vitest";
import {
  headline, projectToMonthEnd, shareUse, board, groupByStation, STATIONS,
  ratchetBars, coverageGauge, timeline, costBreakdown, costMismatch, series,
  formatDuration, formatUsd, formatPct, elapsedSince,
} from "../lib/metrics.js";
import type { IndexFile, LedgerFile, LiveFile, RunFile, BaselinesFile, CoverageFile } from "../lib/types.js";

const index = (over: Partial<IndexFile["metrics"]> = {}): IndexFile => ({
  schema: "index/1",
  updated_at: "2026-11-19T12:00:00Z",
  factory: { runner: "v0.1.0", harness: "claude-code" },
  metrics: { window_days: 30, runs: 0, ...over },
});

describe("the headline row distinguishes zero from nothing to measure", () => {
  it("says there is no data at all, rather than showing zeros", () => {
    const h = headline(null);
    expect(h.autonomy.known).toBe(false);
    if (!h.autonomy.known) expect(h.autonomy.why).toContain("No factory data");
  });

  it("does not report 0% autonomy for a factory that has merged nothing", () => {
    // A new factory has merged nothing. 0% would read as "the agents fail",
    // which is a different claim from "nothing has happened yet".
    const h = headline(index({ runs: 4, merged: 0, automation_rate: 0 }));
    expect(h.autonomy.known).toBe(false);
    if (!h.autonomy.known) expect(h.autonomy.why).toContain("No merged pull requests");
  });

  it("reports autonomy once something has merged", () => {
    const h = headline(index({ runs: 10, merged: 6, automation_rate: 0.5 }));
    expect(h.autonomy).toEqual({ known: true, value: 0.5 });
  });

  it("works out cost per merged PR", () => {
    const h = headline(index({ merged: 4, spend_usd: 10 }));
    expect(h.costPerPr).toEqual({ known: true, value: 2.5 });
  });

  it("does not divide by zero for cost per PR", () => {
    const h = headline(index({ merged: 0, spend_usd: 10 }));
    expect(h.costPerPr.known).toBe(false);
  });

  it("explains that a public repo has no minutes limit, rather than showing nothing", () => {
    const h = headline(index({ actions_minutes: 500, actions_minutes_limit: null }));
    expect(h.actionsMinutes).toEqual({ known: true, value: 500 });
    expect(h.actionsMinutesLimit.known).toBe(false);
    if (!h.actionsMinutesLimit.known) expect(h.actionsMinutesLimit.why).toContain("standard runners are free");
  });

  it("withholds cycle time until something has merged", () => {
    const h = headline(index({ merged: 0, cycle_time_p50_sec: 999 }));
    expect(h.cycleTimeP50.known).toBe(false);
  });
});

describe("the month-end projection", () => {
  it("declines to project in the first two days of a month", () => {
    const m = projectToMonthEnd(10, new Date("2026-11-02T00:00:00Z"));
    expect(m.known).toBe(false);
    if (!m.known) expect(m.why).toContain("Too early");
  });

  it("projects straight-line from the days elapsed", () => {
    // $60 by the 10th of a 30-day month projects to $180.
    const m = projectToMonthEnd(60, new Date("2026-11-10T00:00:00Z"));
    expect(m).toEqual({ known: true, value: 180 });
  });

  it("uses the real length of the month", () => {
    // February 2027 has 28 days.
    const m = projectToMonthEnd(14, new Date("2027-02-14T00:00:00Z"));
    expect(m).toEqual({ known: true, value: 28 });
  });
});

describe("budget shares", () => {
  const shares = { product_work: 60, gardening: 25, review_and_benchmarks: 15 } as const;

  it("counts hardening against the gardening share", () => {
    const use = shareUse(
      index({ budget_usd: 200, by_pipeline: { gardening: { spend_usd: 20 }, hardening: { spend_usd: 10 } } }),
      shares,
    );
    const g = use.find((u) => u.share === "gardening");
    expect(g?.spentUsd).toBe(30);
    expect(g?.allowanceUsd).toBe(50);
    expect(g?.fraction).toBeCloseTo(0.6, 2);
  });

  it("counts conflict resolution against product work", () => {
    const use = shareUse(
      index({ budget_usd: 100, by_pipeline: { conflict: { spend_usd: 6 } } }),
      shares,
    );
    expect(use.find((u) => u.share === "product_work")?.spentUsd).toBe(6);
  });

  it("marks a share paused when any of its pipelines is", () => {
    const use = shareUse(
      index({ budget_usd: 100, by_pipeline: { gardening: { spend_usd: 25, paused: true } } }),
      shares,
    );
    expect(use.find((u) => u.share === "gardening")?.paused).toBe(true);
  });

  it("caps the bar at twice the allowance rather than running off the page", () => {
    const use = shareUse(
      index({ budget_usd: 100, by_pipeline: { gardening: { spend_usd: 9999 } } }),
      shares,
    );
    expect(use.find((u) => u.share === "gardening")?.fraction).toBe(2);
  });

  it("does not divide by zero with no budget set", () => {
    const use = shareUse(index({ by_pipeline: { gardening: { spend_usd: 5 } } }), shares);
    expect(use.every((u) => Number.isFinite(u.fraction))).toBe(true);
  });
});

describe("the live board", () => {
  const ledger = (over: Partial<LedgerFile> = {}): LedgerFile => ({
    schema: "ledger/1", updated_at: "2026-11-19T12:00:00Z",
    open: [], recent: [], merge_queue: [], ...over,
  });

  const live = (over: Partial<LiveFile> = {}): LiveFile => ({
    schema: "live/1", run: "run_1", work_item: "wi_1", pipeline: "product_work",
    step: "builder", started_at: "2026-11-19T11:00:00Z", ...over,
  });

  it("places a queued item at Queued", () => {
    const cards = board(ledger({ open: [{ work_item: "wi_1", pipeline: "product_work", status: "queued" }] }), []);
    expect(cards[0]?.station).toBe("Queued");
  });

  it("lets the live file win over the ledger for a running item", () => {
    // The ledger says running; the live file knows which step. The live file
    // is written at each step change, so it is the more current of the two.
    const cards = board(
      ledger({ open: [{ work_item: "wi_1", pipeline: "product_work", status: "running" }] }),
      [live({ step: "gate", attempt: 2, of: 3 })],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.station).toBe("Gates");
    expect(cards[0]?.attempt).toBe(2);
    expect(cards[0]?.of).toBe(3);
  });

  it("keeps the PR number the ledger knows and the live file does not", () => {
    const cards = board(
      ledger({ open: [{ work_item: "wi_1", pipeline: "product_work", status: "running", pr: 311 }] }),
      [live()],
    );
    expect(cards[0]?.pr).toBe(311);
  });

  it("carries an escalation through from the ledger", () => {
    const cards = board(
      ledger({ open: [{ work_item: "wi_1", pipeline: "product_work", status: "escalated" }] }),
      [],
    );
    expect(cards[0]?.escalated).toBe(true);
  });

  it("maps every step to a station, with no gaps", () => {
    const steps: LiveFile["step"][] = [
      "triage", "spec", "builder", "verifier", "gardener", "hardener", "scorer", "gate", "merge",
    ];
    for (const step of steps) {
      const cards = board(null, [live({ step, work_item: `wi_${step}` })]);
      expect(STATIONS, `step ${step} has no station`).toContain(cards[0]?.station);
    }
  });

  it("groups by station, oldest first within each", () => {
    const cards = board(null, [
      live({ work_item: "b", started_at: "2026-11-19T12:00:00Z" }),
      live({ work_item: "a", started_at: "2026-11-19T10:00:00Z" }),
    ]);
    const grouped = groupByStation(cards);
    expect(grouped["Build"]?.map((c) => c.workItem)).toEqual(["a", "b"]);
  });

  it("gives every station a list, so empty columns still render", () => {
    const grouped = groupByStation([]);
    for (const s of STATIONS) expect(grouped[s]).toEqual([]);
  });
});

describe("the ratchet bars", () => {
  const baselines = (rules: BaselinesFile["rules"]): BaselinesFile => ({ schema: "baselines/1", rules });

  it("shows progress from the count at setup toward zero", () => {
    const bars = ratchetBars(
      baselines({ "no-var": { count: 32 } }),
      baselines({ "no-var": { count: 8 } }),
    );
    expect(bars[0]?.atSetup).toBe(32);
    expect(bars[0]?.now).toBe(8);
    expect(bars[0]?.progress).toBeCloseTo(0.75, 2);
  });

  it("shows a bar that has not moved as exactly that, not as absent", () => {
    const bars = ratchetBars(baselines({ r: { count: 10 } }), baselines({ r: { count: 10 } }));
    expect(bars).toHaveLength(1);
    expect(bars[0]?.progress).toBe(0);
  });

  it("marks a rule retired once its count reaches zero", () => {
    const bars = ratchetBars(baselines({ r: { count: 5 } }), baselines({ r: { count: 0 } }));
    expect(bars[0]?.retired).toBe(true);
    expect(bars[0]?.progress).toBe(1);
  });

  it("orders the most still to do first", () => {
    const bars = ratchetBars(
      baselines({ a: { count: 5 }, b: { count: 50 } }),
      baselines({ a: { count: 4 }, b: { count: 40 } }),
    );
    expect(bars.map((b) => b.rule)).toEqual(["b", "a"]);
  });

  it("counts how many files a rule still spans", () => {
    const bars = ratchetBars(
      baselines({ r: { count: 10 } }),
      baselines({ r: { count: 6, by_file: { "a.js": 3, "b.js": 3 } } }),
    );
    expect(bars[0]?.files).toBe(2);
  });

  it("handles a rule that appeared after setup", () => {
    const bars = ratchetBars(baselines({}), baselines({ fresh: { count: 3 } }));
    expect(bars[0]?.atSetup).toBe(0);
    expect(bars[0]?.progress).toBe(1);
  });
});

describe("the coverage gauge", () => {
  const coverage: CoverageFile = {
    schema: "coverage/1", high_pct: 82, floor_pct: 81, tolerance_pts: 1,
    diff_min_pct: 80, skips: { count: 4, cap: 10 },
  };

  it("shows the floor, the high mark and the headroom between them", () => {
    const g = coverageGauge(coverage);
    expect(g).toEqual({ floor: 81, high: 82, diffMin: 80, skips: 4, skipCap: 10, headroom: 1 });
  });

  it("is null when there is no coverage file, so the page can say why", () => {
    expect(coverageGauge(null)).toBeNull();
  });
});

describe("run detail", () => {
  const run: RunFile = {
    schema: "run/1", id: "run_1", work_item: "wi_1", pipeline: "product_work",
    actor: { kind: "agent", harness: "claude-code" },
    started_at: "2026-11-19T10:00:00Z", ended_at: "2026-11-19T10:30:00Z",
    outcome: "draft_pr", pr: 311,
    steps: [
      { role: "triage", model: "m1", duration_sec: 60, tokens: { in: 100, out: 10 }, cost_usd: 0.2, exit: "ok" },
      { role: "builder", attempt: 1, model: "m2", duration_sec: 300, tokens: { in: 900, out: 80, cached: 500 }, cost_usd: 1.0, exit: "ok" },
      { role: "builder", attempt: 2, model: "m2", duration_sec: 240, tokens: { in: 800, out: 70 }, cost_usd: 0.8, exit: "ok" },
    ],
    gates: [
      { gate: "static", attempt: 1, result: "fail", failures: [{ rule: "no-raw-fetch", file: "a.ts", line: 4 }] },
      { gate: "static", attempt: 2, result: "pass" },
      { gate: "verification", attempt: 1, result: "pass", coverage: { diff_pct: 94, total_pct: 81 } },
    ],
    cost_usd: 2.0,
  };

  it("builds a row per step and per gate attempt", () => {
    const rows = timeline(run);
    expect(rows.filter((r) => r.kind === "step")).toHaveLength(3);
    expect(rows.filter((r) => r.kind === "gate")).toHaveLength(3);
  });

  it("names the gates the way the factory does", () => {
    const rows = timeline(run).filter((r) => r.kind === "gate");
    expect(rows[0]?.label).toBe("Gate 1 · static");
    expect(rows[2]?.label).toBe("Gate 2 · verification");
  });

  it("labels repeated steps by attempt", () => {
    const { rows } = costBreakdown(run);
    expect(rows.map((r) => r.label)).toContain("builder · attempt 2");
  });

  it("uses the run's own recorded total, not the sum of the steps", () => {
    const { total } = costBreakdown(run);
    expect(total).toBe(2.0);
  });

  it("surfaces a mismatch between the steps and the recorded total", () => {
    // The steps sum to 2.00 here, so there is nothing to report.
    expect(costMismatch(run)).toBeNull();
    // A step with no recorded cost leaves a gap, which should be shown rather
    // than hidden by rendering the sum.
    const withGap: RunFile = {
      ...run,
      steps: [...run.steps, { role: "verifier", model: "m3", duration_sec: 100 }],
      cost_usd: 2.5,
    };
    expect(costMismatch(withGap)).toBeCloseTo(0.5, 2);
  });
});

describe("series", () => {
  it("sorts by date and fills a missing value with zero", () => {
    const s = series(
      [{ date: "2026-11-02", spend_usd: 2 }, { date: "2026-11-01" }],
      "spend_usd",
    );
    expect(s).toEqual([
      { date: "2026-11-01", value: 0 },
      { date: "2026-11-02", value: 2 },
    ]);
  });

  it("is empty rather than undefined with no daily data", () => {
    expect(series(undefined, "runs")).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats durations the way someone reads them", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(600)).toBe("10m");
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(5400)).toBe("1h 30m");
    expect(formatDuration(undefined)).toBe("—");
  });

  it("keeps cents on small amounts and drops them on large ones", () => {
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(1234)).toBe("$1,234");
    expect(formatUsd(undefined)).toBe("—");
  });

  it("formats a fraction as a percentage", () => {
    expect(formatPct(0.625)).toBe("63%");
    expect(formatPct(0.625, 1)).toBe("62.5%");
    expect(formatPct(undefined)).toBe("—");
  });

  it("shows elapsed time, and an em dash for an unparseable date", () => {
    const now = new Date("2026-11-19T12:00:00Z");
    expect(elapsedSince("2026-11-19T11:30:00Z", now)).toBe("30m");
    expect(elapsedSince("not a date", now)).toBe("—");
    expect(elapsedSince(undefined, now)).toBe("—");
  });
});

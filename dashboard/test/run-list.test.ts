import { describe, expect, it } from "vitest";
import { visibleRuns } from "../lib/run-list";

describe("runs visible once a pull request exists", () => {
  const live = { run: "run-live", work_item: "wi-live", pipeline: "product_work", started_at: "2026-11-02T00:00:00Z", cost_usd_so_far: 0.2 };
  const file = { id: "run-file", work_item: "wi-file", pipeline: "product_work", outcome: "failed", started_at: "2026-11-01T00:00:00Z", duration_sec: 10, cost_usd: 1.5, pr: 4 };

  it("lists live rows, then run files, then an open ledger item with a PR", () => {
    const rows = visibleRuns({
      live: [live],
      files: [file],
      open: [
        { work_item: "wi-file", pipeline: "product_work", pr: 9 },
        { work_item: "wi-pr", pipeline: "gardening", pr: 12, created_at: "2026-11-03T00:00:00Z" },
        { work_item: "wi-none", pipeline: "product_work", pr: null },
      ],
    });
    expect(rows.map((r) => [r.source, r.work_item, r.outcome, r.pr])).toEqual([
      ["live", "wi-live", "running", null],
      ["file", "wi-file", "draft_pr", 4],
      ["ledger", "wi-pr", "draft_pr", 12],
    ]);
  });

  it("shows a ledger pull request when there are no live jobs and no run files", () => {
    const rows = visibleRuns({
      live: [],
      files: [],
      open: [{ work_item: "wi-pr", pipeline: "product_work", pr: 3, created_at: "2026-11-04T00:00:00Z" }],
    });
    expect(rows).toEqual([
      {
        id: "wi-pr",
        work_item: "wi-pr",
        pipeline: "product_work",
        outcome: "draft_pr",
        started_at: "2026-11-04T00:00:00Z",
        duration_sec: null,
        cost: 0,
        pr: 3,
        source: "ledger",
      },
    ]);
  });

  it("ignores a ledger pr that is not a positive number", () => {
    expect(visibleRuns({ live: [], files: [], open: [{ work_item: "wi", pipeline: "product_work", pr: 0 }] })).toEqual([]);
  });
});

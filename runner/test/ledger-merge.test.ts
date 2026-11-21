import { describe, it, expect } from "vitest";
import { mergeLedgers, type Ledger } from "../src/lib/store.js";

const L = (open: { work_item: string; status: string; pr?: number }[], queue: { pr: number }[] = []): Ledger =>
  ({ schema: "ledger/1", updated_at: "2026-11-21T00:00:00Z", open: open.map((o) => ({ pipeline: "product_work", ...o })), recent: [], merge_queue: queue }) as never;

describe("two writers changing the ledger at once", () => {
  // ts-webapp: intake queued #38 and #39 while a run that had read the ledger
  // earlier was finishing; the run wrote its copy back and the two items
  // vanished from the ledger, so nothing ever dispatched them.
  it("keeps the other writer's new items and applies this writer's own change", () => {
    const base = L([{ work_item: "A", status: "running" }]);
    const mine = L([{ work_item: "A", status: "in_review", pr: 5 }]);
    const current = L([{ work_item: "A", status: "running" }, { work_item: "B", status: "queued" }, { work_item: "C", status: "queued" }]);
    const merged = mergeLedgers(base, mine, current);
    expect(merged.open.map((o) => `${o.work_item}:${o.status}`)).toEqual(["A:in_review", "B:queued", "C:queued"]);
  });

  it("removes what this writer removed, and leaves alone what it did not touch", () => {
    const base = L([{ work_item: "A", status: "in_review" }, { work_item: "B", status: "queued" }]);
    const mine = L([{ work_item: "B", status: "queued" }]);
    const current = L([{ work_item: "A", status: "in_review" }, { work_item: "B", status: "running" }]);
    const merged = mergeLedgers(base, mine, current);
    expect(merged.open.map((o) => `${o.work_item}:${o.status}`)).toEqual(["B:running"]);
  });

  it("merges the merge queue by PR the same way", () => {
    const merged = mergeLedgers(L([], [{ pr: 1 }]), L([], [{ pr: 1 }, { pr: 2 }]), L([], [{ pr: 1 }, { pr: 3 }]));
    expect(merged.merge_queue.map((q) => q.pr)).toEqual([1, 3, 2]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { reportState, sweepReports, recordReport } from "../src/commands/sandbox-reports.js";
import type { Ledger } from "../src/lib/store.js";

const files = new Map<string, string>();
const store = {
  data: {
    list: async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)),
    readJson: async <T,>(p: string) => (files.has(p) ? (JSON.parse(files.get(p)!) as T) : null),
  },
  put: async (changes: { path: string; content: string }[]) => {
    for (const c of changes) files.set(c.path, c.content);
    return "sha";
  },
} as never;

const ledger = (over: Partial<Ledger> = {}): Ledger => ({
  schema: "ledger/1", updated_at: "2026-11-21T00:00:00Z", open: [], recent: [], merge_queue: [], ...over,
});
const report = { role: "builder", needs: "commands.test set to npm test", paths: [".factory/sandbox/manifest.json"], why: "this PR adds the first tests" };
const NOW = "2026-11-21T09:00:00Z";

function fakeGh(openSetupPrs = 0) {
  const dispatched: Record<string, string>[] = [];
  return {
    repo: "o/r",
    dispatched,
    get: vi.fn(async (path: string) =>
      path.includes("/pulls") ? Array.from({ length: openSetupPrs }, () => ({ head: { ref: "factory/setup-1" } })) : { total_count: 0 },
    ),
    dispatchWorkflow: vi.fn(async (_w: string, _ref: unknown, inputs: Record<string, string>) => { dispatched.push(inputs); }),
  };
}

beforeEach(() => files.clear());

describe("when a sandbox report goes to an amendment", () => {
  const stored = { ...report, work_item: "wi_A", reported_at: NOW, reports: 1 };

  it("waits while its change is still open: main does not have what it needs yet", () => {
    // js-legacy: thirteen reports that the PR adding the test runner needed
    // commands.test; an amendment then would read a main with no tests.
    const l = ledger({ open: [{ work_item: "wi_A", pipeline: "gardening", status: "in_review", pr: 11 }] });
    expect(reportState(stored, l).state).toBe("waits_for_merge");
  });

  it("is ready once its change merged, and dropped if it closed unmerged", () => {
    expect(reportState(stored, ledger({ recent: [{ work_item: "wi_A", status: "done", merged_at: NOW }] })).state).toBe("ready");
    expect(reportState(stored, ledger({ recent: [{ work_item: "wi_A", status: "rejected" }] })).state).toBe("dropped");
  });

  it("is ready at once when it came from no work item", () => {
    expect(reportState({ ...report, reported_at: NOW, reports: 1 }, ledger()).state).toBe("ready");
  });
});

describe("sweepReports", () => {
  it("hands every ready report to one amendment, and leaves the waiting ones", async () => {
    await recordReport(store, report, "wi_merged", NOW);
    await recordReport(store, { ...report, needs: "commands.test: npm test", role: "verifier" }, "wi_merged", NOW);
    await recordReport(store, { ...report, needs: "a Postgres" }, "wi_open", NOW);
    const gh = fakeGh();
    const l = ledger({
      open: [{ work_item: "wi_open", pipeline: "product_work", status: "in_review", pr: 4 }],
      recent: [{ work_item: "wi_merged", status: "done", merged_at: NOW }],
    });
    const r = await sweepReports({ gh: gh as never, store, ledger: l, now: NOW });
    expect(r.dispatched).toBe(2);
    expect(r.waiting).toBe(1);
    expect(gh.dispatched).toHaveLength(1);
    expect(JSON.parse(gh.dispatched[0]!["amend"]!).reports).toHaveLength(2);

    // The next sweep, after the open change merges, takes the one that waited.
    const again = await sweepReports({ gh: gh as never, store, ledger: ledger({ recent: [{ work_item: "wi_open", status: "done", merged_at: NOW }] }), now: NOW });
    expect(again.dispatched).toBe(1);
  });

  it("starts nothing while an amendment PR is open", async () => {
    await recordReport(store, report, undefined, NOW);
    const gh = fakeGh(1);
    const r = await sweepReports({ gh: gh as never, store, ledger: ledger(), now: NOW });
    expect(r.dispatched).toBe(0);
    expect(gh.dispatched).toHaveLength(0);
    expect(r.why).toMatch(/already under way/);
  });
});

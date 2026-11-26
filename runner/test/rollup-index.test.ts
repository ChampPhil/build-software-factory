import { describe, it, expect, vi } from "vitest";

// The rollup over a data ref that holds a real run, with every write checked
// against its schema the way the store checks it on GitHub.
const files = new Map<string, string>();
vi.mock("../src/lib/store.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/store.js")>();
  const { assertValid } = await import("../src/lib/schema.js");
  class FactoryStore {
    data = {
      pin: async () => null, list: async () => [...files.keys()], readJson: async <T,>(p: string) => (files.has(p) ? (JSON.parse(files.get(p)!) as T) : null) };
    async get<T>(p: string): Promise<T | null> { return files.has(p) ? (JSON.parse(files.get(p)!) as T) : null; }
    async ledger(now: string) { return (await this.get(real.LEDGER)) ?? real.emptyLedger(now); }
    async put(changes: { path: string; content: string | null }[]) {
      for (const c of changes) {
        if (c.content === null) { files.delete(c.path); continue; }
        const schema = real.schemaFor(c.path);
        if (schema !== null) assertValid(schema, JSON.parse(c.content));
        files.set(c.path, c.content);
      }
      return "sha";
    }
  }
  return { ...real, FactoryStore };
});

const { runRollupCommand } = await import("../src/commands/rollup-run.js");

describe("the rollup on a factory that has runs", () => {
  it("writes an index the schema accepts, with the runs counted", async () => {
    // Every rollup on ts-webapp failed 'index is invalid: /recent_runs/0 must
    // be string', so its metrics read zero runs and zero merges.
    files.set("runs/run_01JD9A000000000000000000AB.json", JSON.stringify({
      schema: "run/1", id: "run_01JD9A000000000000000000AB", work_item: "wi_01JD8Z0000000000000000000A",
      pipeline: "product_work", actor: { kind: "agent", harness: "claude-code" },
      started_at: "2026-11-20T23:40:00Z", ended_at: "2026-11-21T00:10:40Z", duration_sec: 1840,
      outcome: "merged", pr: 311, steps: [], gates: [], cost_usd: 1.84, escalated: false,
    }));
    const gh = { repo: "o/r", dispatchWorkflow: vi.fn(async () => undefined), get: vi.fn(async () => ({ total_count: 0 })) } as never;
    await runRollupCommand({
      gh, now: "2026-11-21T01:00:00Z", windowDays: 30, maxRuns: 3, runnerPin: "x", harness: "claude-code",
      budget: { limitUsd: 100, limitMinutes: null, shares: { product_work: 0.7, gardening: 0.2, review_and_benchmarks: 0.1 }, spentUsd: {}, spentMinutes: {}, productHardStopPct: 100 },
      guardrails: { rules: 0, baselined: 0, coverage_floor_pct: 0, candidates_pending: 0 },
      health: {},
    });
    const index = JSON.parse(files.get("index.json")!);
    expect(index.recent_runs).toEqual(["run_01JD9A000000000000000000AB"]);
    expect(index.metrics.runs).toBe(1);
    expect(index.metrics.merged).toBe(1);
  });
});

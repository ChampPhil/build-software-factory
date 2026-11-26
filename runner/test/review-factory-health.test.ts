import { describe, it, expect, vi, beforeEach } from "vitest";
import { assertValid } from "../src/lib/schema.js";

const RUN = "run_01M7ZGFMV8NX72DCFHP11EPB6A";
let runDoc: Record<string, unknown> = {};
const written: { path: string; content: string | null }[] = [];

vi.mock("../src/lib/store.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/store.js")>();
  class FakeStore {
    data = {
      list: async () => [],
      readJson: async (p: string) => (p === `runs/${RUN}.json` ? runDoc : null),
    };
    get = async () => null;
    ledger = async (now: string) => real.emptyLedger(now);
    put = async (changes: { path: string; content: string | null }[]) => {
      for (const c of changes) {
        const schema = real.schemaFor(c.path);
        if (schema !== null && c.content !== null) assertValid(schema, JSON.parse(c.content));
      }
      written.push(...changes);
      return "sha";
    };
  }
  return { ...real, FactoryStore: FakeStore };
});

beforeEach(() => {
  written.length = 0;
});

const gh = (dispatched: string[]) =>
  ({ repo: "o/r", dispatchWorkflow: async (_w: string, _r: unknown, i: { work_item: string }) => void dispatched.push(i.work_item) }) as never;

const finding = (tag: string) => ({ run: RUN, role: "", area: "src/app", tag, score: 1, kind: "low_score" as const });

describe("findings about missing proof (fix 8)", () => {
  it("are the factory's problem when the verifier never finished: one factory_health item, no hardening, no dispatch", async () => {
    const { runReviewRoute } = await import("../src/commands/review.js");
    runDoc = { pipeline: "product_work", steps: [{ role: "verifier", exit: "error" }] };
    const dispatched: string[] = [];
    const r = await runReviewRoute({
      gh: gh(dispatched), now: "2026-11-26T00:00:00Z",
      failures: [finding("missing_evidence"), finding("overclaimed")],
    });
    const items = written.filter((w) => w.path.startsWith("work-items/")).map((w) => JSON.parse(w.content!) as unknown);
    expect(items.filter((i) => i.pipeline === "hardening")).toHaveLength(0);
    expect(items.filter((i) => i.pipeline === "factory_health")).toHaveLength(1);
    expect(dispatched).toEqual([]);
    expect(r.problems).toHaveLength(0);
  });

  it("stay the repo's when the verifier ran fine", async () => {
    const { runReviewRoute } = await import("../src/commands/review.js");
    runDoc = { pipeline: "product_work", steps: [{ role: "verifier", exit: "ok" }] };
    const r = await runReviewRoute({
      gh: gh([]), now: "2026-11-26T00:00:00Z",
      failures: [finding("missing_evidence"), { ...finding("missing_evidence"), run: RUN }],
    });
    expect(written.some((w) => w.path.startsWith("work-items/") && JSON.parse(w.content!).pipeline === "factory_health")).toBe(false);
    expect(r.problems.length + r.unrouted.length).toBeGreaterThan(0);
  });
});

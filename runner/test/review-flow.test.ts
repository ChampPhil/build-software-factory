import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertValid } from "../src/lib/schema.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-10T00:00:00Z");
const iso = (days: number): string => new Date(T0 + days * DAY).toISOString();
const RUN = (n: string): string => `run_01M7ZGFMV8NX72DCFHP11EPB6${n}`;

interface Run { id: string; pipeline: string; started_at: string; ended_at: string; outcome: string; cost_usd: number; escalated: boolean; actor_kind: "agent"; pr: number | null }
const run = (id: string, pipeline: string, startDay: number): Run => ({
  id, pipeline, actor_kind: "agent", started_at: iso(startDay), ended_at: iso(startDay + 0.1), outcome: "draft_pr", cost_usd: 1, escalated: false, pr: null,
});

let runs: Run[] = [];
let reviews: string[] = [];
const written: { path: string; content: string | null }[] = [];

vi.mock("../src/commands/rollup-run.js", () => ({ readAll: async () => ({ runs, workItems: [] }) }));

vi.mock("../src/lib/store.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/store.js")>();
  class FakeStore {
    data = {
      list: async (prefix = "") => (prefix === "reviews/" ? reviews : []),
      readJson: async (p: string) => {
        const m = /^runs\/(.+)\.json$/.exec(p);
        if (m !== null) {
          const r = runs.find((x) => x.id === m[1]);
          return r === undefined ? null : { pipeline: r.pipeline };
        }
        const rv = /^reviews\//.test(p) ? { at: iso(0) } : null;
        return rv;
      },
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
  runs = [];
  reviews = [];
  written.length = 0;
});

const gh = (dispatched: string[] = []) =>
  ({ repo: "o/r", dispatchWorkflow: async (_w: string, _r: unknown, inputs: { work_item: string }) => void dispatched.push(inputs.work_item) }) as never;

describe("runReviewDue", () => {
  it("does not count /practice runs, and does not start the first review's clock from one", async () => {
    const { runReviewDue } = await import("../src/commands/review.js");
    runs = [run(RUN("A"), "definition", 0), run(RUN("B"), "definition", 0.5)];
    const r = await runReviewDue({ gh: gh(), now: iso(5) });
    expect(r.runsSinceLastReview).toBe(0);
    expect(r.due).toBe(false);
  });

  it("runs the first review at day 3 from the first graded run, with a single run", async () => {
    const { runReviewDue } = await import("../src/commands/review.js");
    runs = [run(RUN("A"), "definition", 0), run(RUN("B"), "product_work", 1)];
    expect((await runReviewDue({ gh: gh(), now: iso(3) })).due).toBe(false); // 2 days after the first graded run
    const due = await runReviewDue({ gh: gh(), now: iso(4) });
    expect(due.due).toBe(true);
    expect(due.runsSinceLastReview).toBe(1);
  });

  it("skips a later review under 5 graded runs", async () => {
    const { runReviewDue } = await import("../src/commands/review.js");
    reviews = ["reviews/2026-11-10.json"];
    runs = [1, 2, 3, 4].map((d) => run(RUN(String(d)), "gardening", d));
    expect((await runReviewDue({ gh: gh(), now: iso(9) })).due).toBe(false);
    runs.push(run(RUN("5"), "hardening", 5));
    expect((await runReviewDue({ gh: gh(), now: iso(9) })).due).toBe(true);
  });
});

describe("review-collect", () => {
  it("leaves /practice runs out of what the scorer grades", async () => {
    const { reviewCollect } = await import("../src/commands/role-steps.js");
    runs = [run(RUN("A"), "definition", 0), run(RUN("B"), "product_work", 1), run(RUN("C"), "conflict", 2)];
    const out = join(mkdtempSync(join(tmpdir(), "bsf-collect-")), "to-score.json");
    const r = await reviewCollect({ gh: { repo: "o/r" } as never, now: iso(5), out });
    expect(r.runs).toBe(2);
    const doc = JSON.parse(readFileSync(out, "utf8")) as { runs: { id: string; pipeline: string }[] };
    expect(doc.runs.map((x) => x.pipeline).sort()).toEqual(["conflict", "product_work"]);
  });
});

describe("runReviewRoute and hardening runs", () => {
  const failure = (id: string) => ({ run: id, role: "builder", area: "src", tag: "weak_test", score: 1, kind: "low_score" as const });

  it("files hardening for a failing product-work run, and only records one from a hardening run", async () => {
    const { runReviewRoute } = await import("../src/commands/review.js");
    runs = [run(RUN("P"), "product_work", 0), run(RUN("H"), "hardening", 1)];
    const dispatched: string[] = [];
    const r = await runReviewRoute({
      gh: gh(dispatched),
      now: iso(4),
      failures: [failure(RUN("P")), failure(RUN("H"))],
    });
    // One problem, from the product-work run; the hardening run's failure is shown, not routed.
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.runs).toEqual([RUN("P")]);
    expect(r.filed).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
    expect(r.unrouted.map((u) => u.run)).toEqual([RUN("H")]);

    const rec = JSON.parse(written.find((c) => c.path.startsWith("reviews/"))!.content!) as {
      unrouted: { run: string }[]; problems: { route: string }[];
    };
    expect(rec.unrouted.map((u) => u.run)).toEqual([RUN("H")]);
    expect(rec.problems.map((p) => p.route)).toEqual(["hardening"]);
  });

  it("files nothing, and dispatches nothing, when every failure came from a hardening run", async () => {
    const { runReviewRoute } = await import("../src/commands/review.js");
    runs = [run(RUN("H"), "hardening", 0)];
    const dispatched: string[] = [];
    const r = await runReviewRoute({ gh: gh(dispatched), now: iso(4), failures: [failure(RUN("H"))] });
    expect(r.filed).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(written.some((c) => c.path === "ledger.json")).toBe(false);
    expect(written.some((c) => c.path.startsWith("reviews/"))).toBe(true);
  });

  it("a review with no unrouted failures records none", async () => {
    const { runReviewRoute } = await import("../src/commands/review.js");
    runs = [run(RUN("P"), "gardening", 0)];
    await runReviewRoute({ gh: gh(), now: iso(4), failures: [failure(RUN("P"))] });
    const rec = JSON.parse(written.find((c) => c.path.startsWith("reviews/"))!.content!) as Record<string, unknown>;
    expect(rec).not.toHaveProperty("unrouted");
  });
});

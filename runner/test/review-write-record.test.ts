import { describe, it, expect, vi } from "vitest";
import { assertValid } from "../src/lib/schema.js";

const written: { path: string; content: string | null }[] = [];

vi.mock("../src/lib/store.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/store.js")>();
  class FakeStore {
    data = { list: async () => [], readJson: async () => null };
    ledger = async (now: string) => real.emptyLedger(now);
    put = async (changes: { path: string; content: string | null }[]) => {
      // The real store validates every file it writes against its schema.
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

describe("the review record", () => {
  it("is a valid review/1 file when the review routes problems", async () => {
    const { runReviewRoute } = await import("../src/commands/review.js");
    const r = await runReviewRoute({
      gh: { repo: "o/r", dispatchWorkflow: async () => undefined } as never,
      now: "2026-11-22T00:30:00.000Z",
      failures: [
        { run: "run_01M7ZGFMV8NX72DCFHP11EPB6Y", role: "builder", area: "src", tag: "weak_test", score: 2, kind: "low_score", detail: "asserts on a mock" },
        { run: "run_01M7ZH7RN6A07PB22AE0E3SERW", role: "builder", area: "src", tag: "weak_test", score: 1, kind: "low_score" },
      ],
    }).catch((e: Error) => e);
    expect(r).not.toBeInstanceOf(Error);
    const review = written.find((c) => c.path.startsWith("reviews/"));
    expect(review, "no review record was written").toBeDefined();
    expect(JSON.parse(review!.content!).window.runs).toBe(2);
  });
});

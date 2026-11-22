import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/commands/rollup-run.js", () => ({
  readAll: async () => ({
    runs: [
      { id: "run_A", pipeline: "product_work", actor_kind: "agent", started_at: "2026-11-21T10:00:00Z", ended_at: "2026-11-21T10:30:00Z", outcome: "draft_pr", cost_usd: 1.2, escalated: false, pr: 32, work_item: "wi_A" },
    ],
    workItems: [],
  }),
}));

vi.mock("../src/lib/store.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/store.js")>();
  class FakeStore {
    data = {
      list: async () => [],
      readJson: async (p: string) => (p === "runs/run_A.json" ? { gates: { tests: "pass" }, steps: [{ role: "builder" }] } : null),
    };
    get = async (p: string) => (p === "work-items/wi_A.json" ? { title: "Reject an empty project name", body: "…", spec: { goal: "error on '-'" } } : null);
  }
  return { ...real, FactoryStore: FakeStore };
});

describe("review-collect", () => {
  it("hands the scorer each run's request, spec, diff, gates and the rubrics, so it never has to fetch them", async () => {
    const { reviewCollect } = await import("../src/commands/role-steps.js");
    const dir = mkdtempSync(join(tmpdir(), "bsf-review-"));
    mkdirSync(join(dir, "rubrics"));
    writeFileSync(join(dir, "rubrics", "product_work.yaml"), "criteria: [correctness]\n");
    const gh = { repo: "o/r", pullFiles: async () => [{ filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }] };
    await reviewCollect({ gh: gh as never, now: "2026-11-21T12:00:00Z", out: join(dir, "to-score.json"), rubricsDir: join(dir, "rubrics") });
    const doc = JSON.parse(readFileSync(join(dir, "to-score.json"), "utf8")) as {
      runs: { request: { title: string }; spec: unknown; diff: { file: string; patch: string }[]; gates: unknown }[];
      rubrics: Record<string, string>;
    };
    expect(doc.runs[0]!.request.title).toBe("Reject an empty project name");
    expect(doc.runs[0]!.spec).toEqual({ goal: "error on '-'" });
    expect(doc.runs[0]!.diff[0]!.patch).toContain("+b");
    expect(doc.runs[0]!.gates).toEqual({ tests: "pass" });
    expect(doc.rubrics["product_work"]).toContain("correctness");
  });
});

describe("reading the scorer's scores", () => {
  it("reads the flat shape the prompt asks for, and the nested shapes a model reaches for", async () => {
    const { normalizeScores } = await import("../src/commands/role-steps.js");
    const flat = normalizeScores({ scores: [{ run: "r1", role: "builder", area: "src", criterion: "meaningful tests", score: 2, tag: "weak_test", detail: "asserts on a mock" }] });
    expect(flat).toEqual([expect.objectContaining({ run: "r1", tag: "weak_test", score: 2, kind: "low_score" })]);
    const nested = normalizeScores({ schema: "scores/1", runs: [{ id: "r2", criteria: [{ name: "minimal change", score: 5 }, { name: "followed the intent", score: 1, tags: ["scope_creep"], note: "added a settings page" }] }] });
    expect(nested.map((f) => [f.run, f.score, f.tag])).toEqual([["r2", 5, "minimal_change"], ["r2", 1, "scope_creep"]]);
    const keyed = normalizeScores({ scores: [{ run: "r3", scores: { "artifacts prove the claim": { score: 2, tag: "evidence_missing" } } }] });
    expect(keyed[0]).toMatchObject({ run: "r3", score: 2, tag: "evidence_missing" });
  });
});
